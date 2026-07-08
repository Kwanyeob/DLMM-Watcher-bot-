import { Connection, PublicKey, AccountInfo, Context } from '@solana/web3.js';
import DLMM from '@meteora-ag/dlmm';
import { StateDB } from '../db/StateDB';
import { PositionState } from '../types';
import { DetectedPosition } from '../detector/PositionDetector';
import { getOrCreateDlmm, parsePositionData, extractDepositAmounts, clearDlmmCache } from './AccountParser';
import { getTokenInfo } from '../utils/tokenInfo';
import {
  classifyQuoteToken,
  ensureTokenTracked,
  getQuoteTokenUsdPrice,
  getQuoteTokenPriceAgeMs,
} from '../price/TieredPriceFeed';
import { RiskEngine } from '../engine/RiskEngine';
import { config } from '../config';
import { logger } from '../utils/logger';
import { fmtPrice } from '../utils/format';
import type { TelegramBot } from '../bot/TelegramBot';

const sleep = (ms: number) => new Promise<void>(res => setTimeout(res, ms));

interface Subs {
  posSubId: number;
  lbPairSubId: number;
}

export class PositionWatcher {
  private connection: Connection;
  private readonly db: StateDB;
  private readonly walletAddress: string;
  private readonly riskEngine: RiskEngine;
  private subs = new Map<string, Subs>();
  private bot?: TelegramBot;

  constructor(connection: Connection, db: StateDB, walletAddress: string, riskEngine: RiskEngine) {
    this.connection = connection;
    this.db = db;
    this.walletAddress = walletAddress;
    this.riskEngine = riskEngine;
  }

  setBot(bot: TelegramBot): void { this.bot = bot; }

  /** Called by ReliableWebSocket on startup and every reconnect */
  async subscribe(connection: Connection): Promise<void> {
    this.connection = connection;
    clearDlmmCache();
    this.subs.clear(); // old sub IDs are dead with the old connection

    const positions = this.db.getAll();

    // Validate positions are still open on-chain before subscribing
    const pubkeys = positions.map(p => new PublicKey(p.address));
    const accountInfos = positions.length > 0
      ? await connection.getMultipleAccountsInfo(pubkeys)
      : [];

    const valid: typeof positions = [];
    for (let i = 0; i < positions.length; i++) {
      if (accountInfos[i] === null) {
        this.db.remove(positions[i].address);
      } else {
        valid.push(positions[i]);
      }
    }

    logger.info(`📌 Tracked positions: ${valid.length}`);
    for (const pos of valid) {
      logger.info(
        `   #${pos.shortId}  ${pos.tokenSymbolA}/${pos.tokenSymbolB}` +
        `  entry=$${pos.entryTotalUsd.toFixed(4)}` +
        `  SL=${pos.slPercent !== null ? pos.slPercent + '%' : '-'}` +
        `  TP=${pos.tpPercent !== null ? pos.tpPercent + '%' : '-'}`,
      );
      this.attachAccountListeners(pos);
    }

    await this.scanExistingPositions();
  }

  /** Scan on-chain for any open positions not yet in DB (catches missed onLogs events) */
  private async scanExistingPositions(): Promise<void> {
    try {
      const allPositions = await DLMM.getAllLbPairPositionsByUser(
        this.connection,
        new PublicKey(this.walletAddress),
      );

      for (const [lbPairAddress, positionInfo] of allPositions) {
        for (const lbPosition of positionInfo.lbPairPositionsData) {
          const positionAddress = lbPosition.publicKey.toBase58();
          if (!this.db.getByAddress(positionAddress)) {
            logger.info(`🔍 Found untracked position on-chain: ${positionAddress.slice(0, 8)}... — registering`);
            await this.onPositionDetected({ signature: '', positionAddress, lbPairAddress, detectedAt: Date.now(), tx: null });
          }
        }
      }
    } catch (err) {
      logger.warn(`scanExistingPositions failed: ${err}`);
    }
  }

  /** Called by Detector when a new DLMM position is opened */
  async onPositionDetected(detected: DetectedPosition): Promise<void> {
    const { positionAddress, lbPairAddress, detectedAt, tx } = detected;

    if (this.db.getByAddress(positionAddress)) {
      logger.warn(`Position ${positionAddress.slice(0, 8)}... already tracked — skipping`);
      return;
    }

    if (this.db.getAll().length >= 10) {
      logger.warn('⚠️  Max 10 positions reached — cannot track more');
      return;
    }

    logger.info(`⏳ Fetching metadata for ${positionAddress.slice(0, 8)}...`);

    try {
      const dlmm = await getOrCreateDlmm(this.connection, lbPairAddress);
      const lbPairData = dlmm.lbPair as any;
      const mintA = (lbPairData.tokenXMint as PublicKey).toBase58();
      const mintB = (lbPairData.tokenYMint as PublicKey).toBase58();

      const [infoA, infoB] = await Promise.all([
        getTokenInfo(mintA, this.connection),
        getTokenInfo(mintB, this.connection),
      ]);

      // Start Jupiter polling for non-SOL, non-stablecoin quote tokens
      const typeB = classifyQuoteToken(mintB);
      ensureTokenTracked(mintB, typeB);

      // Freshly-opened position may not be visible yet on the RPC node that answers this
      // read — the confirmed-commitment notification and this query can land on different
      // backend nodes behind a load-balanced RPC provider. Retry a few times before giving up.
      let parsed: Awaited<ReturnType<typeof parsePositionData>> = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        parsed = await parsePositionData(
          this.connection,
          lbPairAddress,
          positionAddress,
          this.walletAddress,
          infoA.decimals,
          infoB.decimals,
        );
        if (parsed) break;
        logger.debug(`   parsePositionData attempt ${attempt} returned null, retrying...`);
        await sleep(1_500);
      }

      if (!parsed) {
        logger.warn(`Could not parse position ${positionAddress.slice(0, 8)}... after 3 attempts`);
        return;
      }

      // USD price for quote token — wait up to 3s if feed not yet warmed up
      let priceB = getQuoteTokenUsdPrice(mintB, typeB);
      if (priceB === null) {
        logger.debug('Price feed not ready yet — waiting 3s...');
        await new Promise(r => setTimeout(r, 3_000));
        priceB = getQuoteTokenUsdPrice(mintB, typeB) ?? 0;
      }

      // Prefer the exact amounts the wallet deposited (parsed from the open tx's add-liquidity
      // instruction) over a re-query of "current" position state, which can already have drifted
      // from the true cost basis if the pool traded in the gap between tx and this snapshot.
      const depositAmounts = tx
        ? extractDepositAmounts(tx, dlmm.program, positionAddress, mintA, mintB, infoA.decimals, infoB.decimals)
        : null;

      const priceA = parsed.lbPairPrice * priceB;
      const entryAmountA = depositAmounts?.amountA ?? parsed.amountA;
      const entryAmountB = depositAmounts?.amountB ?? parsed.amountB;
      const entryTotalUsd = entryAmountA * priceA + entryAmountB * priceB;

      const detectionLatencyMs = Date.now() - detectedAt;
      const priceBAgeMs = getQuoteTokenPriceAgeMs(mintB, typeB);
      logger.info(
        `📊 Entry snapshot timing — detection→snapshot: ${detectionLatencyMs}ms` +
        `, ${infoB.symbol} price age: ${priceBAgeMs === null ? 'n/a' : priceBAgeMs + 'ms'}` +
        `, amounts: ${depositAmounts ? 'parsed from deposit tx (exact)' : 'position re-query (approximate)'}`,
      );
      const entryRatioA = entryTotalUsd > 0
        ? (entryAmountA * priceA / entryTotalUsd) * 100
        : 50;

      const posState: Omit<PositionState, 'shortId'> = {
        address: positionAddress,
        lbPairAddress,
        tokenMintA: mintA,
        tokenMintB: mintB,
        tokenSymbolA: infoA.symbol,
        tokenSymbolB: infoB.symbol,
        decimalA: infoA.decimals,
        decimalB: infoB.decimals,

        entryAmountA,
        entryAmountB,
        entryPriceA: priceA,
        entryPriceB: priceB,
        entryTotalUsd,
        entryRatioA,
        entryRatioB: 100 - entryRatioA,

        currentAmountA: entryAmountA,
        currentAmountB: entryAmountB,
        feeA: parsed.feeA,
        feeB: parsed.feeB,
        lbPairPrice: parsed.lbPairPrice,

        slPercent: config.defaultSlPercent,
        tpPercent: config.defaultTpPercent,
        minRatioA: config.defaultMinRatioA,
        minRatioB: config.defaultMinRatioB,
        isClosing: false,

        detectedAt,
        binIdLower: parsed.lowerBinId,
        binIdUpper: parsed.upperBinId,
        binStep: parsed.binStep,
      };

      const saved = this.db.add(posState);
      this.logEntrySnapshot(saved);
      this.attachAccountListeners(saved);
      this.bot?.notifyNewPosition(saved);

    } catch (err) {
      logger.error(`PositionWatcher.onPositionDetected error: ${err}`);
    }
  }

  /** Used by /add command: finds the lbPair on-chain then delegates to onPositionDetected */
  async addPositionByAddress(positionAddress: string): Promise<void> {
    const allPositions = await DLMM.getAllLbPairPositionsByUser(
      this.connection,
      new PublicKey(this.walletAddress),
    );

    for (const [lbPairAddress, positionInfo] of allPositions) {
      for (const lbPos of positionInfo.lbPairPositionsData) {
        if (lbPos.publicKey.toBase58() === positionAddress) {
          await this.onPositionDetected({
            signature: '',
            positionAddress,
            lbPairAddress,
            detectedAt: Date.now(),
            tx: null,
          });
          return;
        }
      }
    }

    throw new Error(`Position ${positionAddress} not found on-chain for this wallet`);
  }

  async removePosition(address: string): Promise<void> {
    const sub = this.subs.get(address);
    if (sub) {
      try {
        await this.connection.removeAccountChangeListener(sub.posSubId);
        await this.connection.removeAccountChangeListener(sub.lbPairSubId);
      } catch {
        // safe — listeners may already be gone
      }
      this.subs.delete(address);
    }
    this.db.remove(address);
    logger.info(`🗑  Removed position ${address.slice(0, 8)}...`);
  }

  // ─── private ──────────────────────────────────────────────────────────────

  private attachAccountListeners(pos: PositionState): void {
    const posKey    = new PublicKey(pos.address);
    const lbPairKey = new PublicKey(pos.lbPairAddress);

    const posSubId = this.connection.onAccountChange(
      posKey,
      (_info: AccountInfo<Buffer>, _ctx: Context) => {
        void this.refreshPosition(pos.address);
      },
      'confirmed',
    );

    // Position composition (currentAmountA/B, fees) is a derived value that shifts with the
    // active bin — it can change without the position account itself being written to, so a
    // pool-wide price move needs the same full refresh as a direct position-account change.
    const lbPairSubId = this.connection.onAccountChange(
      lbPairKey,
      (_info: AccountInfo<Buffer>, _ctx: Context) => {
        void this.refreshPosition(pos.address);
      },
      'confirmed',
    );

    this.subs.set(pos.address, { posSubId, lbPairSubId });
    logger.info(
      `   📌 #${pos.shortId} ${pos.tokenSymbolA}/${pos.tokenSymbolB}` +
      `  pos=${posSubId} lbPair=${lbPairSubId}`,
    );
  }

  private async refreshPosition(positionAddress: string): Promise<void> {
    const pos = this.db.getByAddress(positionAddress);
    if (!pos || pos.isClosing) return;

    const parsed = await parsePositionData(
      this.connection,
      pos.lbPairAddress,
      positionAddress,
      this.walletAddress,
      pos.decimalA,
      pos.decimalB,
    );
    if (!parsed) {
      const account = await this.connection.getAccountInfo(new PublicKey(pos.address));
      if (account === null) {
        logger.info(`[#${pos.shortId}] ${pos.tokenSymbolA}/${pos.tokenSymbolB} closed on-chain — removing`);
        await this.removePosition(pos.address);
      }
      return;
    }

    logger.debug(
      `[refreshPosition] #${pos.shortId} ${pos.tokenSymbolA}/${pos.tokenSymbolB}\n` +
      `  My Liquidity  : ${pos.currentAmountA.toFixed(6)} → ${parsed.amountA.toFixed(6)} ${pos.tokenSymbolA} | ${pos.currentAmountB.toFixed(6)} → ${parsed.amountB.toFixed(6)} ${pos.tokenSymbolB}\n` +
      `  Unclaimed Fees: ${pos.feeA.toFixed(6)} → ${parsed.feeA.toFixed(6)} ${pos.tokenSymbolA} | ${pos.feeB.toFixed(6)} → ${parsed.feeB.toFixed(6)} ${pos.tokenSymbolB}\n` +
      `  Current Price : ${fmtPrice(pos.lbPairPrice)} → ${fmtPrice(parsed.lbPairPrice)} ${pos.tokenSymbolB}/${pos.tokenSymbolA}`,
    );

    this.db.update(positionAddress, {
      currentAmountA: parsed.amountA,
      currentAmountB: parsed.amountB,
      feeA: parsed.feeA,
      feeB: parsed.feeB,
      lbPairPrice: parsed.lbPairPrice,
    });

    this.logCurrentState(positionAddress);
    this.riskEngine.check(positionAddress);
  }

  private logCurrentState(positionAddress: string): void {
    const pos = this.db.getByAddress(positionAddress);
    if (!pos) return;

    const typeB  = classifyQuoteToken(pos.tokenMintB);
    const priceB = getQuoteTokenUsdPrice(pos.tokenMintB, typeB) ?? 0;
    const priceA = pos.lbPairPrice * priceB;

    const assetUsd = pos.currentAmountA * priceA + pos.currentAmountB * priceB;
    const feeUsd   = pos.feeA * priceA + pos.feeB * priceB;
    const totalUsd = assetUsd + feeUsd;
    const pnl      = pos.entryTotalUsd > 0
      ? ((totalUsd - pos.entryTotalUsd) / pos.entryTotalUsd) * 100
      : 0;

    const pnlStr = (pnl >= 0 ? '+' : '') + pnl.toFixed(2) + '%';
    logger.info(
      `[#${pos.shortId}] ${pos.tokenSymbolA}/${pos.tokenSymbolB}` +
      `  A=${pos.currentAmountA.toFixed(4)}  B=${pos.currentAmountB.toFixed(4)}` +
      `  fee(A=${pos.feeA.toFixed(6)} B=${pos.feeB.toFixed(6)})` +
      `  $${totalUsd.toFixed(4)}  PnL: ${pnlStr}`,
    );
  }

  private logEntrySnapshot(pos: PositionState): void {
    const sep  = '═'.repeat(56);
    const dash = '─'.repeat(56);
    const valueA = pos.entryAmountA * pos.entryPriceA;
    const valueB = pos.entryAmountB * pos.entryPriceB;
    logger.info(sep);
    logger.info(`🆕  New Position #${pos.shortId} Detected`);
    logger.info(sep);
    logger.info(`  Address : ${pos.address}`);
    logger.info(`  Pool    : ${pos.lbPairAddress}`);
    logger.info(`  Pair    : ${pos.tokenSymbolA} / ${pos.tokenSymbolB}`);
    logger.info(dash);
    logger.info(
      `  Token A : ${pos.entryAmountA.toFixed(6)} ${pos.tokenSymbolA}` +
      `  ($${valueA.toFixed(4)})   ${pos.entryRatioA.toFixed(1)}%`,
    );
    logger.info(
      `  Token B : ${pos.entryAmountB.toFixed(6)} ${pos.tokenSymbolB}` +
      `  ($${valueB.toFixed(4)})   ${pos.entryRatioB.toFixed(1)}%`,
    );
    logger.info(dash);
    logger.info(`  Entry   : $${pos.entryTotalUsd.toFixed(4)}`);
    logger.info(`  Price   : ${fmtPrice(pos.lbPairPrice)} ${pos.tokenSymbolB}/${pos.tokenSymbolA}`);
    const binPrice = (id: number) =>
      Math.pow(1 + pos.binStep / 10_000, id) * Math.pow(10, pos.decimalA - pos.decimalB);
    const lowerPrice = binPrice(pos.binIdLower);
    const upperPrice = binPrice(pos.binIdUpper);
    const lowerPct = ((lowerPrice / pos.lbPairPrice) - 1) * 100;
    const upperPct = ((upperPrice / pos.lbPairPrice) - 1) * 100;
    const fmt = (p: number) => (p >= 0 ? '+' : '') + p.toFixed(1) + '%';
    logger.info(
      `  Range   : ${fmtPrice(lowerPrice)} ${pos.tokenSymbolB}/${pos.tokenSymbolA} (${fmt(lowerPct)})` +
      ` → ${fmtPrice(upperPrice)} ${pos.tokenSymbolB}/${pos.tokenSymbolA} (${fmt(upperPct)})`,
    );
    logger.info(dash);
    const sl = pos.slPercent !== null ? `-${pos.slPercent}%` : 'not set';
    const tp = pos.tpPercent !== null ? `+${pos.tpPercent}%` : 'not set';
    logger.info(`  SL/TP   : SL ${sl}  /  TP ${tp}`);
    logger.info(sep);
  }
}

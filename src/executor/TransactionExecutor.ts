import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import BN from 'bn.js';
import { PositionState } from '../types';
import { CloseReason } from '../engine/RiskEngine';
import { getOrCreateDlmm } from '../watcher/AccountParser';
import { StateDB } from '../db/StateDB';
import { PositionWatcher } from '../watcher/PositionWatcher';
import { classifyQuoteToken, getQuoteTokenUsdPrice } from '../price/TieredPriceFeed';
import { config } from '../config';
import { logger } from '../utils/logger';
import type { TelegramBot } from '../bot/TelegramBot';

const MAX_RETRIES       = 3;
const DEFAULT_PRIORITY  = 50_000; // microLamports fallback

export class TransactionExecutor {
  private bot?: TelegramBot;

  constructor(
    private readonly connection: Connection,
    private readonly wallet: Keypair,
    private readonly db: StateDB,
    private readonly watcher: PositionWatcher,
  ) {}

  setBot(bot: TelegramBot): void { this.bot = bot; }

  async close(pos: PositionState, reason: CloseReason): Promise<void> {
    logger.info(`⚡ [#${pos.shortId}] Closing — reason: ${reason.toUpperCase()}`);
    logger.info(`   Position : ${pos.address}`);
    logger.info(`   Pair     : ${pos.tokenSymbolA}/${pos.tokenSymbolB}`);

    const priorityFee = await this.getPriorityFee(reason);
    logger.info(`   Priority : ${priorityFee} microLamports (${reason === 'sl' ? 'p90' : 'p75'})`);

    const dlmm = await getOrCreateDlmm(this.connection, pos.lbPairAddress);

    // removeLiquidity with shouldClaimAndClose: true handles remove + claimFee + close in one SDK call
    const txs: Transaction[] = await dlmm.removeLiquidity({
      user:               this.wallet.publicKey,
      position:           new PublicKey(pos.address),
      fromBinId:          pos.binIdLower,
      toBinId:            pos.binIdUpper,
      bps:                new BN(10_000), // 100%
      shouldClaimAndClose: true,
    });

    if (txs.length === 0) {
      logger.warn(`[#${pos.shortId}] removeLiquidity returned 0 transactions — position may already be empty`);
    }

    if (config.dryRun) {
      logger.info(`   [DRY RUN] Simulating ${txs.length} transaction(s)...`);
      for (let i = 0; i < txs.length; i++) {
        const tx = txs[i];
        tx.feePayer = this.wallet.publicKey;
        const { blockhash } = await this.connection.getLatestBlockhash('confirmed');
        tx.recentBlockhash = blockhash;
        tx.sign(this.wallet);
        const result = await this.connection.simulateTransaction(tx);
        if (result.value.err) {
          logger.error(`   [DRY RUN] TX ${i + 1}/${txs.length} simulation FAILED: ${JSON.stringify(result.value.err)}`);
          logger.error(`   Logs: ${result.value.logs?.join('\n   ') ?? 'none'}`);
        } else {
          logger.info(`   [DRY RUN] TX ${i + 1}/${txs.length} simulation OK — units: ${result.value.unitsConsumed}`);
        }
      }
      logger.info(`   [DRY RUN] No transactions sent. Set DRY_RUN=false to execute.`);
      return;
    }

    logger.info(`   Sending ${txs.length} transaction(s)...`);
    let lastSignature = '';
    for (let i = 0; i < txs.length; i++) {
      logger.info(`   TX ${i + 1}/${txs.length}...`);
      lastSignature = await this.sendWithRetry(txs[i], priorityFee, pos.shortId);
    }

    logger.info(`✅ [#${pos.shortId}] ${pos.tokenSymbolA}/${pos.tokenSymbolB} closed successfully`);

    // Calculate final PnL and received amounts before removing from DB
    const typeB    = classifyQuoteToken(pos.tokenMintB);
    const priceB   = getQuoteTokenUsdPrice(pos.tokenMintB, typeB) ?? pos.entryPriceB;
    const priceA   = pos.lbPairPrice * priceB;
    const receivedA = pos.currentAmountA + pos.feeA;
    const receivedB = pos.currentAmountB + pos.feeB;
    const finalUsd  = receivedA * priceA + receivedB * priceB;
    const finalPnl  = pos.entryTotalUsd > 0
      ? ((finalUsd - pos.entryTotalUsd) / pos.entryTotalUsd) * 100
      : 0;

    await this.watcher.removePosition(pos.address);
    this.bot?.notifyPositionClosed(pos, reason, lastSignature, finalPnl, receivedA, receivedB);
  }

  // ─── private ──────────────────────────────────────────────────────────────

  private async getPriorityFee(reason: CloseReason): Promise<number> {
    try {
      const fees = await this.connection.getRecentPrioritizationFees();
      if (fees.length === 0) return DEFAULT_PRIORITY;

      const sorted = fees.map(f => f.prioritizationFee).sort((a, b) => a - b);
      // SL = fast (p90), TP/manual = cost-optimized (p75)
      const pct = reason === 'sl' ? 0.9 : 0.75;
      return sorted[Math.floor(sorted.length * pct)] ?? DEFAULT_PRIORITY;
    } catch {
      return DEFAULT_PRIORITY;
    }
  }

  private async sendWithRetry(tx: Transaction, priorityFee: number, shortId: number): Promise<string> {
    // Add priority fee once before retry loop
    const hasBudget = tx.instructions.some(ix =>
      ix.programId.equals(ComputeBudgetProgram.programId),
    );
    if (!hasBudget) {
      tx.instructions.unshift(
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }),
      );
    }

    tx.feePayer = this.wallet.publicKey;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const { blockhash } = await this.connection.getLatestBlockhash('confirmed');
        tx.recentBlockhash = blockhash;

        const sig = await sendAndConfirmTransaction(this.connection, tx, [this.wallet], {
          commitment: 'confirmed',
          maxRetries: 0, // manual retry
        });
        return sig;
      } catch (err: any) {
        const isLast = attempt === MAX_RETRIES;
        logger.warn(`   [#${shortId}] TX attempt ${attempt}/${MAX_RETRIES} failed: ${err.message ?? err}`);
        if (isLast) throw err;
        await new Promise(r => setTimeout(r, 1_000 * attempt)); // 1s, 2s backoff
      }
    }
    throw new Error('sendWithRetry: exceeded max retries');
  }
}

import {
  Connection,
  Logs,
  PublicKey,
  VersionedTransactionResponse,
} from '@solana/web3.js';
import { logger } from '../utils/logger';

export const DLMM_PROGRAM_ID = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';

export interface DetectedPosition {
  signature: string;
  positionAddress: string;
  lbPairAddress: string;
  detectedAt: number;
  /** Full tx, so callers can parse the exact deposited amounts from the add-liquidity instruction */
  tx: VersionedTransactionResponse | null;
}

export type OnPositionDetected = (pos: DetectedPosition) => Promise<void>;

const sleep = (ms: number) => new Promise<void>(res => setTimeout(res, ms));

export class PositionDetector {
  private connection: Connection;
  private readonly walletPubkey: PublicKey;
  private readonly onDetected: OnPositionDetected;
  private subscriptionId: number | null = null;

  constructor(
    connection: Connection,
    walletAddress: string,
    onDetected: OnPositionDetected,
  ) {
    this.connection = connection;
    this.walletPubkey = new PublicKey(walletAddress);
    this.onDetected = onDetected;
  }

  /** Called on startup and on every reconnect by ReliableWebSocket */
  async subscribe(connection: Connection): Promise<void> {
    this.connection = connection;

    // Standard Solana logsSubscribe — works on any RPC plan (unlike Helius'
    // transactionSubscribe, which requires a paid Helius plan).
    this.subscriptionId = connection.onLogs(
      this.walletPubkey,
      (logsResult: Logs) => {
        void this.handleLogs(logsResult);
      },
      'confirmed',
    );

    logger.info(`👁  Watching wallet  : ${this.walletPubkey.toBase58()}`);
    logger.info(`   Method           : logsSubscribe`);
    logger.info(`   Filter           : DLMM InitializePosition`);
    logger.info(`   Subscription ID  : ${this.subscriptionId}`);
  }

  // ─── private ──────────────────────────────────────────────────────────────

  private async handleLogs(logsResult: Logs): Promise<void> {
    const { signature, err, logs: logMessages } = logsResult;

    if (err !== null) {
      logger.debug(`Skipping failed tx: ${signature}`);
      return;
    }

    const hasDlmm    = logMessages.some(l => l.includes(DLMM_PROGRAM_ID));
    const hasInitPos = logMessages.some(l => l.includes('Instruction: InitializePosition'));

    if (!hasDlmm || !hasInitPos) return;

    logger.info('─'.repeat(60));
    logger.info(`📡 InitializePosition detected!`);
    logger.info(`   Signature : ${signature}`);
    logger.debug(`   Raw program logs:`);
    logMessages.forEach(l => logger.debug(`     ${l}`));

    await this.processTransaction(signature);
  }

  private async processTransaction(signature: string): Promise<void> {
    logger.info(`🔍 Fetching transaction...`);

    let tx: VersionedTransactionResponse | null = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
      tx = await this.connection.getTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });
      if (tx) break;
      logger.debug(`   getTransaction attempt ${attempt} returned null, retrying...`);
      await sleep(1_500);
    }

    if (!tx) {
      logger.warn(`⚠️  Could not fetch transaction after 3 attempts: ${signature}`);
      return;
    }

    const { positionAddress, lbPairAddress } = this.extractAccounts(tx);

    logger.info(`🎯 New DLMM Position!`);
    logger.info(`   Position  : ${positionAddress}`);
    logger.info(`   LB Pair   : ${lbPairAddress}`);
    logger.info(`   Solscan   : https://solscan.io/tx/${signature}`);
    logger.info('─'.repeat(60));

    await this.onDetected({
      signature,
      positionAddress,
      lbPairAddress,
      detectedAt: Date.now(),
      tx,
    });
  }

  private extractAccounts(tx: VersionedTransactionResponse): {
    positionAddress: string;
    lbPairAddress: string;
  } {
    const msg = tx.transaction.message as any;

    const staticKeys: PublicKey[]   = msg.staticAccountKeys ?? msg.accountKeys ?? [];
    const writableLoaded: PublicKey[] = tx.meta?.loadedAddresses?.writable ?? [];
    const readonlyLoaded: PublicKey[] = tx.meta?.loadedAddresses?.readonly ?? [];
    const allKeys = [...staticKeys, ...writableLoaded, ...readonlyLoaded];

    logger.debug(`   Total accounts in tx: ${allKeys.length}`);

    const dlmmPk  = new PublicKey(DLMM_PROGRAM_ID);
    const dlmmIdx = allKeys.findIndex(k => k.equals(dlmmPk));

    if (dlmmIdx === -1) {
      logger.warn('   DLMM program not in account keys (unexpected)');
      return this.fallbackExtract(tx, allKeys);
    }

    const compiledIxs: Array<{ programIdIndex: number; accountKeyIndexes: number[] }> =
      msg.compiledInstructions ??
      (msg.instructions ?? []).map((ix: any) => ({
        programIdIndex:    ix.programIdIndex,
        accountKeyIndexes: ix.accounts ?? [],
      }));

    for (const ix of compiledIxs) {
      if (ix.programIdIndex === dlmmIdx && ix.accountKeyIndexes.length >= 3) {
        const pos    = allKeys[ix.accountKeyIndexes[1]]?.toBase58() ?? 'unknown';
        const lbPair = allKeys[ix.accountKeyIndexes[2]]?.toBase58() ?? 'unknown';
        logger.debug(`   Extracted via top-level instruction (accounts[1]=${pos.slice(0, 8)} accounts[2]=${lbPair.slice(0, 8)})`);
        return { positionAddress: pos, lbPairAddress: lbPair };
      }
    }

    for (const outer of tx.meta?.innerInstructions ?? []) {
      for (const inner of outer.instructions as any[]) {
        const accs: number[] = inner.accountKeyIndexes ?? inner.accounts ?? [];
        if (inner.programIdIndex === dlmmIdx && accs.length >= 3) {
          const pos    = allKeys[accs[1]]?.toBase58() ?? 'unknown';
          const lbPair = allKeys[accs[2]]?.toBase58() ?? 'unknown';
          logger.debug(`   Extracted via inner instruction (accounts[1]=${pos.slice(0, 8)} accounts[2]=${lbPair.slice(0, 8)})`);
          return { positionAddress: pos, lbPairAddress: lbPair };
        }
      }
    }

    logger.debug(`   Falling back to newly-funded account heuristic`);
    return this.fallbackExtract(tx, allKeys);
  }

  private fallbackExtract(
    tx: VersionedTransactionResponse,
    allKeys: PublicKey[],
  ): { positionAddress: string; lbPairAddress: string } {
    const pre  = tx.meta?.preBalances  ?? [];
    const post = tx.meta?.postBalances ?? [];

    const newAccounts = allKeys
      .map((k, i) => ({ key: k.toBase58(), pre: pre[i] ?? 0, post: post[i] ?? 0 }))
      .filter(a => a.pre === 0 && a.post > 0)
      .map(a => a.key);

    if (newAccounts.length > 0) {
      logger.debug(`   Newly funded accounts: ${newAccounts.join(', ')}`);
      return {
        positionAddress: newAccounts[0],
        lbPairAddress:   newAccounts[1] ?? 'unknown',
      };
    }

    logger.warn('   ⚠️  Could not extract accounts — manual Solscan inspection needed');
    return { positionAddress: 'unknown', lbPairAddress: 'unknown' };
  }
}

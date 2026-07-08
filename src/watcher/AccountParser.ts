import DLMM from '@meteora-ag/dlmm';
import { Connection, PublicKey, VersionedTransactionResponse } from '@solana/web3.js';
import { logger } from '../utils/logger';
import { fmtPrice } from '../utils/format';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const bs58 = require('bs58') as { decode: (s: string) => Uint8Array };

// Two-sided add-liquidity instructions: args.liquidityParameter.{amountX,amountY}
const TWO_SIDED_ADD_LIQUIDITY_IX = new Set([
  'addLiquidity', 'addLiquidity2',
  'addLiquidityByStrategy', 'addLiquidityByStrategy2',
  'addLiquidityByWeight', 'addLiquidityByWeight2',
]);
// One-sided add-liquidity instructions: args.liquidityParameter.amount (side inferred from token_mint account)
const ONE_SIDED_ADD_LIQUIDITY_IX = new Set([
  'addLiquidityOneSide', 'addLiquidityByStrategyOneSide',
]);

export interface ParsedPositionData {
  amountA: number;      // human units — SDK already converts totalXAmount to string
  amountB: number;
  feeA: number;         // BN → divided by 10^decimalA
  feeB: number;
  lbPairPrice: number;  // how many tokenB per 1 tokenA (human units)
  lowerBinId: number;
  upperBinId: number;
  binStep: number;      // fixed pool property
}

// Cache DLMM instances per pool to avoid recreating on every accountSubscribe tick
const dlmmCache = new Map<string, DLMM>();

export async function getOrCreateDlmm(
  connection: Connection,
  lbPairAddress: string,
): Promise<DLMM> {
  if (!dlmmCache.has(lbPairAddress)) {
    logger.debug(`Creating DLMM instance: ${lbPairAddress.slice(0, 8)}...`);
    dlmmCache.set(lbPairAddress, await DLMM.create(connection, new PublicKey(lbPairAddress)));
  }
  return dlmmCache.get(lbPairAddress)!;
}

export function clearDlmmCache(): void {
  dlmmCache.clear();
}

export async function parsePositionData(
  connection: Connection,
  lbPairAddress: string,
  positionAddress: string,
  walletAddress: string,
  decimalA: number,
  decimalB: number,
): Promise<ParsedPositionData | null> {
  try {
    const dlmm = await getOrCreateDlmm(connection, lbPairAddress);
    await dlmm.refetchStates();

    const { userPositions } = await dlmm.getPositionsByUserAndLbPair(
      new PublicKey(walletAddress),
    );

    const pos = userPositions.find(p => p.publicKey.toBase58() === positionAddress);
    if (!pos) {
      logger.warn(`Position ${positionAddress.slice(0, 8)}... not found in pool`);
      return null;
    }

    // totalXAmount / totalYAmount → raw BN as string (NOT human-readable), divide by decimals
    const amountA = parseFloat(pos.positionData.totalXAmount) / Math.pow(10, decimalA);
    const amountB = parseFloat(pos.positionData.totalYAmount) / Math.pow(10, decimalB);

    // feeX / feeY → raw BN, divide by decimals
    const feeA = pos.positionData.feeX.toNumber() / Math.pow(10, decimalA);
    const feeB = pos.positionData.feeY.toNumber() / Math.pow(10, decimalB);

    // lbPair price: raw bin price × decimal adjustment → human-readable A/B ratio
    const { activeId, binStep } = dlmm.lbPair;
    const rawPrice   = Math.pow(1 + binStep / 10_000, activeId);
    const lbPairPrice = rawPrice * Math.pow(10, decimalA - decimalB);

    const lowerPrice = Math.pow(1 + binStep / 10_000, pos.positionData.lowerBinId) * Math.pow(10, decimalA - decimalB);
    const upperPrice = Math.pow(1 + binStep / 10_000, pos.positionData.upperBinId) * Math.pow(10, decimalA - decimalB);
    logger.debug(
      `[AccountParser] ${positionAddress.slice(0, 8)}...\n` +
      `  Active Bin    : ${activeId}\n` +
      `  Bin Step      : ${binStep}\n` +
      `  Current Price : ${fmtPrice(lbPairPrice)}\n` +
      `  Price Range   : Bin ${pos.positionData.lowerBinId} (${lowerPrice.toFixed(6)}) → Bin ${pos.positionData.upperBinId} (${upperPrice.toFixed(6)})\n` +
      `  My Liquidity  : ${amountA.toFixed(6)} (A) | ${amountB.toFixed(6)} (B)\n` +
      `  Unclaimed Fees: ${feeA.toFixed(6)} (A) | ${feeB.toFixed(6)} (B)`,
    );

    return {
      amountA,
      amountB,
      feeA,
      feeB,
      lbPairPrice,
      lowerBinId: pos.positionData.lowerBinId,
      upperBinId: pos.positionData.upperBinId,
      binStep,
    };
  } catch (err) {
    logger.error(`AccountParser error [${positionAddress.slice(0, 8)}...]: ${err}`);
    return null;
  }
}

/**
 * Parses the exact amounts the wallet deposited by decoding the DLMM program's
 * add-liquidity instruction straight out of the open transaction — instead of
 * re-querying "current" position state a few hundred ms later, which drifts
 * from the true cost basis if the pool trades in that window.
 * Returns null if no recognized add-liquidity instruction is found (falls
 * back to the current-state snapshot in that case).
 */
export function extractDepositAmounts(
  tx: VersionedTransactionResponse,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  program: any,
  positionAddress: string,
  tokenXMint: string,
  tokenYMint: string,
  decimalA: number,
  decimalB: number,
): { amountA: number; amountB: number } | null {
  const msg = tx.transaction.message as any;
  const staticKeys: PublicKey[] = msg.staticAccountKeys ?? msg.accountKeys ?? [];
  const writableLoaded: PublicKey[] = tx.meta?.loadedAddresses?.writable ?? [];
  const readonlyLoaded: PublicKey[] = tx.meta?.loadedAddresses?.readonly ?? [];
  const allKeys = [...staticKeys, ...writableLoaded, ...readonlyLoaded];

  const dlmmIdx = allKeys.findIndex(k => k.equals(program.programId));
  if (dlmmIdx === -1) return null;

  type Ix = { programIdIndex: number; accountKeyIndexes: number[]; data: Uint8Array };

  const topLevel: Ix[] = msg.compiledInstructions ?? [];
  const inner: Ix[] = (tx.meta?.innerInstructions ?? []).flatMap((outer: any) =>
    (outer.instructions as any[]).map(ix => ({
      programIdIndex: ix.programIdIndex,
      accountKeyIndexes: ix.accounts ?? [],
      data: bs58.decode(ix.data),
    })),
  );

  let amountXRaw = 0n;
  let amountYRaw = 0n;
  let found = false;

  for (const ix of [...topLevel, ...inner]) {
    if (ix.programIdIndex !== dlmmIdx) continue;
    // First account of every add-liquidity instruction is the position PDA — only count ixs for this position
    if (allKeys[ix.accountKeyIndexes[0]]?.toBase58() !== positionAddress) continue;

    let decoded: { name: string; data: any } | null;
    try {
      decoded = program.coder.instruction.decode(Buffer.from(ix.data));
    } catch {
      continue;
    }
    if (!decoded) continue;

    const lp = decoded.data?.liquidityParameter;
    if (!lp) continue;

    if (TWO_SIDED_ADD_LIQUIDITY_IX.has(decoded.name) && lp.amountX !== undefined && lp.amountY !== undefined) {
      amountXRaw += BigInt(lp.amountX.toString());
      amountYRaw += BigInt(lp.amountY.toString());
      found = true;
    } else if (ONE_SIDED_ADD_LIQUIDITY_IX.has(decoded.name) && lp.amount !== undefined) {
      const accountMints = ix.accountKeyIndexes.map(i => allKeys[i]?.toBase58());
      const amt = BigInt(lp.amount.toString());
      if (accountMints.includes(tokenXMint)) { amountXRaw += amt; found = true; }
      else if (accountMints.includes(tokenYMint)) { amountYRaw += amt; found = true; }
    }
  }

  if (!found) return null;
  return {
    amountA: Number(amountXRaw) / Math.pow(10, decimalA),
    amountB: Number(amountYRaw) / Math.pow(10, decimalB),
  };
}

/**
 * Simulation mode — no Solana connection or real position needed.
 *
 * Injects a fake SOL/USDC position into StateDB, then ticks lbPairPrice
 * by a configurable % each interval until SL or TP fires.  The RiskEngine
 * and PnL formula run exactly as in production; only the executor is mocked.
 *
 * Usage:
 *   npx ts-node -T scripts/simulate.ts [options]
 *
 * Options:
 *   --sl       <pct>   Stop-loss threshold  (default: 5)
 *   --tp       <pct>   Take-profit threshold (default: 10)
 *   --drift    <pct>   Price Δ per tick, negative = falling (default: -1)
 *   --interval <ms>    Tick interval in milliseconds (default: 1000)
 *   --zigzag          Flip drift direction every 5 ticks (stress test)
 *   --entry    <usd>   Simulated entry value in USD (default: 1000)
 *   --sol-price <usd>  Override SOL price instead of fetching from Pyth
 *
 * Examples:
 *   # Hit SL (~10 ticks at 1%/s drift with 50% SOL allocation)
 *   npx ts-node -T scripts/simulate.ts --sl 5 --drift -1
 *
 *   # Hit TP
 *   npx ts-node -T scripts/simulate.ts --tp 8 --drift 1
 *
 *   # Zigzag stress: oscillate, then slam downward
 *   npx ts-node -T scripts/simulate.ts --zigzag --sl 10 --drift -2
 */

// Suppress verbose internal logs — simulation uses its own stdout output
process.env.LOG_LEVEL = 'warn';
// dotenv not strictly needed (no RPC endpoints used), but load for completeness
import 'dotenv/config';

import { StateDB }                           from '../src/db/StateDB';
import { RiskEngine, CloseReason }           from '../src/engine/RiskEngine';
import { PositionState }                     from '../src/types';
import { startPythFeed, getSolPrice }        from '../src/price/PythFeed';
import { classifyQuoteToken, getQuoteTokenUsdPrice } from '../src/price/TieredPriceFeed';

// ─── CLI arg helpers ─────────────────────────────────────────────────────────

function argNum(flag: string, fallback: number): number {
  const i = process.argv.indexOf(flag);
  if (i === -1) return fallback;
  const v = parseFloat(process.argv[i + 1]);
  return isNaN(v) ? fallback : v;
}

function argFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

const SL_PCT       = argNum('--sl', 5);
const TP_PCT       = argNum('--tp', 10);
const DRIFT_PCT    = argNum('--drift', -1);
const INTERVAL_MS  = argNum('--interval', 1000);
const ENTRY_USD    = argNum('--entry', 1000);
const SOL_OVERRIDE = argNum('--sol-price', 0);   // 0 = fetch from Pyth
const ZIGZAG       = argFlag('--zigzag');

// ─── Well-known mints (no RPC needed — classified by TieredPriceFeed) ────────

const SOL_MINT  = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Syntactically valid base-58 looking strings (32-byte pubkeys, never used on-chain)
const FAKE_POSITION_ADDR = 'SiMuPos1111111111111111111111111111111111111';
const FAKE_LB_PAIR_ADDR  = 'SiMuLbPair11111111111111111111111111111111';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ─── Display helpers ─────────────────────────────────────────────────────────

function pnlBar(pnl: number): string {
  const width  = 24;
  const clamped = Math.max(-SL_PCT, Math.min(TP_PCT, pnl));
  const ratio   = (clamped + SL_PCT) / (SL_PCT + TP_PCT);
  const pos     = Math.round(ratio * width);
  const bar     = '░'.repeat(Math.max(0, pos)) + '█' + '░'.repeat(Math.max(0, width - pos));
  return `\x1b[31m-${SL_PCT}%\x1b[0m [${bar}] \x1b[32m+${TP_PCT}%\x1b[0m`;
}

function colorPnl(pnl: number): string {
  const s = (pnl >= 0 ? '+' : '') + pnl.toFixed(2) + '%';
  return pnl >= 0 ? `\x1b[32m${s}\x1b[0m` : `\x1b[31m${s}\x1b[0m`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\n' + '═'.repeat(58));
  console.log('  DLMM Watcher Bot — Simulation Mode');
  console.log('═'.repeat(58));
  console.log(`  SL: \x1b[31m-${SL_PCT}%\x1b[0m   TP: \x1b[32m+${TP_PCT}%\x1b[0m   Drift: ${DRIFT_PCT > 0 ? '+' : ''}${DRIFT_PCT}%/tick   Interval: ${INTERVAL_MS}ms`);
  if (ZIGZAG) console.log('  Mode: ZIGZAG (direction flips every 5 ticks)');
  console.log('═'.repeat(58) + '\n');

  // ── 1. Get SOL price ───────────────────────────────────────────────────────
  let solPrice: number;

  if (SOL_OVERRIDE > 0) {
    solPrice = SOL_OVERRIDE;
    console.log(`  SOL price: $${solPrice.toFixed(2)}  (manual override)\n`);
  } else {
    startPythFeed();
    process.stdout.write('  Fetching SOL price from Pyth...');
    for (let i = 0; i < 12; i++) {
      await sleep(500);
      const p = getSolPrice();
      if (p) { solPrice = p; break; }
      process.stdout.write('.');
    }
    solPrice ??= 0;

    if (solPrice === 0) {
      console.log('\n  \x1b[33m⚠ Pyth unavailable — using $150 fallback\x1b[0m\n');
      solPrice = 150;
    } else {
      console.log(` $${solPrice.toFixed(2)}\n`);
    }
  }

  // ── 2. Build & persist fake position ──────────────────────────────────────
  const halfUsd     = ENTRY_USD / 2;
  const entryAmtA   = halfUsd / solPrice;   // SOL
  const entryAmtB   = halfUsd;              // USDC

  const db = new StateDB();

  // Remove stale simulation residue
  if (db.getByAddress(FAKE_POSITION_ADDR)) {
    db.remove(FAKE_POSITION_ADDR);
  }

  const posBase: Omit<PositionState, 'shortId'> = {
    address:      FAKE_POSITION_ADDR,
    lbPairAddress: FAKE_LB_PAIR_ADDR,
    tokenMintA:   SOL_MINT,
    tokenMintB:   USDC_MINT,
    tokenSymbolA: 'SOL',
    tokenSymbolB: 'USDC',
    decimalA: 9,
    decimalB: 6,

    entryAmountA:  entryAmtA,
    entryAmountB:  entryAmtB,
    entryPriceA:   solPrice,
    entryPriceB:   1,
    entryTotalUsd: ENTRY_USD,
    entryRatioA:   50,
    entryRatioB:   50,

    currentAmountA: entryAmtA,
    currentAmountB: entryAmtB,
    feeA: 0,
    feeB: 0,
    lbPairPrice: solPrice,

    slPercent: SL_PCT,
    tpPercent: TP_PCT,
    isClosing: false,

    detectedAt:  Date.now(),
    binIdLower: -100,
    binIdUpper:  100,
    binStep:      25,
  };

  const saved = db.add(posBase);

  console.log(`  Position #${saved.shortId} inserted`);
  console.log(`  Pair   : SOL/USDC`);
  console.log(`  Entry  : $${ENTRY_USD.toFixed(2)} — ${entryAmtA.toFixed(4)} SOL + ${entryAmtB.toFixed(2)} USDC`);
  console.log(`  Price  : $${solPrice.toFixed(2)}/SOL`);
  console.log(`  SL/TP  : -${SL_PCT}% / +${TP_PCT}%`);
  console.log('\n' + '─'.repeat(58));

  // ── 3. RiskEngine wired to mock executor ──────────────────────────────────
  let simulationDone = false;

  const riskEngine = new RiskEngine(db, async (pos: PositionState, reason: CloseReason) => {
    simulationDone = true;

    // Read final DB state (RiskEngine may have set isClosing=true)
    const final = db.getByAddress(pos.address) ?? pos;
    const quoteUsd  = getQuoteTokenUsdPrice(USDC_MINT, classifyQuoteToken(USDC_MINT)) ?? 1;
    const finalPnl  = riskEngine.calculatePnL(final, quoteUsd);
    const finalSolP = final.lbPairPrice;
    const finalUsd  = final.currentAmountA * finalSolP + final.currentAmountB;

    const icon  = reason === 'tp' ? '🟢' : reason === 'sl' ? '🔴' : '🔵';
    const label = reason === 'tp' ? 'TAKE PROFIT' : reason === 'sl' ? 'STOP LOSS' : 'MANUAL CLOSE';

    process.stdout.write('\r' + ' '.repeat(80) + '\r'); // clear tick line
    console.log('═'.repeat(58));
    console.log(`  ${icon}  ${label} TRIGGERED`);
    console.log('─'.repeat(58));
    console.log(`  Final PnL  : ${colorPnl(finalPnl)}`);
    console.log(`  SOL price  : $${finalSolP.toFixed(2)}  (entry: $${solPrice.toFixed(2)})`);
    console.log(`  Portfolio  : $${finalUsd.toFixed(2)}`);
    console.log(`  Received   : ${final.currentAmountA.toFixed(4)} SOL + ${final.currentAmountB.toFixed(2)} USDC`);
    console.log('─'.repeat(58));
    console.log('  [MOCK] TransactionExecutor.close() called — DRY RUN');
    console.log('  [MOCK] StateDB.remove() → position cleaned up');
    console.log('═'.repeat(58) + '\n');

    db.remove(pos.address);
    process.exit(0);
  });

  // ── 4. Tick loop ──────────────────────────────────────────────────────────
  let tick         = 0;
  let currentPrice = solPrice;
  let zigzagDir    = DRIFT_PCT;

  const timer = setInterval(() => {
    if (simulationDone) return;
    tick++;

    // Price drift
    if (ZIGZAG && tick % 5 === 0) zigzagDir = -zigzagDir;
    const driftThisTick = ZIGZAG ? zigzagDir : DRIFT_PCT;
    currentPrice *= (1 + driftThisTick / 100);

    // Simple LP model: amounts stay constant, price drives PnL
    // (conservative — ignores IL, accentuates directional exposure)
    db.update(FAKE_POSITION_ADDR, { lbPairPrice: currentPrice });

    const pos = db.getByAddress(FAKE_POSITION_ADDR);
    if (!pos || simulationDone) return;

    const quoteUsd = getQuoteTokenUsdPrice(USDC_MINT, classifyQuoteToken(USDC_MINT)) ?? 1;
    const pnl      = riskEngine.calculatePnL(pos, quoteUsd);
    const totalUsd = pos.currentAmountA * currentPrice + pos.currentAmountB;

    process.stdout.write(
      `\r  Tick ${String(tick).padStart(3)}` +
      `  SOL $${currentPrice.toFixed(2).padStart(7)}` +
      `  Value $${totalUsd.toFixed(2).padStart(8)}` +
      `  PnL ${colorPnl(pnl).padStart(18)}` +
      `  ${pnlBar(pnl)}  `,
    );

    riskEngine.check(FAKE_POSITION_ADDR);
  }, INTERVAL_MS);

  // Ctrl+C cleanup
  process.on('SIGINT', () => {
    clearInterval(timer);
    process.stdout.write('\r' + ' '.repeat(80) + '\r');
    console.log('\n  🛑 Simulation stopped — cleaning up DB...');
    try { db.remove(FAKE_POSITION_ADDR); } catch { /* ignore */ }
    process.exit(0);
  });
}

main().catch(err => {
  console.error('\nFatal simulation error:', err);
  process.exit(1);
});

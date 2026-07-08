import { describe, it, expect } from 'vitest';
import { RiskEngine } from './RiskEngine';
import { StateDB } from '../db/StateDB';
import { PositionState } from '../types';

function makePosition(overrides: Partial<PositionState> = {}): PositionState {
  return {
    address: 'POS',
    lbPairAddress: 'PAIR',
    tokenMintA: 'MINT_A',
    tokenMintB: 'MINT_B',
    tokenSymbolA: 'A',
    tokenSymbolB: 'B',
    decimalA: 9,
    decimalB: 6,
    entryAmountA: 0,
    entryAmountB: 0,
    entryPriceA: 0,
    entryPriceB: 0,
    entryTotalUsd: 100,
    entryRatioA: 50,
    entryRatioB: 50,
    currentAmountA: 10,
    currentAmountB: 20,
    feeA: 0,
    feeB: 0,
    lbPairPrice: 3, // priceA = lbPairPrice * quotePriceUsd
    slPercent: null,
    tpPercent: null,
    minRatioA: null,
    minRatioB: null,
    isClosing: false,
    detectedAt: Date.now(),
    binIdLower: -10,
    binIdUpper: 10,
    binStep: 10,
    shortId: 1,
    ...overrides,
  };
}

// calculatePnL is pure w.r.t. its arguments — the db/callback passed to the
// constructor are never touched by it, so a bare StateDB instance is enough.
const riskEngine = new RiskEngine(new StateDB(), async () => {});

describe('RiskEngine.calculatePnL', () => {
  it('returns 0% when current value exactly matches entry value', () => {
    // priceA = 3 * 2 = 6 → 10*6 + 20*2 = 100 == entryTotalUsd
    const pos = makePosition({ entryTotalUsd: 100, currentAmountA: 10, currentAmountB: 20 });
    expect(riskEngine.calculatePnL(pos, 2)).toBeCloseTo(0, 6);
  });

  it('computes positive PnL from asset appreciation', () => {
    // priceA = 6 → 11*6 + 20*2 = 106 vs entry 100 → +6%
    const pos = makePosition({ entryTotalUsd: 100, currentAmountA: 11, currentAmountB: 20 });
    expect(riskEngine.calculatePnL(pos, 2)).toBeCloseTo(6, 6);
  });

  it('computes negative PnL from asset depreciation', () => {
    // priceA = 6 → 9*6 + 20*2 = 94 vs entry 100 → -6%
    const pos = makePosition({ entryTotalUsd: 100, currentAmountA: 9, currentAmountB: 20 });
    expect(riskEngine.calculatePnL(pos, 2)).toBeCloseTo(-6, 6);
  });

  it('includes unclaimed fees in the total value', () => {
    // assets alone == entry (100); +2.5 feeB * $2 = $5 fee value → +5%
    const pos = makePosition({
      entryTotalUsd: 100,
      currentAmountA: 10,
      currentAmountB: 20,
      feeA: 0,
      feeB: 2.5,
    });
    expect(riskEngine.calculatePnL(pos, 2)).toBeCloseTo(5, 6);
  });

  it('returns 0 when entryTotalUsd is 0 (guard against div-by-zero)', () => {
    const pos = makePosition({ entryTotalUsd: 0, currentAmountA: 10, currentAmountB: 20 });
    expect(riskEngine.calculatePnL(pos, 2)).toBe(0);
  });
});

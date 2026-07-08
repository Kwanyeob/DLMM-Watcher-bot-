import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getSolPrice } = vi.hoisted(() => ({ getSolPrice: vi.fn() }));
const { getJupiterPrice } = vi.hoisted(() => ({ getJupiterPrice: vi.fn() }));

vi.mock('./PythFeed', () => ({
  startPythFeed: vi.fn(),
  getSolPrice,
}));

vi.mock('./JupiterFeed', () => ({
  registerMint: vi.fn(),
  getJupiterPrice,
}));

import { classifyQuoteToken, getQuoteTokenUsdPrice } from './TieredPriceFeed';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const USDH = 'USDH1SM1ojwWUga67PGrgFWUHibbjqMvuMaDkRJTgkX';
const WSOL = 'So11111111111111111111111111111111111111112';
const MEME = 'MemeMintAddressThatIsNotTracked1111111111111';

describe('classifyQuoteToken', () => {
  it('classifies known stablecoins', () => {
    expect(classifyQuoteToken(USDC)).toBe('stablecoin');
    expect(classifyQuoteToken(USDT)).toBe('stablecoin');
    expect(classifyQuoteToken(USDH)).toBe('stablecoin');
  });

  it('classifies wSOL as sol', () => {
    expect(classifyQuoteToken(WSOL)).toBe('sol');
  });

  it('classifies anything else as other', () => {
    expect(classifyQuoteToken(MEME)).toBe('other');
  });
});

describe('getQuoteTokenUsdPrice', () => {
  beforeEach(() => {
    getSolPrice.mockReset();
    getJupiterPrice.mockReset();
  });

  it('hardcodes stablecoins to $1.0 without touching any feed', () => {
    expect(getQuoteTokenUsdPrice(USDC, 'stablecoin')).toBe(1.0);
    expect(getSolPrice).not.toHaveBeenCalled();
    expect(getJupiterPrice).not.toHaveBeenCalled();
  });

  it('routes sol through PythFeed', () => {
    getSolPrice.mockReturnValue(150.25);
    expect(getQuoteTokenUsdPrice(WSOL, 'sol')).toBe(150.25);
  });

  it('returns null when Pyth has no price yet', () => {
    getSolPrice.mockReturnValue(null);
    expect(getQuoteTokenUsdPrice(WSOL, 'sol')).toBeNull();
  });

  it('routes other tokens through JupiterFeed', () => {
    getJupiterPrice.mockReturnValue(0.0042);
    expect(getQuoteTokenUsdPrice(MEME, 'other')).toBe(0.0042);
  });

  it('returns null when Jupiter has no (or stale) price', () => {
    getJupiterPrice.mockReturnValue(null);
    expect(getQuoteTokenUsdPrice(MEME, 'other')).toBeNull();
  });
});

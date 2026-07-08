import { startPythFeed, getSolPrice, getSolPriceAgeMs } from './PythFeed';
import { registerMint, getJupiterPrice, getJupiterPriceAgeMs, setJupiterUpdateHandler } from './JupiterFeed';
import { logger } from '../utils/logger';

export type QuoteTokenType = 'stablecoin' | 'sol' | 'other';

const STABLECOIN_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  'USDH1SM1ojwWUga67PGrgFWUHibbjqMvuMaDkRJTgkX',  // USDH
]);

const SOL_MINTS = new Set([
  'So11111111111111111111111111111111111111112', // wSOL / native SOL
]);

export function classifyQuoteToken(mint: string): QuoteTokenType {
  if (STABLECOIN_MINTS.has(mint)) return 'stablecoin';
  if (SOL_MINTS.has(mint)) return 'sol';
  return 'other';
}

export function ensureTokenTracked(mint: string, type: QuoteTokenType): void {
  if (type === 'other') registerMint(mint);
}

export function getQuoteTokenUsdPrice(mint: string, type: QuoteTokenType): number | null {
  switch (type) {
    case 'stablecoin':
      return 1.0;
    case 'sol': {
      const p = getSolPrice();
      if (!p) logger.warn('SOL price unavailable from Pyth');
      return p;
    }
    case 'other': {
      const p = getJupiterPrice(mint);
      if (!p) logger.warn(`Jupiter price unavailable: ${mint.slice(0, 8)}...`);
      return p;
    }
  }
}

/** Age (ms) of the USD price used for this quote token — 0 for stablecoins (always fresh) */
export function getQuoteTokenPriceAgeMs(mint: string, type: QuoteTokenType): number | null {
  switch (type) {
    case 'stablecoin':
      return 0;
    case 'sol':
      return getSolPriceAgeMs();
    case 'other':
      return getJupiterPriceAgeMs(mint);
  }
}

export { startPythFeed, setJupiterUpdateHandler };

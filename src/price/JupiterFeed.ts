import { logger } from '../utils/logger';

const POLL_MS  = 3_000;
const STALE_MS = 12_000;

const cache        = new Map<string, { price: number; fetchedAt: number }>();
const pollingMints = new Set<string>();
let   pollTimer: NodeJS.Timeout | null = null;
let   onUpdate: (() => void) | null = null;

/** Invoked after every successful price refresh — used to re-run SL/TP checks on price movement alone */
export function setJupiterUpdateHandler(cb: () => void): void {
  onUpdate = cb;
}

async function fetchPrices(mints: string[]): Promise<void> {
  if (mints.length === 0) return;
  try {
    const ids = mints.join(',');
    const res = await fetch(`https://lite-api.jup.ag/price/v2?ids=${ids}`);
    if (!res.ok) return;
    const json = (await res.json()) as any;
    for (const [mint, data] of Object.entries<any>(json.data ?? {})) {
      cache.set(mint, { price: data.price as number, fetchedAt: Date.now() });
      logger.debug(`[Jupiter] ${mint.slice(0, 8)}... — $${(data.price as number).toFixed(6)}`);
    }
    onUpdate?.();
  } catch (err) {
    logger.warn(`Jupiter price fetch failed: ${err}`);
  }
}

export function registerMint(mint: string): void {
  if (pollingMints.has(mint)) return;
  pollingMints.add(mint);
  void fetchPrices([mint]); // immediate first fetch
  if (!pollTimer) {
    pollTimer = setInterval(() => void fetchPrices([...pollingMints]), POLL_MS);
  }
  logger.info(`📡 Jupiter tracking: ${mint.slice(0, 8)}...`);
}

export function getJupiterPrice(mint: string): number | null {
  const entry = cache.get(mint);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > STALE_MS) {
    logger.warn(`⚠️  Jupiter price stale: ${mint.slice(0, 8)}...`);
    return null;
  }
  return entry.price;
}

/** Age (ms) of the cached price, regardless of staleness threshold — null if never fetched */
export function getJupiterPriceAgeMs(mint: string): number | null {
  const entry = cache.get(mint);
  return entry ? Date.now() - entry.fetchedAt : null;
}

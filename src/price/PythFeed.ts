import { logger } from '../utils/logger';

// Pyth Hermes REST API — SOL/USD price feed
const SOL_FEED_ID = 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';
const HERMES_URL = `https://hermes.pyth.network/v2/updates/price/latest?ids[]=${SOL_FEED_ID}`;
const POLL_MS = 1_000;
const STALE_MS = 10_000;

let solPrice: { value: number; fetchedAt: number } | null = null;
let pollTimer: NodeJS.Timeout | null = null;
let onUpdate: (() => void) | null = null;

async function fetchSolPrice(): Promise<void> {
  try {
    const res = await fetch(HERMES_URL);
    if (!res.ok) return;
    const json = (await res.json()) as any;
    const feed = json?.parsed?.[0]?.price;
    if (!feed) return;
    const price = Number(feed.price) * Math.pow(10, Number(feed.expo));
    solPrice = { value: price, fetchedAt: Date.now() };
    logger.debug(
      `[Pyth] SOL/USD — raw: ${feed.price} × 10^${feed.expo} = $${price.toFixed(4)}`,
    );
    onUpdate?.();
  } catch (err) {
    logger.warn(`Pyth SOL price fetch failed: ${err}`);
  }
}

/** onTick is invoked after every successful price refresh — used to re-run SL/TP checks on price movement alone */
export function startPythFeed(onTick?: () => void): void {
  if (onTick) onUpdate = onTick;
  if (pollTimer) return;
  void fetchSolPrice();
  pollTimer = setInterval(() => void fetchSolPrice(), POLL_MS);
  logger.info('📡 Pyth SOL/USD feed started (1s polling)');
}

export function getSolPrice(): number | null {
  if (!solPrice) return null;
  if (Date.now() - solPrice.fetchedAt > STALE_MS) {
    logger.warn('⚠️  Pyth SOL price is stale (>10s)');
    return null;
  }
  return solPrice.value;
}

/** Age (ms) of the cached price, regardless of staleness threshold — null if never fetched */
export function getSolPriceAgeMs(): number | null {
  return solPrice ? Date.now() - solPrice.fetchedAt : null;
}

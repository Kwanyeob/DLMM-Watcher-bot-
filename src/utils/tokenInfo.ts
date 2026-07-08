import { Connection, PublicKey } from '@solana/web3.js';
import { config } from '../config';
import { logger } from './logger';

export interface TokenInfo {
  symbol: string;
  decimals: number;
}

// Well-known mints — no RPC needed
const KNOWN: Record<string, TokenInfo> = {
  So11111111111111111111111111111111111111112:  { symbol: 'SOL',  decimals: 9 },
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: 'USDC', decimals: 6 },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { symbol: 'USDT', decimals: 6 },
  mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: { symbol: 'mSOL', decimals: 9 },
  J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: { symbol: 'JitoSOL', decimals: 9 },
};

const cache: Record<string, TokenInfo> = { ...KNOWN };

export async function getTokenInfo(
  mint: string,
  connection: Connection,
): Promise<TokenInfo> {
  if (cache[mint]) return cache[mint];

  try {
    // Fetch decimals from on-chain mint account (parsed JSON)
    const info = await connection.getParsedAccountInfo(new PublicKey(mint));
    const parsed = (info.value?.data as any)?.parsed?.info;
    const decimals: number = parsed?.decimals ?? 9;

    // 1st try: Jupiter token list
    let symbol = '';
    try {
      const res = await fetch(`https://lite-api.jup.ag/tokens/v1/token/${mint}`);
      if (res.ok) {
        const json = (await res.json()) as any;
        if (json?.symbol) symbol = json.symbol as string;
      }
    } catch { /* ignore */ }

    // 2nd try: Helius getAsset (reads on-chain Metaplex metadata — works for any token)
    if (!symbol) {
      try {
        const res = await fetch(config.rpcEndpoint, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            jsonrpc: '2.0',
            id:      1,
            method:  'getAsset',
            params:  { id: mint },
          }),
        });
        if (res.ok) {
          const json = (await res.json()) as any;
          const s = json?.result?.content?.metadata?.symbol as string | undefined;
          if (s) symbol = s;
        }
      } catch { /* ignore */ }
    }

    if (!symbol) symbol = mint.slice(0, 6) + '...';

    cache[mint] = { symbol, decimals };
    logger.debug(`tokenInfo: ${mint.slice(0, 8)}... → ${symbol} (${decimals} decimals)`);
    return cache[mint];
  } catch (err) {
    logger.warn(`tokenInfo fallback for ${mint.slice(0, 8)}...: ${err}`);
    const fallback: TokenInfo = { symbol: mint.slice(0, 6) + '...', decimals: 9 };
    cache[mint] = fallback;
    return fallback;
  }
}

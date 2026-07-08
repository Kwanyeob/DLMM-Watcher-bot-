import dotenv from 'dotenv';
import { Keypair } from '@solana/web3.js';
dotenv.config();

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    console.error(`[CONFIG] ❌  Missing required env var: ${key}`);
    console.error(`[CONFIG]     Copy .env.example → .env and fill in the values.`);
    process.exit(1);
  }
  return value;
}

function requireKeypair(): Keypair {
  const raw = requireEnv('WALLET_PRIVATE_KEY').trim();

  // Format 1: JSON byte array [1,2,3,...,64]
  try {
    const bytes = JSON.parse(raw);
    if (Array.isArray(bytes)) return Keypair.fromSecretKey(Uint8Array.from(bytes));
  } catch {}

  // Format 2: Base58 string (Phantom / Solflare export)
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const bs58 = require('bs58') as { decode: (s: string) => Uint8Array };
    return Keypair.fromSecretKey(bs58.decode(raw));
  } catch {}

  console.error('[CONFIG] ❌  WALLET_PRIVATE_KEY must be a JSON byte array [1,2,...] or base58 string');
  process.exit(1);
}

function optionalFloat(key: string): number | null {
  const value = process.env[key];
  if (!value) return null;
  const parsed = parseFloat(value);
  return isNaN(parsed) ? null : parsed;
}

export const config = {
  rpcEndpoint:        requireEnv('SOLANA_RPC_ENDPOINT'),
  wsEndpoint:         requireEnv('SOLANA_WS_ENDPOINT'),
  walletAddress:      requireEnv('WALLET_ADDRESS'),
  walletKeypair:      requireKeypair(),
  logLevel:           process.env.LOG_LEVEL ?? 'info',
  defaultSlPercent:   optionalFloat('DEFAULT_SL_PERCENT'),
  defaultTpPercent:   optionalFloat('DEFAULT_TP_PERCENT'),
  defaultMinRatioA:   optionalFloat('DEFAULT_MIN_RATIO_A'),
  defaultMinRatioB:   optionalFloat('DEFAULT_MIN_RATIO_B'),
  dryRun:             (process.env.DRY_RUN ?? '').toLowerCase() === 'true',
  telegramBotToken:   requireEnv('TELEGRAM_BOT_TOKEN'),
  telegramChatId:     requireEnv('TELEGRAM_CHAT_ID'),
} as const;

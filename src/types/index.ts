export interface PositionState {
  address: string;
  lbPairAddress: string;
  tokenMintA: string;       // tokenX (base)
  tokenMintB: string;       // tokenY (quote)
  tokenSymbolA: string;
  tokenSymbolB: string;
  decimalA: number;
  decimalB: number;

  // Entry snapshot (captured once at detection)
  entryAmountA: number;     // human units
  entryAmountB: number;
  entryPriceA: number;      // USD
  entryPriceB: number;      // USD
  entryTotalUsd: number;
  entryRatioA: number;      // % of total value that is tokenA
  entryRatioB: number;

  // Real-time (updated on accountSubscribe events)
  currentAmountA: number;
  currentAmountB: number;
  feeA: number;             // unclaimed fees
  feeB: number;
  lbPairPrice: number;      // current A/B ratio (human units, from lbPair)

  // Risk
  slPercent: number | null;
  tpPercent: number | null;
  minRatioA: number | null; // close when tokenA's % of position value drops below this floor
  minRatioB: number | null; // close when tokenB's % of position value drops below this floor
  isClosing: boolean;

  // Meta
  detectedAt: number;
  binIdLower: number;
  binIdUpper: number;
  binStep: number;          // fixed pool property, used for price range display
  shortId: number;          // 1-10 display index
}

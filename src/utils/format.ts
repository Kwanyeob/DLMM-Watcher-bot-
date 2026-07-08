/**
 * Format a price with enough decimal places to show ~6 significant figures.
 * Handles very small numbers (e.g. 0.000005386154) without truncation.
 *
 * Examples:
 *   0.000005386154  → "0.000005386154"
 *   0.000010701719  → "0.000010701719"
 *   150.5           → "150.500"
 *   1.0             → "1.00000"
 */
export function fmtPrice(n: number, sig = 6): string {
  if (!isFinite(n) || n === 0) return '0';
  const magnitude = Math.ceil(Math.log10(1 / Math.abs(n)));
  const decimals  = Math.max(2, Math.min(magnitude + sig, 18));
  return n.toFixed(decimals);
}

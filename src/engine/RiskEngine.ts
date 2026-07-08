import { StateDB } from '../db/StateDB';
import { PositionState } from '../types';
import { classifyQuoteToken, getQuoteTokenUsdPrice } from '../price/TieredPriceFeed';
import { logger } from '../utils/logger';
import { fmtPrice } from '../utils/format';

export type CloseReason = 'sl' | 'tp' | 'skew' | 'manual';
export type OnCloseTriggered = (pos: PositionState, reason: CloseReason) => Promise<void>;

export class RiskEngine {
  constructor(
    private readonly db: StateDB,
    private readonly onCloseTriggered: OnCloseTriggered,
  ) {}

  check(positionAddress: string): void {
    const pos = this.db.getByAddress(positionAddress);
    if (!pos || pos.isClosing) return;
    if (pos.slPercent === null && pos.tpPercent === null && pos.minRatioA === null && pos.minRatioB === null) return;

    const typeB       = classifyQuoteToken(pos.tokenMintB);
    const livePriceB  = getQuoteTokenUsdPrice(pos.tokenMintB, typeB);
    let   priceB: number;

    if (livePriceB !== null && livePriceB > 0) {
      priceB = livePriceB;
    } else if (pos.entryPriceB > 0) {
      logger.warn(
        `[#${pos.shortId}] ${pos.tokenSymbolB} price feed unavailable — ` +
        `using entry price $${pos.entryPriceB.toFixed(2)} as fallback for SL/TP check`,
      );
      priceB = pos.entryPriceB;
    } else {
      logger.warn(`[#${pos.shortId}] Price feed unavailable and no entry price — SL/TP check skipped`);
      return;
    }

    const pnl = this.calculatePnL(pos, priceB);

    if (!isFinite(pnl)) {
      logger.warn(`[#${pos.shortId}] PnL is not finite — lbPairPrice=${pos.lbPairPrice} priceB=${priceB}`);
      return;
    }

    const priceAUsd  = pos.lbPairPrice * priceB;
    const myLiqUsd   = pos.currentAmountA * priceAUsd + pos.currentAmountB * priceB;
    const feesUsd    = pos.feeA * priceAUsd + pos.feeB * priceB;
    const totalUsd   = myLiqUsd + feesUsd;
    logger.debug(
      `[RiskEngine] #${pos.shortId} ${pos.tokenSymbolA}/${pos.tokenSymbolB}\n` +
      `  Current Price  : ${fmtPrice(pos.lbPairPrice)} ${pos.tokenSymbolB}/${pos.tokenSymbolA} | ${pos.tokenSymbolB}/USD: $${priceB.toFixed(4)}\n` +
      `  My Liquidity   : $${myLiqUsd.toFixed(2)}  |  Unclaimed Fees: $${feesUsd.toFixed(2)}\n` +
      `  Total Value    : $${totalUsd.toFixed(2)}  |  Deposited Value: $${pos.entryTotalUsd.toFixed(2)}\n` +
      `  P&L            : ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%  |  SL: ${pos.slPercent !== null ? `-${pos.slPercent}%` : 'not set'}  |  TP: ${pos.tpPercent !== null ? `+${pos.tpPercent}%` : 'not set'}`,
    );

    if (pos.slPercent !== null && pnl <= -pos.slPercent) {
      logger.info(`🔴 [#${pos.shortId}] SL triggered — PnL ${pnl.toFixed(2)}% ≤ -${pos.slPercent}%`);
      void this.trigger(pos, 'sl');
    } else if (pos.tpPercent !== null && pnl >= pos.tpPercent) {
      logger.info(`🟢 [#${pos.shortId}] TP triggered — PnL ${pnl.toFixed(2)}% ≥ +${pos.tpPercent}%`);
      void this.trigger(pos, 'tp');
    } else if ((pos.minRatioA !== null || pos.minRatioB !== null) && myLiqUsd > 0) {
      const currentRatioA = (pos.currentAmountA * priceAUsd / myLiqUsd) * 100;
      const currentRatioB = 100 - currentRatioA;
      if (pos.minRatioA !== null && currentRatioA < pos.minRatioA) {
        logger.info(
          `🟡 [#${pos.shortId}] Ratio triggered — ${pos.tokenSymbolA} ${currentRatioA.toFixed(1)}% < min ${pos.minRatioA}%`,
        );
        void this.trigger(pos, 'skew');
      } else if (pos.minRatioB !== null && currentRatioB < pos.minRatioB) {
        logger.info(
          `🟡 [#${pos.shortId}] Ratio triggered — ${pos.tokenSymbolB} ${currentRatioB.toFixed(1)}% < min ${pos.minRatioB}%`,
        );
        void this.trigger(pos, 'skew');
      }
    }
  }

  calculatePnL(pos: PositionState, quotePriceUsd: number, includeFees: boolean = true): number {
    const priceA = pos.lbPairPrice * quotePriceUsd;
    const priceB = quotePriceUsd;
    const currentAssetUsd = pos.currentAmountA * priceA + pos.currentAmountB * priceB;
    const currentFeeUsd   = includeFees ? pos.feeA * priceA + pos.feeB * priceB : 0;
    const currentTotalUsd = currentAssetUsd + currentFeeUsd;
    return pos.entryTotalUsd > 0
      ? ((currentTotalUsd - pos.entryTotalUsd) / pos.entryTotalUsd) * 100
      : 0;
  }

  private async trigger(pos: PositionState, reason: CloseReason): Promise<void> {
    this.db.update(pos.address, { isClosing: true });
    try {
      await this.onCloseTriggered(pos, reason);
    } catch (err) {
      logger.error(`RiskEngine trigger failed [#${pos.shortId}]: ${err}`);
      this.db.update(pos.address, { isClosing: false });
    }
  }
}

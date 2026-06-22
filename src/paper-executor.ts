/**
 * Paper Executor
 * Simulates trade execution with virtual money.
 * Replaces the real TradeExecutor during paper trading and backtesting.
 */

import { BotConfig, ParsedTrade, CopyTradeResult, PaperTradingConfig } from './types';
import { log } from './logger';

export class PaperExecutor {
  private config: BotConfig;
  private paperConfig: PaperTradingConfig;

  constructor(config: BotConfig, paperConfig: PaperTradingConfig) {
    this.config = config;
    this.paperConfig = paperConfig;
  }

  /**
   * Calculate the copy trade size based on target's position and our multiplier.
   * (Same logic as the real executor)
   */
  calculateCopySize(targetSize: number): number {
    const raw = targetSize * this.config.positionMultiplier;
    const clamped = Math.min(Math.max(raw, this.config.minTradeSize), this.config.maxTradeSize);
    return Math.round(clamped * 100) / 100;
  }

  /**
   * Simulate executing a trade with virtual money.
   * No real orders are placed — fills are simulated based on configuration.
   */
  async executeCopyTrade(trade: ParsedTrade): Promise<CopyTradeResult> {
    const copyNotional = this.calculateCopySize(trade.size);

    // Calculate simulated fill price
    const fillPrice = this.calculateSimulatedFillPrice(trade);

    // Calculate shares from notional and price
    const copyShares = fillPrice > 0 ? copyNotional / fillPrice : 0;

    // Deduct simulated gas cost
    const gasCost = this.paperConfig.simulatedGasCost;
    const effectiveNotional = copyNotional + gasCost;

    log.info(
      `[PAPER] ${trade.side} ${copyNotional.toFixed(2)} USDC @ ${fillPrice.toFixed(4)} ` +
      `(${copyShares.toFixed(4)} shares) | Gas: $${gasCost.toFixed(2)}`,
    );

    return {
      success: true,
      orderId: `paper-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      copyNotional: effectiveNotional,
      copyShares,
      price: fillPrice,
      side: trade.side,
    };
  }

  /**
   * Calculate simulated fill price based on fill mode and slippage.
   */
  private calculateSimulatedFillPrice(trade: ParsedTrade): number {
    let basePrice: number;

    if (this.paperConfig.fillMode === 'market_price') {
      // Fill at the market price the target traded at
      basePrice = trade.price;
    } else {
      // Fill at target's price (default)
      basePrice = trade.price;
    }

    // Apply simulated slippage
    const slippageBps = this.paperConfig.simulatedSlippageBps;
    const slippageMultiplier = slippageBps / 10_000;

    const adjusted = trade.side === 'BUY'
      ? basePrice * (1 + slippageMultiplier)  // Pay more when buying
      : basePrice * (1 - slippageMultiplier); // Receive less when selling

    // Clamp to valid range
    const clamped = Math.min(Math.max(adjusted, 0.01), 0.99);
    return Math.round(clamped * 100) / 100;
  }
}

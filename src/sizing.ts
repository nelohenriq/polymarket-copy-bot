/**
 * Shared Trade Sizing Helpers
 * Single source of truth for copy-size and execution-price calculations.
 * Used by TradeExecutor, PaperExecutor, and backtest's executePaperSync.
 */

import { BotConfig } from './types';

/**
 * Calculate the copy trade notional based on the target's trade size,
 * our position multiplier, and min/max constraints.
 *
 * Formula: raw = targetSize × multiplier → clamp(min, max) → round to 2dp
 */
export function calculateCopySize(
  config: Pick<BotConfig, 'positionMultiplier' | 'minTradeSize' | 'maxTradeSize'>,
  targetSize: number,
): number {
  const raw = targetSize * config.positionMultiplier;
  const clamped = Math.min(Math.max(raw, config.minTradeSize), config.maxTradeSize);
  return Math.round(clamped * 100) / 100;
}

/**
 * Calculate the execution price with slippage tolerance.
 * For BUY: price + slippage (willing to pay more)
 * For SELL: price - slippage (willing to accept less)
 *
 * Clamped to [0.01, 0.99] and rounded to 2dp.
 */
export function calculateExecutionPrice(
  slippageTolerance: number,
  price: number,
  side: 'BUY' | 'SELL',
): number {
  const adjusted = side === 'BUY'
    ? price * (1 + slippageTolerance)
    : price * (1 - slippageTolerance);

  const clamped = Math.min(Math.max(adjusted, 0.01), 0.99);
  return Math.round(clamped * 100) / 100;
}

/**
 * Calculate simulated fill price with slippage in basis points.
 * Same logic as calculateExecutionPrice but takes bps instead of a fraction.
 */
export function calculateSimulatedFillPrice(
  slippageBps: number,
  price: number,
  side: 'BUY' | 'SELL',
): number {
  const slippageFraction = slippageBps / 10_000;
  return calculateExecutionPrice(slippageFraction, price, side);
}

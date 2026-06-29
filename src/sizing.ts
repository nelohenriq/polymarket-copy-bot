/**
 * Shared Trade Sizing Helpers
 * Single source of truth for copy-size and execution-price calculations.
 * Used by TradeExecutor, PaperExecutor, and backtest's executePaperSync.
 */

import { BotConfig, AIFilterResult } from './types';

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

/**
 * Calculate position size using Kelly Criterion.
 *
 * Kelly formula: f* = (p * b - q) / b
 * Where:
 *   p = probability of winning (AI ensemble probability)
 *   q = 1 - p (probability of losing)
 *   b = odds (potential payout / potential loss)
 *
 * In prediction markets:
 *   - Buy at price `p_buy`, win pays $1, lose = $0
 *   - b = (1 - p_buy) / p_buy (net win / cost)
 *   - f* = (prob * (1-price)/price - (1-prob)) / ((1-price)/price)
 *     = prob - price * (1-prob) / (1-price)
 *     = (prob - price) / (1 - price)  [simplified]
 *
 * We use fractional Kelly (typically 0.25-0.5) for safety.
 *
 * @param aiResult - AI filter result with ensemble probability and edge
 * @param baseNotional - Base notional from standard position sizing
 * @param kellyFraction - Fraction of full Kelly to use (0.5 = half Kelly)
 * @param maxKellyMultiplier - Cap on Kelly multiplier (e.g. 3x base notional)
 * @returns Adjusted notional size
 */
export function calculateKellySize(
  aiResult: AIFilterResult,
  baseNotional: number,
  kellyFraction: number,
  maxKellyMultiplier: number = 3,
): number {
  const prob = aiResult.ensembleProbability;
  const price = aiResult.marketPrice;

  // Cannot calculate Kelly if price is at extremes
  if (price <= 0.01 || price >= 0.99) return baseNotional;

  // Kelly fraction: f* = (prob - price) / (1 - price)
  // This is the edge divided by the odds
  const kellyF = (prob - price) / (1 - price);

  // Only scale up for positive edge (already filtered by AI, but be safe)
  if (kellyF <= 0) return baseNotional;

  // Apply fractional Kelly and confidence weighting
  const confidenceWeight = aiResult.confidence; // 0-1
  const adjustedF = kellyF * kellyFraction * confidenceWeight;

  // Scale base notional by Kelly multiplier, capped
  const multiplier = Math.min(1 + adjustedF * 2, maxKellyMultiplier);
  const kellyNotional = baseNotional * multiplier;

  return Math.round(kellyNotional * 100) / 100;
}

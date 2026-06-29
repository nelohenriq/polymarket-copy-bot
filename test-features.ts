/**
 * Unit Tests — New Features
 * ──────────────────────────────────────────────
 * Tests for Kelly criterion sizing, trailing stop-loss,
 * per-category exposure limits, and AI calibration buckets.
 *
 * Usage: npx tsx test-features.ts
 *
 * Uses Node's built-in test runner (Node >= 18).
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { calculateKellySize, calculateCopySize, calculateExecutionPrice } from './src/sizing';
import { PositionTracker } from './src/positions';
import { RiskManager } from './src/risk';
import { AITradeFilter } from './src/ai-filter';
import type { AIFilterResult, BotConfig, ParsedTrade, Position, AICalibrationRecord } from './src/types';

// Clean up temp calibration files from previous test runs
const TEMP_CALIBRATION_FILES = [
  '/tmp/test-ai-calibration-features.json',
  '/tmp/test-ai-calibration-features-2.json',
  '/tmp/test-ai-calibration-features-3.json',
  '/tmp/test-ai-calibration-features-4.json',
];
before(() => {
  for (const f of TEMP_CALIBRATION_FILES) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
});

// ──────────────────────────────────────────────
// Test Helpers
// ──────────────────────────────────────────────

function makeAiResult(overrides: Partial<AIFilterResult> = {}): AIFilterResult {
  return {
    approved: true,
    ensembleProbability: 0.70,
    marketPrice: 0.50,
    edge: 0.20,
    confidence: 0.80,
    reasoning: 'test',
    estimates: [],
    cached: false,
    latencyMs: 100,
    ...overrides,
  };
}

function makeTrade(overrides: Partial<ParsedTrade> = {}): ParsedTrade {
  return {
    id: 'test-1',
    timestamp: Date.now(),
    market: 'test-condition-id',
    tokenId: 'token-abc',
    side: 'BUY',
    size: 100,
    price: 0.50,
    user: '0xtrader',
    outcome: 'Yes',
    title: 'Test Market',
    ...overrides,
  };
}

function makeConfig(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    privateKey: '0x' + '1'.repeat(64),
    targetWallets: ['0xabc'],
    rpcUrl: 'https://polygon-rpc.com',
    positionMultiplier: 0.1,
    maxTradeSize: 100,
    minTradeSize: 1,
    orderType: 'FOK',
    slippageTolerance: 0.02,
    maxSessionNotional: 1000,
    maxPerMarketNotional: 200,
    maxPerCategoryNotional: 0,
    dailyLossLimit: 0.05,
    maxDrawdown: 0.25,
    totalLossLimit: 0.40,
    maxSessionProfit: 0,
    useWebsocket: false,
    pollInterval: 3000,
    logLevel: 'error',
    dryRun: true,
    trailingStopEnabled: false,
    trailingStopPct: 0.10,
    kellySizingEnabled: false,
    kellyFraction: 0.5,
    livePriceEnabled: false,
    livePriceIntervalMs: 60000,
    aiFeedbackEnabled: false,
    ...overrides,
  } as BotConfig;
}

// ══════════════════════════════════════════════
// Kelly Criterion Sizing Tests
// ══════════════════════════════════════════════

describe('Kelly Criterion Sizing', () => {
  it('returns base notional when price is at extremes (<= 0.01)', () => {
    const result = calculateKellySize(makeAiResult({ marketPrice: 0.01 }), 50, 0.5);
    assert.equal(result, 50);
  });

  it('returns base notional when price is at extremes (>= 0.99)', () => {
    const result = calculateKellySize(makeAiResult({ marketPrice: 0.99 }), 50, 0.5);
    assert.equal(result, 50);
  });

  it('returns base notional when edge is negative (AI prob < market price)', () => {
    // prob=0.30, price=0.50 → kellyF = (0.30-0.50)/(1-0.50) = -0.40 → negative
    const result = calculateKellySize(makeAiResult({ ensembleProbability: 0.30, marketPrice: 0.50 }), 50, 0.5);
    assert.equal(result, 50);
  });

  it('scales up when AI sees positive edge', () => {
    // prob=0.70, price=0.50 → kellyF = (0.70-0.50)/(1-0.50) = 0.40
    // confidence=0.80, fraction=0.5 → adjustedF = 0.40 * 0.5 * 0.80 = 0.16
    // multiplier = min(1 + 0.16*2, 3) = min(1.32, 3) = 1.32
    // kellyNotional = 50 * 1.32 = 66.00
    const result = calculateKellySize(makeAiResult({
      ensembleProbability: 0.70,
      marketPrice: 0.50,
      confidence: 0.80,
    }), 50, 0.5);
    assert.ok(result > 50, `Expected > 50, got ${result}`);
    assert.equal(result, 66);
  });

  it('caps at maxKellyMultiplier', () => {
    // Very high edge: prob=0.95, price=0.10 → kellyF = (0.95-0.10)/(1-0.10) = 0.944
    // confidence=1.0, fraction=1.0 → adjustedF = 0.944 * 1.0 * 1.0 = 0.944
    // multiplier = min(1 + 0.944*2, 3) = min(2.889, 3) = 2.889
    const result = calculateKellySize(makeAiResult({
      ensembleProbability: 0.95,
      marketPrice: 0.10,
      confidence: 1.0,
    }), 50, 1.0, 3);
    assert.ok(result <= 150, `Expected <= 150 (3x base), got ${result}`);
  });

  it('respects lower maxKellyMultiplier cap', () => {
    const result = calculateKellySize(makeAiResult({
      ensembleProbability: 0.90,
      marketPrice: 0.20,
      confidence: 1.0,
    }), 100, 1.0, 2);
    assert.ok(result <= 200, `Expected <= 200 (2x base), got ${result}`);
  });

  it('returns base notional with zero confidence', () => {
    const result = calculateKellySize(makeAiResult({
      ensembleProbability: 0.70,
      marketPrice: 0.50,
      confidence: 0,
    }), 50, 0.5);
    assert.equal(result, 50);
  });

  it('rounds to 2 decimal places', () => {
    const result = calculateKellySize(makeAiResult({
      ensembleProbability: 0.65,
      marketPrice: 0.50,
      confidence: 0.75,
    }), 33.33, 0.5);
    assert.equal(result, Math.round(result * 100) / 100);
  });
});

// ══════════════════════════════════════════════
// Trailing Stop-Loss Tests
// ══════════════════════════════════════════════

describe('Trailing Stop-Loss', () => {
  function makePositionTrackerWithPosition(overrides: Partial<Position> = {}): PositionTracker {
    const tracker = new PositionTracker();
    const trade = makeTrade();
    tracker.recordFill({
      trade,
      notional: 50,
      shares: 100,
      price: 0.50,
      side: 'BUY',
    });
    // Apply overrides directly
    const pos = tracker.getPosition(trade.tokenId);
    if (pos && overrides.peakPrice !== undefined) pos.peakPrice = overrides.peakPrice;
    if (pos && overrides.currentPrice !== undefined) pos.currentPrice = overrides.currentPrice;
    if (pos && overrides.category !== undefined) pos.category = overrides.category;
    return tracker;
  }

  describe('updatePeakPrice()', () => {
    it('sets peak price on first update', () => {
      const tracker = makePositionTrackerWithPosition();
      const updated = tracker.updatePeakPrice('token-abc', 0.60);
      assert.equal(updated, true);
      assert.equal(tracker.getPosition('token-abc')?.peakPrice, 0.60);
    });

    it('updates peak price when new price is higher', () => {
      const tracker = makePositionTrackerWithPosition({ peakPrice: 0.60 });
      const updated = tracker.updatePeakPrice('token-abc', 0.75);
      assert.equal(updated, true);
      assert.equal(tracker.getPosition('token-abc')?.peakPrice, 0.75);
    });

    it('does not update peak price when new price is lower', () => {
      const tracker = makePositionTrackerWithPosition({ peakPrice: 0.75 });
      const updated = tracker.updatePeakPrice('token-abc', 0.60);
      assert.equal(updated, false);
      assert.equal(tracker.getPosition('token-abc')?.peakPrice, 0.75);
    });

    it('returns false for non-existent position', () => {
      const tracker = new PositionTracker();
      const updated = tracker.updatePeakPrice('nonexistent', 0.60);
      assert.equal(updated, false);
    });
  });

  describe('updateCurrentPrice()', () => {
    it('sets current price and updates peak', () => {
      const tracker = makePositionTrackerWithPosition();
      tracker.updateCurrentPrice('token-abc', 0.65);
      const pos = tracker.getPosition('token-abc');
      assert.equal(pos?.currentPrice, 0.65);
      assert.equal(pos?.peakPrice, 0.65);
    });

    it('updates peak when current price exceeds existing peak', () => {
      const tracker = makePositionTrackerWithPosition({ peakPrice: 0.60 });
      tracker.updateCurrentPrice('token-abc', 0.70);
      const pos = tracker.getPosition('token-abc');
      assert.equal(pos?.currentPrice, 0.70);
      assert.equal(pos?.peakPrice, 0.70);
    });

    it('does not lower peak when current price drops', () => {
      const tracker = makePositionTrackerWithPosition({ peakPrice: 0.80 });
      tracker.updateCurrentPrice('token-abc', 0.60);
      const pos = tracker.getPosition('token-abc');
      assert.equal(pos?.currentPrice, 0.60);
      assert.equal(pos?.peakPrice, 0.80);
    });
  });

  describe('getTrailingStopTriggers()', () => {
    it('returns empty when no positions have peak/current prices', () => {
      const tracker = makePositionTrackerWithPosition();
      const triggers = tracker.getTrailingStopTriggers(0.10);
      assert.equal(triggers.length, 0);
    });

    it('returns empty when price is above stop threshold', () => {
      // peak=0.80, current=0.75, stopPct=0.10 → stopPrice = 0.80 * 0.90 = 0.72
      // 0.75 > 0.72 → no trigger
      const tracker = makePositionTrackerWithPosition({ peakPrice: 0.80, currentPrice: 0.75 });
      const triggers = tracker.getTrailingStopTriggers(0.10);
      assert.equal(triggers.length, 0);
    });

    it('triggers when price drops below stop threshold', () => {
      // peak=0.80, current=0.70, stopPct=0.10 → stopPrice = 0.80 * 0.90 = 0.72
      // 0.70 <= 0.72 → trigger!
      const tracker = makePositionTrackerWithPosition({ peakPrice: 0.80, currentPrice: 0.70 });
      const triggers = tracker.getTrailingStopTriggers(0.10);
      assert.equal(triggers.length, 1);
      assert.equal(triggers[0].tokenId, 'token-abc');
    });

    it('triggers exactly at stop threshold', () => {
      // peak=1.00, current=0.90, stopPct=0.10 → stopPrice = 0.90
      const tracker = makePositionTrackerWithPosition({ peakPrice: 1.00, currentPrice: 0.90 });
      const triggers = tracker.getTrailingStopTriggers(0.10);
      assert.equal(triggers.length, 1);
    });

    it('does not trigger for closed positions (shares = 0)', () => {
      const tracker = makePositionTrackerWithPosition({ peakPrice: 0.80, currentPrice: 0.50 });
      // Sell all shares
      tracker.recordFill({
        trade: makeTrade({ side: 'SELL' }),
        notional: 50,
        shares: 100,
        price: 0.50,
        side: 'SELL',
      });
      const triggers = tracker.getTrailingStopTriggers(0.10);
      assert.equal(triggers.length, 0);
    });

    it('uses 20% stop correctly', () => {
      // peak=0.80, stopPct=0.20 → stopPrice = 0.80 * 0.80 = 0.64
      // current=0.65 → no trigger (0.65 > 0.64)
      const tracker = makePositionTrackerWithPosition({ peakPrice: 0.80, currentPrice: 0.65 });
      assert.equal(tracker.getTrailingStopTriggers(0.20).length, 0);

      // current=0.63 → trigger (0.63 <= 0.64)
      tracker.updateCurrentPrice('token-abc', 0.63);
      assert.equal(tracker.getTrailingStopTriggers(0.20).length, 1);
    });
  });

  describe('getUnrealizedPnl()', () => {
    it('returns 0 when no current prices set', () => {
      const tracker = makePositionTrackerWithPosition();
      assert.equal(tracker.getUnrealizedPnl(), 0);
    });

    it('calculates positive unrealized P&L', () => {
      // avgPrice=0.50, currentPrice=0.70, shares=100 → P&L = (0.70-0.50)*100 = 20
      const tracker = makePositionTrackerWithPosition({ currentPrice: 0.70 });
      assert.ok(Math.abs(tracker.getUnrealizedPnl() - 20) < 0.01, `Expected ~20, got ${tracker.getUnrealizedPnl()}`);
    });

    it('calculates negative unrealized P&L', () => {
      // avgPrice=0.50, currentPrice=0.30, shares=100 → P&L = (0.30-0.50)*100 = -20
      const tracker = makePositionTrackerWithPosition({ currentPrice: 0.30 });
      assert.equal(tracker.getUnrealizedPnl(), -20);
    });
  });
});

// ══════════════════════════════════════════════
// Per-Category Exposure Limits Tests
// ══════════════════════════════════════════════

describe('Per-Category Exposure Limits', () => {
  describe('PositionTracker.getCategoryNotionals()', () => {
    it('returns empty map when no categories set', () => {
      const tracker = new PositionTracker();
      tracker.recordFill({ trade: makeTrade(), notional: 50, shares: 100, price: 0.50, side: 'BUY' });
      const cats = tracker.getCategoryNotionals();
      assert.equal(cats.size, 0);
    });

    it('groups notional by category', () => {
      const tracker = new PositionTracker();
      // Position 1: crypto
      tracker.recordFill({
        trade: makeTrade({ tokenId: 'tok-1', category: 'crypto' }),
        notional: 50, shares: 100, price: 0.50, side: 'BUY',
      });
      // Position 2: crypto
      tracker.recordFill({
        trade: makeTrade({ tokenId: 'tok-2', category: 'crypto' }),
        notional: 30, shares: 60, price: 0.50, side: 'BUY',
      });
      // Position 3: politics
      tracker.recordFill({
        trade: makeTrade({ tokenId: 'tok-3', category: 'politics' }),
        notional: 40, shares: 80, price: 0.50, side: 'BUY',
      });

      const cats = tracker.getCategoryNotionals();
      assert.equal(cats.get('crypto'), 80);
      assert.equal(cats.get('politics'), 40);
    });

    it('excludes closed positions (shares = 0)', () => {
      const tracker = new PositionTracker();
      tracker.recordFill({
        trade: makeTrade({ tokenId: 'tok-1', category: 'crypto' }),
        notional: 50, shares: 100, price: 0.50, side: 'BUY',
      });
      // Close the position
      tracker.recordFill({
        trade: makeTrade({ tokenId: 'tok-1', category: 'crypto', side: 'SELL' }),
        notional: 50, shares: 100, price: 0.50, side: 'SELL',
      });

      const cats = tracker.getCategoryNotionals();
      assert.equal(cats.get('crypto'), undefined);
    });
  });

  describe('RiskManager Gate 4b: per-category cap', () => {
    it('allows trade when category limit is disabled (0)', () => {
      const positions = new PositionTracker();
      const config = makeConfig({ maxPerCategoryNotional: 0 });
      const risk = new RiskManager(config, positions);

      const trade = makeTrade({ category: 'crypto' });
      const result = risk.checkTrade(trade, 50);
      assert.equal(result.allowed, true);
    });

    it('allows trade under category limit', () => {
      const positions = new PositionTracker();
      // Existing position: 100 notional in crypto
      positions.recordFill({
        trade: makeTrade({ tokenId: 'tok-1', category: 'crypto' }),
        notional: 100, shares: 200, price: 0.50, side: 'BUY',
      });

      const config = makeConfig({ maxPerCategoryNotional: 300 });
      const risk = new RiskManager(config, positions);

      const trade = makeTrade({ category: 'crypto' });
      // 100 existing + 50 new = 150 < 300 → allowed
      const result = risk.checkTrade(trade, 50);
      assert.equal(result.allowed, true);
    });

    it('blocks trade exceeding category limit', () => {
      const positions = new PositionTracker();
      // Existing position: 250 notional in crypto
      positions.recordFill({
        trade: makeTrade({ tokenId: 'tok-1', category: 'crypto' }),
        notional: 250, shares: 500, price: 0.50, side: 'BUY',
      });

      const config = makeConfig({ maxPerCategoryNotional: 300 });
      const risk = new RiskManager(config, positions);

      const trade = makeTrade({ category: 'crypto' });
      // 250 existing + 100 new = 350 > 300 → blocked
      const result = risk.checkTrade(trade, 100);
      assert.equal(result.allowed, false);
      assert.ok(result.reason?.includes('crypto'));
      assert.ok(result.reason?.includes('$350'));
    });

    it('skips category check when trade has no category', () => {
      const positions = new PositionTracker();
      const config = makeConfig({ maxPerCategoryNotional: 10 });
      const risk = new RiskManager(config, positions);

      const trade = makeTrade({ category: undefined });
      // Even with a very low limit, trades without category bypass the check
      const result = risk.checkTrade(trade, 50);
      assert.equal(result.allowed, true);
    });

    it('tracks categories independently', () => {
      const positions = new PositionTracker();
      // Fill crypto to near limit
      positions.recordFill({
        trade: makeTrade({ tokenId: 'tok-1', category: 'crypto' }),
        notional: 280, shares: 560, price: 0.50, side: 'BUY',
      });

      const config = makeConfig({ maxPerCategoryNotional: 300 });
      const risk = new RiskManager(config, positions);

      // Crypto trade blocked (280 + 50 = 330 > 300)
      const cryptoTrade = makeTrade({ category: 'crypto' });
      assert.equal(risk.checkTrade(cryptoTrade, 50).allowed, false);

      // Politics trade allowed (0 + 50 = 50 < 300)
      const politicsTrade = makeTrade({ category: 'politics' });
      assert.equal(risk.checkTrade(politicsTrade, 50).allowed, true);
    });
  });
});

// ══════════════════════════════════════════════
// AI Calibration Tests
// ══════════════════════════════════════════════

describe('AI Calibration', () => {
  it('AITradeFilter can be instantiated', () => {
    const filter = new AITradeFilter({
      enabled: true,
      provider: 'openai',
      apiKey: 'test-key',
      model: 'test-model',
      minConfidence: 0.6,
      minEdge: 0.05,
      cacheMinutes: 15,
      maxCallsPerMinute: 10,
      timeoutSeconds: 30,
      failOpen: true,
    });
    assert.ok(filter);
  });

  it('getCalibrationContext returns null when feedback disabled', () => {
    const filter = new AITradeFilter({
      enabled: true,
      provider: 'openai',
      apiKey: 'test-key',
      model: 'test-model',
      minConfidence: 0.6,
      minEdge: 0.05,
      cacheMinutes: 15,
      maxCallsPerMinute: 10,
      timeoutSeconds: 30,
      failOpen: true,
    });
    assert.equal(filter.getCalibrationContext(), null);
  });

  it('getCalibrationContext returns null with fewer than 5 records', () => {
    const filter = new AITradeFilter({
      enabled: true,
      provider: 'openai',
      apiKey: 'test-key',
      model: 'test-model',
      minConfidence: 0.6,
      minEdge: 0.05,
      cacheMinutes: 15,
      maxCallsPerMinute: 10,
      timeoutSeconds: 30,
      failOpen: true,
    });
    // Enable with a temp file
    filter.enableFeedback('/tmp/test-ai-calibration-features.json');

    // Add only 3 records
    for (let i = 0; i < 3; i++) {
      filter.addFeedbackRecord({
        probability: 0.70,
        confidence: 0.80,
        actualOutcome: 1,
        timestamp: Date.now(),
      });
    }
    assert.equal(filter.getCalibrationContext(), null);
  });

  it('getCalibrationContext returns text with 5+ records', () => {
    const filter = new AITradeFilter({
      enabled: true,
      provider: 'openai',
      apiKey: 'test-key',
      model: 'test-model',
      minConfidence: 0.6,
      minEdge: 0.05,
      cacheMinutes: 15,
      maxCallsPerMinute: 10,
      timeoutSeconds: 30,
      failOpen: true,
    });
    filter.enableFeedback('/tmp/test-ai-calibration-features-2.json');

    // Add 6 records in the 60-70% bucket, all winning
    for (let i = 0; i < 6; i++) {
      filter.addFeedbackRecord({
        probability: 0.65,
        confidence: 0.80,
        actualOutcome: 1,
        timestamp: Date.now(),
      });
    }

    const ctx = filter.getCalibrationContext();
    assert.ok(ctx !== null);
    assert.ok(ctx!.includes('Historical Calibration'));
    assert.ok(ctx!.includes('60-70%'));
  });

  it('getCalibrationStats returns correct structure', () => {
    const filter = new AITradeFilter({
      enabled: true,
      provider: 'openai',
      apiKey: 'test-key',
      model: 'test-model',
      minConfidence: 0.6,
      minEdge: 0.05,
      cacheMinutes: 15,
      maxCallsPerMinute: 10,
      timeoutSeconds: 30,
      failOpen: true,
    });
    filter.enableFeedback('/tmp/test-ai-calibration-features-3.json');

    // Add records in different buckets
    for (let i = 0; i < 3; i++) {
      filter.addFeedbackRecord({ probability: 0.65, confidence: 0.80, actualOutcome: 1, timestamp: Date.now() });
    }
    for (let i = 0; i < 3; i++) {
      filter.addFeedbackRecord({ probability: 0.85, confidence: 0.90, actualOutcome: 0, timestamp: Date.now(), category: 'crypto' });
    }

    const stats = filter.getCalibrationStats();
    assert.ok(stats !== null);
    assert.equal(stats!.totalPredictions, 6);
    assert.ok(stats!.buckets.length > 0);
  });

  it('addFeedbackRecord caps at 500 records', () => {
    const filter = new AITradeFilter({
      enabled: true,
      provider: 'openai',
      apiKey: 'test-key',
      model: 'test-model',
      minConfidence: 0.6,
      minEdge: 0.05,
      cacheMinutes: 15,
      maxCallsPerMinute: 10,
      timeoutSeconds: 30,
      failOpen: true,
    });
    filter.enableFeedback('/tmp/test-ai-calibration-features-4.json');

    // Add 510 records
    for (let i = 0; i < 510; i++) {
      filter.addFeedbackRecord({
        probability: 0.50 + (i % 50) / 100,
        confidence: 0.80,
        actualOutcome: i % 2,
        timestamp: Date.now(),
      });
    }

    const stats = filter.getCalibrationStats();
    assert.ok(stats !== null);
    assert.equal(stats!.totalPredictions, 500);
  });
});

// ══════════════════════════════════════════════
// Existing Sizing Functions (regression tests)
// ══════════════════════════════════════════════

describe('Sizing (regression)', () => {
  it('calculateCopySize applies multiplier correctly', () => {
    const config = { positionMultiplier: 0.1, minTradeSize: 1, maxTradeSize: 100 };
    assert.equal(calculateCopySize(config, 500), 50);
  });

  it('calculateCopySize clamps to min', () => {
    const config = { positionMultiplier: 0.01, minTradeSize: 5, maxTradeSize: 100 };
    assert.equal(calculateCopySize(config, 100), 5); // raw=1, clamped to 5
  });

  it('calculateCopySize clamps to max', () => {
    const config = { positionMultiplier: 0.5, minTradeSize: 1, maxTradeSize: 50 };
    assert.equal(calculateCopySize(config, 500), 50); // raw=250, clamped to 50
  });

  it('calculateExecutionPrice BUY adds slippage', () => {
    const price = calculateExecutionPrice(0.02, 0.50, 'BUY');
    assert.equal(price, 0.51); // 0.50 * 1.02 = 0.51
  });

  it('calculateExecutionPrice SELL subtracts slippage', () => {
    const price = calculateExecutionPrice(0.02, 0.50, 'SELL');
    assert.equal(price, 0.49); // 0.50 * 0.98 = 0.49
  });
});

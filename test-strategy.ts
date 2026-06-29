/**
 * Unit Tests — Multi-Strategy Architecture
 * ──────────────────────────────────────────────
 * Tests for StrategyRunner (risk isolation, config merging, fill tracking)
 * and StrategyRouter (routing logic, SELL fallback, dual-tracking).
 *
 * Usage: npx tsx test-strategy.ts
 *
 * Uses Node's built-in test runner (Node >= 18).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StrategyRunner, StrategyRouter } from './src/strategy';
import { PositionTracker } from './src/positions';
import { RiskManager } from './src/risk';
import type { BotConfig, ParsedTrade, StrategyConfig, Position, RiskState } from './src/types';

// ──────────────────────────────────────────────
// Test Helpers
// ──────────────────────────────────────────────

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

function makeStrategy(overrides: Partial<StrategyConfig> = {}): StrategyConfig {
  return {
    name: 'test-strategy',
    enabled: true,
    routing: { isDefault: true },
    ...overrides,
  };
}

// ══════════════════════════════════════════════
// StrategyRunner Tests
// ══════════════════════════════════════════════

describe('StrategyRunner', () => {
  describe('constructor — config merging', () => {
    it('inherits global config when no overrides', () => {
      const global = makeConfig({ maxSessionNotional: 500, maxTradeSize: 80 });
      const runner = new StrategyRunner(makeStrategy(), global);
      const ec = runner.getEffectiveConfig();
      assert.equal(ec.maxSessionNotional, 500);
      assert.equal(ec.maxTradeSize, 80);
      assert.equal(ec.positionMultiplier, 0.1);
    });

    it('overrides risk limits from strategy config', () => {
      const global = makeConfig({ maxSessionNotional: 1000, maxTradeSize: 100 });
      const runner = new StrategyRunner(makeStrategy({
        maxSessionNotional: 5000,
        maxTradeSize: 200,
      }), global);
      const ec = runner.getEffectiveConfig();
      assert.equal(ec.maxSessionNotional, 5000);
      assert.equal(ec.maxTradeSize, 200);
      // Non-overridden fields keep global values
      assert.equal(ec.positionMultiplier, 0.1);
    });

    it('overrides sizing parameters from strategy config', () => {
      const global = makeConfig({ positionMultiplier: 0.1, kellyFraction: 0.5 });
      const runner = new StrategyRunner(makeStrategy({
        positionMultiplier: 0.25,
        kellyFraction: 0.75,
      }), global);
      const ec = runner.getEffectiveConfig();
      assert.equal(ec.positionMultiplier, 0.25);
      assert.equal(ec.kellyFraction, 0.75);
    });

    it('strategy config does not mutate global config', () => {
      const global = makeConfig({ maxSessionNotional: 1000 });
      const runner = new StrategyRunner(makeStrategy({ maxSessionNotional: 5000 }), global);
      assert.equal(global.maxSessionNotional, 1000);
      assert.equal(runner.getEffectiveConfig().maxSessionNotional, 5000);
    });
  });

  describe('risk isolation', () => {
    it('checkTrade uses strategy-specific limits, not global', () => {
      const global = makeConfig({ maxSessionNotional: 1000 });
      const runner = new StrategyRunner(makeStrategy({ maxSessionNotional: 50 }), global);

      // Fill to 40 notional
      runner.recordFill({
        trade: makeTrade({ tokenId: 'tok-1' }),
        notional: 40, shares: 80, price: 0.50, side: 'BUY',
      });

      // 40 existing + 20 new = 60 > 50 strategy limit → blocked
      const trade = makeTrade({ tokenId: 'tok-2' });
      const result = runner.checkTrade(trade, 20);
      assert.equal(result.allowed, false);
      assert.ok(result.reason?.includes('50'));
    });

    it('separate runners have independent risk budgets', () => {
      const global = makeConfig({ maxSessionNotional: 500 });
      const aggressive = new StrategyRunner(makeStrategy({
        name: 'aggressive',
        maxSessionNotional: 1000,
      }), global);
      const conservative = new StrategyRunner(makeStrategy({
        name: 'conservative',
        maxSessionNotional: 100,
      }), global);

      // Fill aggressive to 500 notional
      for (let i = 0; i < 5; i++) {
        aggressive.recordFill({
          trade: makeTrade({ tokenId: `tok-a-${i}` }),
          notional: 100, shares: 200, price: 0.50, side: 'BUY',
        });
      }

      // Aggressive still has room (500 < 1000)
      assert.equal(aggressive.checkTrade(makeTrade(), 100).allowed, true);

      // Conservative is still empty (0 < 100)
      assert.equal(conservative.checkTrade(makeTrade(), 50).allowed, true);

      // Fill conservative to near limit
      conservative.recordFill({
        trade: makeTrade({ tokenId: 'tok-c-1' }),
        notional: 80, shares: 160, price: 0.50, side: 'BUY',
      });

      // 80 + 50 = 130 > 100 → blocked
      assert.equal(conservative.checkTrade(makeTrade(), 50).allowed, false);
    });
  });

  describe('recordFill and recordExit', () => {
    it('recordFill updates position tracker and stats', () => {
      const runner = new StrategyRunner(makeStrategy(), makeConfig());
      const trade = makeTrade({ tokenId: 'tok-1' });

      runner.recordFill({ trade, notional: 50, shares: 100, price: 0.50, side: 'BUY' });

      assert.equal(runner.getPositions().getPosition('tok-1')?.shares, 100);
      assert.equal(runner.getPositions().getNotional('tok-1'), 50);
      assert.equal(runner.getState().openPositions, 1);
      assert.equal(runner.getState().sessionNotional, 50);
    });

    it('recordExit updates position tracker, frees notional, and records P&L', () => {
      const runner = new StrategyRunner(makeStrategy(), makeConfig());
      const buyTrade = makeTrade({ tokenId: 'tok-1', side: 'BUY' });
      const sellTrade = makeTrade({ tokenId: 'tok-1', side: 'SELL' });

      runner.recordFill({ trade: buyTrade, notional: 50, shares: 100, price: 0.50, side: 'BUY' });
      runner.recordExit(sellTrade, 0.50, 100, 0.70, 20);

      // Position should have 0 shares
      assert.equal(runner.getPositions().getPosition('tok-1')?.shares, 0);
      // Notional should be freed
      assert.equal(runner.getState().sessionNotional, 0);
      // P&L should be recorded
      assert.equal(runner.getState().sessionPnl, 20);
      // Open positions should decrease
      assert.equal(runner.getState().openPositions, 0);
    });

    it('recordExit with loss records negative P&L', () => {
      const runner = new StrategyRunner(makeStrategy(), makeConfig());
      const buyTrade = makeTrade({ tokenId: 'tok-1', side: 'BUY' });
      const sellTrade = makeTrade({ tokenId: 'tok-1', side: 'SELL' });

      runner.recordFill({ trade: buyTrade, notional: 50, shares: 100, price: 0.50, side: 'BUY' });
      runner.recordExit(sellTrade, 0.50, 100, 0.30, -20);

      assert.equal(runner.getState().sessionPnl, -20);
    });
  });

  describe('stats tracking', () => {
    it('trackRouted increments routed count', () => {
      const runner = new StrategyRunner(makeStrategy(), makeConfig());
      runner.trackRouted();
      runner.trackRouted();
      assert.equal(runner.getState().tradesRouted, 2);
    });

    it('trackExecuted increments executed count and volume', () => {
      const runner = new StrategyRunner(makeStrategy(), makeConfig());
      runner.trackExecuted(100);
      runner.trackExecuted(200);
      const state = runner.getState();
      assert.equal(state.tradesExecuted, 2);
      assert.equal(state.totalVolume, 300);
    });

    it('trackBlocked increments blocked count', () => {
      const runner = new StrategyRunner(makeStrategy(), makeConfig());
      runner.trackBlocked();
      assert.equal(runner.getState().tradesBlocked, 1);
    });
  });

  describe('evaluateAI', () => {
    it('returns null when no AI filter configured', async () => {
      const runner = new StrategyRunner(makeStrategy(), makeConfig());
      const result = await runner.evaluateAI(makeTrade());
      assert.equal(result, null);
    });
  });

  describe('restoreState', () => {
    it('restores positions from persisted state', () => {
      const runner = new StrategyRunner(makeStrategy(), makeConfig());
      const positions: Position[] = [{
        tokenId: 'tok-1',
        market: 'mkt-1',
        outcome: 'Yes',
        shares: 100,
        notional: 50,
        avgPrice: 0.50,
        lastUpdated: Date.now(),
      }];
      runner.restoreState(positions, {});
      assert.equal(runner.getPositions().getPosition('tok-1')?.shares, 100);
      assert.equal(runner.getState().openPositions, 1);
    });

    it('restores risk state from persisted data', () => {
      const runner = new StrategyRunner(makeStrategy(), makeConfig());
      runner.restoreState([], { sessionPnl: 42, peakCapital: 50 });
      const state = runner.getState();
      assert.equal(state.sessionPnl, 42);
    });
  });
});

// ══════════════════════════════════════════════
// StrategyRouter Tests
// ══════════════════════════════════════════════

describe('StrategyRouter', () => {
  describe('routeBuy — category matching', () => {
    it('routes trade to strategy matching by category', () => {
      const global = makeConfig();
      const crypto = new StrategyRunner(makeStrategy({
        name: 'crypto', routing: { categories: ['crypto'] },
      }), global);
      const politics = new StrategyRunner(makeStrategy({
        name: 'politics', routing: { categories: ['politics'] },
      }), global);

      const router = new StrategyRouter([crypto, politics]);

      assert.equal(router.routeBuy(makeTrade({ category: 'crypto' }))?.name, 'crypto');
      assert.equal(router.routeBuy(makeTrade({ category: 'politics' }))?.name, 'politics');
    });

    it('falls back to default when no category matches', () => {
      const global = makeConfig();
      const crypto = new StrategyRunner(makeStrategy({
        name: 'crypto', routing: { categories: ['crypto'] },
      }), global);
      const fallback = new StrategyRunner(makeStrategy({
        name: 'fallback', routing: { isDefault: true },
      }), global);

      const router = new StrategyRouter([crypto, fallback]);
      assert.equal(router.routeBuy(makeTrade({ category: 'sports' }))?.name, 'fallback');
    });

    it('returns null when no match and no default', () => {
      const global = makeConfig();
      const crypto = new StrategyRunner(makeStrategy({
        name: 'crypto', routing: { categories: ['crypto'] },
      }), global);

      const router = new StrategyRouter([crypto]);
      assert.equal(router.routeBuy(makeTrade({ category: 'sports' })), null);
    });
  });

  describe('routeBuy — trader matching', () => {
    it('routes trade to strategy matching by trader wallet', () => {
      const global = makeConfig();
      const whale = new StrategyRunner(makeStrategy({
        name: 'whale', routing: { traders: ['0xwhale'] },
      }), global);
      const fallback = new StrategyRunner(makeStrategy({
        name: 'fallback', routing: { isDefault: true },
      }), global);

      const router = new StrategyRouter([whale, fallback]);
      assert.equal(router.routeBuy(makeTrade({ user: '0xwhale' }))?.name, 'whale');
      assert.equal(router.routeBuy(makeTrade({ user: '0xother' }))?.name, 'fallback');
    });
  });

  describe('routeBuy — slug matching', () => {
    it('routes trade to strategy matching by market slug', () => {
      const global = makeConfig();
      const trump = new StrategyRunner(makeStrategy({
        name: 'trump-bets', routing: { marketSlugs: ['trump', 'election'] },
      }), global);
      const fallback = new StrategyRunner(makeStrategy({
        name: 'fallback', routing: { isDefault: true },
      }), global);

      const router = new StrategyRouter([trump, fallback]);
      assert.equal(router.routeBuy(makeTrade({ slug: 'trump-2024-winner' }))?.name, 'trump-bets');
      assert.equal(router.routeBuy(makeTrade({ slug: 'bitcoin-price' }))?.name, 'fallback');
    });
  });

  describe('routeBuy — priority', () => {
    it('first matching strategy wins when rules overlap', () => {
      const global = makeConfig();
      const first = new StrategyRunner(makeStrategy({
        name: 'first', routing: { categories: ['crypto'] },
      }), global);
      const second = new StrategyRunner(makeStrategy({
        name: 'second', routing: { categories: ['crypto'] },
      }), global);

      const router = new StrategyRouter([first, second]);
      assert.equal(router.routeBuy(makeTrade({ category: 'crypto' }))?.name, 'first');
    });

    it('skips disabled strategies', () => {
      const global = makeConfig();
      const disabled = new StrategyRunner(makeStrategy({
        name: 'disabled', enabled: false, routing: { categories: ['crypto'] },
      }), global);
      const fallback = new StrategyRunner(makeStrategy({
        name: 'fallback', routing: { isDefault: true },
      }), global);

      const router = new StrategyRouter([disabled, fallback]);
      assert.equal(router.routeBuy(makeTrade({ category: 'crypto' }))?.name, 'fallback');
    });
  });

  describe('routeSell — position ownership', () => {
    it('routes SELL to the strategy that owns the position', () => {
      const global = makeConfig();
      const crypto = new StrategyRunner(makeStrategy({
        name: 'crypto', routing: { categories: ['crypto'] },
      }), global);
      const politics = new StrategyRunner(makeStrategy({
        name: 'politics', routing: { categories: ['politics'] },
      }), global);

      // Fill position in crypto strategy
      crypto.recordFill({
        trade: makeTrade({ tokenId: 'tok-1', category: 'crypto' }),
        notional: 50, shares: 100, price: 0.50, side: 'BUY',
      });

      const router = new StrategyRouter([crypto, politics]);
      assert.equal(router.routeSell('tok-1')?.name, 'crypto');
    });

    it('does not route SELL to wrong strategy', () => {
      const global = makeConfig();
      const crypto = new StrategyRunner(makeStrategy({
        name: 'crypto', routing: { categories: ['crypto'] },
      }), global);
      const politics = new StrategyRunner(makeStrategy({
        name: 'politics', routing: { categories: ['politics'] },
      }), global);

      crypto.recordFill({
        trade: makeTrade({ tokenId: 'tok-1', category: 'crypto' }),
        notional: 50, shares: 100, price: 0.50, side: 'BUY',
      });

      const router = new StrategyRouter([crypto, politics]);
      // tok-2 is not owned by any strategy
      assert.notEqual(router.routeSell('tok-2')?.name, 'crypto');
      assert.notEqual(router.routeSell('tok-2')?.name, 'politics');
    });
  });

  describe('routeSell — fallback for orphaned positions', () => {
    it('falls back to default strategy for orphaned SELL', () => {
      const global = makeConfig();
      const crypto = new StrategyRunner(makeStrategy({
        name: 'crypto', routing: { categories: ['crypto'] },
      }), global);
      const fallback = new StrategyRunner(makeStrategy({
        name: 'fallback', routing: { isDefault: true },
      }), global);

      const router = new StrategyRouter([crypto, fallback]);
      // No strategy owns tok-orphan
      assert.equal(router.routeSell('tok-orphan')?.name, 'fallback');
    });

    it('returns null for orphaned SELL when no default', () => {
      const global = makeConfig();
      const crypto = new StrategyRunner(makeStrategy({
        name: 'crypto', routing: { categories: ['crypto'] },
      }), global);

      const router = new StrategyRouter([crypto]);
      assert.equal(router.routeSell('tok-orphan'), null);
    });

    it('ignores closed positions (shares = 0) for SELL routing', () => {
      const global = makeConfig();
      const crypto = new StrategyRunner(makeStrategy({
        name: 'crypto', routing: { categories: ['crypto'] },
      }), global);
      const fallback = new StrategyRunner(makeStrategy({
        name: 'fallback', routing: { isDefault: true },
      }), global);

      // Fill then close position
      const buyTrade = makeTrade({ tokenId: 'tok-1', category: 'crypto', side: 'BUY' });
      const sellTrade = makeTrade({ tokenId: 'tok-1', category: 'crypto', side: 'SELL' });
      crypto.recordFill({ trade: buyTrade, notional: 50, shares: 100, price: 0.50, side: 'BUY' });
      crypto.recordExit(sellTrade, 0.50, 100, 0.70, 20);

      const router = new StrategyRouter([crypto, fallback]);
      // Position is closed — should fall back to default
      assert.equal(router.routeSell('tok-1')?.name, 'fallback');
    });
  });

  describe('getAll', () => {
    it('returns all strategy runners', () => {
      const global = makeConfig();
      const a = new StrategyRunner(makeStrategy({ name: 'a' }), global);
      const b = new StrategyRunner(makeStrategy({ name: 'b' }), global);

      const router = new StrategyRouter([a, b]);
      assert.equal(router.getAll().length, 2);
      assert.equal(router.getAll()[0].name, 'a');
      assert.equal(router.getAll()[1].name, 'b');
    });
  });
});

// ══════════════════════════════════════════════
// Dual-Tracking Verification Tests
// ══════════════════════════════════════════════

describe('Dual-Tracking (Strategy + Global)', () => {
  it('strategy and global trackers are independent instances', () => {
    const global = makeConfig();
    const runner = new StrategyRunner(makeStrategy(), global);

    // They should be different objects
    assert.notEqual(runner.getPositions(), new PositionTracker());
  });

  it('filling strategy tracker does not affect a separate global tracker', () => {
    const global = makeConfig();
    const runner = new StrategyRunner(makeStrategy(), global);
    const globalPositions = new PositionTracker();

    runner.recordFill({
      trade: makeTrade({ tokenId: 'tok-1' }),
      notional: 50, shares: 100, price: 0.50, side: 'BUY',
    });

    // Strategy tracker has the position
    assert.equal(runner.getPositions().getPosition('tok-1')?.shares, 100);
    // Global tracker (separate instance) does not
    assert.equal(globalPositions.getPosition('tok-1'), undefined);
  });

  it('simulating dual-tracking: both strategy and global updated on BUY', () => {
    const global = makeConfig();
    const runner = new StrategyRunner(makeStrategy(), global);
    const globalPositions = new PositionTracker();
    const globalRisk = new RiskManager(global, globalPositions);

    const trade = makeTrade({ tokenId: 'tok-1' });
    const notional = 50;
    const shares = 100;

    // Simulate what executeForStrategy does: update both trackers
    runner.recordFill({ trade, notional, shares, price: 0.50, side: 'BUY' });
    globalPositions.recordFill({ trade, notional, shares, price: 0.50, side: 'BUY' });
    globalRisk.recordFill({ trade, notional, shares, price: 0.50, side: 'BUY' });

    // Both should have the position
    assert.equal(runner.getPositions().getPosition('tok-1')?.shares, 100);
    assert.equal(globalPositions.getPosition('tok-1')?.shares, 100);

    // Both should track notional
    assert.equal(runner.getState().sessionNotional, 50);
    assert.equal(globalRisk.getState().sessionNotional, 50);
  });

  it('simulating dual-tracking: both updated on SELL exit', () => {
    const global = makeConfig();
    const runner = new StrategyRunner(makeStrategy(), global);
    const globalPositions = new PositionTracker();
    const globalRisk = new RiskManager(global, globalPositions);

    const buyTrade = makeTrade({ tokenId: 'tok-1', side: 'BUY' });
    const sellTrade = makeTrade({ tokenId: 'tok-1', side: 'SELL' });

    // BUY on both
    runner.recordFill({ trade: buyTrade, notional: 50, shares: 100, price: 0.50, side: 'BUY' });
    globalPositions.recordFill({ trade: buyTrade, notional: 50, shares: 100, price: 0.50, side: 'BUY' });
    globalRisk.recordFill({ trade: buyTrade, notional: 50, shares: 100, price: 0.50, side: 'BUY' });

    // SELL on both (simulating what index.ts does)
    runner.recordExit(sellTrade, 0.50, 100, 0.70, 20);
    globalPositions.recordFill({ trade: sellTrade, notional: 70, shares: 100, price: 0.70, side: 'SELL' });
    globalRisk.reduceSessionNotional(50);
    globalRisk.addSessionPnl(20);

    // Both should show 0 open positions
    assert.equal(runner.getPositions().getPosition('tok-1')?.shares, 0);
    assert.equal(globalPositions.getPosition('tok-1')?.shares, 0);

    // Both should show P&L
    assert.equal(runner.getState().sessionPnl, 20);
    assert.equal(globalRisk.getState().sessionPnl, 20);

    // Both should have freed notional
    assert.equal(runner.getState().sessionNotional, 0);
    assert.equal(globalRisk.getState().sessionNotional, 0);
  });

  it('global safety-net can catch overexposure that strategy allows', () => {
    const global = makeConfig({ maxSessionNotional: 200 });
    const runner = new StrategyRunner(makeStrategy({
      maxSessionNotional: 1000, // Strategy allows much more
    }), global);
    const globalPositions = new PositionTracker();
    const globalRisk = new RiskManager(global, globalPositions);

    // Fill both trackers to 180
    for (let i = 0; i < 3; i++) {
      const trade = makeTrade({ tokenId: `tok-${i}` });
      const notional = 60;
      runner.recordFill({ trade, notional, shares: 120, price: 0.50, side: 'BUY' });
      globalPositions.recordFill({ trade, notional, shares: 120, price: 0.50, side: 'BUY' });
      globalRisk.recordFill({ trade, notional, shares: 120, price: 0.50, side: 'BUY' });
    }

    // Strategy check passes (180 < 1000)
    assert.equal(runner.checkTrade(makeTrade(), 50).allowed, true);

    // Global safety-net blocks (180 + 50 = 230 > 200)
    assert.equal(globalRisk.checkTrade(makeTrade(), 50).allowed, false);
  });
});

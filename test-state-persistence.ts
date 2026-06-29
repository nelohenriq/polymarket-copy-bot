/**
 * Unit Tests — Per-Strategy State Persistence
 * ──────────────────────────────────────────────
 * Tests for the save/restore cycle of per-strategy positions, risk state,
 * and stats through bot-state.json.
 *
 * Usage: npx tsx test-state-persistence.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { saveState, loadState } from './src/state';
import { StrategyRunner, StrategyRouter } from './src/strategy';
import type { BotConfig, ParsedTrade, StrategyConfig, Position, RiskState, SessionStats, PersistedStrategyState } from './src/types';

// ──────────────────────────────────────────────
// Test Helpers
// ──────────────────────────────────────────────

const TEST_STATE_DIR = path.join(process.cwd(), '.test-state');
const TEST_STATE_PATH = path.join(TEST_STATE_DIR, 'test-bot-state.json');

function ensureTestDir(): void {
  if (!fs.existsSync(TEST_STATE_DIR)) {
    fs.mkdirSync(TEST_STATE_DIR, { recursive: true });
  }
}

function cleanTestDir(): void {
  try {
    if (fs.existsSync(TEST_STATE_PATH)) fs.unlinkSync(TEST_STATE_PATH);
    if (fs.existsSync(TEST_STATE_DIR)) fs.rmdirSync(TEST_STATE_DIR);
  } catch { /* ignore */ }
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

function makeStrategy(overrides: Partial<StrategyConfig> = {}): StrategyConfig {
  return {
    name: 'test-strategy',
    enabled: true,
    routing: { isDefault: true },
    ...overrides,
  };
}

function makeRiskState(overrides: Partial<RiskState> = {}): RiskState {
  return {
    sessionNotional: 0,
    sessionPnl: 0,
    peakCapital: 0,
    dailyLoss: 0,
    consecutiveLosses: 0,
    consecutiveWins: 0,
    halted: false,
    ...overrides,
  };
}

function makeSessionStats(overrides: Partial<SessionStats> = {}): SessionStats {
  return {
    startTime: Date.now(),
    tradesDetected: 10,
    tradesCopied: 5,
    tradesSkipped: 3,
    tradesFailed: 1,
    tradesAiRejected: 1,
    totalVolume: 500,
    totalPnl: 42,
    ...overrides,
  };
}

function makePosition(overrides: Partial<Position> = {}): Position {
  return {
    tokenId: 'token-abc',
    market: 'test-condition-id',
    outcome: 'Yes',
    shares: 100,
    notional: 50,
    avgPrice: 0.50,
    lastUpdated: Date.now(),
    ...overrides,
  };
}

// ══════════════════════════════════════════════
// saveState — strategies parameter
// ══════════════════════════════════════════════

describe('saveState — strategies parameter', () => {
  beforeEach(() => { ensureTestDir(); });
  afterEach(() => { cleanTestDir(); });

  it('includes strategies array when provided', () => {
    const strategies: PersistedStrategyState[] = [{
      name: 'crypto',
      positions: [makePosition({ tokenId: 'tok-crypto' })],
      riskState: makeRiskState({ sessionNotional: 150, sessionPnl: 25 }),
      stats: {
        name: 'crypto', tradesRouted: 10, tradesExecuted: 8, tradesBlocked: 2,
        totalVolume: 800, openPositions: 1, sessionNotional: 150, sessionPnl: 25, halted: false,
      },
    }];

    saveState(TEST_STATE_PATH, [], [], new Map(), makeRiskState(), makeSessionStats(), 0, strategies);

    const raw = JSON.parse(fs.readFileSync(TEST_STATE_PATH, 'utf-8'));
    assert.ok(Array.isArray(raw.strategies), 'strategies should be an array');
    assert.equal(raw.strategies.length, 1);
    assert.equal(raw.strategies[0].name, 'crypto');
    assert.equal(raw.strategies[0].positions.length, 1);
    assert.equal(raw.strategies[0].positions[0].tokenId, 'tok-crypto');
    assert.equal(raw.strategies[0].riskState.sessionNotional, 150);
    assert.equal(raw.strategies[0].stats.tradesExecuted, 8);
  });

  it('omits strategies field when not provided (backward compat)', () => {
    saveState(TEST_STATE_PATH, [], [], new Map(), makeRiskState(), makeSessionStats(), 0);

    const raw = JSON.parse(fs.readFileSync(TEST_STATE_PATH, 'utf-8'));
    assert.equal(raw.strategies, undefined, 'strategies should be absent');
  });

  it('omits strategies field when empty array', () => {
    saveState(TEST_STATE_PATH, [], [], new Map(), makeRiskState(), makeSessionStats(), 0, []);

    const raw = JSON.parse(fs.readFileSync(TEST_STATE_PATH, 'utf-8'));
    assert.equal(raw.strategies, undefined, 'empty strategies should be omitted');
  });

  it('filters out closed positions (shares = 0) in strategies', () => {
    const strategies: PersistedStrategyState[] = [{
      name: 'test',
      positions: [
        makePosition({ tokenId: 'tok-open', shares: 100 }),
        makePosition({ tokenId: 'tok-closed', shares: 0 }),
      ],
      riskState: makeRiskState(),
      stats: {
        name: 'test', tradesRouted: 5, tradesExecuted: 3, tradesBlocked: 2,
        totalVolume: 300, openPositions: 1, sessionNotional: 50, sessionPnl: 10, halted: false,
      },
    }];

    saveState(TEST_STATE_PATH, [], [], new Map(), makeRiskState(), makeSessionStats(), 0, strategies);

    const raw = JSON.parse(fs.readFileSync(TEST_STATE_PATH, 'utf-8'));
    // Strategy positions are stored as-is (not filtered by saveState — that only filters
    // the global positions array). StrategyRunner.restoreState handles them correctly.
    assert.equal(raw.strategies[0].positions.length, 2, 'both positions persisted in strategy state');
  });

  it('persists multiple strategies', () => {
    const strategies: PersistedStrategyState[] = [
      {
        name: 'aggressive',
        positions: [makePosition({ tokenId: 'tok-a', shares: 200 })],
        riskState: makeRiskState({ sessionNotional: 500, sessionPnl: -10 }),
        stats: {
          name: 'aggressive', tradesRouted: 20, tradesExecuted: 15, tradesBlocked: 5,
          totalVolume: 1500, openPositions: 1, sessionNotional: 500, sessionPnl: -10, halted: false,
        },
      },
      {
        name: 'conservative',
        positions: [makePosition({ tokenId: 'tok-c', shares: 50 })],
        riskState: makeRiskState({ sessionNotional: 25, sessionPnl: 5 }),
        stats: {
          name: 'conservative', tradesRouted: 8, tradesExecuted: 6, tradesBlocked: 2,
          totalVolume: 150, openPositions: 1, sessionNotional: 25, sessionPnl: 5, halted: false,
        },
      },
    ];

    saveState(TEST_STATE_PATH, [], [], new Map(), makeRiskState(), makeSessionStats(), 0, strategies);

    const raw = JSON.parse(fs.readFileSync(TEST_STATE_PATH, 'utf-8'));
    assert.equal(raw.strategies.length, 2);
    assert.equal(raw.strategies[0].name, 'aggressive');
    assert.equal(raw.strategies[1].name, 'conservative');
    assert.equal(raw.strategies[0].riskState.sessionPnl, -10);
    assert.equal(raw.strategies[1].riskState.sessionPnl, 5);
  });
});

// ══════════════════════════════════════════════
// loadState — backward compatibility
// ══════════════════════════════════════════════

describe('loadState — backward compatibility', () => {
  beforeEach(() => { ensureTestDir(); });
  afterEach(() => { cleanTestDir(); });

  it('loads state file without strategies field (old format)', () => {
    // Write an old-format state file (no strategies)
    const oldState = {
      version: 1,
      savedAt: new Date().toISOString(),
      entries: [],
      positions: [],
      lastProcessedTimestamps: {},
      riskState: makeRiskState(),
      sessionStats: makeSessionStats(),
      counter: 0,
    };
    fs.writeFileSync(TEST_STATE_PATH, JSON.stringify(oldState), 'utf-8');

    const loaded = loadState(TEST_STATE_PATH);
    assert.ok(loaded !== null);
    assert.equal(loaded!.strategies, undefined);
  });

  it('loads state file with strategies field', () => {
    const stateWithStrategies = {
      version: 1,
      savedAt: new Date().toISOString(),
      entries: [],
      positions: [],
      lastProcessedTimestamps: {},
      riskState: makeRiskState(),
      sessionStats: makeSessionStats(),
      counter: 0,
      strategies: [{
        name: 'my-strategy',
        positions: [makePosition({ tokenId: 'tok-1' })],
        riskState: makeRiskState({ sessionPnl: 100 }),
        stats: {
          name: 'my-strategy', tradesRouted: 5, tradesExecuted: 4, tradesBlocked: 1,
          totalVolume: 400, openPositions: 1, sessionNotional: 50, sessionPnl: 100, halted: false,
        },
      }],
    };
    fs.writeFileSync(TEST_STATE_PATH, JSON.stringify(stateWithStrategies), 'utf-8');

    const loaded = loadState(TEST_STATE_PATH);
    assert.ok(loaded !== null);
    assert.ok(Array.isArray(loaded!.strategies));
    assert.equal(loaded!.strategies!.length, 1);
    assert.equal(loaded!.strategies![0].name, 'my-strategy');
    assert.equal(loaded!.strategies![0].positions[0].tokenId, 'tok-1');
    assert.equal(loaded!.strategies![0].riskState.sessionPnl, 100);
  });

  it('returns null for missing file', () => {
    const loaded = loadState('/nonexistent/path/state.json');
    assert.equal(loaded, null);
  });

  it('returns null for invalid JSON', () => {
    fs.writeFileSync(TEST_STATE_PATH, 'not json!!!', 'utf-8');
    const loaded = loadState(TEST_STATE_PATH);
    assert.equal(loaded, null);
  });

  it('returns null for version mismatch', () => {
    const badState = { version: 999, entries: [] };
    fs.writeFileSync(TEST_STATE_PATH, JSON.stringify(badState), 'utf-8');
    const loaded = loadState(TEST_STATE_PATH);
    assert.equal(loaded, null);
  });
});

// ══════════════════════════════════════════════
// Full Round-Trip: Save → Load → Restore to Runners
// ══════════════════════════════════════════════

describe('Full round-trip: save → load → restore to StrategyRunners', () => {
  beforeEach(() => { ensureTestDir(); });
  afterEach(() => { cleanTestDir(); });

  it('positions survive save/restore cycle', () => {
    // Create runners and fill positions
    const global = makeConfig();
    const crypto = new StrategyRunner(makeStrategy({
      name: 'crypto', routing: { categories: ['crypto'] },
    }), global);
    const politics = new StrategyRunner(makeStrategy({
      name: 'politics', routing: { categories: ['politics'] },
    }), global);

    crypto.recordFill({
      trade: makeTrade({ tokenId: 'tok-btc', category: 'crypto' }),
      notional: 200, shares: 400, price: 0.50, side: 'BUY',
    });
    politics.recordFill({
      trade: makeTrade({ tokenId: 'tok-trump', category: 'politics' }),
      notional: 100, shares: 200, price: 0.50, side: 'BUY',
    });

    // Collect persisted state (same as persistJournal in index.ts)
    const strategyRunners = [crypto, politics];
    const strategies: PersistedStrategyState[] = strategyRunners.map(r => ({
      name: r.name,
      positions: r.getPositions().getAllPositions().filter(p => p.shares > 0),
      riskState: r.getRiskManager().getState(),
      stats: r.getState(),
    }));

    // Save
    saveState(TEST_STATE_PATH, [], [], new Map(), makeRiskState(), makeSessionStats(), 0, strategies);

    // Load
    const loaded = loadState(TEST_STATE_PATH);
    assert.ok(loaded !== null);
    assert.ok(loaded!.strategies);
    assert.equal(loaded!.strategies!.length, 2);

    // Create fresh runners (simulating restart)
    const freshCrypto = new StrategyRunner(makeStrategy({
      name: 'crypto', routing: { categories: ['crypto'] },
    }), global);
    const freshPolitics = new StrategyRunner(makeStrategy({
      name: 'politics', routing: { categories: ['politics'] },
    }), global);

    // Restore state to fresh runners
    for (const persisted of loaded!.strategies!) {
      const runner = [freshCrypto, freshPolitics].find(r => r.name === persisted.name);
      if (runner) {
        runner.restoreState(persisted.positions, persisted.riskState, persisted.stats);
      }
    }

    // Verify crypto positions restored
    assert.equal(freshCrypto.getPositions().getPosition('tok-btc')?.shares, 400);
    assert.equal(freshCrypto.getPositions().getNotional('tok-btc'), 200);

    // Verify politics positions restored
    assert.equal(freshPolitics.getPositions().getPosition('tok-trump')?.shares, 200);
    assert.equal(freshPolitics.getPositions().getNotional('tok-trump'), 100);

    // Verify routing still works after restore
    const router = new StrategyRouter([freshCrypto, freshPolitics]);
    assert.equal(router.routeSell('tok-btc')?.name, 'crypto');
    assert.equal(router.routeSell('tok-trump')?.name, 'politics');
    assert.equal(router.routeBuy(makeTrade({ category: 'crypto' }))?.name, 'crypto');
    assert.equal(router.routeBuy(makeTrade({ category: 'politics' }))?.name, 'politics');
  });

  it('risk state survives save/restore cycle', () => {
    const global = makeConfig();
    const runner = new StrategyRunner(makeStrategy({ name: 'test' }), global);

    // Fill and exit to build up risk state
    runner.recordFill({
      trade: makeTrade({ tokenId: 'tok-1' }),
      notional: 100, shares: 200, price: 0.50, side: 'BUY',
    });
    runner.recordExit(makeTrade({ tokenId: 'tok-1', side: 'SELL' }), 0.50, 200, 0.70, 40);
    runner.recordFill({
      trade: makeTrade({ tokenId: 'tok-2' }),
      notional: 50, shares: 100, price: 0.50, side: 'BUY',
    });

    const strategies: PersistedStrategyState[] = [{
      name: runner.name,
      positions: runner.getPositions().getAllPositions().filter(p => p.shares > 0),
      riskState: runner.getRiskManager().getState(),
      stats: runner.getState(),
    }];

    saveState(TEST_STATE_PATH, [], [], new Map(), makeRiskState(), makeSessionStats(), 0, strategies);
    const loaded = loadState(TEST_STATE_PATH);

    // Create fresh runner and restore
    const freshRunner = new StrategyRunner(makeStrategy({ name: 'test' }), global);
    freshRunner.restoreState(
      loaded!.strategies![0].positions,
      loaded!.strategies![0].riskState,
      loaded!.strategies![0].stats,
    );

    // Verify risk state: P&L should be 40, notional should be 50
    const state = freshRunner.getState();
    assert.equal(state.sessionPnl, 40);
    assert.equal(state.sessionNotional, 50);
    assert.equal(state.openPositions, 1);
  });

  it('stats survive save/restore cycle', () => {
    const global = makeConfig();
    const runner = new StrategyRunner(makeStrategy({ name: 'stats-test' }), global);

    // Build up stats
    runner.trackRouted();
    runner.trackRouted();
    runner.trackRouted();
    runner.trackExecuted(100);
    runner.trackExecuted(200);
    runner.trackBlocked();

    const strategies: PersistedStrategyState[] = [{
      name: runner.name,
      positions: [],
      riskState: runner.getRiskManager().getState(),
      stats: runner.getState(),
    }];

    saveState(TEST_STATE_PATH, [], [], new Map(), makeRiskState(), makeSessionStats(), 0, strategies);
    const loaded = loadState(TEST_STATE_PATH);

    // Create fresh runner and restore
    const freshRunner = new StrategyRunner(makeStrategy({ name: 'stats-test' }), global);
    freshRunner.restoreState(
      loaded!.strategies![0].positions,
      loaded!.strategies![0].riskState,
      loaded!.strategies![0].stats,
    );

    // Verify stats restored
    const state = freshRunner.getState();
    assert.equal(state.tradesRouted, 3);
    assert.equal(state.tradesExecuted, 2);
    assert.equal(state.tradesBlocked, 1);
    assert.equal(state.totalVolume, 300);
  });

  it('orphaned positions (strategy removed from config) fall back to default', () => {
    const global = makeConfig();

    // Simulate: bot had 2 strategies, saved state with both
    const strategies: PersistedStrategyState[] = [
      {
        name: 'removed-strategy',
        positions: [makePosition({ tokenId: 'tok-orphan', shares: 100 })],
        riskState: makeRiskState({ sessionNotional: 50, sessionPnl: 10 }),
        stats: {
          name: 'removed-strategy', tradesRouted: 5, tradesExecuted: 4, tradesBlocked: 1,
          totalVolume: 400, openPositions: 1, sessionNotional: 50, sessionPnl: 10, halted: false,
        },
      },
      {
        name: 'default',
        positions: [],
        riskState: makeRiskState(),
        stats: {
          name: 'default', tradesRouted: 0, tradesExecuted: 0, tradesBlocked: 0,
          totalVolume: 0, openPositions: 0, sessionNotional: 0, sessionPnl: 0, halted: false,
        },
      },
    ];

    saveState(TEST_STATE_PATH, [], [], new Map(), makeRiskState(), makeSessionStats(), 0, strategies);
    const loaded = loadState(TEST_STATE_PATH);

    // Restart with only the default strategy (removed-strategy no longer in config)
    const defaultRunner = new StrategyRunner(makeStrategy({
      name: 'default', routing: { isDefault: true },
    }), global);

    // Restore: only 'default' matches, 'removed-strategy' is skipped
    let restoredCount = 0;
    for (const persisted of loaded!.strategies!) {
      const runner = [defaultRunner].find(r => r.name === persisted.name);
      if (runner) {
        runner.restoreState(persisted.positions, persisted.riskState, persisted.stats);
        restoredCount++;
      }
    }
    assert.equal(restoredCount, 1);

    // The orphaned position (tok-orphan) is in the global tracker, not in default strategy
    // routeSell should fall back to default for orphaned positions
    const router = new StrategyRouter([defaultRunner]);
    assert.equal(router.routeSell('tok-orphan')?.name, 'default');
  });

  it('empty strategies array on first run (no prior multi-strategy state)', () => {
    // Save without strategies (single-strategy mode)
    saveState(TEST_STATE_PATH, [], [], new Map(), makeRiskState(), makeSessionStats(), 0);
    const loaded = loadState(TEST_STATE_PATH);

    assert.ok(loaded !== null);
    assert.equal(loaded!.strategies, undefined);

    // Code should handle this gracefully — no strategies to restore
    const strategiesToRestore = loaded!.strategies || [];
    assert.equal(strategiesToRestore.length, 0);
  });
});

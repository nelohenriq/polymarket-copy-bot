/**
 * Multi-Strategy Architecture
 * ──────────────────────────────────────────────
 *
 * StrategyRunner wraps PositionTracker + RiskManager + optional AI filter
 * for independent per-strategy risk management.
 *
 * StrategyRouter dispatches incoming trades to the correct strategy
 * based on routing rules (category, trader, market slug).
 */

import { BotConfig, ParsedTrade, StrategyConfig, StrategyState, AIFilterConfig, RiskCheckResult, Position, RiskState } from './types';
import { PositionTracker } from './positions';
import { RiskManager } from './risk';
import { AITradeFilter } from './ai-filter';
import { log } from './logger';

/**
 * Creates an effective BotConfig by merging strategy overrides onto the global config.
 * Only the fields relevant to risk/sizing/AI are overridden.
 */
function mergeStrategyConfig(globalConfig: BotConfig, strategy: StrategyConfig): BotConfig {
  return {
    ...globalConfig,
    // Risk overrides
    maxSessionNotional: strategy.maxSessionNotional ?? globalConfig.maxSessionNotional,
    maxPerMarketNotional: strategy.maxPerMarketNotional ?? globalConfig.maxPerMarketNotional,
    maxPerCategoryNotional: strategy.maxPerCategoryNotional ?? globalConfig.maxPerCategoryNotional,
    maxTradeSize: strategy.maxTradeSize ?? globalConfig.maxTradeSize,
    minTradeSize: strategy.minTradeSize ?? globalConfig.minTradeSize,
    dailyLossLimit: strategy.dailyLossLimit ?? globalConfig.dailyLossLimit,
    maxDrawdown: strategy.maxDrawdown ?? globalConfig.maxDrawdown,
    totalLossLimit: strategy.totalLossLimit ?? globalConfig.totalLossLimit,
    maxSessionProfit: strategy.maxSessionProfit ?? globalConfig.maxSessionProfit,
    // Sizing overrides
    positionMultiplier: strategy.positionMultiplier ?? globalConfig.positionMultiplier,
    kellySizingEnabled: strategy.kellySizingEnabled ?? globalConfig.kellySizingEnabled,
    kellyFraction: strategy.kellyFraction ?? globalConfig.kellyFraction,
    trailingStopEnabled: strategy.trailingStopEnabled ?? globalConfig.trailingStopEnabled,
    trailingStopPct: strategy.trailingStopPct ?? globalConfig.trailingStopPct,
  };
}

export class StrategyRunner {
  readonly name: string;
  readonly config: StrategyConfig;

  private effectiveConfig: BotConfig;
  private positions: PositionTracker;
  private riskManager: RiskManager;
  private aiFilter: AITradeFilter | null = null;

  // Per-strategy stats
  private _stats: StrategyState;

  constructor(strategy: StrategyConfig, globalConfig: BotConfig) {
    this.name = strategy.name;
    this.config = strategy;
    this.effectiveConfig = mergeStrategyConfig(globalConfig, strategy);
    this.positions = new PositionTracker();
    this.riskManager = new RiskManager(this.effectiveConfig, this.positions);

    this._stats = {
      name: strategy.name,
      tradesRouted: 0,
      tradesExecuted: 0,
      tradesBlocked: 0,
      totalVolume: 0,
      openPositions: 0,
      sessionNotional: 0,
      sessionPnl: 0,
      halted: false,
    };

    // Initialize AI filter if strategy overrides AI settings
    if (strategy.aiFilterEnabled) {
      const apiKey = process.env['AI_FILTER_API_KEY'] || '';
      if (apiKey) {
        const defaultModel = process.env['AI_FILTER_MODEL'] || 'gpt-4o';
        const aiConfig: AIFilterConfig = {
          enabled: true,
          provider: (process.env['AI_FILTER_PROVIDER'] || 'openai') as AIFilterConfig['provider'],
          apiKey,
          model: strategy.aiFilterModel || defaultModel,
          minConfidence: strategy.aiFilterMinConfidence ?? 0.6,
          minEdge: strategy.aiFilterMinEdge ?? 0.05,
          cacheMinutes: 15,
          maxCallsPerMinute: 10,
          timeoutSeconds: 30,
          failOpen: true,
        };
        try {
          this.aiFilter = new AITradeFilter(aiConfig);
          log.info(`Strategy '${strategy.name}': AI filter enabled (model: ${aiConfig.model})`);
        } catch {
          log.warn(`Strategy '${strategy.name}': AI filter failed to initialize — running without`);
        }
      }
    }
  }

  /**
   * Get the effective BotConfig (global + strategy overrides) for this runner.
   */
  getEffectiveConfig(): BotConfig {
    return this.effectiveConfig;
  }

  /**
   * Get the PositionTracker for this strategy.
   */
  getPositions(): PositionTracker {
    return this.positions;
  }

  /**
   * Get the RiskManager for this strategy.
   */
  getRiskManager(): RiskManager {
    return this.riskManager;
  }

  /**
   * Check if this strategy's risk gates allow the trade.
   */
  checkTrade(trade: ParsedTrade, copyNotional: number): RiskCheckResult {
    return this.riskManager.checkTrade(trade, copyNotional);
  }

  /**
   * Record a successful fill in this strategy's position tracker and risk manager.
   */
  recordFill(params: {
    trade: ParsedTrade;
    notional: number;
    shares: number;
    price: number;
    side: 'BUY' | 'SELL';
  }): void {
    this.positions.recordFill(params);
    this.riskManager.recordFill(params);
    if (params.side === 'BUY') {
      this._stats.openPositions = this.positions.count();
    }
  }

  /**
   * Record a position exit (SELL) — update position tracker, free notional and record P&L.
   */
  recordExit(trade: ParsedTrade, entryPrice: number, size: number, exitPrice: number, pnl: number): void {
    // Update position tracker (reduces shares to 0)
    this.positions.recordFill({
      trade,
      notional: exitPrice * size,
      shares: size,
      price: exitPrice,
      side: 'SELL',
    });
    this.riskManager.reduceSessionNotional(entryPrice * size);
    this.riskManager.addSessionPnl(pnl);
    this._stats.openPositions = this.positions.count();
  }

  /**
   * Run the AI filter if configured. Returns null if no AI filter.
   */
  async evaluateAI(trade: ParsedTrade): Promise<import('./types').AIFilterResult | null> {
    if (!this.aiFilter) return null;
    try {
      return await this.aiFilter.evaluate(trade);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`Strategy '${this.name}' AI filter error: ${msg}`);
      return null;
    }
  }

  /**
   * Track a routed trade in stats.
   */
  trackRouted(): void {
    this._stats.tradesRouted++;
  }

  /**
   * Track a successfully executed trade.
   */
  trackExecuted(notional: number): void {
    this._stats.tradesExecuted++;
    this._stats.totalVolume += notional;
  }

  /**
   * Track a blocked trade.
   */
  trackBlocked(): void {
    this._stats.tradesBlocked++;
  }

  /**
   * Get current strategy state for dashboard/API.
   */
  getState(): StrategyState {
    return {
      ...this._stats,
      sessionNotional: this.riskManager.getState().sessionNotional,
      sessionPnl: this.riskManager.getState().sessionPnl,
      halted: this.riskManager.getState().halted,
      openPositions: this.positions.count(),
    };
  }

  /**
   * Restore strategy state from persisted data.
   */
  restoreState(positions: import('./types').Position[], riskState: Partial<import('./types').RiskState>): void {
    if (positions.length > 0) {
      this.positions.loadPositions(positions);
    }
    if (riskState) {
      this.riskManager.restoreState(riskState);
    }
  }
}

/**
 * Trade Router — dispatches trades to the correct StrategyRunner
 * based on routing rules (category, trader, market slug).
 */
export class StrategyRouter {
  private strategies: StrategyRunner[];
  private defaultStrategy: StrategyRunner | null;

  constructor(strategies: StrategyRunner[]) {
    this.strategies = strategies;
    this.defaultStrategy = strategies.find(s => s.config.routing.isDefault) || null;
  }

  /**
   * Find all strategies that match a BUY trade.
   * Returns the first matching strategy, or the default strategy, or null.
   */
  routeBuy(trade: ParsedTrade): StrategyRunner | null {
    for (const strategy of this.strategies) {
      if (!strategy.config.enabled) continue;
      if (this.matches(trade, strategy.config.routing)) {
        return strategy;
      }
    }
    return this.defaultStrategy;
  }

  /**
   * Find the strategy that owns a position (by tokenId) for SELL routing.
   * Scans all strategies' position trackers to find which one holds the token.
   * Falls back to default strategy for orphaned positions (e.g. from persisted state
   * where per-strategy tracker state is lost on restart).
   */
  routeSell(tokenId: string): StrategyRunner | null {
    for (const strategy of this.strategies) {
      if (!strategy.config.enabled) continue;
      const pos = strategy.getPositions().getPosition(tokenId);
      if (pos && pos.shares > 0) {
        return strategy;
      }
    }
    // Fallback: route orphaned SELLs to default strategy so persisted positions
    // (loaded into the global tracker on restart) can still be closed
    return this.defaultStrategy;
  }

  /**
   * Get all active strategy runners.
   */
  getAll(): StrategyRunner[] {
    return this.strategies;
  }

  /**
   * Check if a trade matches a strategy's routing rules.
   */
  private matches(trade: ParsedTrade, rules: import('./types').StrategyRoutingRules): boolean {
    const { categories, traders, marketSlugs } = rules;

    // Match by category
    if (categories && categories.length > 0 && trade.category) {
      if (categories.includes(trade.category)) return true;
    }

    // Match by trader wallet
    if (traders && traders.length > 0) {
      if (traders.includes(trade.user.toLowerCase())) return true;
    }

    // Match by market slug
    if (marketSlugs && marketSlugs.length > 0 && trade.slug) {
      if (marketSlugs.some(s => trade.slug!.includes(s))) return true;
    }

    return false;
  }
}

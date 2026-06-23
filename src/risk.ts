/**
 * Risk Manager
 * Enforces multi-layer protection: session caps, per-market limits,
 * daily loss limits, drawdown tracking, and permanent halt.
 */

import { BotConfig, RiskCheckResult, RiskState, ParsedTrade } from './types';
import { PositionTracker } from './positions';
import { log } from './logger';

export class RiskManager {
  private config: BotConfig;
  private positions: PositionTracker;
  private state: RiskState;

  /** Timestamp of last daily reset */
  private lastDailyReset: number;

  constructor(config: BotConfig, positions: PositionTracker) {
    this.config = config;
    this.positions = positions;

    this.state = {
      sessionNotional: 0,
      sessionPnl: 0,
      // peakCapital tracks the highest capital reached. Start at 0 —
      // drawdown checks only apply once the bot has actually traded.
      // We use a sentinel value of -1 to mean "no trades yet, skip drawdown checks".
      peakCapital: 0,
      dailyLoss: 0,
      consecutiveLosses: 0,
      consecutiveWins: 0,
      halted: false,
    };

    this.lastDailyReset = Date.now();
  }

  /**
   * Check whether a proposed trade passes all risk gates.
   * Returns { allowed: true } or { allowed: false, reason }.
   */
  checkTrade(trade: ParsedTrade, copyNotional: number): RiskCheckResult {
    // Gate 0: Bot is permanently halted
    if (this.state.halted) {
      return { allowed: false, reason: `Bot halted: ${this.state.haltReason}` };
    }

    // Gate 1: Minimum trade size
    if (copyNotional <= 0) {
      return { allowed: false, reason: 'Copy notional is <= 0' };
    }

    if (copyNotional < this.config.minTradeSize) {
      return {
        allowed: false,
        reason: `Copy notional $${copyNotional.toFixed(2)} below minimum $${this.config.minTradeSize}`,
      };
    }

    // Gate 2: Maximum single trade size
    if (copyNotional > this.config.maxTradeSize) {
      return {
        allowed: false,
        reason: `Copy notional $${copyNotional.toFixed(2)} exceeds max trade size $${this.config.maxTradeSize}`,
      };
    }

    // Gate 3: Session notional cap
    if (this.config.maxSessionNotional > 0) {
      const nextSession = this.state.sessionNotional + copyNotional;
      if (nextSession > this.config.maxSessionNotional) {
        return {
          allowed: false,
          reason: `Session notional cap exceeded ($${nextSession.toFixed(2)} > $${this.config.maxSessionNotional})`,
        };
      }
    }

    // Gate 4: Per-market notional cap
    if (this.config.maxPerMarketNotional > 0) {
      const current = this.positions.getNotional(trade.tokenId);
      const next = current + copyNotional;
      if (next > this.config.maxPerMarketNotional) {
        return {
          allowed: false,
          reason: `Per-market notional cap exceeded ($${next.toFixed(2)} > $${this.config.maxPerMarketNotional})`,
        };
      }
    }

    // Gate 5: Daily loss limit
    this.checkDailyReset();
    if (this.state.dailyLoss >= this.config.dailyLossLimit * this.state.peakCapital) {
      return {
        allowed: false,
        reason: `Daily loss limit hit ($${this.state.dailyLoss.toFixed(2)})`,
      };
    }

    // Gate 6: Drawdown limit
    if (this.state.peakCapital > 0) {
      const drawdown = (this.state.peakCapital - this.state.sessionPnl) / this.state.peakCapital;
      if (drawdown >= this.config.maxDrawdown) {
        return {
          allowed: false,
          reason: `Max drawdown exceeded (${(drawdown * 100).toFixed(1)}%)`,
        };
      }
    }

    // Gate 7: Total loss limit (permanent halt)
    if (this.state.peakCapital > 0) {
      const totalLoss = (this.state.peakCapital - this.state.sessionPnl) / this.state.peakCapital;
      if (totalLoss >= this.config.totalLossLimit) {
        this.state.halted = true;
        this.state.haltReason = `Total loss limit reached (${(totalLoss * 100).toFixed(1)}%)`;
        log.risk(`🛑 PERMANENT HALT: ${this.state.haltReason}`);
        return { allowed: false, reason: this.state.haltReason };
      }
    }

    return { allowed: true };
  }

  /**
   * Record a completed fill for tracking purposes.
   */
  recordFill(params: {
    trade: ParsedTrade;
    notional: number;
    shares: number;
    price: number;
    side: 'BUY' | 'SELL';
    pnl?: number;
  }): void {
    this.state.sessionNotional += params.notional;

    if (params.pnl !== undefined) {
      this.state.sessionPnl += params.pnl;
      this.state.dailyLoss += params.pnl < 0 ? Math.abs(params.pnl) : 0;

      if (params.pnl >= 0) {
        this.state.consecutiveWins++;
        this.state.consecutiveLosses = 0;
      } else {
        this.state.consecutiveLosses++;
        this.state.consecutiveWins = 0;
      }
    }

    // Track peak capital — only set after the bot has been profitable.
    // peakCapital starts at 0; drawdown checks are skipped until a profitable
    // trade sets the baseline. The session notional cap provides protection before then.
    if (this.state.sessionPnl > this.state.peakCapital) {
      this.state.peakCapital = this.state.sessionPnl;
    }
  }

  /**
   * Get current risk state for display.
   */
  getState(): RiskState {
    this.checkDailyReset();
    return { ...this.state };
  }

  /**
   * Print risk status panel.
   */
  printStatus(): void {
    const state = this.getState();
    const capital = this.state.peakCapital || 1;

    console.log('\n🛡️  Risk Status:');
    console.log('─'.repeat(50));
    console.log(
      `  Daily Loss:     $${state.dailyLoss.toFixed(2)} / ` +
      `$${(this.config.dailyLossLimit * capital).toFixed(2)} ` +
      `(${((state.dailyLoss / (this.config.dailyLossLimit * capital || 1)) * 100).toFixed(0)}%)`,
    );
    console.log(
      `  Session Volume: $${state.sessionNotional.toFixed(2)} / ` +
      `${this.config.maxSessionNotional > 0 ? `$${this.config.maxSessionNotional}` : '∞'}`,
    );
    console.log(`  Session P&L:    $${state.sessionPnl.toFixed(2)}`);
    console.log(`  Peak Capital:   $${state.peakCapital.toFixed(2)}`);

    if (state.halted) {
      console.log(`  🛑 STATUS:      HALTED — ${state.haltReason}`);
    } else {
      console.log(`  ✅ STATUS:      Active`);
    }
    console.log('─'.repeat(50));
  }

  /**
   * Reset the daily loss counter at midnight.
   */
  private checkDailyReset(): void {
    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;
    if (now - this.lastDailyReset > oneDayMs) {
      this.state.dailyLoss = 0;
      this.lastDailyReset = now;
      log.info('Daily loss counter reset');
    }
  }
}

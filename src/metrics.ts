/**
 * Performance Metrics Calculator
 * Calculates comprehensive trading performance statistics from trade journals.
 */

import { TradeJournalEntry, PerformanceMetrics, PortfolioSnapshot } from './types';

export class MetricsCalculator {
  /**
   * Calculate comprehensive performance metrics from a trade journal.
   */
  static calculate(journal: TradeJournalEntry[], startingCapital: number): PerformanceMetrics {
    const closedTrades = journal.filter((t) => t.pnl !== undefined);
    const totalTrades = closedTrades.length;

    if (totalTrades === 0) {
      return MetricsCalculator.emptyMetrics();
    }

    const pnls = closedTrades.map((t) => t.pnl!);
    const wins = pnls.filter((p) => p > 0);
    const losses = pnls.filter((p) => p <= 0);

    const totalPnl = pnls.reduce((sum, p) => sum + p, 0);
    const totalReturn = totalPnl;
    const totalReturnPct = startingCapital > 0 ? (totalPnl / startingCapital) * 100 : 0;

    // Win/Loss statistics
    const winRate = totalTrades > 0 ? wins.length / totalTrades : 0;
    const averageWin = wins.length > 0 ? wins.reduce((s, w) => s + w, 0) / wins.length : 0;
    const averageLoss = losses.length > 0 ? Math.abs(losses.reduce((s, l) => s + l, 0) / losses.length) : 0;
    const grossProfit = wins.reduce((s, w) => s + w, 0);
    const grossLoss = Math.abs(losses.reduce((s, l) => s + l, 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

    // Hold times
    const holdTimes = closedTrades
      .filter((t) => t.holdTimeMs !== undefined && t.holdTimeMs > 0)
      .map((t) => t.holdTimeMs!);
    const averageHoldTimeMs = holdTimes.length > 0
      ? holdTimes.reduce((s, h) => s + h, 0) / holdTimes.length
      : 0;
    const longestHoldTimeMs = holdTimes.length > 0 ? Math.max(...holdTimes) : 0;
    const shortestHoldTimeMs = holdTimes.length > 0 ? Math.min(...holdTimes) : 0;

    // Consecutive wins/losses
    let maxConsecutiveWins = 0;
    let maxConsecutiveLosses = 0;
    let currentWins = 0;
    let currentLosses = 0;
    for (const pnl of pnls) {
      if (pnl > 0) {
        currentWins++;
        currentLosses = 0;
        maxConsecutiveWins = Math.max(maxConsecutiveWins, currentWins);
      } else {
        currentLosses++;
        currentWins = 0;
        maxConsecutiveLosses = Math.max(maxConsecutiveLosses, currentLosses);
      }
    }

    // Drawdown calculation from cumulative P&L curve
    const { maxDrawdown, maxDrawdownPct } = MetricsCalculator.calculateDrawdown(pnls, startingCapital);

    // Sharpe ratio (annualized, assuming ~252 trading days)
    const dailyReturns = MetricsCalculator.calculateDailyReturns(journal, startingCapital);
    const sharpeRatio = MetricsCalculator.calculateSharpe(dailyReturns);

    // Annualized return
    const firstTradeTime = closedTrades[0]?.timestamp || Date.now();
    const lastTradeTime = closedTrades[closedTrades.length - 1]?.timestamp || Date.now();
    const daysElapsed = Math.max((lastTradeTime - firstTradeTime) / (1000 * 60 * 60 * 24), 1);
    const annualizedReturn = startingCapital > 0
      ? (Math.pow(1 + totalPnl / startingCapital, 365 / daysElapsed) - 1) * 100
      : 0;

    // Calmar ratio = annualized return / max drawdown
    const calmarRatio = maxDrawdownPct > 0 ? annualizedReturn / (maxDrawdownPct * 100) : 0;

    return {
      totalReturn,
      totalReturnPct,
      annualizedReturn,
      sharpeRatio,
      maxDrawdown,
      maxDrawdownPct,
      winRate,
      averageWin,
      averageLoss,
      profitFactor,
      totalTrades,
      winningTrades: wins.length,
      losingTrades: losses.length,
      averageHoldTimeMs,
      longestHoldTimeMs,
      shortestHoldTimeMs,
      consecutiveWins: maxConsecutiveWins,
      consecutiveLosses: maxConsecutiveLosses,
      calmarRatio,
    };
  }

  /**
   * Calculate maximum drawdown from a sequence of P&L values.
   */
  private static calculateDrawdown(pnls: number[], startingCapital: number): {
    maxDrawdown: number;
    maxDrawdownPct: number;
  } {
    let peak = startingCapital;
    let maxDrawdown = 0;
    let maxDrawdownPct = 0;
    let current = startingCapital;

    for (const pnl of pnls) {
      current += pnl;
      if (current > peak) {
        peak = current;
      }
      const drawdown = peak - current;
      const drawdownPct = peak > 0 ? drawdown / peak : 0;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
        maxDrawdownPct = drawdownPct;
      }
    }

    return { maxDrawdown, maxDrawdownPct };
  }

  /**
   * Calculate daily returns from the trade journal for Sharpe ratio computation.
   */
  private static calculateDailyReturns(journal: TradeJournalEntry[], _startingCapital: number): number[] {
    // Group trades by day
    const dailyPnl = new Map<string, number>();
    for (const trade of journal) {
      if (trade.pnl === undefined) continue;
      const day = new Date(trade.timestamp).toISOString().slice(0, 10);
      dailyPnl.set(day, (dailyPnl.get(day) || 0) + trade.pnl);
    }

    return Array.from(dailyPnl.values());
  }

  /**
   * Calculate annualized Sharpe ratio from daily returns.
   * Assumes risk-free rate of 0 for simplicity.
   */
  private static calculateSharpe(dailyReturns: number[]): number {
    if (dailyReturns.length < 2) return 0;

    const mean = dailyReturns.reduce((s, r) => s + r, 0) / dailyReturns.length;
    const variance = dailyReturns.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / (dailyReturns.length - 1);
    const stdDev = Math.sqrt(variance);

    if (stdDev === 0) return 0;

    // Annualize: sqrt(252) for trading days
    const dailySharpe = mean / stdDev;
    return dailySharpe * Math.sqrt(252);
  }

  /**
   * Generate portfolio snapshots from the journal for charting.
   */
  static generateSnapshots(
    journal: TradeJournalEntry[],
    startingCapital: number,
    intervalMs: number = 3600_000, // Default: hourly snapshots
  ): PortfolioSnapshot[] {
    const snapshots: PortfolioSnapshot[] = [];
    let cash = startingCapital;
    const positions = new Map<string, { shares: number; avgPrice: number; notional: number; market: string; outcome: string; tokenId: string }>();
    let realizedPnl = 0;

    // Sort journal by timestamp
    const sorted = [...journal].sort((a, b) => a.timestamp - b.timestamp);

    let lastSnapshotTime = sorted.length > 0 ? sorted[0].timestamp : Date.now();

    for (const trade of sorted) {
      // Update positions
      if (trade.side === 'BUY') {
        const existing = positions.get(trade.tokenId);
        const newShares = (existing?.shares || 0) + trade.size;
        const newNotional = (existing?.notional || 0) + trade.entryPrice * trade.size;
        positions.set(trade.tokenId, {
          shares: newShares,
          avgPrice: newNotional / newShares,
          notional: newNotional,
          market: trade.market,
          outcome: trade.outcome,
          tokenId: trade.tokenId,
        });
        cash -= trade.entryPrice * trade.size;
      } else if (trade.side === 'SELL') {
        const existing = positions.get(trade.tokenId);
        if (existing) {
          const sellShares = Math.min(trade.size, existing.shares);
          cash += trade.entryPrice * sellShares;
          existing.shares -= sellShares;
          existing.notional -= existing.avgPrice * sellShares;
          if (existing.shares <= 0) {
            positions.delete(trade.tokenId);
          }
        }
      }

      // Record P&L
      if (trade.pnl !== undefined) {
        realizedPnl += trade.pnl;
      }

      // Generate snapshot at intervals
      if (trade.timestamp - lastSnapshotTime >= intervalMs) {
        const posArray = Array.from(positions.values()).map((p) => ({
          tokenId: p.tokenId,
          market: p.market,
          outcome: p.outcome,
          shares: p.shares,
          notional: p.notional,
          avgPrice: p.avgPrice,
          lastUpdated: trade.timestamp,
        }));

        const unrealizedPnl = posArray.reduce((sum, p) => sum + (p.notional - p.avgPrice * p.shares), 0);
        const totalValue = cash + posArray.reduce((sum, p) => sum + p.notional, 0);

        snapshots.push({
          timestamp: trade.timestamp,
          cash,
          positions: posArray,
          totalValue,
          unrealizedPnl,
          realizedPnl,
        });

        lastSnapshotTime = trade.timestamp;
      }
    }

    return snapshots;
  }

  /**
   * Format metrics as a readable console report.
   */
  static formatReport(metrics: PerformanceMetrics): string {
    const lines = [
      '',
      '═'.repeat(60),
      '📈  PERFORMANCE REPORT',
      '═'.repeat(60),
      '',
      '  Returns:',
      `    Total Return:       $${metrics.totalReturn.toFixed(2)} (${metrics.totalReturnPct.toFixed(2)}%)`,
      `    Annualized Return:  ${metrics.annualizedReturn.toFixed(2)}%`,
      `    Sharpe Ratio:       ${metrics.sharpeRatio.toFixed(2)}`,
      `    Calmar Ratio:       ${metrics.calmarRatio.toFixed(2)}`,
      '',
      '  Risk:',
      `    Max Drawdown:       $${metrics.maxDrawdown.toFixed(2)} (${(metrics.maxDrawdownPct * 100).toFixed(2)}%)`,
      `    Profit Factor:      ${metrics.profitFactor === Infinity ? '∞' : metrics.profitFactor.toFixed(2)}`,
      '',
      '  Win/Loss:',
      `    Win Rate:           ${(metrics.winRate * 100).toFixed(1)}%`,
      `    Total Trades:       ${metrics.totalTrades}`,
      `    Winning:            ${metrics.winningTrades}`,
      `    Losing:             ${metrics.losingTrades}`,
      `    Avg Win:            $${metrics.averageWin.toFixed(2)}`,
      `    Avg Loss:           $${metrics.averageLoss.toFixed(2)}`,
      '',
      '  Streaks:',
      `    Max Consec. Wins:   ${metrics.consecutiveWins}`,
      `    Max Consec. Losses: ${metrics.consecutiveLosses}`,
      '',
      '  Hold Times:',
      `    Average:            ${MetricsCalculator.formatDuration(metrics.averageHoldTimeMs)}`,
      `    Longest:            ${MetricsCalculator.formatDuration(metrics.longestHoldTimeMs)}`,
      `    Shortest:           ${MetricsCalculator.formatDuration(metrics.shortestHoldTimeMs)}`,
      '',
      '═'.repeat(60),
    ];

    return lines.join('\n');
  }

  /**
   * Format duration in milliseconds to a human-readable string.
   */
  private static formatDuration(ms: number): string {
    if (ms === 0) return 'N/A';
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }

  /**
   * Export trade journal to JSON string.
   */
  static exportJournalJSON(journal: TradeJournalEntry[]): string {
    return JSON.stringify(journal, null, 2);
  }

  /**
   * Export trade journal to CSV string.
   */
  static exportJournalCSV(journal: TradeJournalEntry[]): string {
    const headers = [
      'tradeId', 'timestamp', 'market', 'outcome', 'side', 'size',
      'entryPrice', 'exitPrice', 'pnl', 'holdTimeMs', 'reason', 'source',
    ];
    const rows = journal.map((t) => [
      t.tradeId,
      new Date(t.timestamp).toISOString(),
      t.market,
      t.outcome,
      t.side,
      t.size.toFixed(4),
      t.entryPrice.toFixed(4),
      t.exitPrice?.toFixed(4) || '',
      t.pnl?.toFixed(4) || '',
      t.holdTimeMs?.toString() || '',
      t.reason,
      t.source,
    ]);

    return [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
  }

  private static emptyMetrics(): PerformanceMetrics {
    return {
      totalReturn: 0,
      totalReturnPct: 0,
      annualizedReturn: 0,
      sharpeRatio: 0,
      maxDrawdown: 0,
      maxDrawdownPct: 0,
      winRate: 0,
      averageWin: 0,
      averageLoss: 0,
      profitFactor: 0,
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      averageHoldTimeMs: 0,
      longestHoldTimeMs: 0,
      shortestHoldTimeMs: 0,
      consecutiveWins: 0,
      consecutiveLosses: 0,
      calmarRatio: 0,
    };
  }
}

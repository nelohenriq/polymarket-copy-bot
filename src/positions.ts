/**
 * Position Tracker
 * Maintains a map of current positions, tracks fills, and calculates exposure.
 */

import { Position, ParsedTrade } from './types';
import { log } from './logger';

export class PositionTracker {
  private positions: Map<string, Position> = new Map();

  /**
   * Record a fill (trade execution) and update position state.
   */
  recordFill(params: {
    trade: ParsedTrade;
    notional: number;
    shares: number;
    price: number;
    side: 'BUY' | 'SELL';
  }): void {
    const { trade, notional, shares, price, side } = params;
    const key = trade.tokenId;
    const existing = this.positions.get(key);

    const sign = side === 'BUY' ? 1 : -1;
    const deltaShares = shares * sign;
    const deltaNotional = notional * sign;

    const nextShares = (existing?.shares || 0) + deltaShares;
    const nextNotional = (existing?.notional || 0) + deltaNotional;
    const avgPrice = nextShares !== 0 ? Math.abs(nextNotional / nextShares) : 0;

    const updated: Position = {
      tokenId: trade.tokenId,
      market: trade.market,
      outcome: trade.outcome,
      shares: Math.max(0, nextShares),
      notional: Math.max(0, nextNotional),
      avgPrice: nextShares !== 0 ? avgPrice : 0,
      lastUpdated: Date.now(),
    };

    this.positions.set(key, updated);

    log.debug(
      `Position updated: ${trade.outcome} | ` +
      `shares=${updated.shares.toFixed(4)} | ` +
      `notional=$${updated.notional.toFixed(2)} | ` +
      `avgPrice=$${updated.avgPrice.toFixed(4)}`,
    );
  }

  /**
   * Get the notional exposure for a specific token.
   */
  getNotional(tokenId: string): number {
    return this.positions.get(tokenId)?.notional || 0;
  }

  /**
   * Get the total notional exposure across all positions.
   */
  getTotalNotional(): number {
    let total = 0;
    for (const pos of this.positions.values()) {
      total += pos.notional;
    }
    return total;
  }

  /**
   * Get a specific position.
   */
  getPosition(tokenId: string): Position | undefined {
    return this.positions.get(tokenId);
  }

  /**
   * Get all positions.
   */
  getAllPositions(): Position[] {
    return Array.from(this.positions.values());
  }

  /**
   * Get number of open positions.
   */
  count(): number {
    let count = 0;
    for (const pos of this.positions.values()) {
      if (pos.shares > 0) count++;
    }
    return count;
  }

  /**
   * Print a summary of all positions.
   */
  printSummary(): void {
    const positions = this.getAllPositions().filter((p) => p.shares > 0);
    if (positions.length === 0) {
      log.info('No open positions');
      return;
    }

    console.log('\n📊 Position Summary:');
    console.log('─'.repeat(70));
    console.log(
      'Outcome'.padEnd(30) +
      'Shares'.padStart(12) +
      'Notional'.padStart(12) +
      'Avg Price'.padStart(12),
    );
    console.log('─'.repeat(70));

    for (const pos of positions) {
      console.log(
        pos.outcome.slice(0, 28).padEnd(30) +
        pos.shares.toFixed(4).padStart(12) +
        `$${pos.notional.toFixed(2)}`.padStart(12) +
        `$${pos.avgPrice.toFixed(4)}`.padStart(12),
      );
    }

    console.log('─'.repeat(70));
    console.log(
      'TOTAL'.padEnd(30) +
      ''.padStart(12) +
      `$${this.getTotalNotional().toFixed(2)}`.padStart(12) +
      ''.padStart(12),
    );
    console.log('');
  }
}

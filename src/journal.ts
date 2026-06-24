/**
 * Trade Journal
 * Records all paper trades with entry/exit tracking and P&L calculation.
 * Supports exporting to JSON and CSV.
 */

import { TradeJournalEntry, ParsedTrade } from './types';
import { log } from './logger';

export class TradeJournal {
  private entries: TradeJournalEntry[] = [];
  private openPositions: Map<string, TradeJournalEntry> = new Map(); // tokenId -> entry
  private counter = 0;

  /**
   * Record a new trade entry (BUY).
   */
  recordEntry(trade: ParsedTrade, copyNotional: number, price: number, source: string): TradeJournalEntry {
    const entry: TradeJournalEntry = {
      tradeId: `T${String(++this.counter).padStart(6, '0')}`,
      timestamp: trade.timestamp,
      market: trade.market,
      title: trade.title || trade.market,
      tokenId: trade.tokenId,
      outcome: trade.outcome,
      side: trade.side,
      size: copyNotional / price, // shares
      entryPrice: price,
      reason: `Copy-trade from ${trade.user.slice(0, 8)}...`,
      source,
      trader: trade.user,
      slug: trade.slug,
      volume24hr: trade.volume24hr,
      category: trade.category,
    };

    this.entries.push(entry);

    // Track open position for exit matching
    if (trade.side === 'BUY') {
      this.openPositions.set(trade.tokenId, entry);
    }

    log.debug(`Journal entry: ${entry.tradeId} | ${entry.side} ${entry.outcome} @ $${price}`);
    return entry;
  }

  /**
   * Record an exit (SELL or resolution) and calculate P&L.
   */
  recordExit(tokenId: string, exitPrice: number, exitTimestamp: number): void {
    const entry = this.openPositions.get(tokenId);
    if (!entry) {
      log.debug(`No open position found for ${tokenId.slice(0, 12)}... to close`);
      return;
    }

    entry.exitPrice = exitPrice;
    entry.exitTimestamp = exitTimestamp;
    entry.holdTimeMs = exitTimestamp - entry.timestamp;

    // P&L = (exit price - entry price) * shares
    const shares = entry.size;
    entry.pnl = (exitPrice - entry.entryPrice) * shares;

    this.openPositions.delete(tokenId);

    log.debug(
      `Journal exit: ${entry.tradeId} | P&L: $${entry.pnl.toFixed(4)} | ` +
      `Hold: ${entry.holdTimeMs ? (entry.holdTimeMs / 1000 / 60).toFixed(1) : '?'}m`,
    );
  }

  /**
   * Get all journal entries.
   */
  getEntries(): TradeJournalEntry[] {
    return [...this.entries];
  }

  /**
   * Get only closed trades (with P&L).
   */
  getClosedTrades(): TradeJournalEntry[] {
    return this.entries.filter((e) => e.pnl !== undefined);
  }

  /**
   * Find the open position entry for a given tokenId (without closing it).
   * Used to access entry details before recordExit removes it from the map.
   */
  findOpenPosition(tokenId: string): TradeJournalEntry | undefined {
    return this.openPositions.get(tokenId);
  }

  /**
   * Get open positions (entries without exits).
   */
  getOpenPositions(): TradeJournalEntry[] {
    return Array.from(this.openPositions.values());
  }

  /**
   * Get total number of entries.
   */
  count(): number {
    return this.entries.length;
  }

  /**
   * Get the current entry counter (for state persistence continuity).
   */
  getCounter(): number {
    return this.counter;
  }

  /**
   * Load entries from persisted state (for restart recovery).
   * Restores both the full entries array and the openPositions map.
   * @param entries - Previously saved journal entries
   * @param counter - The entry counter at save time (for ID continuity)
   */
  loadFromEntries(entries: TradeJournalEntry[], counter?: number): void {
    this.entries = entries;
    this.counter = counter ?? entries.length;

    // Rebuild openPositions from entries that have no exit
    this.openPositions.clear();
    for (const e of this.entries) {
      if (e.exitPrice === undefined && e.side === 'BUY') {
        this.openPositions.set(e.tokenId, e);
      }
    }

    log.info(`Journal restored: ${entries.length} entries, ${this.openPositions.size} open positions`);
  }

  /**
   * Export journal to JSON.
   */
  toJSON(): string {
    return JSON.stringify(this.entries, null, 2);
  }

  /**
   * Export journal to CSV.
   */
  toCSV(): string {
    const headers = [
      'tradeId', 'timestamp', 'market', 'outcome', 'side', 'shares',
      'entryPrice', 'exitPrice', 'pnl', 'holdTimeMs', 'reason', 'source',
    ];
    const rows = this.entries.map((t) => [
      t.tradeId,
      new Date(t.timestamp).toISOString(),
      `"${t.market}"`,
      `"${t.outcome}"`,
      t.side,
      t.size.toFixed(4),
      t.entryPrice.toFixed(4),
      t.exitPrice?.toFixed(4) || '',
      t.pnl?.toFixed(4) || '',
      t.holdTimeMs?.toString() || '',
      `"${t.reason}"`,
      t.source,
    ]);

    return [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
  }
}

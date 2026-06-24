/**
 * Historical Monitor
 * Fetches historical trades from the Polymarket Data API and replays them
 * chronologically through a callback — used for backtesting strategies.
 */

import { BotConfig, ParsedTrade, DataApiTrade, BacktestConfig } from './types';
import { log } from './logger';
import { proxyFetch } from './proxy';

const DATA_API_BASE = 'https://data-api.polymarket.com';

export type OnTradeCallback = (trade: ParsedTrade) => void;

export class HistoricalMonitor {
  private config: BotConfig;
  private backtestConfig: BacktestConfig;
  private onTrade: OnTradeCallback;
  private running = false;

  constructor(config: BotConfig, backtestConfig: BacktestConfig, onTrade: OnTradeCallback) {
    this.config = config;
    this.backtestConfig = backtestConfig;
    this.onTrade = onTrade;
  }

  /**
   * Fetch all historical trades for target wallets within the backtest time range,
   * sort them chronologically, and replay them through the callback.
   */
  async start(): Promise<void> {
    this.running = true;
    log.info('Fetching historical trades for backtesting...');

    const allTrades: ParsedTrade[] = [];

    for (const wallet of this.backtestConfig.targetWallets) {
      try {
        const trades = await this.fetchHistoricalTrades(wallet);
        allTrades.push(...trades);
        log.info(`Fetched ${trades.length} historical trades from ${wallet.slice(0, 8)}...`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error(`Failed to fetch trades for ${wallet.slice(0, 8)}...: ${msg}`);
      }
    }

    // Sort chronologically (oldest first)
    allTrades.sort((a, b) => a.timestamp - b.timestamp);

    log.info(`Total historical trades: ${allTrades.length}`);
    log.info(`Replaying at ${this.backtestConfig.speedMultiplier}x speed...`);

    // Replay trades through callback
    let lastTimestamp = 0;
    for (const trade of allTrades) {
      if (!this.running) break;

      // Simulate time delay between trades
      if (lastTimestamp > 0 && this.backtestConfig.speedMultiplier > 0) {
        const delay = (trade.timestamp - lastTimestamp) / this.backtestConfig.speedMultiplier;
        if (delay > 0 && delay < 60_000) { // Cap individual delays at 1 minute
          await this.sleep(delay);
        }
      }

      this.onTrade(trade);
      lastTimestamp = trade.timestamp;
    }

    log.success('Historical replay complete');
  }

  stop(): void {
    this.running = false;
    log.info('Historical monitor stopped');
  }

  /**
   * Fetch historical trades for a single wallet within the backtest time range.
   * Handles pagination to get all trades.
   */
  private async fetchHistoricalTrades(walletAddress: string): Promise<ParsedTrade[]> {
    const trades: ParsedTrade[] = [];
    let offset = 0;
    const pageSize = 100;
    let hasMore = true;

    const startSeconds = Math.floor(this.backtestConfig.startTime / 1000);
    const endSeconds = Math.floor(this.backtestConfig.endTime / 1000);

    while (hasMore) {
      const params = new URLSearchParams({
        user: walletAddress,
        type: 'TRADE',
        limit: String(pageSize),
        sortBy: 'TIMESTAMP',
        sortDirection: 'ASC',
        start: String(startSeconds),
      });

      // Add offset for pagination
      if (offset > 0) {
        params.set('offset', String(offset));
      }

      const url = `${DATA_API_BASE}/activity?${params.toString()}`;
      const response = await proxyFetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        throw new Error(`Data API returned ${response.status}: ${response.statusText}`);
      }

      const rawTrades = (await response.json()) as DataApiTrade[];
      if (!Array.isArray(rawTrades) || rawTrades.length === 0) {
        hasMore = false;
        break;
      }

      for (const raw of rawTrades) {
        const parsed = this.parseTrade(raw);
        if (parsed && parsed.timestamp <= endSeconds * 1000) {
          trades.push(parsed);
        }
      }

      // If we got fewer than pageSize results, we've reached the end
      if (rawTrades.length < pageSize) {
        hasMore = false;
      } else {
        offset += pageSize;
      }

      // Rate limiting — small delay between pagination requests
      await this.sleep(500);
    }

    return trades;
  }

  private parseTrade(raw: DataApiTrade): ParsedTrade | null {
    try {
      const size = typeof raw.size === 'number' ? raw.size : parseFloat(String(raw.size));
      const price = typeof raw.price === 'number' ? raw.price : parseFloat(String(raw.price));

      if (isNaN(size) || isNaN(price) || size <= 0 || price <= 0) {
        return null;
      }

      const tradeId = `${raw.conditionId}-${raw.proxyWallet}-${raw.timestamp}-${(raw.transactionHash as string) || ''}`;

      return {
        id: tradeId,
        timestamp: typeof raw.timestamp === 'number' ? raw.timestamp * 1000 : new Date(raw.timestamp).getTime(),
        market: raw.conditionId,
        tokenId: raw.asset as string,
        side: raw.side,
        size,
        price,
        user: (raw.proxyWallet as string || '').toLowerCase(),
        outcome: (raw.outcome as string) || (raw.title as string) || 'Unknown',
        title: (raw.title as string) || '',
        slug: raw.slug as string || undefined,
        volume24hr: typeof raw.volume24hr === 'number' ? raw.volume24hr : typeof raw.volume_24hr === 'number' ? raw.volume_24hr as number : undefined,
        category: typeof raw.groupItemTitle === 'string' ? raw.groupItemTitle : typeof raw.groupTitle === 'string' ? raw.groupTitle : undefined,
      };
    } catch {
      return null;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

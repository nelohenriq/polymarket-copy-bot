/**
 * Leaderboard Scraper
 * Discovers top Polymarket traders by querying the Data API leaderboard endpoint,
 * then analyzes their trade history to calculate win rate, P&L, consistency,
 * and a composite score for ranking.
 *
 * Used to automatically populate TARGET_WALLETS instead of manual configuration.
 */

import { LeaderboardConfig, TraderProfile, DataApiTrade } from './types';
import { log } from './logger';
import { proxyFetch } from './proxy';

const DATA_API_BASE = 'https://data-api.polymarket.com';

// ──────────────────────────────────────────────
// Leaderboard API Response Types
// ──────────────────────────────────────────────

interface LeaderboardEntry {
  proxyWallet: string;
  address?: string;
  pnl?: number;
  volume?: number;
  numTrades?: number;
  winRate?: number;
  name?: string;
  rank?: number;
  [key: string]: unknown;
}

// ──────────────────────────────────────────────
// Trade Analysis
// ──────────────────────────────────────────────

interface TradeAnalysis {
  totalTrades: number;
  buyTrades: number;
  sellTrades: number;
  totalVolume: number;
  avgTradeSize: number;
  largestTrade: number;
  uniqueMarkets: number;
  lastTradeTime: number;
  consistencyScore: number; // 0-1: how consistent are trade sizes
}

/**
 * Fetch and analyze recent trades for a specific wallet.
 */
async function analyzeTraderTrades(walletAddress: string): Promise<TradeAnalysis> {
  const params = new URLSearchParams({
    user: walletAddress,
    type: 'TRADE',
    limit: '100',
    sortBy: 'TIMESTAMP',
    sortDirection: 'DESC',
  });

  try {
    const response = await proxyFetch(`${DATA_API_BASE}/activity?${params}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      throw new Error(`Data API returned ${response.status}`);
    }

    const trades = (await response.json()) as DataApiTrade[];
    if (!Array.isArray(trades) || trades.length === 0) {
      return {
        totalTrades: 0,
        buyTrades: 0,
        sellTrades: 0,
        totalVolume: 0,
        avgTradeSize: 0,
        largestTrade: 0,
        uniqueMarkets: 0,
        lastTradeTime: 0,
        consistencyScore: 0,
      };
    }

    const sizes = trades.map((t) => parseFloat(t.size) || 0);
    const markets = new Set(trades.map((t) => t.market));

    const totalVolume = sizes.reduce((s, v) => s + v, 0);
    const avgTradeSize = totalVolume / trades.length;
    const largestTrade = Math.max(...sizes);

    // Consistency score: inverse of coefficient of variation
    // More consistent trade sizes = higher score
    let consistencyScore = 0;
    if (avgTradeSize > 0 && sizes.length > 1) {
      const variance = sizes.reduce((s, v) => s + Math.pow(v - avgTradeSize, 2), 0) / sizes.length;
      const stdDev = Math.sqrt(variance);
      const cv = stdDev / avgTradeSize;
      // cv of 0 = perfect consistency (score 1), cv of 2+ = very inconsistent (score 0)
      consistencyScore = Math.max(0, Math.min(1, 1 - cv / 2));
    }

    const lastTradeTime = new Date(trades[0].timestamp).getTime();

    return {
      totalTrades: trades.length,
      buyTrades: trades.filter((t) => t.side === 'BUY').length,
      sellTrades: trades.filter((t) => t.side === 'SELL').length,
      totalVolume,
      avgTradeSize,
      largestTrade,
      uniqueMarkets: markets.size,
      lastTradeTime,
      consistencyScore,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.debug(`Failed to analyze trades for ${walletAddress.slice(0, 8)}...: ${msg}`);
    return {
      totalTrades: 0,
      buyTrades: 0,
      sellTrades: 0,
      totalVolume: 0,
      avgTradeSize: 0,
      largestTrade: 0,
      uniqueMarkets: 0,
      lastTradeTime: 0,
      consistencyScore: 0,
    };
  }
}

// ──────────────────────────────────────────────
// Composite Scoring
// ──────────────────────────────────────────────

/**
 * Calculate a composite score for ranking traders.
 * Higher score = better trader to follow.
 *
 * Weights:
 * - P&L: 35% (raw profitability)
 * - Win Rate: 25% (skill indicator)
 * - Volume: 15% (activity level — more active = more copy opportunities)
 * - Consistency: 15% (reliable vs lucky)
 * - Recency: 10% (recently active traders preferred)
 */
function calculateScore(
  entry: LeaderboardEntry,
  analysis: TradeAnalysis,
): number {
  const pnl = entry.pnl || 0;
  const winRate = entry.winRate || 0;
  const volume = entry.volume || 0;

  // Normalize each metric to 0-1 scale
  // P&L: positive is good, clamp to reasonable range
  const pnlScore = Math.max(0, Math.min(1, (pnl + 10_000) / 20_000));

  // Win rate: already 0-1
  const winRateScore = winRate;

  // Volume: log scale (a trader with $1M volume isn't 10x better than $100k)
  const volumeScore = volume > 0 ? Math.min(1, Math.log10(volume) / 7) : 0; // 7 = log10(10M)

  // Consistency: from trade analysis
  const consistencyScore = analysis.consistencyScore;

  // Recency: prefer traders active in last 24h
  const hoursSinceLastTrade = analysis.lastTradeTime > 0
    ? (Date.now() - analysis.lastTradeTime) / (1000 * 60 * 60)
    : 999;
  const recencyScore = Math.max(0, 1 - hoursSinceLastTrade / 168); // 168 = 1 week

  // Weighted composite
  const score =
    pnlScore * 0.35 +
    winRateScore * 0.25 +
    volumeScore * 0.15 +
    consistencyScore * 0.15 +
    recencyScore * 0.10;

  return Math.round(score * 1000) / 1000;
}

// ──────────────────────────────────────────────
// Main Leaderboard Scraper
// ──────────────────────────────────────────────

export class LeaderboardScraper {
  private config: LeaderboardConfig;
  private cachedProfiles: TraderProfile[] = [];
  private lastRefreshTime = 0;

  constructor(config: LeaderboardConfig) {
    this.config = config;
  }

  /**
   * Discover top traders from the Polymarket leaderboard.
   * Returns a filtered and ranked list of trader profiles.
   */
  async discover(): Promise<TraderProfile[]> {
    log.info('🔍 Discovering top Polymarket traders...');

    // Step 1: Fetch raw leaderboard data
    const leaderboard = await this.fetchLeaderboard();
    if (leaderboard.length === 0) {
      log.warn('No leaderboard data available');
      return this.cachedProfiles; // Return cached if available
    }

    log.info(`Fetched ${leaderboard.length} traders from leaderboard`);

    // Step 2: Filter by minimum criteria
    const candidates = leaderboard.filter((entry) => {
      const pnl = entry.pnl || 0;
      const winRate = entry.winRate || 0;
      const trades = entry.numTrades || 0;
      return (
        pnl >= this.config.minPnl &&
        winRate >= this.config.minWinRate &&
        trades >= this.config.minTrades
      );
    });

    log.info(`${candidates.length} traders pass minimum filters (PnL≥$${this.config.minPnl}, WR≥${(this.config.minWinRate * 100).toFixed(0)}%, trades≥${this.config.minTrades})`);

    if (candidates.length === 0) {
      log.warn('No traders pass minimum filters — try relaxing criteria');
      return this.cachedProfiles;
    }

    // Step 3: Analyze each candidate's recent trades (for consistency scoring)
    log.info(`Analyzing trade history for ${Math.min(candidates.length, this.config.maxWallets * 2)} candidates...`);

    const analyzed: { entry: LeaderboardEntry; profile: TraderProfile }[] = [];
    const toAnalyze = candidates.slice(0, this.config.maxWallets * 2); // Analyze 2x to have enough after scoring

    for (const entry of toAnalyze) {
      const wallet = (entry.proxyWallet || entry.address || '').toLowerCase();
      if (!wallet) continue;

      const analysis = await analyzeTraderTrades(wallet);
      const score = calculateScore(entry, analysis);

      const profile: TraderProfile = {
        walletAddress: wallet,
        displayName: entry.name || `${wallet.slice(0, 6)}...${wallet.slice(-4)}`,
        pnl: entry.pnl || 0,
        volume: entry.volume || 0,
        winRate: entry.winRate || 0,
        tradeCount: entry.numTrades || analysis.totalTrades,
        profitFactor: this.estimateProfitFactor(entry.winRate || 0, entry.pnl || 0),
        score,
        topCategories: [],
        lastTradeTimestamp: analysis.lastTradeTime,
      };

      analyzed.push({ entry, profile });

      // Small delay to avoid rate limiting
      await this.sleep(50);
    }

    // Step 4: Rank by composite score and take top N
    analyzed.sort((a, b) => b.profile.score - a.profile.score);
    const topTraders = analyzed.slice(0, this.config.maxWallets).map((a) => a.profile);

    // Cache results
    this.cachedProfiles = topTraders;
    this.lastRefreshTime = Date.now();

    // Step 5: Print results
    this.printLeaderboard(topTraders);

    return topTraders;
  }

  /**
   * Get cached trader profiles (avoids re-fetching if recently refreshed).
   */
  getCached(): TraderProfile[] {
    return this.cachedProfiles;
  }

  /**
   * Check if the leaderboard needs refreshing.
   */
  needsRefresh(): boolean {
    if (this.cachedProfiles.length === 0) return true;
    const elapsed = (Date.now() - this.lastRefreshTime) / (1000 * 60);
    return elapsed >= this.config.refreshIntervalMinutes;
  }

  /**
   * Get wallet addresses from the current leaderboard.
   */
  getWalletAddresses(): string[] {
    return this.cachedProfiles.map((p) => p.walletAddress);
  }

  // ──────────────────────────────────────────────
  // Internal
  // ──────────────────────────────────────────────

  /**
   * Fetch the raw leaderboard from the Polymarket Data API.
   */
  private async fetchLeaderboard(): Promise<LeaderboardEntry[]> {
    const params = new URLSearchParams({
      limit: String(this.config.fetchLimit),
    });

    // Add optional filters
    if (this.config.timePeriod) params.set('timePeriod', this.config.timePeriod);
    if (this.config.category) params.set('category', this.config.category);
    if (this.config.orderBy) params.set('orderBy', this.config.orderBy);

    const url = `${DATA_API_BASE}/leaderboard?${params}`;
    log.debug(`Fetching leaderboard: ${url}`);

    try {
      const response = await proxyFetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        throw new Error(`Leaderboard API returned ${response.status}: ${response.statusText}`);
      }

      const data = (await response.json()) as LeaderboardEntry[] | { data?: LeaderboardEntry[] };
      // Handle both array and wrapped response formats
      if (Array.isArray(data)) return data;
      if (data && typeof data === 'object' && 'data' in data && Array.isArray(data.data)) {
        return data.data;
      }

      log.warn('Unexpected leaderboard response format');
      return [];
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`Failed to fetch leaderboard: ${msg}`);
      return [];
    }
  }

  /**
   * Estimate profit factor from win rate and P&L.
   * profitFactor = (wins / losses) * (avg_win / avg_loss)
   * We approximate this from available data.
   */
  private estimateProfitFactor(winRate: number, pnl: number): number {
    if (winRate <= 0 || winRate >= 1) return 1;
    // If P&L is positive and win rate is high, profit factor is likely > 1
    const winLossRatio = winRate / (1 - winRate);
    // Adjust by P&L direction
    const pnlMultiplier = pnl > 0 ? 1 + Math.log10(Math.abs(pnl) + 1) / 5 : 0.5;
    return Math.round(winLossRatio * pnlMultiplier * 100) / 100;
  }

  /**
   * Print the discovered leaderboard in a formatted table.
   */
  private printLeaderboard(profiles: TraderProfile[]): void {
    console.log('');
    console.log('═'.repeat(80));
    console.log('🏆  Discovered Top Traders');
    console.log('═'.repeat(80));
    console.log(
      '#'.padStart(3) +
      '  Wallet'.padEnd(18) +
      'P&L'.padStart(12) +
      'Win Rate'.padStart(10) +
      'Trades'.padStart(8) +
      'Volume'.padStart(14) +
      'Score'.padStart(8),
    );
    console.log('─'.repeat(80));

    for (let i = 0; i < profiles.length; i++) {
      const p = profiles[i];
      console.log(
        `${i + 1}`.padStart(3) +
        `  ${p.displayName}`.padEnd(18) +
        `$${p.pnl.toFixed(0)}`.padStart(12) +
        `${(p.winRate * 100).toFixed(1)}%`.padStart(10) +
        `${p.tradeCount}`.padStart(8) +
        `$${p.volume.toFixed(0)}`.padStart(14) +
        `${p.score.toFixed(3)}`.padStart(8),
      );
    }

    console.log('─'.repeat(80));
    console.log(`  ${profiles.length} traders selected for copy-trading`);
    console.log('');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

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
import { discoverSmartMoney, getBullpenLeaderboard } from './bullpen';

const DATA_API_BASE = 'https://data-api.polymarket.com/v1';

// ──────────────────────────────────────────────
// Leaderboard API Response Types
// ──────────────────────────────────────────────

interface LeaderboardEntry {
  proxyWallet: string;
  address?: string;
  pnl?: number;
  volume?: number;
  vol?: number; // API uses 'vol' not 'volume'
  numTrades?: number;
  winRate?: number;
  name?: string;
  userName?: string; // API uses 'userName' not 'name'
  rank?: number | string;
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

    const sizes = trades.map((t) => typeof t.size === 'number' ? t.size : parseFloat(String(t.size)) || 0);
    const markets = new Set(trades.map((t) => t.conditionId));

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

    const lastTradeTime = typeof trades[0].timestamp === 'number' ? trades[0].timestamp * 1000 : new Date(trades[0].timestamp).getTime();

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
 * Note: Win rate is not available from the Polymarket Data API,
 * so we omit it and redistribute weight to other signals.
 *
 * Weights:
 * - P&L: 40% (raw profitability — strongest available signal)
 * - Volume: 20% (activity level — more active = more copy opportunities)
 * - Consistency: 20% (reliable vs lucky)
 * - Recency: 10% (recently active traders preferred)
 * - Trade count: 10% (more trades = more data = more reliable signal)
 */
function calculateScore(
  entry: LeaderboardEntry,
  analysis: TradeAnalysis,
): number {
  const pnl = entry.pnl || 0;
  const volume = entry.volume || 0;

  // Normalize each metric to 0-1 scale
  // P&L: positive is good, clamp to reasonable range
  const pnlScore = Math.max(0, Math.min(1, (pnl + 10_000) / 20_000));

  // Volume: log scale (a trader with $1M volume isn't 10x better than $100k)
  const volumeScore = volume > 0 ? Math.min(1, Math.log10(volume) / 7) : 0; // 7 = log10(10M)

  // Consistency: from trade analysis
  const consistencyScore = analysis.consistencyScore;

  // Recency: prefer traders active in last 24h
  const hoursSinceLastTrade = analysis.lastTradeTime > 0
    ? (Date.now() - analysis.lastTradeTime) / (1000 * 60 * 60)
    : 999;
  const recencyScore = Math.max(0, 1 - hoursSinceLastTrade / 168); // 168 = 1 week

  // Trade count: more trades = more reliable signal (log scale, 100 trades = max)
  const tradeCountScore = analysis.totalTrades > 0 ? Math.min(1, Math.log10(analysis.totalTrades) / 2) : 0;

  // Weighted composite
  const score =
    pnlScore * 0.40 +
    volumeScore * 0.20 +
    consistencyScore * 0.20 +
    recencyScore * 0.10 +
    tradeCountScore * 0.10;

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

    // Step 0: Try Bullpen smart money first (better signals, whale tracking)
    let bullpenProfiles: TraderProfile[] = [];
    try {
      const smartMoney = await discoverSmartMoney({ type: 'top_traders', limit: this.config.fetchLimit });
      if (smartMoney.length > 0) {
        bullpenProfiles = smartMoney.filter((p) =>
          p.pnl >= this.config.minPnl &&
          p.winRate >= this.config.minWinRate &&
          p.tradeCount >= this.config.minTrades
        );
        log.info(`Bullpen smart money: ${bullpenProfiles.length} traders pass filters`);
      }
    } catch (error) {
      log.debug('Bullpen smart money unavailable, falling back to Polymarket API');
    }

    // Step 1: Fetch raw leaderboard data (from Polymarket API or Bullpen)
    let leaderboard: LeaderboardEntry[];
    if (bullpenProfiles.length >= this.config.maxWallets) {
      // Bullpen provided enough — skip Polymarket API
      const topBullpen = bullpenProfiles
        .sort((a, b) => b.score - a.score)
        .slice(0, this.config.maxWallets);
      this.cachedProfiles = topBullpen;
      this.lastRefreshTime = Date.now();
      this.printLeaderboard(topBullpen);
      return topBullpen;
    }
    leaderboard = await this.fetchLeaderboard();
    if (leaderboard.length === 0) {
      log.warn('No leaderboard data available');
      return this.cachedProfiles; // Return cached if available
    }

    log.info(`Fetched ${leaderboard.length} traders from leaderboard`);

    // Step 2: Filter by minimum criteria
    // Normalize fields: API uses 'vol' and 'userName', code expects 'volume' and 'name'
    for (const entry of leaderboard) {
      if (entry.vol !== undefined && entry.volume === undefined) entry.volume = entry.vol;
      if (entry.userName !== undefined && !entry.name) entry.name = entry.userName;
      if (typeof entry.rank === 'string') entry.rank = parseInt(entry.rank, 10);
    }

    // The leaderboard API doesn't return winRate or numTrades.
    // We only filter by P&L here; win rate and trade count are determined
    // later by analyzing individual trade history.
    const candidates = leaderboard.filter((entry) => {
      const pnl = entry.pnl || 0;
      return pnl >= this.config.minPnl;
    });

    log.info(`${candidates.length} traders pass P&L filter (≥$${this.config.minPnl}) — analyzing trade history next`);

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

      // Filter by minimum trade count (API doesn't provide win rate data)
      if (analysis.totalTrades < this.config.minTrades) {
        log.debug(`Skipping ${wallet.slice(0, 8)}...: only ${analysis.totalTrades} trades (need ≥${this.config.minTrades})`);
        continue;
      }

      const score = calculateScore(entry, analysis);

      const profile: TraderProfile = {
        walletAddress: wallet,
        displayName: entry.name || `${wallet.slice(0, 6)}...${wallet.slice(-4)}`,
        pnl: entry.pnl || 0,
        volume: entry.volume || 0,
        winRate: 0, // Not available from Data API
        tradeCount: analysis.totalTrades,
        profitFactor: 0, // Cannot calculate without win/loss data
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
   * Print the discovered leaderboard in a formatted table.
   */
  private printLeaderboard(profiles: TraderProfile[]): void {
    console.log('');
    console.log('═'.repeat(65));
    console.log('🏆  Discovered Top Traders');
    console.log('═'.repeat(65));
    console.log(
      '#'.padStart(3) +
      '  Wallet'.padEnd(18) +
      'P&L'.padStart(12) +
      'Volume'.padStart(14) +
      'Trades'.padStart(8) +
      'Score'.padStart(8),
    );
    console.log('─'.repeat(65));

    for (let i = 0; i < profiles.length; i++) {
      const p = profiles[i];
      console.log(
        `${i + 1}`.padStart(3) +
        `  ${p.displayName}`.padEnd(18) +
        `$${p.pnl.toFixed(0)}`.padStart(12) +
        `$${p.volume.toFixed(0)}`.padStart(14) +
        `${p.tradeCount}`.padStart(8) +
        `${p.score.toFixed(3)}`.padStart(8),
      );
    }

    console.log('─'.repeat(65));
    console.log(`  ${profiles.length} traders selected for copy-trading`);
    console.log('');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

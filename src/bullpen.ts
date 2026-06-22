/**
 * Bullpen.fi Integration
 * Wraps the Bullpen CLI for:
 * 1. Smart Money Discovery — find top traders via bullpen polymarket data smart-money
 * 2. Market Data Enrichment — get real-time prices, orderbook depth, spreads
 * 3. CLI Execution Fallback — execute trades via bullpen polymarket buy/sell
 *
 * Requires: `npm install -g @bullpenfi/cli` and `bullpen login`
 * Enable experimental features: `bullpen experimental enable prediction_analytics`
 */

import { execSync, exec } from 'child_process';
import { log } from './logger';
import { TraderProfile } from './types';

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

interface BullpenTrader {
  address: string;
  nickname?: string;
  pnl?: number;
  volume?: number;
  win_rate?: number;
  trades?: number;
  rank?: number;
  score?: number;
  recent_activity?: string;
  [key: string]: unknown;
}

interface BullpenMarketPrice {
  market: string;
  slug?: string;
  yes_bid?: number;
  yes_ask?: number;
  last_price?: number;
  spread?: number;
  volume_24h?: number;
  [key: string]: unknown;
}

interface BullpenOrderbook {
  market: string;
  bids: Array<{ price: number; size: number }>;
  asks: Array<{ price: number; size: number }>;
  spread?: number;
  mid_price?: number;
  depth_yes?: number;
  depth_no?: number;
  [key: string]: unknown;
}

export interface BullpenMarketData {
  price: BullpenMarketPrice | null;
  orderbook: BullpenOrderbook | null;
}

export interface BullpenTradeResult {
  success: boolean;
  orderId?: string;
  error?: string;
  details?: string;
}

// ──────────────────────────────────────────────
// CLI Detection
// ──────────────────────────────────────────────

let _cliAvailable: boolean | null = null;
let _authenticated: boolean | null = null;

/**
 * Check if the Bullpen CLI is installed and authenticated.
 */
export function isBullpenAvailable(): boolean {
  if (_cliAvailable !== null) return _cliAvailable;

  try {
    const version = execSync('bullpen --version', {
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString().trim();
    _cliAvailable = true;
    log.debug(`Bullpen CLI detected: ${version}`);
  } catch {
    _cliAvailable = false;
    log.debug('Bullpen CLI not found');
  }

  return _cliAvailable;
}

/**
 * Check if the Bullpen CLI is authenticated.
 */
export function isBullpenAuthenticated(): boolean {
  if (_authenticated !== null) return _authenticated;

  if (!isBullpenAvailable()) {
    _authenticated = false;
    return false;
  }

  try {
    const status = execSync('bullpen status', {
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString();
    _authenticated = status.toLowerCase().includes('authenticated') ||
                     status.toLowerCase().includes('logged in') ||
                     !status.toLowerCase().includes('not logged in');
  } catch {
    _authenticated = false;
  }

  return _authenticated;
}

// ──────────────────────────────────────────────
// CLI Execution Helper
// ──────────────────────────────────────────────

/**
 * Run a Bullpen CLI command and parse JSON output.
 * Returns null if the command fails or output isn't valid JSON.
 */
function runBullpen<T>(command: string, timeoutMs = 15_000): T | null {
  try {
    const output = execSync(`${command} --output json`, {
      timeout: timeoutMs,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    }).trim();

    if (!output) return null;

    try {
      return JSON.parse(output) as T;
    } catch {
      // Some commands return non-JSON even with --output json flag
      log.debug(`Bullpen CLI returned non-JSON for: ${command}`);
      return null;
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.debug(`Bullpen CLI command failed: ${command} — ${msg}`);
    return null;
  }
}

// ──────────────────────────────────────────────
// Smart Money Discovery
// ──────────────────────────────────────────────

/**
 * Discover top traders via Bullpen's smart money analytics.
 * Returns trader profiles ranked by Bullpen's proprietary score.
 */
export async function discoverSmartMoney(options?: {
  type?: 'top_traders' | 'new_wallet';
  category?: string;
  limit?: number;
}): Promise<TraderProfile[]> {
  if (!isBullpenAvailable()) {
    log.debug('Bullpen CLI not available — skipping smart money discovery');
    return [];
  }

  const type = options?.type || 'top_traders';
  const category = options?.category || '';
  const limit = options?.limit || 20;

  let cmd = `bullpen polymarket data smart-money --type ${type} --limit ${limit}`;
  if (category) cmd += ` --category ${category}`;

  log.info(`Fetching smart money data via Bullpen (${type})...`);

  const data = runBullpen<BullpenTrader[] | { traders?: BullpenTrader[] }>(cmd);

  if (!data) {
    log.warn('Bullpen smart money query returned no data');
    return [];
  }

  const traders = Array.isArray(data) ? data : (data.traders || []);

  // Convert to our TraderProfile format
  const profiles: TraderProfile[] = traders
    .filter((t) => t.address)
    .map((t) => ({
      walletAddress: t.address.toLowerCase(),
      displayName: t.nickname || `${t.address.slice(0, 6)}...${t.address.slice(-4)}`,
      pnl: t.pnl || 0,
      volume: t.volume || 0,
      winRate: t.win_rate || 0,
      tradeCount: t.trades || 0,
      profitFactor: estimateProfitFactor(t.win_rate || 0, t.pnl || 0),
      score: t.score || 0,
      topCategories: category ? [category] : [],
      lastTradeTimestamp: t.recent_activity ? new Date(t.recent_activity).getTime() : 0,
    }));

  log.success(`Bullpen smart money: found ${profiles.length} traders`);
  return profiles;
}

/**
 * Get the Polymarket leaderboard via Bullpen CLI.
 */
export async function getBullpenLeaderboard(options?: {
  period?: 'day' | 'week' | 'month' | 'all';
  limit?: number;
}): Promise<TraderProfile[]> {
  if (!isBullpenAvailable()) return [];

  const period = options?.period || 'week';
  const limit = options?.limit || 20;

  const cmd = `bullpen polymarket data leaderboard --period ${period} --limit ${limit}`;
  log.info(`Fetching Bullpen leaderboard (${period})...`);

  const data = runBullpen<BullpenTrader[] | { traders?: BullpenTrader[] }>(cmd);

  if (!data) return [];

  const traders = Array.isArray(data) ? data : (data.traders || []);

  const profiles: TraderProfile[] = traders
    .filter((t) => t.address)
    .map((t) => ({
      walletAddress: t.address.toLowerCase(),
      displayName: t.nickname || `${t.address.slice(0, 6)}...${t.address.slice(-4)}`,
      pnl: t.pnl || 0,
      volume: t.volume || 0,
      winRate: t.win_rate || 0,
      tradeCount: t.trades || 0,
      profitFactor: estimateProfitFactor(t.win_rate || 0, t.pnl || 0),
      score: t.score || 0,
      topCategories: [],
      lastTradeTimestamp: t.recent_activity ? new Date(t.recent_activity).getTime() : 0,
    }));

  log.success(`Bullpen leaderboard: ${profiles.length} traders`);
  return profiles;
}

/**
 * Get a specific trader's profile and recent activity via Bullpen.
 */
export async function getTraderProfile(address: string): Promise<TraderProfile | null> {
  if (!isBullpenAvailable()) return null;

  const cmd = `bullpen polymarket data profile ${address}`;
  const data = runBullpen<BullpenTrader>(cmd);

  if (!data || !data.address) return null;

  return {
    walletAddress: data.address.toLowerCase(),
    displayName: data.nickname || `${data.address.slice(0, 6)}...${data.address.slice(-4)}`,
    pnl: data.pnl || 0,
    volume: data.volume || 0,
    winRate: data.win_rate || 0,
    tradeCount: data.trades || 0,
    profitFactor: estimateProfitFactor(data.win_rate || 0, data.pnl || 0),
    score: data.score || 0,
    topCategories: [],
    lastTradeTimestamp: data.recent_activity ? new Date(data.recent_activity).getTime() : 0,
  };
}

// ──────────────────────────────────────────────
// Market Data Enrichment
// ──────────────────────────────────────────────

/**
 * Fetch real-time market data from Bullpen (price + orderbook).
 * Used to enrich the AI filter with spread, depth, and liquidity info.
 */
export async function getMarketData(marketSlug: string): Promise<BullpenMarketData> {
  if (!isBullpenAvailable()) {
    return { price: null, orderbook: null };
  }

  // Fetch price and orderbook in parallel
  const [priceData, bookData] = await Promise.allSettled([
    fetchPrice(marketSlug),
    fetchOrderbook(marketSlug),
  ]);

  return {
    price: priceData.status === 'fulfilled' ? priceData.value : null,
    orderbook: bookData.status === 'fulfilled' ? bookData.value : null,
  };
}

async function fetchPrice(marketSlug: string): Promise<BullpenMarketPrice | null> {
  return runBullpen<BullpenMarketPrice>(`bullpen polymarket price ${marketSlug}`, 10_000);
}

async function fetchOrderbook(marketSlug: string): Promise<BullpenOrderbook | null> {
  return runBullpen<BullpenOrderbook>(`bullpen polymarket clob book ${marketSlug}`, 10_000);
}

/**
 * Format Bullpen market data for inclusion in an AI filter prompt.
 */
export function formatMarketDataForPrompt(data: BullpenMarketData): string {
  const lines: string[] = [];

  if (data.price) {
    const p = data.price;
    lines.push('## Bullpen Market Data');
    if (p.yes_bid !== undefined) lines.push(`- YES Bid: $${p.yes_bid.toFixed(4)}`);
    if (p.yes_ask !== undefined) lines.push(`- YES Ask: $${p.yes_ask.toFixed(4)}`);
    if (p.spread !== undefined) lines.push(`- Spread: ${(p.spread * 100).toFixed(2)}%`);
    if (p.last_price !== undefined) lines.push(`- Last Price: $${p.last_price.toFixed(4)}`);
    if (p.volume_24h !== undefined) lines.push(`- 24h Volume: $${p.volume_24h.toFixed(0)}`);
  }

  if (data.orderbook) {
    const book = data.orderbook;
    if (book.mid_price !== undefined) lines.push(`- Mid Price: $${book.mid_price.toFixed(4)}`);
    if (book.depth_yes !== undefined) lines.push(`- YES Depth: $${book.depth_yes.toFixed(0)}`);
    if (book.depth_no !== undefined) lines.push(`- NO Depth: $${book.depth_no.toFixed(0)}`);

    // Top 3 bid/ask levels
    if (book.bids && book.bids.length > 0) {
      const top3 = book.bids.slice(0, 3).map((b) => `$${b.price.toFixed(3)}(${b.size.toFixed(0)})`).join(', ');
      lines.push(`- Top Bids: ${top3}`);
    }
    if (book.asks && book.asks.length > 0) {
      const top3 = book.asks.slice(0, 3).map((a) => `$${a.price.toFixed(3)}(${a.size.toFixed(0)})`).join(', ');
      lines.push(`- Top Asks: ${top3}`);
    }
  }

  if (lines.length > 0) lines.push('');
  return lines.join('\n');
}

// ──────────────────────────────────────────────
// CLI Execution Fallback
// ──────────────────────────────────────────────

/**
 * Execute a trade via Bullpen CLI as a fallback when CLOB API is unavailable.
 * Uses `bullpen polymarket buy` or `bullpen polymarket limit-buy`.
 */
export async function executeTradeViaBullpen(params: {
  marketSlug: string;
  side: 'BUY' | 'SELL';
  outcome: 'Yes' | 'No';
  shares: number;
  maxPrice?: number;
}): Promise<BullpenTradeResult> {
  if (!isBullpenAvailable() || !isBullpenAuthenticated()) {
    return { success: false, error: 'Bullpen CLI not available or not authenticated' };
  }

  const { marketSlug, side, outcome, shares, maxPrice } = params;

  let cmd: string;
  if (side === 'BUY') {
    cmd = `bullpen polymarket buy ${marketSlug} "${outcome}" ${shares.toFixed(2)}`;
    if (maxPrice) cmd += ` --max-price ${maxPrice.toFixed(4)}`;
  } else {
    cmd = `bullpen polymarket sell ${marketSlug} "${outcome}" ${shares.toFixed(2)}`;
    if (maxPrice) cmd += ` --min-price ${maxPrice.toFixed(4)}`;
  }

  log.info(`[BULLPEN] Executing: ${cmd}`);

  try {
    const output = execSync(cmd, {
      timeout: 30_000,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    }).trim();

    // Try to parse JSON response
    try {
      const result = JSON.parse(output) as { order_id?: string; id?: string; success?: boolean; error?: string };
      if (result.error) {
        return { success: false, error: result.error, details: output };
      }
      return {
        success: true,
        orderId: result.order_id || result.id || 'unknown',
        details: output,
      };
    } catch {
      // Non-JSON output — check for success indicators
      if (output.toLowerCase().includes('success') || output.toLowerCase().includes('filled')) {
        return { success: true, details: output };
      }
      return { success: false, error: 'Unexpected output from Bullpen CLI', details: output };
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error(`[BULLPEN] Trade execution failed: ${msg}`);
    return { success: false, error: msg };
  }
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function estimateProfitFactor(winRate: number, pnl: number): number {
  if (winRate <= 0 || winRate >= 1) return 1;
  const winLossRatio = winRate / (1 - winRate);
  const pnlMultiplier = pnl > 0 ? 1 + Math.log10(Math.abs(pnl) + 1) / 5 : 0.5;
  return Math.round(winLossRatio * pnlMultiplier * 100) / 100;
}

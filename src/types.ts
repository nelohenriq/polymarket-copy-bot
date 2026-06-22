/**
 * Type definitions for the Polymarket Copy-Trading Bot
 */

// ──────────────────────────────────────────────
// Configuration
// ──────────────────────────────────────────────

export interface BotConfig {
  /** EOA private key for signing */
  privateKey: string;
  /** Wallet addresses to copy-trade */
  targetWallets: string[];
  /** Polygon RPC endpoint */
  rpcUrl: string;
  /** Position size multiplier relative to target */
  positionMultiplier: number;
  /** Maximum single trade size in USDC */
  maxTradeSize: number;
  /** Minimum trade size in USDC */
  minTradeSize: number;
  /** Order type for copy trades */
  orderType: CopyOrderType;
  /** Slippage tolerance (e.g. 0.02 = 2%) */
  slippageTolerance: number;
  /** Maximum total session notional (0 = unlimited) */
  maxSessionNotional: number;
  /** Maximum per-market notional (0 = unlimited) */
  maxPerMarketNotional: number;
  /** Daily loss limit as fraction */
  dailyLossLimit: number;
  /** Max drawdown from peak */
  maxDrawdown: number;
  /** Total loss limit (permanent halt) */
  totalLossLimit: number;
  /** Enable WebSocket monitoring */
  useWebsocket: boolean;
  /** REST polling interval in ms */
  pollInterval: number;
  /** Log level */
  logLevel: LogLevel;
  /** Simulation mode */
  dryRun: boolean;
  /** Proxy URL for routing API traffic (SOCKS5, HTTP, HTTPS) */
  proxyUrl?: string;
  /** WebSocket RPC URL for on-chain settlement monitoring (e.g. Alchemy wss://...) */
  wsRpcUrl?: string;
  /** Telegram bot token for notifications */
  telegramBotToken?: string;
  /** Telegram chat ID to send notifications to */
  telegramChatId?: string;
  /** FinFeedAPI key for cross-platform market data (paid) */
  finfeedApiKey?: string;
  /** Enable Bullpen.fi integration for smart money, market data, and fallback execution */
  bullpenEnabled?: boolean;
}

export type CopyOrderType = 'FOK' | 'GTC' | 'FAK';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// ──────────────────────────────────────────────
// Data API Types
// ──────────────────────────────────────────────

/** Raw trade from Polymarket Data API /activity endpoint */
export interface DataApiTrade {
  id: string;
  timestamp: string;
  market: string;
  asset_id: string;
  side: 'BUY' | 'SELL';
  size: string;
  price: string;
  user: string;
  outcome: string;
  title: string;
  slug: string;
  /** Additional fields from the API */
  condition_id?: string;
  transaction_hash?: string;
}

/** Parsed trade ready for copy execution */
export interface ParsedTrade {
  id: string;
  timestamp: number;
  market: string;
  tokenId: string;
  side: 'BUY' | 'SELL';
  size: number;
  price: number;
  user: string;
  outcome: string;
  title: string;
}

// ──────────────────────────────────────────────
// Market Data
// ──────────────────────────────────────────────

export interface MarketBook {
  bids: BookEntry[];
  asks: BookEntry[];
  hash: string;
  market: string;
  asset_id: string;
  timestamp: string;
}

export interface BookEntry {
  price: string;
  size: string;
}

export interface MarketInfo {
  conditionId: string;
  questionId: string;
  question: string;
  tokens: {
    tokenId: string;
    outcome: string;
  }[];
  negRisk: boolean;
  active: boolean;
  enableOrderBook: boolean;
}

// ──────────────────────────────────────────────
// Position Tracking
// ──────────────────────────────────────────────

export interface Position {
  tokenId: string;
  market: string;
  outcome: string;
  shares: number;
  notional: number;
  avgPrice: number;
  lastUpdated: number;
}

// ──────────────────────────────────────────────
// Risk Management
// ──────────────────────────────────────────────

export interface RiskCheckResult {
  allowed: boolean;
  reason?: string;
}

export interface RiskState {
  sessionNotional: number;
  sessionPnl: number;
  peakCapital: number;
  dailyLoss: number;
  consecutiveLosses: number;
  consecutiveWins: number;
  halted: boolean;
  haltReason?: string;
}

// ──────────────────────────────────────────────
// Execution
// ──────────────────────────────────────────────

export interface CopyTradeResult {
  success: boolean;
  orderId?: string;
  copyNotional: number;
  copyShares: number;
  price: number;
  side: 'BUY' | 'SELL';
  error?: string;
}

// ──────────────────────────────────────────────
// WebSocket
// ──────────────────────────────────────────────

export interface WsSubscribeMessage {
  type: 'market' | 'user';
  assets_ids?: string[];
  markets?: string[];
  auth?: {
    apikey: string;
    apiKey: string;
    secret: string;
    passphrase: string;
  };
}

export interface WsTradeMessage {
  event_type: 'trade';
  asset_id: string;
  side: 'BUY' | 'SELL';
  price: string;
  size: string;
  timestamp: string;
  maker?: string;
  taker?: string;
  fee_rate_bps?: string;
}

export interface WsBookMessage {
  event_type: 'book';
  asset_id: string;
  bids: BookEntry[];
  asks: BookEntry[];
  hash: string;
  timestamp: string;
}

// ──────────────────────────────────────────────
// Session Stats
// ──────────────────────────────────────────────

export interface SessionStats {
  startTime: number;
  tradesDetected: number;
  tradesCopied: number;
  tradesSkipped: number;
  tradesFailed: number;
  tradesAiRejected: number;
  totalVolume: number;
  totalPnl: number;
}

// ──────────────────────────────────────────────
// AI Trade Filtering
// ──────────────────────────────────────────────

export type LLMProvider = 'openai' | 'anthropic' | 'openrouter' | 'custom';

/** Configuration for AI-powered trade filtering */
export interface AIFilterConfig {
  /** Enable AI filtering */
  enabled: boolean;
  /** LLM provider */
  provider: LLMProvider;
  /** API key for the LLM provider */
  apiKey: string;
  /** Model to use (e.g. 'gpt-4o', 'claude-sonnet-4-20250514', 'anthropic/claude-sonnet-4-20250514') */
  model: string;
  /** Custom API base URL (required when provider='custom', e.g. 'http://localhost:11434/v1' for Ollama) */
  baseUrl?: string;
  /** Second model for ensemble consensus (optional) */
  secondModel?: string;
  /** Minimum AI confidence to approve trade (0.0-1.0) */
  minConfidence: number;
  /** Minimum probability edge over market price to approve (e.g. 0.05 = 5%) */
  minEdge: number;
  /** Cache analysis results for N minutes to avoid re-analyzing same market */
  cacheMinutes: number;
  /** Max API calls per minute (rate limiting) */
  maxCallsPerMinute: number;
  /** Timeout for LLM API calls in seconds */
  timeoutSeconds: number;
  /** If true, AI errors will approve the trade (fail-open). If false, reject on error (fail-closed). */
  failOpen: boolean;
}

/** Probability estimate from a single LLM model */
export interface AIProbabilityEstimate {
  model: string;
  probability: number; // 0.0-1.0 estimated true probability
  confidence: number; // 0.0-1.0 how confident the model is
  reasoning: string;
  keyFactors: string[];
  timestamp: number;
}

/** Final AI filter decision */
export interface AIFilterResult {
  approved: boolean;
  ensembleProbability: number;
  marketPrice: number;
  edge: number; // ensemble - market
  confidence: number;
  reasoning: string;
  estimates: AIProbabilityEstimate[];
  cached: boolean;
  latencyMs: number;
}

// ──────────────────────────────────────────────
// Paper Trading & Backtesting
// ──────────────────────────────────────────────

/** A simulated trade in the paper trading journal */
export interface TradeJournalEntry {
  tradeId: string;
  timestamp: number;
  market: string;
  tokenId: string;
  outcome: string;
  side: 'BUY' | 'SELL';
  size: number;
  entryPrice: number;
  exitPrice?: number;
  exitTimestamp?: number;
  pnl?: number;
  holdTimeMs?: number;
  reason: string;
  source: string; // e.g. 'copy-trade', 'signal', 'manual'
}

/** Snapshot of the virtual portfolio at a point in time */
export interface PortfolioSnapshot {
  timestamp: number;
  cash: number;
  positions: Position[];
  totalValue: number;
  unrealizedPnl: number;
  realizedPnl: number;
}

/** Performance metrics calculated from trade history */
export interface PerformanceMetrics {
  totalReturn: number;
  totalReturnPct: number;
  annualizedReturn: number;
  sharpeRatio: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  winRate: number;
  averageWin: number;
  averageLoss: number;
  profitFactor: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  averageHoldTimeMs: number;
  longestHoldTimeMs: number;
  shortestHoldTimeMs: number;
  consecutiveWins: number;
  consecutiveLosses: number;
  calmarRatio: number;
}

/** Configuration for paper trading mode */
export interface PaperTradingConfig {
  startingCapital: number;
  /** How to simulate fills: 'target_price' = fill at target's price, 'market_price' = fill at market mid */
  fillMode: 'target_price' | 'market_price';
  /** Simulated slippage in basis points */
  simulatedSlippageBps: number;
  /** Simulated gas cost per trade in USDC */
  simulatedGasCost: number;
  /** Auto-close positions after market resolution */
  autoCloseOnResolution: boolean;
  /** Export trade journal on exit */
  exportOnExit: boolean;
  /** Export format */
  exportFormat: 'json' | 'csv';
}

/** Configuration for backtesting mode */
export interface BacktestConfig {
  /** Start time for backtest (ISO string or epoch ms) */
  startTime: number;
  /** End time for backtest */
  endTime: number;
  /** Starting capital */
  startingCapital: number;
  /** Target wallets to backtest against */
  targetWallets: string[];
  /** Simulated slippage in basis points */
  simulatedSlippageBps: number;
  /** Simulated gas cost per trade */
  simulatedGasCost: number;
  /** Speed multiplier (1 = realtime, 10 = 10x faster) */
  speedMultiplier: number;
  /** Export results on completion */
  exportResults: boolean;
  /** Export format */
  exportFormat: 'json' | 'csv';
}

/** Complete backtest result */
export interface BacktestResult {
  config: BacktestConfig;
  metrics: PerformanceMetrics;
  journal: TradeJournalEntry[];
  snapshots: PortfolioSnapshot[];
  startTime: number;
  endTime: number;
  durationMs: number;
}

// ──────────────────────────────────────────────
// Market Intelligence
// ──────────────────────────────────────────────

export type EventCategory =
  | 'political'
  | 'economic'
  | 'sports'
  | 'crypto'
  | 'regulatory'
  | 'technology'
  | 'geopolitical'
  | 'social'
  | 'weather'
  | 'entertainment'
  | 'other';

export type SentimentScore = 'bullish' | 'bearish' | 'neutral';

/** A news event or signal detected by the intelligence system */
export interface MarketEvent {
  id: string;
  source: string;
  sourceUrl?: string;
  timestamp: number;
  title: string;
  content: string;
  category: EventCategory;
  sentiment: SentimentScore;
  sentimentConfidence: number; // 0.0 to 1.0
  impactScore: number; // 0.0 to 1.0 (how likely to move markets)
  keywords: string[];
  relatedMarkets: string[]; // market slugs or condition IDs
}

/** Correlation between an event and a market price movement */
export interface EventCorrelation {
  eventId: string;
  marketSlug: string;
  priceBefore: number;
  priceAfter: number;
  priceChange: number;
  priceChangePct: number;
  timeToImpactMs: number;
  category: EventCategory;
}

/** Alert for high-impact events */
export interface MarketAlert {
  id: string;
  timestamp: number;
  severity: 'low' | 'medium' | 'high' | 'critical';
  event: MarketEvent;
  suggestedAction: string;
  affectedMarkets: string[];
}

/** Configuration for the market intelligence system */
export interface IntelligenceConfig {
  /** RSS feed URLs to monitor */
  rssFeeds: string[];
  /** Polling interval in ms */
  pollIntervalMs: number;
  /** Minimum impact score to trigger alert (0.0-1.0) */
  alertThreshold: number;
  /** Categories to monitor (empty = all) */
  categories: EventCategory[];
  /** Keywords to boost impact score */
  watchKeywords: string[];
  /** Enable LLM-powered analysis (requires OPENAI_API_KEY or ANTHROPIC_API_KEY) */
  useLLM: boolean;
  /** LLM API key */
  llmApiKey?: string;
  /** LLM provider */
  llmProvider?: 'openai' | 'anthropic';
  /** Export events on exit */
  exportOnExit: boolean;
}

/** Historical event-price correlation data for learning */
export interface CorrelationRecord {
  category: EventCategory;
  keywords: string[];
  avgImpactScore: number;
  avgPriceChangePct: number;
  sampleSize: number;
  lastUpdated: number;
}

// ──────────────────────────────────────────────
// Leaderboard / Trader Discovery
// ──────────────────────────────────────────────

/** Configuration for automatic trader discovery */
export interface LeaderboardConfig {
  /** Enable auto-discovery of top traders at startup */
  enabled: boolean;
  /** Time period for leaderboard ranking */
  timePeriod: 'DAY' | 'WEEK' | 'MONTH' | 'ALL';
  /** Market category to filter by */
  category: 'OVERALL' | 'POLITICS' | 'CRYPTO' | 'SPORTS' | 'SCIENCE';
  /** How to rank traders */
  orderBy: 'PNL' | 'VOLUME' | 'WIN_RATE';
  /** Number of top traders to fetch from leaderboard */
  fetchLimit: number;
  /** Minimum P&L to qualify (USD) */
  minPnl: number;
  /** Minimum win rate (0.0-1.0) */
  minWinRate: number;
  /** Minimum number of trades to qualify */
  minTrades: number;
  /** Maximum number of wallets to copy-trade */
  maxWallets: number;
  /** How often to refresh the leaderboard (minutes) */
  refreshIntervalMinutes: number;
}

/** A discovered trader profile from the leaderboard */
export interface TraderProfile {
  /** Wallet address (proxy wallet) */
  walletAddress: string;
  /** Display name or shortened address */
  displayName: string;
  /** Total P&L in USD */
  pnl: number;
  /** Total volume traded in USD */
  volume: number;
  /** Win rate (0.0-1.0) */
  winRate: number;
  /** Number of trades */
  tradeCount: number;
  /** Profit factor (wins / losses) */
  profitFactor: number;
  /** Composite score used for ranking (higher = better) */
  score: number;
  /** Market categories this trader excels in */
  topCategories: string[];
  /** Last trade timestamp */
  lastTradeTimestamp: number;
}

/**
 * Configuration loader
 * Reads environment variables and validates all required settings.
 */

import * as dotenv from 'dotenv';
import { BotConfig, CopyOrderType, LogLevel, AIFilterConfig, LeaderboardConfig, PaperTradingConfig, BacktestConfig, IntelligenceConfig, EventCategory } from './types';

dotenv.config();

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optionalEnv(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

function parseFloatEnv(key: string, defaultValue: number): number {
  const raw = process.env[key];
  if (!raw) return defaultValue;
  const parsed = parseFloat(raw);
  if (isNaN(parsed)) {
    throw new Error(`Invalid number for ${key}: ${raw}`);
  }
  return parsed;
}

function parseBoolEnv(key: string, defaultValue: boolean): boolean {
  const raw = process.env[key];
  if (!raw) return defaultValue;
  return raw.toLowerCase() === 'true';
}

const VALID_ORDER_TYPES: CopyOrderType[] = ['FOK', 'GTC', 'FAK'];
const VALID_LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

/**
 * Load the main bot configuration.
 * @param allowMissingKey - If true, PRIVATE_KEY is optional (used for backtest mode)
 */
export function loadConfig(allowMissingKey = false): BotConfig {
  const orderType = optionalEnv('ORDER_TYPE', 'FOK') as CopyOrderType;
  if (!VALID_ORDER_TYPES.includes(orderType)) {
    throw new Error(`Invalid ORDER_TYPE: ${orderType}. Must be one of: ${VALID_ORDER_TYPES.join(', ')}`);
  }

  const logLevel = optionalEnv('LOG_LEVEL', 'info') as LogLevel;
  if (!VALID_LOG_LEVELS.includes(logLevel)) {
    throw new Error(`Invalid LOG_LEVEL: ${logLevel}. Must be one of: ${VALID_LOG_LEVELS.join(', ')}`);
  }

  // TARGET_WALLETS can be empty if AUTO_DISCOVER_WALLETS is enabled
  const autoDiscover = parseBoolEnv('AUTO_DISCOVER_WALLETS', false);
  const targetWalletsRaw = process.env['TARGET_WALLETS'] || '';
  const targetWallets = targetWalletsRaw
    .split(',')
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w.length > 0);

  if (targetWallets.length === 0 && !autoDiscover) {
    throw new Error('TARGET_WALLETS must contain at least one wallet address (or enable AUTO_DISCOVER_WALLETS)');
  }

  const config: BotConfig = {
    privateKey: allowMissingKey ? (process.env['PRIVATE_KEY'] || '0x' + '00'.repeat(32)) : requireEnv('PRIVATE_KEY'),
    targetWallets,
    rpcUrl: optionalEnv('RPC_URL', 'https://polygon-rpc.com'),
    positionMultiplier: parseFloatEnv('POSITION_MULTIPLIER', 0.1),
    maxTradeSize: parseFloatEnv('MAX_TRADE_SIZE', 100),
    minTradeSize: parseFloatEnv('MIN_TRADE_SIZE', 1),
    orderType,
    slippageTolerance: parseFloatEnv('SLIPPAGE_TOLERANCE', 0.02),
    maxSessionNotional: parseFloatEnv('MAX_SESSION_NOTIONAL', 1000),
    maxPerMarketNotional: parseFloatEnv('MAX_PER_MARKET_NOTIONAL', 200),
    dailyLossLimit: parseFloatEnv('DAILY_LOSS_LIMIT', 0.05),
    maxDrawdown: parseFloatEnv('MAX_DRAWDOWN', 0.25),
    totalLossLimit: parseFloatEnv('TOTAL_LOSS_LIMIT', 0.40),
    useWebsocket: parseBoolEnv('USE_WEBSOCKET', true),
    pollInterval: parseFloatEnv('POLL_INTERVAL', 3000),
    logLevel,
    dryRun: parseBoolEnv('DRY_RUN', true),
    proxyUrl: process.env['PROXY_URL'] || undefined,
    wsRpcUrl: process.env['WS_RPC_URL'] || undefined,
    telegramBotToken: process.env['TELEGRAM_BOT_TOKEN'] || undefined,
    telegramChatId: process.env['TELEGRAM_CHAT_ID'] || undefined,
    finfeedApiKey: process.env['FINFEED_API_KEY'] || undefined,
    bullpenEnabled: parseBoolEnv('BULLPEN_ENABLED', false),
  };

  return config;
}

/**
 * Load AI filter configuration from environment variables.
 * Returns undefined if AI filtering is not enabled.
 */
export function loadAIConfig(): AIFilterConfig | undefined {
  const enabled = parseBoolEnv('AI_FILTER_ENABLED', false);
  if (!enabled) return undefined;

  const provider = optionalEnv('AI_FILTER_PROVIDER', 'openai') as AIFilterConfig['provider'];
  const validProviders = ['openai', 'anthropic', 'openrouter', 'custom'];
  if (!validProviders.includes(provider)) {
    throw new Error(`Invalid AI_FILTER_PROVIDER: ${provider}. Must be one of: ${validProviders.join(', ')}`);
  }

  // Custom provider requires a base URL
  const baseUrl = process.env['AI_FILTER_BASE_URL'] || undefined;
  if (provider === 'custom' && !baseUrl) {
    throw new Error('AI_FILTER_BASE_URL is required when AI_FILTER_PROVIDER=custom');
  }

  const defaultModel = provider === 'openai' ? 'gpt-4o'
    : provider === 'anthropic' ? 'claude-sonnet-4-20250514'
    : provider === 'openrouter' ? 'anthropic/claude-sonnet-4-20250514'
    : 'default';

  return {
    enabled: true,
    provider,
    apiKey: requireEnv('AI_FILTER_API_KEY'),
    model: optionalEnv('AI_FILTER_MODEL', defaultModel),
    baseUrl,
    secondModel: process.env['AI_FILTER_SECOND_MODEL'] || undefined,
    minConfidence: parseFloatEnv('AI_FILTER_MIN_CONFIDENCE', 0.6),
    minEdge: parseFloatEnv('AI_FILTER_MIN_EDGE', 0.05),
    cacheMinutes: parseFloatEnv('AI_FILTER_CACHE_MINUTES', 15),
    maxCallsPerMinute: parseFloatEnv('AI_FILTER_MAX_CALLS_PER_MIN', 10),
    timeoutSeconds: parseFloatEnv('AI_FILTER_TIMEOUT_SECONDS', 30),
    failOpen: parseBoolEnv('AI_FILTER_FAIL_OPEN', true),
  };
}

export function printAIConfig(config: AIFilterConfig | undefined): void {
  if (!config) {
    console.log('   AI Filter:        disabled');
    return;
  }
  console.log('   AI Filter:        ✅ ENABLED');
  console.log(`     Provider:       ${config.provider}`);
  console.log(`     Model:          ${config.model}`);
  if (config.secondModel) console.log(`     Second Model:   ${config.secondModel}`);
  console.log(`     Min Confidence: ${(config.minConfidence * 100).toFixed(0)}%`);
  console.log(`     Min Edge:       ${(config.minEdge * 100).toFixed(0)}%`);
  console.log(`     Cache TTL:      ${config.cacheMinutes}min`);
  console.log(`     Fail Mode:      ${config.failOpen ? 'open (approve on error)' : 'closed (reject on error)'}`);
}

/**
 * Load leaderboard/auto-discovery configuration from environment variables.
 * Returns undefined if auto-discovery is not enabled.
 */
export function loadLeaderboardConfig(): LeaderboardConfig | undefined {
  const enabled = parseBoolEnv('AUTO_DISCOVER_WALLETS', false);
  if (!enabled) return undefined;

  return {
    enabled: true,
    timePeriod: (optionalEnv('LEADERBOARD_TIME_PERIOD', 'WEEK') as LeaderboardConfig['timePeriod']),
    category: (optionalEnv('LEADERBOARD_CATEGORY', 'OVERALL') as LeaderboardConfig['category']),
    orderBy: (optionalEnv('LEADERBOARD_ORDER_BY', 'PNL') as LeaderboardConfig['orderBy']),
    fetchLimit: parseFloatEnv('LEADERBOARD_FETCH_LIMIT', 50),
    minPnl: parseFloatEnv('LEADERBOARD_MIN_PNL', 500),
    minWinRate: parseFloatEnv('LEADERBOARD_MIN_WIN_RATE', 0.6),
    minTrades: parseFloatEnv('LEADERBOARD_MIN_TRADES', 20),
    maxWallets: parseFloatEnv('LEADERBOARD_MAX_WALLETS', 5),
    refreshIntervalMinutes: parseFloatEnv('LEADERBOARD_REFRESH_MINUTES', 60),
  };
}

export function printLeaderboardConfig(config: LeaderboardConfig | undefined): void {
  if (!config) {
    console.log('   Auto-Discovery:   disabled (using manual TARGET_WALLETS)');
    return;
  }
  console.log('   Auto-Discovery:   ✅ ENABLED');
  console.log(`     Time Period:    ${config.timePeriod}`);
  console.log(`     Category:       ${config.category}`);
  console.log(`     Order By:       ${config.orderBy}`);
  console.log(`     Fetch Limit:    ${config.fetchLimit}`);
  console.log(`     Min P&L:        $${config.minPnl}`);
  console.log(`     Min Win Rate:   ${(config.minWinRate * 100).toFixed(0)}%`);
  console.log(`     Min Trades:     ${config.minTrades}`);
  console.log(`     Max Wallets:    ${config.maxWallets}`);
  console.log(`     Refresh:        every ${config.refreshIntervalMinutes}min`);
}

/**
 * Check if paper trading mode is enabled.
 */
export function isPaperTrading(): boolean {
  return parseBoolEnv('PAPER_TRADING', false);
}

/**
 * Load paper trading configuration from environment variables.
 * Returns undefined if paper trading is not enabled.
 */
export function loadPaperConfig(): PaperTradingConfig | undefined {
  if (!isPaperTrading()) return undefined;

  return {
    startingCapital: parseFloatEnv('PAPER_STARTING_CAPITAL', 1000),
    fillMode: (optionalEnv('PAPER_FILL_MODE', 'target_price') as PaperTradingConfig['fillMode']),
    simulatedSlippageBps: parseFloatEnv('PAPER_SLIPPAGE_BPS', 30),
    simulatedGasCost: parseFloatEnv('PAPER_GAS_COST', 0.01),
    autoCloseOnResolution: parseBoolEnv('PAPER_AUTO_CLOSE', true),
    exportOnExit: parseBoolEnv('PAPER_EXPORT_ON_EXIT', true),
    exportFormat: (optionalEnv('PAPER_EXPORT_FORMAT', 'json') as 'json' | 'csv'),
  };
}

export function printPaperConfig(config: PaperTradingConfig | undefined): void {
  if (!config) {
    console.log('   Paper Trading:    disabled');
    return;
  }
  console.log('   Paper Trading:    ✅ ENABLED');
  console.log(`     Starting Cap:   $${config.startingCapital}`);
  console.log(`     Fill Mode:      ${config.fillMode}`);
  console.log(`     Slippage:       ${config.simulatedSlippageBps} bps`);
  console.log(`     Gas Cost:       $${config.simulatedGasCost}`);
  console.log(`     Export:         ${config.exportOnExit ? config.exportFormat : 'disabled'}`);
}

/**
 * Check if backtest mode is enabled.
 */
export function isBacktest(): boolean {
  return parseBoolEnv('BACKTEST', false);
}

/**
 * Load backtest configuration from environment variables.
 * Returns undefined if backtest is not enabled.
 */
export function loadBacktestConfig(): BacktestConfig | undefined {
  if (!isBacktest()) return undefined;

  const startRaw = process.env['BACKTEST_START'];
  const endRaw = process.env['BACKTEST_END'];

  if (!startRaw || !endRaw) {
    throw new Error('BACKTEST_START and BACKTEST_END are required when BACKTEST=true (ISO date or epoch ms)');
  }

  const startTime = isNaN(Number(startRaw)) ? new Date(startRaw).getTime() : Number(startRaw);
  const endTime = isNaN(Number(endRaw)) ? new Date(endRaw).getTime() : Number(endRaw);

  if (isNaN(startTime) || isNaN(endTime) || startTime >= endTime) {
    throw new Error(`Invalid backtest time range: ${startRaw} → ${endRaw}`);
  }

  return {
    startTime,
    endTime,
    startingCapital: parseFloatEnv('BACKTEST_STARTING_CAPITAL', 1000),
    targetWallets: [],  // Filled from BotConfig.targetWallets at runtime
    simulatedSlippageBps: parseFloatEnv('BACKTEST_SLIPPAGE_BPS', 30),
    simulatedGasCost: parseFloatEnv('BACKTEST_GAS_COST', 0.01),
    speedMultiplier: parseFloatEnv('BACKTEST_SPEED', 100),
    exportResults: parseBoolEnv('BACKTEST_EXPORT', true),
    exportFormat: (optionalEnv('BACKTEST_EXPORT_FORMAT', 'json') as 'json' | 'csv'),
  };
}

export function printBacktestConfig(config: BacktestConfig | undefined): void {
  if (!config) {
    console.log('   Backtest:         disabled');
    return;
  }
  console.log('   Backtest:         ✅ ENABLED');
  console.log(`     Start:          ${new Date(config.startTime).toISOString()}`);
  console.log(`     End:            ${new Date(config.endTime).toISOString()}`);
  console.log(`     Starting Cap:   $${config.startingCapital}`);
  console.log(`     Speed:          ${config.speedMultiplier}x`);
  console.log(`     Slippage:       ${config.simulatedSlippageBps} bps`);
  console.log(`     Export:         ${config.exportResults ? config.exportFormat : 'disabled'}`);
}

export function printConfig(config: BotConfig): void {
  console.log('\n📋 Configuration:');
  console.log(`   Target wallets: ${config.targetWallets.length}`);
  config.targetWallets.forEach((w, i) => console.log(`     [${i + 1}] ${w}`));
  console.log(`   Position multiplier: ${config.positionMultiplier}x`);
  console.log(`   Max trade size: $${config.maxTradeSize}`);
  console.log(`   Min trade size: $${config.minTradeSize}`);
  console.log(`   Order type: ${config.orderType}`);
  console.log(`   Slippage tolerance: ${(config.slippageTolerance * 100).toFixed(1)}%`);
  console.log(`   Max session notional: ${config.maxSessionNotional > 0 ? `$${config.maxSessionNotional}` : 'unlimited'}`);
  console.log(`   Max per-market notional: ${config.maxPerMarketNotional > 0 ? `$${config.maxPerMarketNotional}` : 'unlimited'}`);
  console.log(`   Daily loss limit: ${(config.dailyLossLimit * 100).toFixed(1)}%`);
  console.log(`   Max drawdown: ${(config.maxDrawdown * 100).toFixed(1)}%`);
  console.log(`   Total loss halt: ${(config.totalLossLimit * 100).toFixed(1)}%`);
  console.log(`   WebSocket: ${config.useWebsocket ? 'enabled' : 'disabled'}`);
  console.log(`   Poll interval: ${config.pollInterval}ms`);
  console.log(`   Mode: ${config.dryRun ? '🟢 DRY RUN (simulation)' : '🔴 LIVE TRADING'}`);
  if (isPaperTrading()) console.log('   Paper Trading:    ✅ ENABLED (virtual money)');
  if (isBacktest()) console.log('   Backtest:         ✅ ENABLED (historical replay)');
  if (config.proxyUrl) console.log(`   Proxy: ${config.proxyUrl}`);
  if (config.wsRpcUrl) console.log(`   On-chain:         enabled (WS RPC)`);
  if (config.telegramBotToken && config.telegramChatId) console.log(`   Telegram:         enabled`);
  if (config.finfeedApiKey) console.log(`   FinFeedAPI:       enabled`);
  if (config.bullpenEnabled) console.log('   Bullpen:          ✅ ENABLED');
  console.log('');
}

export function isIntelligenceEnabled(): boolean {
  return parseBoolEnv('INTELLIGENCE_ENABLED', false);
}

export function loadIntelligenceConfig(): IntelligenceConfig | undefined {
  if (!isIntelligenceEnabled()) return undefined;

  const feedsRaw = process.env['INTELLIGENCE_RSS_FEEDS'] || '';
  const rssFeeds = feedsRaw.split(',').map((f) => f.trim()).filter((f) => f.length > 0);

  const categoriesRaw = process.env['INTELLIGENCE_CATEGORIES'] || '';
  const validCategories: EventCategory[] = ['political', 'economic', 'sports', 'crypto', 'regulatory', 'technology', 'geopolitical', 'social', 'weather', 'entertainment', 'other'];
  const categories = categoriesRaw
    .split(',')
    .map((c) => c.trim().toLowerCase())
    .filter((c) => validCategories.includes(c as EventCategory)) as EventCategory[];

  const keywordsRaw = process.env['INTELLIGENCE_WATCH_KEYWORDS'] || '';
  const watchKeywords = keywordsRaw.split(',').map((k) => k.trim()).filter((k) => k.length > 0);

  const useLLM = parseBoolEnv('INTELLIGENCE_USE_LLM', false);

  return {
    rssFeeds,
    pollIntervalMs: parseFloatEnv('INTELLIGENCE_POLL_INTERVAL', 300_000),
    alertThreshold: parseFloatEnv('INTELLIGENCE_ALERT_THRESHOLD', 0.5),
    categories,
    watchKeywords,
    useLLM,
    llmApiKey: process.env['INTELLIGENCE_LLM_API_KEY'] || process.env['AI_FILTER_API_KEY'] || undefined,
    llmProvider: (process.env['INTELLIGENCE_LLM_PROVIDER'] || 'openai') as 'openai' | 'anthropic',
    exportOnExit: parseBoolEnv('INTELLIGENCE_EXPORT', false),
  };
}

export function printIntelligenceConfig(config: IntelligenceConfig | undefined): void {
  if (!config) {
    console.log('   Intelligence:     disabled');
    return;
  }
  console.log('   Intelligence:     ✅ ENABLED');
  console.log(`     RSS Feeds:      ${config.rssFeeds.length > 0 ? config.rssFeeds.length + ' custom' : 'defaults (8 feeds)'}`);
  console.log(`     Poll Interval:  ${config.pollIntervalMs / 1000}s`);
  console.log(`     Alert Threshold: ${(config.alertThreshold * 100).toFixed(0)}%`);
  console.log(`     Categories:     ${config.categories.length > 0 ? config.categories.join(', ') : 'all'}`);
  console.log(`     Watch Keywords: ${config.watchKeywords.length > 0 ? config.watchKeywords.join(', ') : 'none'}`);
  console.log(`     LLM Analysis:   ${config.useLLM ? 'enabled' : 'disabled'}`);
}

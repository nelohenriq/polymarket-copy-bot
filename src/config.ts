/**
 * Configuration loader
 * Reads environment variables and validates all required settings.
 */

import * as dotenv from 'dotenv';
import { BotConfig, CopyOrderType, LogLevel, AIFilterConfig, LeaderboardConfig } from './types';

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

export function loadConfig(): BotConfig {
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
    privateKey: requireEnv('PRIVATE_KEY'),
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
  if (config.proxyUrl) console.log(`   Proxy: ${config.proxyUrl}`);
  if (config.wsRpcUrl) console.log(`   On-chain:         enabled (WS RPC)`);
  if (config.telegramBotToken && config.telegramChatId) console.log(`   Telegram:         enabled`);
  if (config.finfeedApiKey) console.log(`   FinFeedAPI:       enabled`);
  console.log('');
}

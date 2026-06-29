/**
 * Polymarket Copy-Trading Bot
 * ──────────────────────────────────────────────
 *
 * Main orchestrator that wires together:
 * - Config loading & validation
 * - CLOB client initialization (EOA auth)
 * - Trade monitoring (Data API polling + WebSocket)
 * - Risk management (4-layer protection)
 * - Trade execution (FOK/GTC/FAK orders)
 * - Position tracking
 *
 * Modes:
 *   LIVE    — Real orders via Polymarket CLOB (default)
 *   PAPER   — Virtual money, simulated fills, journal + metrics (PAPER_TRADING=true)
 *   BACKTEST— Historical replay, paper execution, full report (BACKTEST=true)
 *
 * Usage:
 *   1. Copy .env.example to .env and fill in your credentials
 *   2. npm install
 *   3. npm run dev   (development with tsx)
 *   4. npm run build && npm start  (production)
 */

import {
  loadConfig, loadAIConfig, loadLeaderboardConfig,
  printConfig, printAIConfig, printLeaderboardConfig,
  isPaperTrading, isBacktest, loadPaperConfig, loadBacktestConfig,
  printPaperConfig, printBacktestConfig,
  isIntelligenceEnabled, loadIntelligenceConfig, printIntelligenceConfig,
  loadStrategies, printStrategiesConfig,
} from './config';
import { configureProxy, proxyFetch, runProxyDiagnostics } from './proxy';
import { configureFinFeed } from './cross-platform';
import { isBullpenAvailable, isBullpenAuthenticated, executeTradeViaBullpen } from './bullpen';
import { initClient, ensureAllowances } from './client';
import { TradeMonitor } from './monitor';
import { HistoricalMonitor } from './historical-monitor';
import { RiskManager } from './risk';
import { TradeExecutor } from './executor';
import { PaperExecutor } from './paper-executor';
import { PositionTracker } from './positions';
import { TradeJournal } from './journal';
import { MetricsCalculator } from './metrics';
import { AITradeFilter } from './ai-filter';
import { LeaderboardScraper } from './leaderboard';
import { OnChainMonitor, verifyOnChainBalances } from './onchain';
import { MarketResolver } from './resolver';
import { TelegramNotifier } from './telegram';
import { MarketIntelligence, formatIntelligenceForPrompt } from './intelligence';
import { log, setLogLevel } from './logger';
import { ParsedTrade, SessionStats, BotConfig, PaperTradingConfig, AIFilterResult } from './types';
import { loadState, saveState, getStatePath } from './state';
import { calculateCopySize, calculateSimulatedFillPrice, calculateKellySize } from './sizing';
import { StrategyRunner, StrategyRouter } from './strategy';
import * as fs from 'fs';
import * as dns from 'dns';
import * as http from 'http';
import * as path from 'path';

// ──────────────────────────────────────────────
// Session Statistics
// ──────────────────────────────────────────────

const stats: SessionStats = {
  startTime: Date.now(),
  tradesDetected: 0,
  tradesCopied: 0,
  tradesSkipped: 0,
  tradesFailed: 0,
  tradesAiRejected: 0,
  totalVolume: 0,
  totalPnl: 0,
};

// ──────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────

async function main(): Promise<void> {
  // DNS validation: check if c-ares resolution (used by the bot) can reach Polymarket.
  // The proxy module sets dns.setServers(['8.8.8.8', '1.1.1.1']) which affects dns.resolve
  // but NOT dns.lookup (which uses OS getaddrinfo). We test with dns.resolve here.
  try {
    const resolved = await new Promise<string[]>((resolve, reject) => {
      dns.resolve4('data-api.polymarket.com', (err, addresses) => {
        if (err) reject(err);
        else resolve(addresses);
      });
    });
    const isCloudflare = resolved.some(ip => ip.startsWith('172.64.') || ip.startsWith('104.18.') || ip.startsWith('104.16.'));
    if (isCloudflare) {
      console.log(`   ✅ DNS OK (c-ares): data-api.polymarket.com → ${resolved[0]}`);
    } else {
      console.warn(`\n⚠️  DNS WARNING: data-api.polymarket.com → ${resolved.join(', ')}`);
    }
  } catch (dnsErr) {
    const dnsMsg = dnsErr instanceof Error ? dnsErr.message : String(dnsErr);
    console.warn(`⚠️  DNS resolution failed: ${dnsMsg} — check your network connectivity`);
  }

  // Detect mode early for banner
  const paperMode = isPaperTrading();
  const backtestMode = isBacktest();
  const dryRunEarly = (process.env['DRY_RUN'] || 'true').toLowerCase() === 'true';
  const modeLabel = backtestMode ? '📊 BACKTEST' : paperMode ? '📝 PAPER TRADING' : dryRunEarly ? '🟢 DRY RUN' : '🔴 LIVE';

  console.log(`
╔══════════════════════════════════════════════════╗
║       Polymarket Copy-Trading Bot v1.0           ║
╠══════════════════════════════════════════════════╣
║  Mode: ${modeLabel.padEnd(41)}║
║  Monitor top traders → Mirror their trades       ║
║  Built with Polymarket CLOB SDK                  ║
╚══════════════════════════════════════════════════╝
  `);

  // ── Step 1: Load configuration ──
  // Backtest mode doesn't need PRIVATE_KEY — load config with relaxed validation
  let config = loadConfig(backtestMode);
  const aiConfig = loadAIConfig();
  const leaderboardConfig = loadLeaderboardConfig();
  const paperConfig = loadPaperConfig();
  const backtestConfig = loadBacktestConfig();
  const intelligenceConfig = loadIntelligenceConfig();
  const strategyConfigs = loadStrategies();

  setLogLevel(config.logLevel);
  printConfig(config);
  printAIConfig(aiConfig);
  printLeaderboardConfig(leaderboardConfig);
  printPaperConfig(paperConfig);
  printBacktestConfig(backtestConfig);
  printIntelligenceConfig(intelligenceConfig);
  printStrategiesConfig(strategyConfigs);

  // Validate mode combinations
  if (paperMode && backtestMode) {
    log.warn('Both PAPER_TRADING and BACKTEST are enabled — backtest mode takes priority');
  }
  if (backtestMode && !backtestConfig) {
    log.error('BACKTEST=true but config failed to load. Exiting.');
    process.exit(1);
  }

  // ── Step 1a: Configure proxy and external APIs ──
  configureProxy(config.proxyUrl);

  // Run proxy diagnostics if proxy is configured
  if (config.proxyUrl) {
    await runProxyDiagnostics();
  }
  configureFinFeed(config.finfeedApiKey);

  // Check Bullpen CLI availability
  if (config.bullpenEnabled) {
    const available = isBullpenAvailable();
    const authed = isBullpenAuthenticated();
    if (available && authed) {
      log.success('Bullpen CLI detected and authenticated — smart money + market data active');
    } else if (available) {
      log.warn('Bullpen CLI detected but not authenticated — run `bullpen login` for full features');
    } else {
      log.warn('Bullpen CLI not found — install with `npm install -g @bullpenfi/cli`');
    }
  }

  // ── Step 1b: Auto-discover wallets if enabled ──
  let scraper: LeaderboardScraper | null = null;
  if (leaderboardConfig && !backtestMode) {
    scraper = new LeaderboardScraper(leaderboardConfig);
    const profiles = await scraper.discover();
    if (profiles.length > 0) {
      const discoveredWallets = profiles.map((p) => p.walletAddress);
      const allWallets = [...new Set([...config.targetWallets, ...discoveredWallets])];
      config = { ...config, targetWallets: allWallets };
      log.success(`Auto-discovered ${profiles.length} top traders (${allWallets.length} total wallets)`);
    } else if (config.targetWallets.length === 0) {
      log.error('Auto-discovery returned no traders and no manual TARGET_WALLETS configured. Exiting.');
      process.exit(1);
    } else {
      log.warn('Auto-discovery returned no traders — using manual TARGET_WALLETS only');
    }
  }

  // Fill backtest wallet list from config
  if (backtestConfig) {
    backtestConfig.targetWallets = config.targetWallets;
  }

  // ──────────────────────────────────────────────
  // BACKTEST MODE — Historical replay, then exit
  // ──────────────────────────────────────────────
  if (backtestMode && backtestConfig) {
    await runBacktest(config, backtestConfig);
    return;
  }

  // ── Step 2: Initialize CLOB client (skip in paper mode — no real orders) ──
  let clob: import('@polymarket/clob-client').ClobClient | null = null;
  let wallet: import('ethers').Wallet;

  if (paperMode) {
    // Paper mode: only need wallet address for logging — skip CLOB auth
    const { ethers } = await import('ethers');
    wallet = new ethers.Wallet(config.privateKey);
    log.info(`[PAPER] Wallet: ${wallet.address} (simulated — no real orders)`);
  } else {
    const bundle = await initClient(config);
    clob = bundle.clob;
    wallet = bundle.wallet;
  }

  // ── Step 3: Set token allowances (one-time, skips if already set) ──
  if (!config.dryRun && !paperMode && clob) {
    await ensureAllowances(clob);
  } else {
    log.info(paperMode ? '[PAPER] Skipping allowance setup' : '[DRY RUN] Skipping allowance setup');
  }

  // ── Step 4: Initialize components ──
  const positions = new PositionTracker();
  const riskManager = new RiskManager(config, positions);

  // Swap executor based on mode
  const executor = paperMode
    ? new PaperExecutor(config, paperConfig!)
    : new TradeExecutor(config, clob!);

  const aiFilter = aiConfig ? new AITradeFilter(aiConfig) : null;

  // Enable AI self-improvement feedback loop
  if (aiFilter && config.aiFeedbackEnabled) {
    aiFilter.enableFeedback();
    log.info('AI self-improvement feedback enabled — tracking prediction calibration');
  }

  // ── Multi-strategy initialization ──
  let strategyRunners: StrategyRunner[] = [];
  let strategyRouter: StrategyRouter | null = null;
  const multiStrategy = !!strategyConfigs && strategyConfigs.length > 0;
  if (multiStrategy && strategyConfigs) {
    for (const sc of strategyConfigs) {
      if (sc.enabled) {
        strategyRunners.push(new StrategyRunner(sc, config));
      }
    }
    if (strategyRunners.length > 0) {
      strategyRouter = new StrategyRouter(strategyRunners);
      log.success(`Multi-strategy mode: ${strategyRunners.length} active strategies`);
      for (const runner of strategyRunners) {
        const ec = runner.getEffectiveConfig();
        log.info(`  [${runner.name}] maxNotional=$${ec.maxSessionNotional} maxTrade=$${ec.maxTradeSize} multiplier=${ec.positionMultiplier}x`);
      }
    } else {
      log.warn('STRATEGIES_FILE loaded but no enabled strategies found — using single-strategy mode');
    }
  }

  // Trade journal — tracks all trades for paper trading, backtesting, AND dry-run mode
  const journal = (paperMode || config.dryRun) ? new TradeJournal() : null;
  const startingCapital = paperMode ? paperConfig!.startingCapital : 0;
  const dashboardPath = 'dry-run-trades.json';

  // ── Load persisted state (position reconciliation across restarts) ──
  const lastProcessedTimestamps = new Map<string, number>();
  const statePath = config.stateFilePath || getStatePath();
  let savedState = loadState(statePath);
  if (savedState) {
    const openCount = savedState.entries.filter(e => e.exitPrice === undefined && e.side === 'BUY').length;
    const closedCount = savedState.entries.filter(e => e.exitPrice !== undefined).length;
    log.success(`State restored from ${statePath}: ${savedState.entries.length} entries (${openCount} open, ${closedCount} closed)`);

    // Restore journal entries
    if (journal && savedState.entries.length > 0) {
      journal.loadFromEntries(savedState.entries, savedState.counter);
    }

    // Restore position tracker
    if (savedState.positions.length > 0) {
      positions.loadPositions(savedState.positions);
    }

    // Restore per-wallet timestamps for catch-up replay
    for (const [wallet, ts] of Object.entries(savedState.lastProcessedTimestamps)) {
      lastProcessedTimestamps.set(wallet, ts);
    }

    // Restore risk manager state
    if (savedState.riskState) {
      riskManager.restoreState(savedState.riskState);
    }

    // Recalculate sessionNotional as CURRENT open exposure (not cumulative volume)
    if (journal) {
      const openExposure = journal.getOpenPositions().reduce(
        (sum, p) => sum + (p.entryPrice * p.size), 0
      );
      riskManager.setSessionNotional(openExposure);
      log.info(`Open exposure recalculated: $${openExposure.toFixed(2)} / $${config.maxSessionNotional || '∞'}`);
    }

    // Restore session stats
    if (savedState.sessionStats) {
      Object.assign(stats, savedState.sessionStats);
      stats.startTime = Date.now(); // Keep fresh uptime
    }
  } else {
    log.info('No persisted state found — starting fresh');
  }

  // Initialize Telegram notifier (skip for paper trading unless explicitly configured)
  let telegram: TelegramNotifier | null = null;
  const tgToken = config.telegramBotToken;
  const tgChatId = config.telegramChatId;
  if (tgToken && tgChatId) {
    telegram = new TelegramNotifier({
      botToken: tgToken,
      chatId: tgChatId,
      enabledEvents: { trade: true, ai: true, risk: true, execution: true, error: true, status: true },
    });
    await telegram.connect();
  }

  // ── Persist journal to disk (for dry-run dashboard + state reconciliation) ──
  function persistJournal(): void {
    try {
      // Dashboard JSON file — always write so dashboard works in all modes
      const data: Record<string, unknown> = {
        lastUpdated: new Date().toISOString(),
        stats: { ...stats },
      };
      if (journal) {
        data['entries'] = journal.getEntries();
        data['openPositions'] = journal.getOpenPositions().map(e => ({ outcome: e.outcome, tokenId: e.tokenId, shares: e.size, entryPrice: e.entryPrice, title: e.title, trader: e.trader, slug: e.slug, volume24hr: e.volume24hr, category: e.category }));
      } else {
        data['entries'] = [];
        data['openPositions'] = [];
      }
      fs.writeFileSync(dashboardPath, JSON.stringify(data, null, 2), 'utf-8');

      // Full state file — only save when journal exists to avoid overwriting
      // loaded state with empty entries in LIVE mode (where journal is null)
      if (journal) {
        saveState(
          statePath,
          journal.getEntries(),
          positions.getAllPositions(),
          lastProcessedTimestamps,
          riskManager.getState(),
          stats,
          journal.getCounter(),
        );
        reconciliation.lastStateSave = new Date().toISOString();
      }
    } catch {
      // Silently ignore — dashboard is non-critical
    }
  }

  // ── Runtime-adjustable settings ──
  let runtimeMaxMissedSellDeviation = config.maxMissedSellDeviation ?? 0.15;
  let runtimeAutoCloseOrderType: import('./types').CopyOrderType = config.autoCloseOrderType || config.orderType;

  // ── Pending GTC auto-close order tracking ──
  // When GTC is used for auto-close, orders rest on the book and may not fill.
  // Track them here so the periodic checker can cancel + retry with FOK on timeout.
  const pendingGtcAutoCloses: Array<{
    orderId: string;
    tokenId: string;
    outcome: string;
    shares: number;
    exitPrice: number;
    entryPrice: number;
    placedAt: number;
    journalAsset: string;
    journalExitTs: number;
    trader: string;
  }> = [];

  // ── Mode tracking ──
  let notionalCappedLogged = false;
  let profitTargetMonitoring = false;
  let profitTargetLogged = false;

  // ── Reconciliation tracking ──
  const reconciliation = {
    lastStateSave: savedState?.savedAt || null,
    stateRestored: !!savedState,
    catchUpRan: false as boolean,
    catchUpMissedSells: 0,
    catchUpAutoCloses: 0,
    catchUpAutoCloseFails: 0,
    catchUpDeviationBlocks: 0,
    catchUpGtcTimeouts: 0,
    catchUpFokRetries: 0,
    catchUpFokRetryFails: 0,
    pendingGtcOrders: 0,
    stalePositionCount: 0,
    stalePositions: [] as string[],
    openOrdersChecked: 0,
    staleOrdersCanceled: 0,
    onChainVerified: false as boolean,
    onChainMatched: 0,
    onChainMismatched: 0,
    onChainMismatches: [] as string[],
    marketsResolved: 0,
    positionsWon: 0,
    positionsLost: 0,
    redemptionAttempts: 0,
    redemptionSuccesses: 0,
    redemptionFailures: 0,
    resolvedPositions: [] as Array<{ tokenId: string; outcome: string; title: string; won: boolean; redeemed: boolean }>,
    mode: 'normal' as 'normal' | 'exit-only' | 'profit-shutdown',
  };

  // If profit target was already reached on startup and we still have open positions,
  // enter monitoring mode immediately (don't wait for next trade to trigger it)
  if (journal && config.maxSessionProfit > 0 && riskManager.isProfitTargetReached() && journal.getOpenPositions().length > 0) {
    profitTargetMonitoring = true;
    profitTargetLogged = true;
    reconciliation.mode = 'profit-shutdown';
    log.success(`🎯 Profit target already reached ($${riskManager.getState().sessionPnl.toFixed(2)}) — monitoring ${journal.getOpenPositions().length} open position(s) for exits`);
  }

  // ── Helper: Execute a trade for a specific strategy runner ──
  async function executeForStrategy(runner: StrategyRunner, trade: ParsedTrade, notional: number): Promise<void> {
    runner.trackRouted();

    // Strategy-level risk check
    const riskCheck = runner.checkTrade(trade, notional);
    if (!riskCheck.allowed) {
      log.risk(`[${runner.name}] Trade blocked: ${riskCheck.reason}`);
      telegram?.notifyRisk({ type: 'blocked', message: `[${runner.name}] ${riskCheck.reason ?? 'Unknown'}`, trade: trade.outcome });
      runner.trackBlocked();
      stats.tradesSkipped++;
      return;
    }

    // Global safety-net risk check (catches cross-strategy overexposure)
    const globalCheck = riskManager.checkTrade(trade, notional);
    if (!globalCheck.allowed) {
      log.risk(`[${runner.name}] Global risk block: ${globalCheck.reason}`);
      telegram?.notifyRisk({ type: 'blocked', message: `Global limit: ${globalCheck.reason ?? 'Unknown'}`, trade: trade.outcome });
      runner.trackBlocked();
      stats.tradesSkipped++;
      return;
    }

    // Strategy-level AI filter
    const aiResult = await runner.evaluateAI(trade);
    if (aiResult && !aiResult.approved) {
      stats.tradesAiRejected++;
      log.info(`[${runner.name}] 🤖 AI rejected: prob=${(aiResult.ensembleProbability * 100).toFixed(1)}%`);
      runner.trackBlocked();
      return;
    }

    if (aiResult) {
      trade.aiProbability = aiResult.ensembleProbability;
      trade.aiConfidence = aiResult.confidence;
    }

    // Execute via shared executor
    executor
      .executeCopyTrade(trade)
      .then((result) => {
        if (result.success) {
          stats.tradesCopied++;
          stats.totalVolume += result.copyNotional;

          // Record in strategy's independent trackers
          runner.recordFill({
            trade, notional: result.copyNotional, shares: result.copyShares,
            price: result.price, side: result.side,
          });
          runner.trackExecuted(result.copyNotional);

          // Also update global trackers for the safety-net risk manager
          positions.recordFill({ trade, notional: result.copyNotional, shares: result.copyShares, price: result.price, side: result.side });
          riskManager.recordFill({ trade, notional: result.copyNotional, shares: result.copyShares, price: result.price, side: result.side });

          if (journal) {
            journal.recordEntry(trade, result.copyNotional, result.price, `[${runner.name}]`);
            persistJournal();
          }

          telegram?.notifyExecution({ side: result.side, shares: result.copyShares, price: result.price, notional: result.copyNotional, orderId: result.orderId ?? '', outcome: trade.outcome });
          log.success(`[${runner.name}] Copy trade executed: ${result.side} ${result.copyShares.toFixed(4)} shares @ $${result.price.toFixed(4)}`);
        } else {
          stats.tradesFailed++;
          log.error(`[${runner.name}] Copy trade failed: ${result.error}`);
        }
      })
      .catch((error) => {
        stats.tradesFailed++;
        log.error(`[${runner.name}] Copy trade error: ${error instanceof Error ? error.message : String(error)}`);
      });
  }

  // ── Step 5: Handle incoming trades ──
  async function handleNewTrade(trade: ParsedTrade): Promise<void> {
    stats.tradesDetected++;

    // ── Multi-strategy routing ──
    if (strategyRouter) {
      if (trade.side === 'BUY') {
        const runner = strategyRouter.routeBuy(trade);
        if (runner) {
          const notional = executor.calculateCopySize(trade.size);
          log.trade(`[${runner.name}] BUY signal from ${trade.user.slice(0, 8)}... | ${trade.outcome.slice(0, 30)} | $${trade.size.toFixed(2)} @ ${trade.price.toFixed(4)}`);
          await executeForStrategy(runner, trade, notional);
        } else {
          log.debug(`No strategy matched BUY trade for ${trade.outcome.slice(0, 30)} — skipping`);
          stats.tradesSkipped++;
        }
      } else if (trade.side === 'SELL') {
        // Track per-wallet timestamp for catch-up replay on restart
        if (trade.user) {
          lastProcessedTimestamps.set(trade.user, Math.max(lastProcessedTimestamps.get(trade.user) || 0, trade.timestamp));
        }

        // Route SELL to the strategy that owns the position
        const runner = strategyRouter.routeSell(trade.tokenId);
        if (runner) {
          log.info(`[${runner.name}] SELL signal: ${trade.outcome.slice(0, 30)} @ $${trade.price}`);
          // Record exit in journal
          if (journal) {
            const exitEntry = journal.findOpenPosition(trade.tokenId);
            journal.recordExit(trade.tokenId, trade.price, trade.timestamp);
            if (exitEntry) {
              const exitPnl = exitEntry.pnl ?? 0;
              const freedNotional = exitEntry.entryPrice * exitEntry.size;

              // Update strategy's own trackers
              runner.recordExit(trade, exitEntry.entryPrice, exitEntry.size, trade.price, exitPnl);

              // Also update global trackers for safety-net risk manager + live price/trailing stop
              positions.recordFill({ trade, notional: trade.price * exitEntry.size, shares: exitEntry.size, price: trade.price, side: 'SELL' });
              riskManager.reduceSessionNotional(freedNotional);
              riskManager.addSessionPnl(exitPnl);

              const emoji = exitPnl >= 0 ? '✅' : '❌';
              log.info(`${emoji} [${runner.name} EXIT] ${exitEntry.outcome} | P&L: $${exitPnl.toFixed(2)}`);
              telegram?.notifyTrade({ side: 'SELL', size: exitEntry.size, price: trade.price, outcome: exitEntry.outcome, user: exitEntry.trader || 'unknown' });
            }
            persistJournal();
          }
        } else {
          log.debug(`No strategy owns position ${trade.tokenId.slice(0, 12)}… — SELL ignored`);
        }
        stats.tradesSkipped++;
      }
      return;
    }

    // ── Single-strategy mode (original logic) ──
    const isProfitHit = riskManager.isProfitTargetReached();
    const isCapped = riskManager.isNotionalCapped();

    // ── Profit target reached → monitoring mode (block BUYs, process SELLs) ──
    if (isProfitHit && !profitTargetLogged) {
      profitTargetMonitoring = true;
      profitTargetLogged = true;
      reconciliation.mode = 'profit-shutdown';
      log.success(`🎯 SESSION PROFIT TARGET REACHED ($${riskManager.getState().sessionPnl.toFixed(2)} >= $${config.maxSessionProfit}) — monitoring exits only`);
      telegram?.notifyRisk({ type: 'halt', message: `🎯 Profit target reached — monitoring exits only until all positions close`, trade: '' });
    }

    // ── Notional cap reached → exit-only mode (skip BUYs, process SELLs) ──
    if (trade.side === 'BUY' && (isProfitHit || isCapped)) {
      if (isCapped && !isProfitHit && !notionalCappedLogged) {
        notionalCappedLogged = true;
        reconciliation.mode = 'exit-only';
        log.warn(`⏸️  Notional cap reached ($${riskManager.getState().sessionNotional.toFixed(2)} / $${config.maxSessionNotional}) — exit-only mode, monitoring for position exits`);
        telegram?.notifyRisk({ type: 'blocked', message: `⏸️ Notional cap reached — monitoring exits only until positions close`, trade: '' });
      }
      stats.tradesSkipped++;
      return;
    }

    // Resume normal trading if notional dropped below cap (and not in profit monitoring)
    if (!isCapped && notionalCappedLogged && !profitTargetMonitoring) {
      notionalCappedLogged = false;
      reconciliation.mode = 'normal';
      log.success(`▶️  Notional below cap ($${riskManager.getState().sessionNotional.toFixed(2)} / $${config.maxSessionNotional}) — resuming normal trading`);
    }

    // Record SELL as exit in journal (all modes with a journal — must run BEFORE BUY-only filter)
    if (trade.side === 'SELL' && journal) {
      const exitEntry = journal.findOpenPosition(trade.tokenId);
      journal.recordExit(trade.tokenId, trade.price, trade.timestamp);
      if (exitEntry) {
        const exitPnl = exitEntry.pnl ?? 0;
        const freedNotional = exitEntry.entryPrice * exitEntry.size;
        const holdMs = exitEntry.holdTimeMs ?? (trade.timestamp - exitEntry.timestamp);
        const holdLabel = holdMs > 86_400_000 ? `${(holdMs / 86_400_000).toFixed(1)}d`
          : holdMs > 3_600_000 ? `${(holdMs / 3_600_000).toFixed(1)}h`
          : `${(holdMs / 60_000).toFixed(0)}m`;
        const emoji = exitPnl >= 0 ? '✅' : '❌';
        log.info(`${emoji} [EXIT] ${exitEntry.outcome} | P&L: $${exitPnl.toFixed(2)} | Hold: ${holdLabel} | Exit: $${trade.price}`);

        // Update risk manager: free notional + record P&L
        riskManager.reduceSessionNotional(freedNotional);
        riskManager.addSessionPnl(exitPnl);

        telegram?.notifyTrade({
          side: 'SELL',
          size: exitEntry.size,
          price: trade.price,
          outcome: exitEntry.outcome,
          user: exitEntry.trader || 'unknown',
        });
      } else if (paperMode) {
        log.info(`[PAPER] Exit recorded: ${trade.outcome} @ $${trade.price}`);
      }
      persistJournal();

      // If in profit monitoring mode and all positions are closed, shut down gracefully
      if (profitTargetMonitoring && journal.getOpenPositions().length === 0) {
        log.success('🎯 All positions closed after profit target reached. Shutting down gracefully...');
        persistJournal();
        shutdown('PROFIT TARGET COMPLETE').catch(() => process.exit(0));
        return;
      }
    }

    // Track per-wallet timestamp for catch-up replay on restart
    if (trade.user) {
      lastProcessedTimestamps.set(trade.user, Math.max(lastProcessedTimestamps.get(trade.user) || 0, trade.timestamp));
    }

    // Skip SELL trades for execution (BUY-only mode — exits are recorded above via recordExit)
    if (trade.side === 'SELL') {
      log.debug(`Skipping SELL trade from ${trade.user.slice(0, 8)}... (BUY-only mode)`);
      stats.tradesSkipped++;
      return;
    }

    // Notify: trade detected
    telegram?.notifyTrade({ side: trade.side, size: trade.size, price: trade.price, outcome: trade.outcome, user: trade.user });

    // Calculate copy size (mutable — Kelly sizing may adjust it)
    let copyNotional = executor.calculateCopySize(trade.size);

    // Risk check
    const riskCheck = riskManager.checkTrade(trade, copyNotional);
    if (!riskCheck.allowed) {
      log.risk(`Trade blocked: ${riskCheck.reason}`);
      telegram?.notifyRisk({ type: 'blocked', message: riskCheck.reason ?? 'Unknown', trade: trade.outcome });
      stats.tradesSkipped++;
      return;
    }

    log.trade(
      `New BUY signal from ${trade.user.slice(0, 8)}... | ` +
      `${trade.outcome.slice(0, 30)} | ` +
      `$${trade.size.toFixed(2)} @ ${trade.price.toFixed(4)}`,
    );

    // AI filter — estimate true probability before copying
    let aiResultForSizing: AIFilterResult | null = null;
    if (aiFilter) {
      try {
        const aiResult = await aiFilter.evaluate(trade);
        aiResultForSizing = aiResult;
        if (!aiResult.approved) {
          stats.tradesAiRejected++;
          telegram?.notifyAI({ approved: false, probability: aiResult.ensembleProbability, marketPrice: aiResult.marketPrice, edge: aiResult.edge, confidence: aiResult.confidence, outcome: trade.outcome, latencyMs: aiResult.latencyMs });
          log.info(
            `🤖 AI rejected: prob=${(aiResult.ensembleProbability * 100).toFixed(1)}% ` +
            `market=${(aiResult.marketPrice * 100).toFixed(1)}% ` +
            `edge=${(aiResult.edge * 100).toFixed(1)}% (${aiResult.latencyMs}ms)`,
          );
          return;
        }
        telegram?.notifyAI({ approved: true, probability: aiResult.ensembleProbability, marketPrice: aiResult.marketPrice, edge: aiResult.edge, confidence: aiResult.confidence, outcome: trade.outcome, latencyMs: aiResult.latencyMs });
        log.success(
          `🤖 AI approved: prob=${(aiResult.ensembleProbability * 100).toFixed(1)}% ` +
          `market=${(aiResult.marketPrice * 100).toFixed(1)}% ` +
          `edge=${(aiResult.edge * 100).toFixed(1)}% (${aiResult.latencyMs}ms)`,
        );

        // Attach AI estimates to trade for journal + calibration feedback
        trade.aiProbability = aiResult.ensembleProbability;
        trade.aiConfidence = aiResult.confidence;

        // Kelly criterion sizing — scale position by AI confidence
        if (config.kellySizingEnabled && aiResult.approved) {
          const kellyNotional = calculateKellySize(aiResult, copyNotional, config.kellyFraction);
          if (kellyNotional !== copyNotional) {
            log.info(`📊 Kelly sizing: $${copyNotional.toFixed(2)} → $${kellyNotional.toFixed(2)} (conf=${(aiResult.confidence * 100).toFixed(0)}%, edge=${(aiResult.edge * 100).toFixed(1)}%)`);
            copyNotional = kellyNotional;
            // Re-check risk gates with adjusted size
            const recheck = riskManager.checkTrade(trade, copyNotional);
            if (!recheck.allowed) {
              log.risk(`Trade blocked after Kelly adjustment: ${recheck.reason}`);
              telegram?.notifyRisk({ type: 'blocked', message: recheck.reason ?? 'Unknown', trade: trade.outcome });
              stats.tradesSkipped++;
              return;
            }
          }
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error(`AI filter error: ${msg}`);
        telegram?.notifyError('AI Filter Error', msg);
        if (!aiConfig?.failOpen) {
          stats.tradesAiRejected++;
          telegram?.notifyRisk({ type: 'blocked', message: 'AI filter failed in fail-closed mode — rejecting trade', trade: trade.outcome });
          log.error('AI filter failed in fail-closed mode — rejecting trade');
          return;
        }
        log.warn('AI filter failed in fail-open mode — approving trade anyway');
      }
    }

    // Execute copy trade
    executor
      .executeCopyTrade(trade)
      .then((result) => {
        if (result.success) {
          stats.tradesCopied++;
          stats.totalVolume += result.copyNotional;

          // Record in position tracker
          positions.recordFill({
            trade,
            notional: result.copyNotional,
            shares: result.copyShares,
            price: result.price,
            side: result.side,
          });

          // Record in risk manager
          riskManager.recordFill({
            trade,
            notional: result.copyNotional,
            shares: result.copyShares,
            price: result.price,
            side: result.side,
          });

          // Record in trade journal
          if (journal) {
            journal.recordEntry(trade, result.copyNotional, result.price, paperMode ? 'copy-trade' : 'dry-run');
            persistJournal();
          }

          telegram?.notifyExecution({ side: result.side, shares: result.copyShares, price: result.price, notional: result.copyNotional, orderId: result.orderId ?? '', outcome: trade.outcome });
          log.success(
            `Copy trade executed: ${result.side} ${result.copyShares.toFixed(4)} shares ` +
            `@ $${result.price.toFixed(4)} | OrderID: ${result.orderId}`,
          );
        } else {
          stats.tradesFailed++;
          telegram?.notifyError('Trade Failed', `Copy trade failed: ${result.error}`);
          log.error(`Copy trade failed: ${result.error}`);
        }
      })
      .catch((error) => {
        stats.tradesFailed++;
        const msg = error instanceof Error ? error.message : String(error);
        telegram?.notifyError('Trade Error', msg);
        log.error(`Copy trade error: ${msg}`);
      });
  }

  // ── Step 5b: Start market intelligence (if enabled) ──
  let intelligence: MarketIntelligence | null = null;
  let marketRefreshInterval: ReturnType<typeof setInterval> | null = null;
  if (intelligenceConfig && !paperMode) {
    intelligence = new MarketIntelligence(intelligenceConfig, (alert) => {
      // Log alerts prominently even without Telegram
      const emoji = alert.severity === 'critical' ? '🚨' : alert.severity === 'high' ? '⚠️' : '📋';
      log.risk(`${emoji} INTELLIGENCE ALERT [${alert.severity.toUpperCase()}]: ${alert.event.title}`);
      log.risk(`   ${alert.suggestedAction}`);
      log.risk(`   Markets: ${alert.affectedMarkets.length > 0 ? alert.affectedMarkets.join(', ') : 'none matched'}`);

      // Forward high-impact alerts to Telegram
      if (telegram && alert.severity !== 'low') {
        telegram.notifyRisk({
          type: 'halt',
          message: `${emoji} [${alert.severity.toUpperCase()}] ${alert.event.title.slice(0, 100)}\n${alert.suggestedAction}`,
          trade: alert.affectedMarkets[0],
        });
      }
    });
    intelligence.start();

    // Fetch active Polymarket markets for event correlation (initial + periodic)
    const refreshActiveMarkets = async (): Promise<void> => {
      try {
        const resp = await proxyFetch('https://gamma-api.polymarket.com/markets?active=true&limit=200&order=volume24hr&ascending=false', {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(15_000),
        });
        if (resp.ok) {
          const markets = (await resp.json()) as Array<{ slug?: string; question?: string; conditionId?: string }>;
          intelligence!.updateActiveMarkets(
            markets.map((m) => ({ slug: m.slug || '', question: m.question || '', conditionId: m.conditionId }))
          );
        }
      } catch (err) {
        log.debug('Failed to refresh active markets for intelligence correlation');
      }
    };
    refreshActiveMarkets();
    marketRefreshInterval = setInterval(refreshActiveMarkets, 300_000); // Refresh every 5 min

    // Attach intelligence engine to AI filter for event-enriched prompts
    if (aiFilter) {
      aiFilter.setIntelligence(intelligence);
    }
  }

  // ── Step 5c: Start on-chain settlement monitor (skip for paper mode) ──
  let onchainMonitor: OnChainMonitor | null = null;
  if (config.wsRpcUrl && !paperMode) {
    onchainMonitor = new OnChainMonitor(config.targetWallets, (fill) => {
      log.debug(`On-chain settlement confirmed: ${fill.side} token=${fill.tokenId.slice(0, 12)}... amount=${fill.makerAmount} USDC`);
    });
    onchainMonitor.start(config.wsRpcUrl).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`On-chain monitor failed to start: ${msg} (continuing without it)`);
    });
  }

  // ── Step 5d: Catch-up replay — process missed trades since last state ──
  if (savedState && journal && lastProcessedTimestamps.size > 0) {
    const openBefore = journal.getOpenPositions().length;
    if (openBefore > 0) {
      log.info(`\n🔄 Catch-up replay: checking ${config.targetWallets.length} wallet(s) for missed trades...`);
      log.info(`   Open positions to reconcile: ${openBefore}`);

      let missedSells = 0;
      let priceDeviationBlocks = 0;
      const catchUpClosedPositions: Array<{ outcome: string; pnl: number; exitPrice: number; entryPrice: number; size: number; autoClosed: boolean }> = [];
      reconciliation.catchUpRan = true;
      const maxDeviation = runtimeMaxMissedSellDeviation;

      for (const wallet of config.targetWallets) {
        const lastTs = lastProcessedTimestamps.get(wallet) || 0;
        if (lastTs === 0) continue;
        let lastSuccessfulTs = lastTs; // Only advance watermark for successfully processed trades

        try {
          const { proxyFetch } = await import('./proxy');
          const sinceSec = Math.floor(lastTs / 1000);
          const params = new URLSearchParams({
            user: wallet,
            type: 'TRADE',
            limit: '100',
            sortBy: 'TIMESTAMP',
            sortDirection: 'ASC',
          });
          const url = `https://data-api.polymarket.com/activity?${params.toString()}`;
          const resp = await proxyFetch(url, {
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(15_000),
          });

          if (!resp.ok) {
            log.warn(`Catch-up failed for ${wallet.slice(0, 8)}...: HTTP ${resp.status}`);
            continue;
          }

          const trades = (await resp.json()) as import('./types').DataApiTrade[];
          if (!Array.isArray(trades)) continue;

          for (const raw of trades) {
            const tradeTs = typeof raw.timestamp === 'number' ? raw.timestamp * 1000 : new Date(raw.timestamp).getTime();
            if (tradeTs <= lastTs) continue; // Already processed

            if (raw.side === 'SELL' && journal) {
              const openPos = journal.findOpenPosition(raw.asset);
              if (openPos) {
                const exitPrice = typeof raw.price === 'number' ? raw.price : parseFloat(String(raw.price));
                const entryPrice = openPos.entryPrice;

                // Price deviation guard: check if market moved too much during downtime
                if (entryPrice > 0 && exitPrice > 0) {
                  const deviation = Math.abs(exitPrice - entryPrice) / entryPrice;
                  if (deviation > maxDeviation) {
                    priceDeviationBlocks++;
                    log.risk(
                      `⚠️  PRICE DEVIATION BLOCKED: ${openPos.outcome.slice(0, 30)} | ` +
                      `Entry: $${entryPrice.toFixed(4)} → Target exit: $${exitPrice.toFixed(4)} | ` +
                      `Deviation: ${(deviation * 100).toFixed(1)}% > max ${(maxDeviation * 100).toFixed(0)}%`
                    );
                    telegram?.notifyRisk({
                      type: 'halt',
                      message: `Price deviation blocked auto-close: ${openPos.outcome.slice(0, 50)}\nEntry: $${entryPrice.toFixed(4)} → Exit: $${exitPrice.toFixed(4)} (${(deviation * 100).toFixed(1)}% deviation)\nManual review required.`,
                      trade: openPos.outcome,
                    });
                    continue; // Skip this SELL — requires manual intervention
                  }
                }

                // Safe to close — price deviation within bounds
                // If auto-close is enabled, attempt CLOB SELL order first
                let clobCloseSuccess = true;
                if (config.autoCloseOnCatchUp && clob && !config.dryRun) {
                  try {
                    log.info(`🔄 [AUTO-CLOSE] Placing SELL order: ${openPos.outcome.slice(0, 30)} | ${openPos.size.toFixed(4)} shares @ $${exitPrice.toFixed(4)}`);
                    const closeResult = await executor.executeCloseOrder(openPos.tokenId, openPos.size, exitPrice, runtimeAutoCloseOrderType);
                    if (closeResult.success) {
                      if (runtimeAutoCloseOrderType === 'GTC') {
                        // GTC orders rest on the book — track as pending until filled or timeout
                        clobCloseSuccess = false; // Don't record journal exit yet
                        pendingGtcAutoCloses.push({
                          orderId: closeResult.orderId!,
                          tokenId: openPos.tokenId,
                          outcome: openPos.outcome,
                          shares: openPos.size,
                          exitPrice: closeResult.price,
                          entryPrice,
                          placedAt: Date.now(),
                          journalAsset: raw.asset,
                          journalExitTs: tradeTs,
                          trader: openPos.trader || 'unknown',
                        });
                        reconciliation.pendingGtcOrders = pendingGtcAutoCloses.length;
                        log.info(`⏳ [AUTO-CLOSE] GTC order posted: ${closeResult.orderId} | ${openPos.outcome.slice(0, 30)} — waiting to fill or timeout`);
                      } else {
                        reconciliation.catchUpAutoCloses++;
                        log.success(`✅ [AUTO-CLOSE] Order filled: ${closeResult.orderId} | ${closeResult.copyShares.toFixed(4)} shares @ $${closeResult.price.toFixed(4)}`);
                        telegram?.notifyExecution({ side: 'SELL', shares: closeResult.copyShares, price: closeResult.price, notional: closeResult.copyNotional, orderId: closeResult.orderId ?? '', outcome: openPos.outcome });
                      }
                    } else {
                      clobCloseSuccess = false;
                      reconciliation.catchUpAutoCloseFails++;
                      log.error(`❌ [AUTO-CLOSE] Order failed: ${closeResult.error} — position left open for retry`);
                      telegram?.notifyError('Auto-Close Failed', `${openPos.outcome.slice(0, 40)}: ${closeResult.error}`);
                    }
                  } catch (closeErr) {
                    clobCloseSuccess = false;
                    reconciliation.catchUpAutoCloseFails++;
                    const closeMsg = closeErr instanceof Error ? closeErr.message : String(closeErr);
                    log.error(`❌ [AUTO-CLOSE] Error: ${closeMsg} — position left open for retry`);
                  }
                }

                // Only record journal exit if auto-close succeeded or auto-close is disabled
                if (clobCloseSuccess) {
                  journal.recordExit(raw.asset, exitPrice, tradeTs);
                  missedSells++;

                  // Compute P&L directly — openPos.pnl is stale (from before recordExit)
                  const catchUpPnl = (exitPrice - entryPrice) * openPos.size;

                  // Update risk manager: free notional + record P&L
                  riskManager.reduceSessionNotional(openPos.entryPrice * openPos.size);
                  riskManager.addSessionPnl(catchUpPnl);

                  catchUpClosedPositions.push({
                    outcome: openPos.outcome,
                    pnl: catchUpPnl,
                    exitPrice,
                    entryPrice,
                    size: openPos.size,
                    autoClosed: config.autoCloseOnCatchUp === true,
                  });
                  const emoji = catchUpPnl >= 0 ? '✅' : '❌';
                  log.info(
                    `${emoji} [CATCH-UP EXIT] ${openPos.outcome.slice(0, 30)} | ` +
                    `P&L: $${catchUpPnl.toFixed(2)} | Exit: $${exitPrice.toFixed(4)}`
                  );
                  telegram?.notifyTrade({
                    side: 'SELL',
                    size: openPos.size,
                    price: exitPrice,
                    outcome: openPos.outcome,
                    user: openPos.trader || 'unknown',
                  });
                  lastSuccessfulTs = Math.max(lastSuccessfulTs, tradeTs);
                } else {
                  log.info(`⏳ [AUTO-CLOSE] Skipping journal exit — will retry on next restart`);
                }
              }
            }
          }

          // Update lastProcessedTimestamp — only advance to last successful trade
          // Failed auto-closes stay below the watermark so they retry on next restart
          lastProcessedTimestamps.set(wallet, Math.max(lastTs, lastSuccessfulTs));

        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(`Catch-up error for ${wallet.slice(0, 8)}...: ${msg}`);
        }
      }

      const openAfter = journal.getOpenPositions().length;
      reconciliation.catchUpMissedSells = missedSells;
      reconciliation.catchUpDeviationBlocks = priceDeviationBlocks;
      if (reconciliation.catchUpAutoCloses > 0 || reconciliation.catchUpAutoCloseFails > 0) {
        log.info(`   Auto-close: ${reconciliation.catchUpAutoCloses} order(s) filled, ${reconciliation.catchUpAutoCloseFails} failed`);
      }
      if (missedSells > 0 || priceDeviationBlocks > 0) {
        log.info(`   Catch-up complete: ${missedSells} missed exits processed, ${priceDeviationBlocks} blocked (price deviation), ${openAfter} positions still open`);
      } else {
        log.info(`   Catch-up complete: no missed exits found, ${openAfter} positions still open`);
      }

      // ── Telegram summary: list all auto-closed positions with P&L ──
      if (telegram && catchUpClosedPositions.length > 0) {
        const totalPnl = catchUpClosedPositions.reduce((s, p) => s + p.pnl, 0);
        const wins = catchUpClosedPositions.filter(p => p.pnl >= 0).length;
        const losses = catchUpClosedPositions.filter(p => p.pnl < 0).length;
        const lines = catchUpClosedPositions.map(p => {
          const icon = p.pnl >= 0 ? '✅' : '❌';
          return `${icon} ${p.outcome.slice(0, 40)} | P&L: $${p.pnl.toFixed(2)} | Exit: $${p.exitPrice.toFixed(4)}`;
        });
        const summary = [
          `🔄 *Catch-up Summary*`,
          '',
          `*Auto-closed:* ${catchUpClosedPositions.length} position(s)`,
          `*Wins:* ${wins} | *Losses:* ${losses}`,
          `*Total P&L:* $${totalPnl.toFixed(2)} ${totalPnl >= 0 ? '✅' : '❌'}`,
          `*Remaining open:* ${openAfter}`,
          '',
          ...lines,
        ].join('\n');
        telegram.notifyRisk({
          type: totalPnl >= 0 ? 'blocked' : 'drawdown',
          message: summary,
          trade: '',
        });
      }

    }
  }

  // Persist state + dashboard after catch-up (runs in all modes)
  persistJournal();

  // ── Notify: startup open positions (after catch-up, so list is accurate) ──
  if (telegram && journal) {
    const openPositions = journal.getOpenPositions();
    if (openPositions.length > 0) {
      const now = Date.now();
      const lines = openPositions.map(pos => {
        const ageMs = now - pos.timestamp;
        const ageDays = (ageMs / 86_400_000).toFixed(1);
        const ageLabel = ageMs > 86_400_000 ? `${ageDays}d`
          : ageMs > 3_600_000 ? `${(ageMs / 3_600_000).toFixed(1)}h`
          : `${(ageMs / 60_000).toFixed(0)}m`;
        return `• ${pos.outcome.slice(0, 40)} | $${pos.entryPrice.toFixed(4)} | ${pos.size.toFixed(2)} sh | ${ageLabel} old`;
      });
      const exposure = openPositions.reduce((s, p) => s + p.entryPrice * p.size, 0);
      const msg = `ℹ️ [INFO] Startup: ${openPositions.length} open position(s) ($${exposure.toFixed(2)} exposure)\n\n${lines.join('\n')}`;
      log.info(`\n${msg}`);
      telegram.notifyRisk({ type: 'blocked', message: msg, trade: '' });
    }
  }

  // ── Step 5e: CLOB stale order cleanup on startup ──
  // GTC orders persist across restarts. If we don't have a matching position,
  // the order is stale and could fill unexpectedly — cancel it.
  if (clob && !config.dryRun) {
    try {
      const openOrders = await clob.getOpenOrders();
      const orders = Array.isArray(openOrders) ? openOrders : (openOrders as Record<string, unknown>).data as unknown[] || [];
      if (orders.length > 0) {
        const openTokenIds = new Set(positions.getAllPositions().filter(p => p.shares > 0).map(p => p.tokenId));
        const openJournalTokenIds = journal ? new Set(journal.getOpenPositions().map(e => e.tokenId)) : new Set<string>();
        const staleOrders: string[] = [];

        for (const order of orders) {
          const o = order as Record<string, unknown>;
          const tokenId = (o.asset_id as string) || (o.tokenID as string) || (o.tokenId as string) || '';
          const orderId = (o.id as string) || (o.orderID as string) || (o.orderId as string) || '';
          const orderSize = typeof o.original_size === 'number' ? o.original_size : typeof o.size === 'number' ? o.size : 0;

          if (!tokenId || !orderId) continue;

          // An order is stale if its token has no matching position or journal entry
          const hasPosition = openTokenIds.has(tokenId);
          const hasJournalEntry = openJournalTokenIds.has(tokenId);

          if (!hasPosition && !hasJournalEntry) {
            staleOrders.push(orderId);
            log.warn(`Stale CLOB order found: ${orderId.slice(0, 12)}… token=${tokenId.slice(0, 12)}… size=${orderSize}`);
          }
        }

        if (staleOrders.length > 0) {
          log.info(`Canceling ${staleOrders.length} stale CLOB order(s)...`);
          try {
            if (staleOrders.length === 1) {
              await clob.cancelOrder({ orderID: staleOrders[0] });
            } else {
              await clob.cancelOrders(staleOrders);
            }
            log.success(`Canceled ${staleOrders.length} stale CLOB order(s)`);
            reconciliation.staleOrdersCanceled = staleOrders.length;
          } catch (cancelErr) {
            const cancelMsg = cancelErr instanceof Error ? cancelErr.message : String(cancelErr);
            log.error(`Failed to cancel stale orders: ${cancelMsg}`);
            // Fallback: cancel all orders if batch cancel fails
            try {
              await clob.cancelAll();
              log.warn('Used cancelAll as fallback — all open orders canceled');
              reconciliation.staleOrdersCanceled = staleOrders.length;
            } catch (cancelAllErr) {
              const cancelAllMsg = cancelAllErr instanceof Error ? cancelAllErr.message : String(cancelAllErr);
              log.error(`cancelAll fallback also failed: ${cancelAllMsg}`);
            }
          }
        } else {
          log.info(`CLOB order check: ${orders.length} open order(s), all have matching positions — no stale orders`);
        }
        reconciliation.openOrdersChecked = orders.length;
      } else {
        log.info('No open CLOB orders found on startup');
      }
    } catch (orderErr) {
      const orderMsg = orderErr instanceof Error ? orderErr.message : String(orderErr);
      log.warn(`Could not check CLOB orders on startup: ${orderMsg} (continuing without cleanup)`);
    }
  }

  // ── Step 5f: On-chain balance verification ──
  // Verify our persisted positions actually exist on-chain by querying
  // ERC1155 balances from the ConditionalTokens contract on Polygon.
  // Skipped in dry-run/paper mode (no real on-chain positions).
  // In live mode, tokens are held by the Polymarket proxy wallet, not the EOA.
  // We attempt to resolve the proxy wallet from the Data API; if that fails,
  // verification is skipped silently.
  const onChainVerify = (process.env['ON_CHAIN_VERIFY'] || 'false').toLowerCase() === 'true';
  if (onChainVerify && config.rpcUrl && journal && !config.dryRun && !paperMode) {
    const openPositions = journal.getOpenPositions();
    if (openPositions.length > 0) {
      const tokenIds = openPositions.map(e => e.tokenId);
      try {
        log.info(`\n🔗 On-chain verification: checking ${tokenIds.length} position(s)...`);
        const onChainBalances = await verifyOnChainBalances(config.rpcUrl, wallet.address, tokenIds);

        let matched = 0;
        let mismatched = 0;
        const mismatches: string[] = [];

        for (const pos of openPositions) {
          const chainBalance = onChainBalances.get(pos.tokenId) || 0;
          const localShares = pos.size;

          if (chainBalance > 0) {
            matched++;
            log.debug(`  ✅ ${pos.outcome.slice(0, 30)} | on-chain: ${chainBalance.toFixed(4)} shares`);
          } else {
            mismatched++;
            mismatches.push(pos.outcome);
            log.warn(
              `  ⚠️  MISMATCH: ${pos.outcome.slice(0, 30)} | ` +
              `Local: ${localShares.toFixed(4)} shares | On-chain: 0 — position may have been sold or resolved`
            );
          }
        }

        reconciliation.onChainVerified = true;
        reconciliation.onChainMatched = matched;
        reconciliation.onChainMismatched = mismatched;
        reconciliation.onChainMismatches = mismatches;

        if (mismatched > 0) {
          log.risk(
            `⚠️  On-chain verification: ${mismatched} of ${tokenIds.length} positions NOT found on-chain — ` +
            `these may have been sold, resolved, or transferred while the bot was offline`
          );
          telegram?.notifyRisk({
            type: 'halt',
            message: `🔗 On-chain mismatch: ${mismatched} position(s) not found on-chain\n` +
              mismatches.map(m => `• ${m.slice(0, 60)}`).join('\n') +
              `\nThese positions may have been closed. Review recommended.`,
            trade: mismatches[0],
          });
        } else {
          log.success(`On-chain verification: all ${matched} position(s) confirmed on-chain`);
        }
      } catch (verifyErr) {
        const verifyMsg = verifyErr instanceof Error ? verifyErr.message : String(verifyErr);
        log.warn(`On-chain verification failed: ${verifyMsg} (continuing without verification)`);
      }
    }
  }

  // ── Step 5g: Stale position monitoring (periodic) ──
  const staleWarnMs = (config.stalePositionWarnDays ?? 30) * 24 * 60 * 60 * 1000;
  const staleAlerted = new Set<string>(); // tokenId -> already alerted (avoid spam)
  const staleCheckInterval = setInterval(() => {
    if (!journal) return;
    const now = Date.now();
    const openPositions = journal.getOpenPositions();
    for (const pos of openPositions) {
      const holdMs = now - pos.timestamp;
      if (holdMs > staleWarnMs && !staleAlerted.has(pos.tokenId)) {
        staleAlerted.add(pos.tokenId);
        reconciliation.stalePositionCount = staleAlerted.size;
        reconciliation.stalePositions = Array.from(staleAlerted);
        const holdDays = (holdMs / 86_400_000).toFixed(1);
        log.warn(`⏰ STALE POSITION: ${pos.outcome.slice(0, 30)} held for ${holdDays} days (entry: $${pos.entryPrice.toFixed(4)})`);
        telegram?.notifyRisk({
          type: 'halt',
          message: `⏰ Stale position held ${holdDays} days: ${pos.outcome.slice(0, 50)}\nEntry: $${pos.entryPrice.toFixed(4)} | Size: ${pos.size.toFixed(2)} shares\nConsider closing manually.`,
          trade: pos.outcome,
        });
      }
    }
  }, 3_600_000); // Check every hour

  // ── Step 5g2: Pending GTC auto-close timeout checker (periodic) ──
  // When GTC is used for auto-close, orders rest on the book. If they don't
  // fill within the timeout, cancel them and retry with FOK for immediate fill.
  const gtcTimeoutMs = config.autoCloseGtcTimeoutMs ?? 300_000;
  const gtcCheckInterval = setInterval(async () => {
    if (pendingGtcAutoCloses.length === 0 || !clob || config.dryRun) return;
    const now = Date.now();

    // Check which orders are still open on the CLOB
    let openOrderIds = new Set<string>();
    try {
      const openOrders = await clob.getOpenOrders();
      const orders = Array.isArray(openOrders) ? openOrders : (openOrders as Record<string, unknown>).data as unknown[] || [];
      openOrderIds = new Set(orders.map(o => ((o as Record<string, unknown>).id as string) || ((o as Record<string, unknown>).orderID as string) || ((o as Record<string, unknown>).orderId as string) || ''));
    } catch (err) {
      log.debug(`GTC check: failed to get open orders: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    // Process pending orders (iterate backwards since we may splice)
    for (let i = pendingGtcAutoCloses.length - 1; i >= 0; i--) {
      const pending = pendingGtcAutoCloses[i];

      if (!openOrderIds.has(pending.orderId)) {
        // Order no longer open — assume filled
        pendingGtcAutoCloses.splice(i, 1);
        reconciliation.catchUpAutoCloses++;
        reconciliation.pendingGtcOrders = pendingGtcAutoCloses.length;

        // Record journal exit
        if (journal) {
          journal.recordExit(pending.journalAsset, pending.exitPrice, pending.journalExitTs);
          const catchUpPnl = (pending.exitPrice - pending.entryPrice) * pending.shares;
          riskManager.reduceSessionNotional(pending.entryPrice * pending.shares);
          riskManager.addSessionPnl(catchUpPnl);
        }

        log.success(`✅ [GTC FILLED] ${pending.outcome.slice(0, 30)} | Order: ${pending.orderId.slice(0, 12)}…`);
        telegram?.notifyExecution({ side: 'SELL', shares: pending.shares, price: pending.exitPrice, notional: pending.exitPrice * pending.shares, orderId: pending.orderId, outcome: pending.outcome });
        persistJournal();
        continue;
      }

      // Order still open — check timeout
      const elapsed = now - pending.placedAt;
      if (elapsed < gtcTimeoutMs) continue;

      // Timeout reached — cancel and retry with FOK
      log.warn(`⏰ [GTC TIMEOUT] ${pending.outcome.slice(0, 30)} | ${pending.orderId.slice(0, 12)}… unfilled after ${(elapsed / 1000).toFixed(0)}s — canceling and retrying with FOK`);
      reconciliation.catchUpGtcTimeouts++;

      try {
        await clob.cancelOrder({ orderID: pending.orderId });
        log.info(`[GTC TIMEOUT] Order ${pending.orderId.slice(0, 12)}… canceled`);
      } catch (cancelErr) {
        log.warn(`[GTC TIMEOUT] Failed to cancel order ${pending.orderId.slice(0, 12)}…: ${cancelErr instanceof Error ? cancelErr.message : String(cancelErr)}`);
      }

      // Retry with FOK
      reconciliation.catchUpFokRetries++;
      try {
        const retryResult = await executor.executeCloseOrder(pending.tokenId, pending.shares, pending.exitPrice, 'FOK');
        if (retryResult.success) {
          pendingGtcAutoCloses.splice(i, 1);
          reconciliation.catchUpAutoCloses++;
          reconciliation.pendingGtcOrders = pendingGtcAutoCloses.length;

          // Record journal exit
          if (journal) {
            journal.recordExit(pending.journalAsset, pending.exitPrice, pending.journalExitTs);
            const catchUpPnl = (pending.exitPrice - pending.entryPrice) * pending.shares;
            riskManager.reduceSessionNotional(pending.entryPrice * pending.shares);
            riskManager.addSessionPnl(catchUpPnl);
          }

          log.success(`✅ [FOK RETRY] ${pending.outcome.slice(0, 30)} | Filled: ${retryResult.copyShares.toFixed(4)} shares @ $${retryResult.price.toFixed(4)}`);
          telegram?.notifyExecution({ side: 'SELL', shares: retryResult.copyShares, price: retryResult.price, notional: retryResult.copyNotional, orderId: retryResult.orderId ?? '', outcome: pending.outcome });
          persistJournal();
        } else {
          reconciliation.catchUpFokRetryFails++;
          log.error(`❌ [FOK RETRY FAILED] ${pending.outcome.slice(0, 30)}: ${retryResult.error}`);
          telegram?.notifyError('FOK Retry Failed', `${pending.outcome.slice(0, 40)}: ${retryResult.error}`);
        }
      } catch (retryErr) {
        reconciliation.catchUpFokRetryFails++;
        log.error(`❌ [FOK RETRY ERROR] ${pending.outcome.slice(0, 30)}: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`);
      }
    }
  }, 30_000); // Check every 30 seconds

  // ── Step 5h: Market resolution detection (periodic) ──
  // Polls the Gamma API to detect when markets with open positions resolve.
  // For winning positions, optionally redeems ERC1155 tokens via CTF.
  let resolver: MarketResolver | null = null;
  let resolutionCheckInterval: ReturnType<typeof setInterval> | null = null;
  if (config.resolutionCheckEnabled && journal && !backtestMode) {
    resolver = new MarketResolver({
      config: {
        enabled: true,
        checkIntervalMs: config.resolutionCheckIntervalMs ?? 600_000,
        autoRedeem: config.autoRedeemEnabled ?? false,
      },
      journal,
      riskManager,
      wallet,
      rpcUrl: config.rpcUrl,
      telegram,
      onResolution: (result) => {
        reconciliation.marketsResolved++;
        if (result.won) {
          reconciliation.positionsWon++;
          if (result.redemptionAttempted) {
            reconciliation.redemptionAttempts++;
            if (result.redeemed) {
              reconciliation.redemptionSuccesses++;
            } else {
              reconciliation.redemptionFailures++;
            }
          }
          // Deduplicate by tokenId
          if (!reconciliation.resolvedPositions.find(p => p.tokenId === result.tokenId)) {
            reconciliation.resolvedPositions.push({
              tokenId: result.tokenId,
              outcome: result.outcome,
              title: result.title,
              won: true,
              redeemed: result.redeemed,
            });
          }
        } else {
          reconciliation.positionsLost++;
          if (!reconciliation.resolvedPositions.find(p => p.tokenId === result.tokenId)) {
            reconciliation.resolvedPositions.push({
              tokenId: result.tokenId,
              outcome: result.outcome,
              title: result.title,
              won: false,
              redeemed: false,
            });
          }
        }
        // Feed resolution outcome back to AI filter for calibration
        if (config.aiFeedbackEnabled && result.aiProbability !== undefined && aiFilter) {
          aiFilter.addFeedbackRecord({
            probability: result.aiProbability,
            confidence: result.aiConfidence ?? 0,
            actualOutcome: result.won ? 1 : 0,
            category: result.category,
            timestamp: Date.now(),
          });
        }

        persistJournal();
      },
    });
    const checkMs = config.resolutionCheckIntervalMs ?? 600_000;
    resolutionCheckInterval = setInterval(() => {
      resolver?.checkResolutions().catch(err => {
        log.debug(`[RESOLVER] Check failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, checkMs);
    // Run initial check after 30s (let the bot start up first)
    setTimeout(() => {
      resolver?.checkResolutions().catch(() => {});
    }, 30_000);
    log.info(`Resolution check enabled: every ${(checkMs / 1000).toFixed(0)}s` +
      (config.autoRedeemEnabled ? ' (auto-redeem ON)' : ' (detection only)'));
  }

  // ── Step 5i: Dynamic leaderboard refresh (periodic) ──
  let leaderboardRefreshInterval: ReturnType<typeof setInterval> | null = null;
  if (scraper && leaderboardConfig && !backtestMode) {
    leaderboardRefreshInterval = setInterval(async () => {
      if (!scraper!.needsRefresh()) return;
      try {
        log.info('🔄 Refreshing leaderboard — checking for new top traders...');
        const profiles = await scraper!.discover();
        if (profiles.length > 0) {
          const discoveredWallets = profiles.map((p) => p.walletAddress);
          const allWallets = [...new Set([...config.targetWallets, ...discoveredWallets])];
          const newCount = allWallets.length - config.targetWallets.length;
          if (newCount > 0) {
            config = { ...config, targetWallets: allWallets };
            log.success(`Leaderboard refreshed: ${newCount} new trader(s) added (${allWallets.length} total)`);
            telegram?.notifyRisk({ type: 'blocked', message: `🔄 Leaderboard refreshed: ${newCount} new trader(s) added`, trade: '' });
          } else {
            log.info('Leaderboard refresh: no new traders found');
          }
        }
      } catch (err) {
        log.debug(`Leaderboard refresh failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, (leaderboardConfig.refreshIntervalMinutes || 60) * 60_000);
    log.info(`Dynamic leaderboard refresh: every ${leaderboardConfig.refreshIntervalMinutes || 60} min`);
  }

  // ── Step 5j: Live price tracking + trailing stop-loss (periodic) ──
  let livePriceInterval: ReturnType<typeof setInterval> | null = null;
  let trailingStopInterval: ReturnType<typeof setInterval> | null = null;
  if (config.livePriceEnabled && journal && !backtestMode) {
    const priceIntervalMs = config.livePriceIntervalMs ?? 60_000;
    livePriceInterval = setInterval(async () => {
      const openPositions = positions.getAllPositions().filter(p => p.shares > 0);
      if (openPositions.length === 0) return;

      // Fetch current prices from Gamma API for all open positions
      for (const pos of openPositions) {
        try {
          const resp = await proxyFetch(
            `https://gamma-api.polymarket.com/markets?token_id=${pos.tokenId}&limit=1`,
            { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8_000) }
          );
          if (!resp.ok) continue;
          const markets = (await resp.json()) as Array<{ outcomePrices?: string }>;
          if (!Array.isArray(markets) || markets.length === 0) continue;

          const rawPrices = markets[0].outcomePrices;
          const prices: string[] = typeof rawPrices === 'string'
            ? JSON.parse(rawPrices) as string[]
            : Array.isArray(rawPrices) ? rawPrices : [];

          // Match our token to the correct price by finding its index in the tokens array
          // Gamma API returns tokens: [{token_id, outcome}], prices: [YES_price, NO_price]
          const tokens = (markets[0] as Record<string, unknown>).tokens as Array<{ token_id?: string; token?: string }> | undefined;
          if (tokens && Array.isArray(tokens)) {
            const tokenIdx = tokens.findIndex(t => (t.token_id || t.token) === pos.tokenId);
            if (tokenIdx >= 0 && tokenIdx < prices.length) {
              const price = parseFloat(prices[tokenIdx]);
              if (!isNaN(price) && price > 0 && price < 1) {
                positions.updateCurrentPrice(pos.tokenId, price);
              }
            }
          }
        } catch {
          // Silently continue — price updates are best-effort
        }
      }

      // Update realized P&L from journal for portfolio valuation
      if (journal) {
        const closedTrades = journal.getClosedTrades();
        const realizedPnl = closedTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
        riskManager.setRealizedPnl(realizedPnl);
      }
    }, priceIntervalMs);
    log.info(`Live price tracking: every ${priceIntervalMs / 1000}s`);
  }

  // Trailing stop-loss check (runs after live prices are updated)
  if (config.trailingStopEnabled && journal && !backtestMode) {
    const stopCheckMs = Math.max(config.livePriceIntervalMs ?? 60_000, 30_000);
    trailingStopInterval = setInterval(async () => {
      const triggers = positions.getTrailingStopTriggers(config.trailingStopPct);
      if (triggers.length === 0) return;

      for (const pos of triggers) {
        const stopPrice = (pos.peakPrice || 0) * (1 - config.trailingStopPct);
        const drawdownPct = pos.peakPrice ? ((pos.peakPrice - (pos.currentPrice || 0)) / pos.peakPrice * 100).toFixed(1) : '?';
        log.warn(`🛑 TRAILING STOP: ${pos.outcome.slice(0, 30)} | Current: $${(pos.currentPrice || 0).toFixed(4)} | Peak: $${(pos.peakPrice || 0).toFixed(4)} | Drawdown: ${drawdownPct}%`);

        // Attempt to sell via CLOB
        if (clob && !config.dryRun) {
          try {
            const closeResult = await executor.executeCloseOrder(pos.tokenId, pos.shares, pos.currentPrice || stopPrice, 'FOK');
            if (closeResult.success) {
              log.success(`✅ [TRAILING STOP] Sold ${pos.outcome.slice(0, 30)} | ${closeResult.copyShares.toFixed(4)} shares @ $${closeResult.price.toFixed(4)}`);
              telegram?.notifyExecution({ side: 'SELL', shares: closeResult.copyShares, price: closeResult.price, notional: closeResult.copyNotional, orderId: closeResult.orderId ?? '', outcome: pos.outcome });

              // Record exit in journal
              if (journal) {
                const exitEntry = journal.findOpenPosition(pos.tokenId);
                journal.recordExit(pos.tokenId, closeResult.price, Date.now());
                if (exitEntry) {
                  const exitPnl = (closeResult.price - exitEntry.entryPrice) * exitEntry.size;
                  riskManager.reduceSessionNotional(exitEntry.entryPrice * exitEntry.size);
                  riskManager.addSessionPnl(exitPnl);
                }
              }
              persistJournal();
            } else {
              log.error(`❌ [TRAILING STOP] Failed to sell ${pos.outcome.slice(0, 30)}: ${closeResult.error}`);
              telegram?.notifyError('Trailing Stop Failed', `${pos.outcome.slice(0, 40)}: ${closeResult.error}`);
            }
          } catch (err) {
            log.error(`❌ [TRAILING STOP] Error: ${err instanceof Error ? err.message : String(err)}`);
          }
        } else {
          // Dry run — just log
          log.info(`[DRY RUN] Trailing stop triggered: ${pos.outcome.slice(0, 30)} would sell @ $${(pos.currentPrice || 0).toFixed(4)}`);
          if (journal) {
            journal.recordExit(pos.tokenId, pos.currentPrice || stopPrice, Date.now());
          }
          persistJournal();
        }

        // Update position tracker to reflect the sell (reduces shares to 0)
        // Without this, getTrailingStopTriggers() would keep finding the position
        // because PositionTracker and TradeJournal are separate systems.
        positions.recordFill({
          trade: {
            id: `trailing-stop-${pos.tokenId}`,
            timestamp: Date.now(),
            market: pos.market,
            tokenId: pos.tokenId,
            side: 'SELL' as const,
            size: pos.shares,
            price: pos.currentPrice || pos.avgPrice,
            user: 'trailing-stop',
            outcome: pos.outcome,
            title: pos.outcome,
          },
          notional: (pos.currentPrice || pos.avgPrice) * pos.shares,
          shares: pos.shares,
          price: pos.currentPrice || pos.avgPrice,
          side: 'SELL',
        });
      }
    }, stopCheckMs);
    log.info(`Trailing stop-loss: enabled (${(config.trailingStopPct * 100).toFixed(0)}% drawdown from peak)`);
  }

  // ── Step 6: Start trade monitor ──
  const monitor = new TradeMonitor(config, handleNewTrade);
  await monitor.start();

  const modeDisplay = paperMode ? '📝 PAPER TRADING' : config.dryRun ? '🟢 DRY RUN' : '🔴 LIVE TRADING';
  log.success(`Bot is running! Monitoring target wallets...`);
  log.info(`Wallet: ${wallet.address}`);
  log.info(`Mode: ${modeDisplay}`);
  if (paperMode) {
    log.info(`Starting capital: $${startingCapital.toFixed(2)}`);
  }
  log.info('Press Ctrl+C to stop\n');

  // ── Step 6b: Start dashboard HTTP server (all modes) ──
  let dashboardServer: http.Server | null = null;
  const DASHBOARD_PORT = 3456;
  dashboardServer = http.createServer((req, res) => {
    const reqPath = req.url?.split('?')[0] || '/';
    if (reqPath === '/dry-run-trades.json') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
      // Always return live stats from memory (up-to-date even if file hasn't been written yet)
      // Build title lookup from journal entries for position enrichment
      const journalEntries = journal ? journal.getEntries() : [];
      const titleByToken = new Map<string, string>();
      for (const e of journalEntries) {
        if (e.title && e.tokenId) titleByToken.set(e.tokenId, e.title);
      }
        // Per-trader aggregation with enriched details
        const traderMap = new Map<string, {
          trades: number; volume: number; pnl: number; wins: number; losses: number;
          categories: Set<string>; recentTrades: Array<{ tradeId: string; outcome: string; title: string; side: string; price: number; pnl?: number; timestamp: number; notional: number; slug?: string }>;
          bestTrade: { tradeId: string; pnl: number } | null; worstTrade: { tradeId: string; pnl: number } | null;
          firstTrade: number; lastTrade: number; openPositions: number; avgHoldTimeMs: number; totalHoldMs: number; closedCount: number;
        }>();
        for (const e of journalEntries) {
          if (!e.trader) continue;
          const t = traderMap.get(e.trader) || {
            trades: 0, volume: 0, pnl: 0, wins: 0, losses: 0,
            categories: new Set<string>(), recentTrades: [], bestTrade: null, worstTrade: null,
            firstTrade: Infinity, lastTrade: 0, openPositions: 0, avgHoldTimeMs: 0, totalHoldMs: 0, closedCount: 0,
          };
          t.trades++;
          t.volume += (e.entryPrice || 0) * (e.size || 0);
          if (e.category) t.categories.add(e.category);
          t.firstTrade = Math.min(t.firstTrade, e.timestamp);
          t.lastTrade = Math.max(t.lastTrade, e.timestamp);
          if (e.pnl !== undefined) {
            t.pnl += e.pnl;
            t.closedCount++;
            if (e.holdTimeMs) t.totalHoldMs += e.holdTimeMs;
            if (e.pnl > 0) t.wins++; else if (e.pnl < 0) t.losses++;
            if (!t.bestTrade || e.pnl > t.bestTrade.pnl) t.bestTrade = { tradeId: e.tradeId, pnl: e.pnl };
            if (!t.worstTrade || e.pnl < t.worstTrade.pnl) t.worstTrade = { tradeId: e.tradeId, pnl: e.pnl };
          } else {
            t.openPositions++;
          }
          // Keep last 20 trades per trader for the modal
          t.recentTrades.push({ tradeId: e.tradeId, outcome: e.outcome, title: e.title || e.market, side: e.side, price: e.entryPrice, pnl: e.pnl, timestamp: e.timestamp, notional: (e.entryPrice || 0) * (e.size || 0), slug: e.slug });
          if (t.recentTrades.length > 20) t.recentTrades.shift();
          traderMap.set(e.trader, t);
        }
        const traders = Array.from(traderMap.entries()).map(([addr, t]) => ({
          address: addr,
          short: addr.slice(0, 6) + '…' + addr.slice(-4),
          trades: t.trades, volume: t.volume, pnl: t.pnl, wins: t.wins, losses: t.losses,
          winRate: (t.wins + t.losses) > 0 ? t.wins / (t.wins + t.losses) : 0,
          categories: Array.from(t.categories),
          recentTrades: t.recentTrades,
          bestTrade: t.bestTrade, worstTrade: t.worstTrade,
          firstTrade: t.firstTrade === Infinity ? 0 : t.firstTrade,
          lastTrade: t.lastTrade,
          openPositions: t.openPositions,
          avgHoldTimeMs: t.closedCount > 0 ? t.totalHoldMs / t.closedCount : 0,
        })).sort((a, b) => b.trades - a.trades);

        const liveData = {
          lastUpdated: new Date().toISOString(),
          startTime: stats.startTime,
          stats: { ...stats },
          entries: journalEntries,
          openPositions: journal ? journal.getOpenPositions().map(e => ({ outcome: e.outcome, tokenId: e.tokenId, shares: e.size, entryPrice: e.entryPrice, timestamp: e.timestamp, market: e.market, title: e.title, reason: e.reason, trader: e.trader, slug: e.slug, volume24hr: e.volume24hr, category: e.category })) : [],
          positions: positions.getAllPositions().filter(p => p.shares > 0).map(p => ({
            market: p.market,
            title: titleByToken.get(p.tokenId) || p.outcome,
            outcome: p.outcome,
            tokenId: p.tokenId,
            shares: p.shares,
            notional: p.notional,
            avgPrice: p.avgPrice,
            currentPrice: p.currentPrice,
            peakPrice: p.peakPrice,
            unrealizedPnl: p.currentPrice !== undefined ? (p.currentPrice - p.avgPrice) * p.shares : undefined,
            trailingStopPrice: p.peakPrice ? p.peakPrice * (1 - (config.trailingStopPct || 0.10)) : undefined,
          })),
          risk: { ...riskManager.getState() },
          portfolio: {
            realized: riskManager.getRealizedPnl(),
            unrealized: positions.getUnrealizedPnl(),
            total: startingCapital + riskManager.getRealizedPnl() + positions.getUnrealizedPnl(),
            startingCapital,
          },
          traders,
          config: {
            maxSessionNotional: config.maxSessionNotional,
            maxPerMarketNotional: config.maxPerMarketNotional,
            maxPerCategoryNotional: config.maxPerCategoryNotional,
            positionMultiplier: config.positionMultiplier,
            targetWallets: config.targetWallets.length,
            maxMissedSellDeviation: runtimeMaxMissedSellDeviation,
            autoCloseOrderType: runtimeAutoCloseOrderType,
            trailingStopEnabled: config.trailingStopEnabled,
            trailingStopPct: config.trailingStopPct,
            kellySizingEnabled: config.kellySizingEnabled,
            livePriceEnabled: config.livePriceEnabled,
          },
          calibration: aiFilter && config.aiFeedbackEnabled ? aiFilter.getCalibrationStats() : null,
          strategies: strategyRouter ? strategyRunners.map(r => r.getState()) : null,
          reconciliation: { ...reconciliation },
        };
        res.end(JSON.stringify(liveData));
      } else if (reqPath === '/api/config' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', () => {
          try {
            const update = JSON.parse(body);
            let updated = false;
            if (typeof update.maxMissedSellDeviation === 'number' && update.maxMissedSellDeviation >= 0 && update.maxMissedSellDeviation <= 1) {
              runtimeMaxMissedSellDeviation = update.maxMissedSellDeviation;
              log.info(`Max missed sell deviation updated to ${(runtimeMaxMissedSellDeviation * 100).toFixed(0)}%`);
              updated = true;
            }
            if (typeof update.autoCloseOrderType === 'string' && ['FOK', 'GTC', 'FAK'].includes(update.autoCloseOrderType)) {
              runtimeAutoCloseOrderType = update.autoCloseOrderType;
              log.info(`Auto-close order type updated to ${runtimeAutoCloseOrderType}`);
              updated = true;
            }
            if (updated) {
              res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
              res.end(JSON.stringify({ ok: true, maxMissedSellDeviation: runtimeMaxMissedSellDeviation, autoCloseOrderType: runtimeAutoCloseOrderType }));
            } else {
              res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
              res.end(JSON.stringify({ error: 'No valid config fields provided' }));
            }
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
          }
        });
      } else if (reqPath === '/api/config' && req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
        res.end();
      } else if (reqPath === '/api/redeem' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', async () => {
          try {
            const { tokenId } = JSON.parse(body) as { tokenId?: string };
            if (!tokenId || typeof tokenId !== 'string') {
              res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
              res.end(JSON.stringify({ error: 'tokenId is required' }));
              return;
            }
            if (!resolver) {
              res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
              res.end(JSON.stringify({ error: 'Resolution check not enabled (set RESOLUTION_CHECK_ENABLED=true)' }));
              return;
            }
            log.info(`[API] Manual redeem requested for token ${tokenId.slice(0, 12)}…`);
            const result = await resolver.redeemOnDemand(tokenId);
            if (result.success) {
              // Only increment attempts if not already counted by auto-redeem
              const rp = reconciliation.resolvedPositions.find(p => p.tokenId === tokenId);
              if (!rp?.redeemed) {
                reconciliation.redemptionAttempts++;
                reconciliation.redemptionSuccesses++;
              }
              if (rp) rp.redeemed = true;
              persistJournal();
            } else {
              reconciliation.redemptionAttempts++;
              reconciliation.redemptionFailures++;
            }
            res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify(result));
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Invalid request' }));
          }
        });
      } else if (reqPath === '/api/redeem' && req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
        res.end();
      } else if (reqPath === '/' || reqPath === '/dashboard.html') {
        try {
          const html = fs.readFileSync(path.join(process.cwd(), 'dashboard.html'), 'utf-8');
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(html);
        } catch {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('dashboard.html not found in project root');
        }
      } else if (reqPath === '/favicon.ico') {
        res.writeHead(204);
        res.end();
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
      }
    });
  dashboardServer.listen(DASHBOARD_PORT, () => {
    log.success(`📊 Dashboard: http://localhost:${DASHBOARD_PORT}`);
  });
  dashboardServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      log.warn(`Dashboard port ${DASHBOARD_PORT} in use — dashboard unavailable`);
    }
  });

  // ── Periodic journal persistence (keeps dashboard + state fresh) ──
  const persistInterval: ReturnType<typeof setInterval> = setInterval(() => { persistJournal(); }, 30_000); // Every 30 seconds
  persistJournal(); // Write initial file so dashboard loads immediately

  // ── Step 7: Periodic status reports ──
  const statusInterval = setInterval(() => {
    printStatusReport();
    telegram?.notifyStatus({
      uptime: Math.floor((Date.now() - stats.startTime) / 1000),
      detected: stats.tradesDetected,
      copied: stats.tradesCopied,
      skipped: stats.tradesSkipped,
      aiRejected: stats.tradesAiRejected,
      failed: stats.tradesFailed,
      volume: stats.totalVolume,
    });
  }, 600_000); // Every 10 minutes

  // ── Step 8: Graceful shutdown ──
  async function shutdown(signal: string): Promise<void> {
    log.info(`\n${signal} received. Shutting down...`);
    monitor.stop();
    if (dashboardServer) dashboardServer.close();
    if (onchainMonitor) onchainMonitor.stop();
    if (intelligence) intelligence.stop();
    clearInterval(statusInterval);
    clearInterval(staleCheckInterval);
    clearInterval(gtcCheckInterval);
    if (resolutionCheckInterval) clearInterval(resolutionCheckInterval);
    if (leaderboardRefreshInterval) clearInterval(leaderboardRefreshInterval);
    if (livePriceInterval) clearInterval(livePriceInterval);
    if (trailingStopInterval) clearInterval(trailingStopInterval);
    clearInterval(persistInterval);
    if (marketRefreshInterval) clearInterval(marketRefreshInterval);

    // Cancel any pending GTC auto-close orders on shutdown
    if (pendingGtcAutoCloses.length > 0 && clob && !config.dryRun) {
      log.info(`Canceling ${pendingGtcAutoCloses.length} pending GTC auto-close order(s)...`);
      for (const pending of pendingGtcAutoCloses) {
        try {
          await clob.cancelOrder({ orderID: pending.orderId });
          log.info(`  Canceled GTC order: ${pending.orderId.slice(0, 12)}… (${pending.outcome.slice(0, 30)})`);
        } catch (cancelErr) {
          log.warn(`  Failed to cancel GTC order ${pending.orderId.slice(0, 12)}…: ${cancelErr instanceof Error ? cancelErr.message : String(cancelErr)}`);
        }
      }
      pendingGtcAutoCloses.length = 0;
      reconciliation.pendingGtcOrders = 0;
    }

    printFinalReport();

    // Paper trading: print metrics and optionally export journal
    if (paperMode && journal) {
      const entries = journal.getEntries();
      const closedTrades = journal.getClosedTrades();
      const openPositions = journal.getOpenPositions();

      if (closedTrades.length > 0 || openPositions.length > 0) {
        const metrics = MetricsCalculator.calculate(entries, startingCapital);
        console.log(MetricsCalculator.formatReport(metrics));

        if (openPositions.length > 0) {
          console.log(`\n📂 ${openPositions.length} open position(s) (no exit recorded):`);
          for (const pos of openPositions) {
            console.log(`  • ${pos.outcome} | ${pos.size.toFixed(4)} shares @ $${pos.entryPrice.toFixed(4)}`);
          }
        }
      }

      if (paperConfig?.exportOnExit && entries.length > 0) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const ext = paperConfig.exportFormat;
        const filename = `paper-journal-${timestamp}.${ext}`;
        const content = ext === 'csv' ? MetricsCalculator.exportJournalCSV(entries) : MetricsCalculator.exportJournalJSON(entries);

        try {
          fs.writeFileSync(filename, content, 'utf-8');
          log.success(`Journal exported: ${filename}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(`Failed to export journal: ${msg}`);
        }
      }
    }

    // Persist final state and dashboard data (all modes)
    persistJournal();
    if ((config.dryRun || paperMode) && journal) {
      const entries = journal.getEntries();
      if (entries.length > 0) {
        const closedTrades = journal.getClosedTrades();
        const openPositions = journal.getOpenPositions();
        console.log(`\n📋 Dry-Run Trade Journal: ${entries.length} entries, ${closedTrades.length} closed, ${openPositions.length} open`);
        console.log(`   View dashboard: open dashboard.html in your browser`);
        console.log(`   Trade data: ${dashboardPath}`);
      }
    }

    if (telegram) await telegram.disconnect();
    process.exit(0);
  }

  process.on('SIGINT', () => { shutdown('SIGINT').catch(() => process.exit(1)); });
  process.on('SIGTERM', () => { shutdown('SIGTERM').catch(() => process.exit(1)); });
}

// ──────────────────────────────────────────────
// Paper Trading Helpers
// ──────────────────────────────────────────────

/**
 * Synchronous paper trade execution — mirrors PaperExecutor logic inline.
 * Used during backtest to guarantee journal entry ordering (no async gaps).
 * Applies simulated slippage and gas costs for realistic backtest results.
 */
function executePaperSync(
  config: BotConfig,
  trade: ParsedTrade,
  paperCfg: PaperTradingConfig,
): { success: true; orderId: string; copyNotional: number; copyShares: number; price: number; side: 'BUY' | 'SELL' } {
  const copyNotional = calculateCopySize(config, trade.size);
  const fillPrice = calculateSimulatedFillPrice(paperCfg.simulatedSlippageBps, trade.price, trade.side);

  const copyShares = fillPrice > 0 ? copyNotional / fillPrice : 0;
  const gasCost = paperCfg.simulatedGasCost;

  log.info(
    `[BACKTEST] ${trade.side} ${copyNotional.toFixed(2)} USDC @ ${fillPrice.toFixed(4)} ` +
    `(${copyShares.toFixed(4)} shares) | Gas: $${gasCost.toFixed(2)}`,
  );
  return {
    success: true,
    orderId: `backtest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    copyNotional: copyNotional + gasCost,
    copyShares,
    price: fillPrice,
    side: trade.side,
  };
}

// ──────────────────────────────────────────────
// Backtest Mode — Historical replay
// ──────────────────────────────────────────────

async function runBacktest(
  config: BotConfig,
  backtestConfig: import('./types').BacktestConfig,
): Promise<void> {
  log.info('Starting backtest...');
  log.info(`Time range: ${new Date(backtestConfig.startTime).toISOString()} → ${new Date(backtestConfig.endTime).toISOString()}`);
  log.info(`Wallets: ${backtestConfig.targetWallets.length}`);
  log.info(`Starting capital: $${backtestConfig.startingCapital}`);
  log.info(`Speed: ${backtestConfig.speedMultiplier}x`);

  const backtestStart = Date.now();

  // Create paper components (no CLOB needed)
  const paperCfg: import('./types').PaperTradingConfig = {
    startingCapital: backtestConfig.startingCapital,
    fillMode: 'target_price',
    simulatedSlippageBps: backtestConfig.simulatedSlippageBps,
    simulatedGasCost: backtestConfig.simulatedGasCost,
    autoCloseOnResolution: true,
    exportOnExit: backtestConfig.exportResults,
    exportFormat: backtestConfig.exportFormat,
  };

  const positions = new PositionTracker();
  const riskManager = new RiskManager(config, positions);
  const journal = new TradeJournal();

  if (backtestConfig.targetWallets.length === 0) {
    log.warn('No target wallets configured — backtest will have no trades');
  }

  let totalTrades = 0;
  let copiedTrades = 0;
  let skippedTrades = 0;

  // Trade handler for backtest — fully synchronous to preserve journal ordering.
  function handleBacktestTrade(trade: ParsedTrade): void {
    totalTrades++;

    // Record SELL as exit in journal
    if (trade.side === 'SELL') {
      const exitEntry = journal.findOpenPosition(trade.tokenId);
      journal.recordExit(trade.tokenId, trade.price, trade.timestamp);
      if (exitEntry) {
        riskManager.reduceSessionNotional(exitEntry.entryPrice * exitEntry.size);
        riskManager.addSessionPnl(exitEntry.pnl ?? 0);
      }
      return;
    }

    const copyNotional = calculateCopySize(config, trade.size);

    // Risk check
    const riskCheck = riskManager.checkTrade(trade, copyNotional);
    if (!riskCheck.allowed) {
      skippedTrades++;
      return;
    }

    // Execute paper trade synchronously (no async — preserves journal ordering)
    const result = executePaperSync(config, trade, paperCfg);
    if (result.success) {
      copiedTrades++;
      stats.tradesCopied++;
      stats.totalVolume += result.copyNotional;

      positions.recordFill({ trade, notional: result.copyNotional, shares: result.copyShares, price: result.price, side: result.side });
      riskManager.recordFill({ trade, notional: result.copyNotional, shares: result.copyShares, price: result.price, side: result.side });
      journal.recordEntry(trade, result.copyNotional, result.price, 'backtest');
    } else {
      stats.tradesFailed++;
    }
  }

  // Start historical replay
  const historicalMonitor = new HistoricalMonitor(config, backtestConfig, handleBacktestTrade);

  try {
    await historicalMonitor.start();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error(`Backtest failed: ${msg}`);
    process.exit(1);
  }

  const backtestDuration = Date.now() - backtestStart;

  // ── Generate report ──
  const entries = journal.getEntries();
  const closedTrades = journal.getClosedTrades();
  const openPositions = journal.getOpenPositions();

  console.log('\n' + '═'.repeat(60));
  console.log('📊  BACKTEST COMPLETE');
  console.log('═'.repeat(60));
  console.log(`  Duration:         ${(backtestDuration / 1000).toFixed(1)}s`);
  console.log(`  Trades fetched:   ${totalTrades}`);
  console.log(`  Trades copied:    ${copiedTrades}`);
  console.log(`  Trades skipped:   ${skippedTrades}`);
  console.log(`  Journal entries:  ${entries.length}`);
  console.log(`  Closed trades:    ${closedTrades.length}`);
  console.log(`  Open positions:   ${openPositions.length}`);

  if (closedTrades.length > 0) {
    const metrics = MetricsCalculator.calculate(entries, backtestConfig.startingCapital);
    console.log(MetricsCalculator.formatReport(metrics));
  } else if (entries.length > 0) {
    console.log('\n  ⚠️  No closed trades — all positions are still open');
    console.log('  → The target wallets only had BUY trades during this time range');
    console.log('  → They haven\'t sold yet, so there are no exit prices or P&L to calculate');
    console.log('  → Try a wider BACKTEST_START → BACKTEST_END range to capture full round-trips');
  } else {
    console.log('\n  ⚠️  No trades found for target wallets in this time range');
    console.log('  → Check that TARGET_WALLETS contains valid Polymarket proxy wallets');
    console.log('  → Try a wider BACKTEST_START → BACKTEST_END range');
  }

  // Export results
  if (backtestConfig.exportResults && entries.length > 0) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const ext = backtestConfig.exportFormat;

    // Export journal
    const journalFile = `backtest-journal-${timestamp}.${ext}`;
    const journalContent = ext === 'csv'
      ? MetricsCalculator.exportJournalCSV(entries)
      : MetricsCalculator.exportJournalJSON(entries);

    // Export full backtest result as JSON
    const resultFile = `backtest-result-${timestamp}.json`;
    const snapshots = MetricsCalculator.generateSnapshots(entries, backtestConfig.startingCapital);
    const result: import('./types').BacktestResult = {
      config: backtestConfig,
      metrics: closedTrades.length > 0
        ? MetricsCalculator.calculate(entries, backtestConfig.startingCapital)
        : MetricsCalculator.calculate([], backtestConfig.startingCapital),
      journal: entries,
      snapshots,
      startTime: backtestConfig.startTime,
      endTime: backtestConfig.endTime,
      durationMs: backtestDuration,
    };

    try {
      fs.writeFileSync(journalFile, journalContent, 'utf-8');
      log.success(`Journal exported: ${journalFile}`);
      fs.writeFileSync(resultFile, JSON.stringify(result, null, 2), 'utf-8');
      log.success(`Results exported: ${resultFile}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`Failed to export: ${msg}`);
    }
  }

  log.success('Backtest finished');
}

// ──────────────────────────────────────────────
// Status & Reporting
// ──────────────────────────────────────────────

function printStatusReport(): void {
  const uptime = Math.floor((Date.now() - stats.startTime) / 1000);
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);

  console.log('\n' + '═'.repeat(50));
  console.log(`📊 Status Report (uptime: ${hours}h ${minutes}m)`);
  console.log('═'.repeat(50));
  console.log(`  Trades detected:  ${stats.tradesDetected}`);
  console.log(`  Trades copied:    ${stats.tradesCopied}`);
  console.log(`  Trades skipped:   ${stats.tradesSkipped}`);
  console.log(`  AI rejected:      ${stats.tradesAiRejected}`);
  console.log(`  Trades failed:    ${stats.tradesFailed}`);
  console.log(`  Total volume:     $${stats.totalVolume.toFixed(2)}`);
  console.log('═'.repeat(50) + '\n');
}

function printFinalReport(): void {
  const uptime = Math.floor((Date.now() - stats.startTime) / 1000);

  console.log('\n' + '═'.repeat(50));
  console.log('📋 Final Session Report');
  console.log('═'.repeat(50));
  console.log(`  Uptime:           ${uptime}s`);
  console.log(`  Trades detected:  ${stats.tradesDetected}`);
  console.log(`  Trades copied:    ${stats.tradesCopied}`);
  console.log(`  Trades skipped:   ${stats.tradesSkipped}`);
  console.log(`  AI rejected:      ${stats.tradesAiRejected}`);
  console.log(`  Trades failed:    ${stats.tradesFailed}`);
  console.log(`  Total volume:     $${stats.totalVolume.toFixed(2)}`);
  console.log(`  Success rate:     ${stats.tradesDetected > 0 ? ((stats.tradesCopied / stats.tradesDetected) * 100).toFixed(1) : 0}%`);
  console.log('═'.repeat(50));
}

// ── Run ──
main().catch((error) => {
  log.error(`Fatal error: ${error}`);
  process.exit(1);
});

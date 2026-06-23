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
import { OnChainMonitor } from './onchain';
import { TelegramNotifier } from './telegram';
import { MarketIntelligence, formatIntelligenceForPrompt } from './intelligence';
import { log, setLogLevel } from './logger';
import { ParsedTrade, SessionStats, BotConfig, PaperTradingConfig } from './types';
import { calculateCopySize, calculateSimulatedFillPrice } from './sizing';
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

  setLogLevel(config.logLevel);
  printConfig(config);
  printAIConfig(aiConfig);
  printLeaderboardConfig(leaderboardConfig);
  printPaperConfig(paperConfig);
  printBacktestConfig(backtestConfig);
  printIntelligenceConfig(intelligenceConfig);

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
  if (leaderboardConfig && !backtestMode) {
    const scraper = new LeaderboardScraper(leaderboardConfig);
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

  // ── Step 2: Initialize CLOB client ──
  const { clob, wallet } = await initClient(config);

  // ── Step 3: Set token allowances (one-time, skips if already set) ──
  if (!config.dryRun && !paperMode) {
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
    : new TradeExecutor(config, clob);

  const aiFilter = aiConfig ? new AITradeFilter(aiConfig) : null;

  // Trade journal — tracks all trades for paper trading, backtesting, AND dry-run mode
  const journal = (paperMode || config.dryRun) ? new TradeJournal() : null;
  const startingCapital = paperMode ? paperConfig!.startingCapital : 0;
  const dashboardPath = 'dry-run-trades.json';

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

  // ── Persist journal to disk (for dry-run dashboard) ──
  function persistJournal(): void {
    if (!journal || !config.dryRun) return;
    try {
      const data = {
        lastUpdated: new Date().toISOString(),
        stats: { ...stats },
        entries: journal.getEntries(),
        openPositions: journal.getOpenPositions().map(e => ({ outcome: e.outcome, tokenId: e.tokenId, shares: e.size, entryPrice: e.entryPrice })),
      };
      fs.writeFileSync(dashboardPath, JSON.stringify(data, null, 2), 'utf-8');
    } catch {
      // Silently ignore — dashboard is non-critical
    }
  }

  // ── Step 5: Handle incoming trades ──
  async function handleNewTrade(trade: ParsedTrade): Promise<void> {
    stats.tradesDetected++;

    // Record SELL as exit in journal (all modes with a journal — must run BEFORE BUY-only filter)
    if (trade.side === 'SELL' && journal) {
      journal.recordExit(trade.tokenId, trade.price, trade.timestamp);
      if (paperMode) {
        log.info(`[PAPER] Exit recorded: ${trade.outcome} @ $${trade.price}`);
      }
      if (config.dryRun && !paperMode) {
        persistJournal();
      }
    }

    // In non-paper mode, skip SELL trades for execution (BUY-only mode)
    if (trade.side === 'SELL' && !paperMode) {
      log.debug(`Skipping SELL trade from ${trade.user.slice(0, 8)}... (BUY-only mode)`);
      stats.tradesSkipped++;
      return;
    }

    // Notify: trade detected
    telegram?.notifyTrade({ side: trade.side, size: trade.size, price: trade.price, outcome: trade.outcome, user: trade.user });

    // Calculate copy size
    const copyNotional = executor.calculateCopySize(trade.size);

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
    if (aiFilter) {
      try {
        const aiResult = await aiFilter.evaluate(trade);
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
            if (config.dryRun) {
              persistJournal();
            }
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

  // ── Step 6b: Start dashboard HTTP server (dry-run mode) ──
  let dashboardServer: http.Server | null = null;
  if (config.dryRun && !paperMode) {
    const DASHBOARD_PORT = 3456;
    dashboardServer = http.createServer((req, res) => {
      const reqPath = req.url?.split('?')[0] || '/';
      if (reqPath === '/dry-run-trades.json') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        // Always return live stats from memory (up-to-date even if file hasn't been written yet)
        const liveData = {
          lastUpdated: new Date().toISOString(),
          stats: { ...stats },
          entries: journal ? journal.getEntries() : [],
          openPositions: journal ? journal.getOpenPositions().map(e => ({ outcome: e.outcome, tokenId: e.tokenId, shares: e.size, entryPrice: e.entryPrice, timestamp: e.timestamp, market: e.market, reason: e.reason })) : [],
          positions: positions.getAllPositions().filter(p => p.shares > 0).map(p => ({ market: p.market, outcome: p.outcome, shares: p.shares, notional: p.notional, avgPrice: p.avgPrice })),
          risk: { ...riskManager.getState() },
        };
        res.end(JSON.stringify(liveData));
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
  }

  // ── Periodic journal persistence (keeps dashboard data fresh) ──
  let persistInterval: ReturnType<typeof setInterval> | null = null;
  if (config.dryRun && !paperMode && journal) {
    persistInterval = setInterval(() => { persistJournal(); }, 30_000); // Every 30 seconds
    persistJournal(); // Write initial file so dashboard loads immediately
  }

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
    if (persistInterval) clearInterval(persistInterval);
    if (marketRefreshInterval) clearInterval(marketRefreshInterval);
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

    // Dry-run mode: persist final journal and print summary
    if (config.dryRun && !paperMode && journal) {
      persistJournal();
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
      journal.recordExit(trade.tokenId, trade.price, trade.timestamp);
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
  } else {
    console.log('\n  ⚠️  No closed trades — not enough data for performance metrics');
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

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
import { loadState, saveState, getStatePath } from './state';
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
      Object.assign(riskManager.getState(), savedState.riskState);
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
    if (!journal || !(config.dryRun || paperMode)) return;
    try {
      // Legacy dashboard file (backwards compatible)
      const data = {
        lastUpdated: new Date().toISOString(),
        stats: { ...stats },
        entries: journal.getEntries(),
        openPositions: journal.getOpenPositions().map(e => ({ outcome: e.outcome, tokenId: e.tokenId, shares: e.size, entryPrice: e.entryPrice, title: e.title, trader: e.trader, slug: e.slug, volume24hr: e.volume24hr, category: e.category })),
      };
      fs.writeFileSync(dashboardPath, JSON.stringify(data, null, 2), 'utf-8');

      // Full state file (for position reconciliation across restarts)
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
    } catch {
      // Silently ignore — dashboard is non-critical
    }
  }

  // ── Exit-only mode tracking ──
  let exitOnlyMode = false;
  let exitOnlyLogged = false;

  // ── Reconciliation tracking ──
  const reconciliation = {
    lastStateSave: savedState?.savedAt || null,
    stateRestored: !!savedState,
    catchUpRan: false as boolean,
    catchUpMissedSells: 0,
    catchUpDeviationBlocks: 0,
    stalePositionCount: 0,
    stalePositions: [] as string[],
    openOrdersChecked: 0,
    staleOrdersCanceled: 0,
    mode: 'normal' as 'normal' | 'exit-only' | 'profit-shutdown',
  };

  // ── Step 5: Handle incoming trades ──
  async function handleNewTrade(trade: ParsedTrade): Promise<void> {
    stats.tradesDetected++;

    // ── Profit target reached → graceful shutdown ──
    if (exitOnlyMode && riskManager.isProfitTargetReached()) return; // Already shutting down
    if (riskManager.isProfitTargetReached()) {
      exitOnlyMode = true;
      reconciliation.mode = 'profit-shutdown';
      log.success(`🎯 SESSION PROFIT TARGET REACHED ($${riskManager.getState().sessionPnl.toFixed(2)} >= $${config.maxSessionProfit})`);
      persistJournal();
      telegram?.notifyRisk({ type: 'halt', message: `🎯 Profit target reached: $${riskManager.getState().sessionPnl.toFixed(2)} — shutting down`, trade: '' });
      shutdown('PROFIT TARGET').catch(() => process.exit(0));
      return;
    }

    // ── Notional cap reached → exit-only mode (skip BUYs, process SELLs) ──
    if (trade.side === 'BUY' && riskManager.isNotionalCapped()) {
      if (!exitOnlyLogged) {
        exitOnlyLogged = true;
        exitOnlyMode = true;
        reconciliation.mode = 'exit-only';
        log.warn(`⏸️  Notional cap reached ($${riskManager.getState().sessionNotional.toFixed(2)} / $${config.maxSessionNotional}) — exit-only mode, monitoring for position exits`);
        telegram?.notifyRisk({ type: 'blocked', message: `⏸️ Notional cap reached — monitoring exits only until positions close`, trade: '' });
      }
      stats.tradesSkipped++;
      return;
    }

    // If we were in exit-only mode but notional dropped below cap, resume normal trading
    if (exitOnlyMode && !riskManager.isNotionalCapped()) {
      exitOnlyMode = false;
      exitOnlyLogged = false;
      reconciliation.mode = 'normal';
      log.success(`▶️  Notional below cap ($${riskManager.getState().sessionNotional.toFixed(2)} / $${config.maxSessionNotional}) — resuming normal trading`);
    }

    // Record SELL as exit in journal (all modes with a journal — must run BEFORE BUY-only filter)
    if (trade.side === 'SELL' && journal) {
      const exitEntry = journal.findOpenPosition(trade.tokenId);
      journal.recordExit(trade.tokenId, trade.price, trade.timestamp);
      if (exitEntry) {
        const exitPnl = exitEntry.pnl ?? 0;
        const holdMs = exitEntry.holdTimeMs ?? (trade.timestamp - exitEntry.timestamp);
        const holdLabel = holdMs > 86_400_000 ? `${(holdMs / 86_400_000).toFixed(1)}d`
          : holdMs > 3_600_000 ? `${(holdMs / 3_600_000).toFixed(1)}h`
          : `${(holdMs / 60_000).toFixed(0)}m`;
        const emoji = exitPnl >= 0 ? '✅' : '❌';
        log.info(`${emoji} [EXIT] ${exitEntry.outcome} | P&L: $${exitPnl.toFixed(2)} | Hold: ${holdLabel} | Exit: $${trade.price}`);
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
      if (config.dryRun || paperMode) {
        persistJournal();
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

  // ── Step 5d: Catch-up replay — process missed trades since last state ──
  if (savedState && journal && lastProcessedTimestamps.size > 0) {
    const openBefore = journal.getOpenPositions().length;
    if (openBefore > 0) {
      log.info(`\n🔄 Catch-up replay: checking ${config.targetWallets.length} wallet(s) for missed trades...`);
      log.info(`   Open positions to reconcile: ${openBefore}`);

      let missedSells = 0;
      let priceDeviationBlocks = 0;
      reconciliation.catchUpRan = true;
      const maxDeviation = config.maxMissedSellDeviation ?? 0.15;

      for (const wallet of config.targetWallets) {
        const lastTs = lastProcessedTimestamps.get(wallet) || 0;
        if (lastTs === 0) continue;

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
                journal.recordExit(raw.asset, exitPrice, tradeTs);
                missedSells++;
                const exitPnl = openPos.pnl ?? 0;
                const emoji = exitPnl >= 0 ? '✅' : '❌';
                log.info(
                  `${emoji} [CATCH-UP EXIT] ${openPos.outcome.slice(0, 30)} | ` +
                  `P&L: $${exitPnl.toFixed(2)} | Exit: $${exitPrice.toFixed(4)}`
                );
                telegram?.notifyTrade({
                  side: 'SELL',
                  size: openPos.size,
                  price: exitPrice,
                  outcome: openPos.outcome,
                  user: openPos.trader || 'unknown',
                });
              }
            }
          }

          // Update lastProcessedTimestamp for this wallet
          const latestTs = trades.length > 0
            ? (typeof trades[trades.length - 1].timestamp === 'number'
              ? trades[trades.length - 1].timestamp * 1000
              : new Date(trades[trades.length - 1].timestamp).getTime())
            : lastTs;
          lastProcessedTimestamps.set(wallet, Math.max(lastTs, latestTs));

        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(`Catch-up error for ${wallet.slice(0, 8)}...: ${msg}`);
        }
      }

      const openAfter = journal.getOpenPositions().length;
      reconciliation.catchUpMissedSells = missedSells;
      reconciliation.catchUpDeviationBlocks = priceDeviationBlocks;
      if (missedSells > 0 || priceDeviationBlocks > 0) {
        log.info(`   Catch-up complete: ${missedSells} missed exits processed, ${priceDeviationBlocks} blocked (price deviation), ${openAfter} positions still open`);
      } else {
        log.info(`   Catch-up complete: no missed exits found, ${openAfter} positions still open`);
      }

      // Persist updated state after catch-up
      persistJournal();
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

  // ── Step 5f: Stale position monitoring (periodic) ──
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
  if (config.dryRun || paperMode) {
    const DASHBOARD_PORT = 3456;
    dashboardServer = http.createServer((req, res) => {
      const reqPath = req.url?.split('?')[0] || '/';
      if (reqPath === '/dry-run-trades.json') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
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
          })),
          risk: { ...riskManager.getState() },
          traders,
          config: {
            maxSessionNotional: config.maxSessionNotional,
            maxPerMarketNotional: config.maxPerMarketNotional,
            positionMultiplier: config.positionMultiplier,
            targetWallets: config.targetWallets.length,
          },
          reconciliation: { ...reconciliation },
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
  if ((config.dryRun || paperMode) && journal) {
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
    clearInterval(staleCheckInterval);
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
    if ((config.dryRun || paperMode) && journal) {
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

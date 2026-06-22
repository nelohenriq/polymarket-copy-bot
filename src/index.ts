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
 * Usage:
 *   1. Copy .env.example to .env and fill in your credentials
 *   2. npm install
 *   3. npm run dev   (development with tsx)
 *   4. npm run build && npm start  (production)
 */

import { loadConfig, loadAIConfig, loadLeaderboardConfig, printConfig, printAIConfig, printLeaderboardConfig } from './config';
import { configureProxy } from './proxy';
import { configureFinFeed } from './cross-platform';
import { initClient, ensureAllowances } from './client';
import { TradeMonitor } from './monitor';
import { RiskManager } from './risk';
import { TradeExecutor } from './executor';
import { PositionTracker } from './positions';
import { AITradeFilter } from './ai-filter';
import { LeaderboardScraper } from './leaderboard';
import { OnChainMonitor } from './onchain';
import { TelegramNotifier } from './telegram';
import { log, setLogLevel } from './logger';
import { ParsedTrade, SessionStats, BotConfig } from './types';

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
  console.log(`
╔══════════════════════════════════════════════════╗
║       🤖 Polymarket Copy-Trading Bot v1.0        ║
╠══════════════════════════════════════════════════╣
║  Monitor top traders → Mirror their trades       ║
║  Built with Polymarket CLOB SDK                  ║
╚══════════════════════════════════════════════════╝
  `);

  // ── Step 1: Load configuration ──
  let config = loadConfig();
  const aiConfig = loadAIConfig();
  const leaderboardConfig = loadLeaderboardConfig();
  setLogLevel(config.logLevel);
  printConfig(config);
  printAIConfig(aiConfig);
  printLeaderboardConfig(leaderboardConfig);

  // ── Step 1a: Configure proxy and external APIs ──
  configureProxy(config.proxyUrl);
  configureFinFeed(config.finfeedApiKey);

  // ── Step 1b: Auto-discover wallets if enabled ──
  if (leaderboardConfig) {
    const scraper = new LeaderboardScraper(leaderboardConfig);
    const profiles = await scraper.discover();
    if (profiles.length > 0) {
      const discoveredWallets = profiles.map((p) => p.walletAddress);
      // Merge discovered wallets with manually configured ones
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

  // ── Step 2: Initialize CLOB client ──
  const { clob, wallet } = await initClient(config);

  // ── Step 3: Set token allowances (one-time, skips if already set) ──
  if (!config.dryRun) {
    await ensureAllowances(clob);
  } else {
    log.info('[DRY RUN] Skipping allowance setup');
  }

  // ── Step 4: Initialize components ──
  const positions = new PositionTracker();
  const riskManager = new RiskManager(config, positions);
  const executor = new TradeExecutor(config, clob);
  const aiFilter = aiConfig ? new AITradeFilter(aiConfig) : null;

  // Initialize Telegram notifier (if configured)
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

  // ── Step 5: Handle incoming trades ──
  async function handleNewTrade(trade: ParsedTrade): Promise<void> {
    stats.tradesDetected++;

    // Skip sells in copy-trading mode (BUY-only safeguard)
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

  // ── Step 5b: Start on-chain settlement monitor (if WS_RPC_URL configured) ──
  let onchainMonitor: OnChainMonitor | null = null;
  if (config.wsRpcUrl) {
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

  log.success('Bot is running! Monitoring target wallets...');
  log.info(`Wallet: ${wallet.address}`);
  log.info(`Mode: ${config.dryRun ? '🟢 DRY RUN' : '🔴 LIVE TRADING'}`);
  log.info('Press Ctrl+C to stop\n');

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
  }, 600_000); // Every 10 minutes (avoids flooding Telegram)

  // ── Step 8: Graceful shutdown ──
  async function shutdown(signal: string): Promise<void> {
    log.info(`\n${signal} received. Shutting down...`);
    monitor.stop();
    if (onchainMonitor) onchainMonitor.stop();
    clearInterval(statusInterval);
    printFinalReport();
    if (telegram) await telegram.disconnect();
    process.exit(0);
  }

  process.on('SIGINT', () => { shutdown('SIGINT').catch(() => process.exit(1)); });
  process.on('SIGTERM', () => { shutdown('SIGTERM').catch(() => process.exit(1)); });

  // Keep process alive — SIGINT/SIGTERM handlers above will call
  // process.exit() to trigger a clean shutdown.
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

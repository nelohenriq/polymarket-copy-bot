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
import { initClient, ensureAllowances } from './client';
import { TradeMonitor } from './monitor';
import { RiskManager } from './risk';
import { TradeExecutor } from './executor';
import { PositionTracker } from './positions';
import { AITradeFilter } from './ai-filter';
import { LeaderboardScraper } from './leaderboard';
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

  // ── Step 1a: Configure proxy (if set) ──
  configureProxy(config.proxyUrl);

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

  // ── Step 5: Handle incoming trades ──
  async function handleNewTrade(trade: ParsedTrade): Promise<void> {
    stats.tradesDetected++;

    // Skip sells in copy-trading mode (BUY-only safeguard)
    if (trade.side === 'SELL') {
      log.debug(`Skipping SELL trade from ${trade.user.slice(0, 8)}... (BUY-only mode)`);
      stats.tradesSkipped++;
      return;
    }

    // Calculate copy size
    const copyNotional = executor.calculateCopySize(trade.size);

    // Risk check
    const riskCheck = riskManager.checkTrade(trade, copyNotional);
    if (!riskCheck.allowed) {
      log.risk(`Trade blocked: ${riskCheck.reason}`);
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
          log.info(
            `🤖 AI rejected: prob=${(aiResult.ensembleProbability * 100).toFixed(1)}% ` +
            `market=${(aiResult.marketPrice * 100).toFixed(1)}% ` +
            `edge=${(aiResult.edge * 100).toFixed(1)}% (${aiResult.latencyMs}ms)`,
          );
          return;
        }
        log.success(
          `🤖 AI approved: prob=${(aiResult.ensembleProbability * 100).toFixed(1)}% ` +
          `market=${(aiResult.marketPrice * 100).toFixed(1)}% ` +
          `edge=${(aiResult.edge * 100).toFixed(1)}% (${aiResult.latencyMs}ms)`,
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error(`AI filter error: ${msg}`);
        if (!aiConfig?.failOpen) {
          stats.tradesAiRejected++;
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

          log.success(
            `Copy trade executed: ${result.side} ${result.copyShares.toFixed(4)} shares ` +
            `@ $${result.price.toFixed(4)} | OrderID: ${result.orderId}`,
          );
        } else {
          stats.tradesFailed++;
          log.error(`Copy trade failed: ${result.error}`);
        }
      })
      .catch((error) => {
        stats.tradesFailed++;
        const msg = error instanceof Error ? error.message : String(error);
        log.error(`Copy trade error: ${msg}`);
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
  }, 60_000); // Every minute

  // ── Step 8: Graceful shutdown ──
  function shutdown(signal: string): void {
    log.info(`\n${signal} received. Shutting down...`);
    monitor.stop();
    clearInterval(statusInterval);
    printFinalReport();
    process.exit(0);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

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

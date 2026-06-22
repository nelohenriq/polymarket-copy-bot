/**
 * Telegram Notifications
 * Sends real-time alerts to a Telegram chat for:
 * - Trade detections (whale activity)
 * - AI filter decisions (approved/rejected with reasoning)
 * - Trade executions (copy trade filled)
 * - Risk alerts (blocks, drawdown, halt)
 * - Errors and status reports
 *
 * Uses the Telegram Bot API (no extra dependencies — just fetch).
 */

import { log } from './logger';
import { proxyFetch } from './proxy';

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

export interface TelegramConfig {
  botToken: string;
  chatId: string;
  /** Which event types to send (all enabled by default) */
  enabledEvents: {
    trade: boolean;
    ai: boolean;
    risk: boolean;
    execution: boolean;
    error: boolean;
    status: boolean;
  };
}

// ──────────────────────────────────────────────
// Rate Limiter (prevent Telegram API flood)
// ──────────────────────────────────────────────

class TelegramRateLimiter {
  private timestamps: number[] = [];
  private maxPerMinute: number;

  constructor(maxPerMinute: number) {
    this.maxPerMinute = maxPerMinute;
  }

  tryAcquire(): boolean {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < 60_000);
    if (this.timestamps.length >= this.maxPerMinute) {
      return false;
    }
    this.timestamps.push(now);
    return true;
  }
}

// ──────────────────────────────────────────────
// Telegram Bot Client
// ──────────────────────────────────────────────

export class TelegramNotifier {
  private config: TelegramConfig;
  private apiBase: string;
  private rateLimiter: TelegramRateLimiter;
  private connected = false;
  private queue: string[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: TelegramConfig) {
    this.config = config;
    this.apiBase = `https://api.telegram.org/bot${config.botToken}`;
    this.rateLimiter = new TelegramRateLimiter(20); // Telegram limit: ~30 msg/min
  }

  /**
   * Test the connection by sending a startup message.
   */
  async connect(): Promise<void> {
    try {
      const result = await this.send('🤖 *Polymarket Bot Started*\n\nConnected and monitoring...');
      if (result) {
        this.connected = true;
        log.success('Telegram notifications connected');

        // Start queue flush timer (batch messages to reduce API calls)
        this.flushTimer = setInterval(() => this.flushQueue(), 5_000);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.warn(`Telegram connection failed: ${msg}`);
    }
  }

  /**
   * Stop the notifier and send a shutdown message.
   */
  async disconnect(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flushQueue();
    if (this.connected) {
      await this.send('🛑 *Polymarket Bot Stopped*\n\nShutting down...');
      this.connected = false;
    }
  }

  // ──────────────────────────────────────────────
  // Event Notifications
  // ──────────────────────────────────────────────

  /**
   * Trade detected from a target wallet.
   */
  notifyTrade(trade: { side: string; size: number; price: number; outcome: string; user: string }): void {
    if (!this.config.enabledEvents.trade) return;

    const msg = [
      '🔍 *Trade Detected*',
      '',
      `*Trader:* \`${trade.user.slice(0, 8)}...${trade.user.slice(-4)}\``,
      `*Side:* ${trade.side === 'BUY' ? '🟢 BUY' : '🔴 SELL'}`,
      `*Market:* ${this.safeMarketName(trade.outcome)}`,
      `*Size:* $${trade.size.toFixed(2)}`,
      `*Price:* $${trade.price.toFixed(4)} (${(trade.price * 100).toFixed(1)}%)`,
    ].join('\n');

    this.enqueue(msg);
  }

  /**
   * AI filter decision (approved or rejected).
   */
  notifyAI(data: {
    approved: boolean;
    probability: number;
    marketPrice: number;
    edge: number;
    confidence: number;
    outcome: string;
    latencyMs: number;
  }): void {
    if (!this.config.enabledEvents.ai) return;

    const icon = data.approved ? '✅' : '❌';
    const label = data.approved ? 'AI Approved' : 'AI Rejected';
    const msg = [
      `${icon} *${label}*`,
      '',
      `*Market:* ${this.safeMarketName(data.outcome)}`,
      `*AI Prob:* ${(data.probability * 100).toFixed(1)}%`,
      `*Market:* ${(data.marketPrice * 100).toFixed(1)}%`,
      `*Edge:* ${(data.edge * 100).toFixed(1)}%`,
      `*Confidence:* ${(data.confidence * 100).toFixed(0)}%`,
      `*Latency:* ${data.latencyMs}ms`,
    ].join('\n');

    this.enqueue(msg);
  }

  /**
   * Copy trade executed successfully.
   */
  notifyExecution(result: {
    side: string;
    shares: number;
    price: number;
    notional: number;
    orderId: string;
    outcome: string;
  }): void {
    if (!this.config.enabledEvents.execution) return;

    const msg = [
      '🚀 *Copy Trade Executed*',
      '',
      `*Market:* ${this.safeMarketName(result.outcome)}`,
      `*Side:* ${result.side}`,
      `*Shares:* ${result.shares.toFixed(4)}`,
      `*Price:* $${result.price.toFixed(4)}`,
      `*Notional:* $${result.notional.toFixed(2)}`,
      `*Order ID:* \`${result.orderId}\``,
    ].join('\n');

    this.enqueue(msg);
  }

  /**
   * Risk alert (trade blocked, drawdown, halt).
   */
  notifyRisk(alert: {
    type: 'blocked' | 'drawdown' | 'daily_loss' | 'halt' | 'cap';
    message: string;
    trade?: string;
  }): void {
    if (!this.config.enabledEvents.risk) return;

    const icons: Record<string, string> = {
      blocked: '🛡️',
      drawdown: '📉',
      daily_loss: '⚠️',
      halt: '🛑',
      cap: '🔒',
    };

    const msg = [
      `${icons[alert.type] || '⚠️'} *Risk Alert: ${alert.type.toUpperCase()}*`,
      '',
      alert.message.slice(0, 200),
      alert.trade ? `*Market:* ${this.safeMarketName(alert.trade)}` : '',
    ].filter(Boolean).join('\n');

    this.enqueue(msg);
  }

  /**
   * Error notification.
   */
  notifyError(title: string, message: string): void {
    if (!this.config.enabledEvents.error) return;

    const msg = [
      '🚨 *Error*',
      `*${title}*`,
      '',
      message.slice(0, 300),
    ].join('\n');

    this.enqueue(msg);
  }

  /**
   * Periodic status report.
   */
  notifyStatus(stats: {
    uptime: number;
    detected: number;
    copied: number;
    skipped: number;
    aiRejected: number;
    failed: number;
    volume: number;
  }): void {
    if (!this.config.enabledEvents.status) return;

    const hours = Math.floor(stats.uptime / 3600);
    const minutes = Math.floor((stats.uptime % 3600) / 60);

    const msg = [
      '📊 *Status Report*',
      '',
      `*Uptime:* ${hours}h ${minutes}m`,
      `*Detected:* ${stats.detected}`,
      `*Copied:* ${stats.copied}`,
      `*Skipped:* ${stats.skipped}`,
      `*AI Rejected:* ${stats.aiRejected}`,
      `*Failed:* ${stats.failed}`,
      `*Volume:* $${stats.volume.toFixed(2)}`,
    ].join('\n');

    this.enqueue(msg);
  }

  // ──────────────────────────────────────────────
  // Internal
  // ──────────────────────────────────────────────

  /**
   * Add message to queue (batched sending to reduce API calls).
   */
  private enqueue(message: string): void {
    this.queue.push(message);
    // If queue gets big, flush immediately
    if (this.queue.length >= 5) {
      this.flushQueue();
    }
  }

  /**
   * Flush queued messages as a single batched message.
   */
  private flushQueue(): void {
    if (this.queue.length === 0) return;

    // Send queued messages individually (Telegram doesn't support long messages well)
    const messages = this.queue.splice(0, 10); // Max 10 per flush
    for (const msg of messages) {
      this.send(msg).catch(() => {
        // Silently ignore send failures — don't crash the bot over notifications
      });
    }
  }

  /**
   * Send a message via the Telegram Bot API.
   */
  /**
   * Escape special Markdown characters to prevent Telegram parse errors.
   */
  private escapeMarkdown(text: string): string {
    // Only escape characters that are special in Telegram's legacy Markdown mode
    return text.replace(/[*_`\[]/g, '\\$&');
  }

  /**
   * Safely format a market name for Telegram Markdown.
   * Truncates and escapes special characters.
   */
  private safeMarketName(outcome: string): string {
    return this.escapeMarkdown(outcome.slice(0, 50));
  }

  private async send(text: string): Promise<boolean> {
    if (!this.rateLimiter.tryAcquire()) {
      log.debug('Telegram rate limited — dropping message');
      return false;
    }

    try {
      const response = await proxyFetch(`${this.apiBase}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.config.chatId,
          text,
          parse_mode: 'Markdown',
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => 'unknown');
        log.debug(`Telegram API error ${response.status}: ${errText.slice(0, 100)}`);
        // If Markdown parsing fails, retry as plain text
        if (response.status === 400 && errText.includes('parse')) {
          return this.sendPlainText(text.replace(/[*_`\[\]]/g, ''));
        }
        return false;
      }

      return true;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.debug(`Telegram send failed: ${msg}`);
      return false;
    }
  }

  private async sendPlainText(text: string): Promise<boolean> {
    try {
      const response = await proxyFetch(`${this.apiBase}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.config.chatId,
          text,
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

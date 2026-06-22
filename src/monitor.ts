/**
 * Trade Monitor
 * Watches target wallets for new trades using:
 * 1. Data API polling (reliable, slightly slower)
 * 2. WebSocket (fast, for real-time detection)
 */

import WebSocket from 'ws';
import { BotConfig, ParsedTrade, DataApiTrade } from './types';
import { log } from './logger';
import { proxyFetch, isProxyEnabled } from './proxy';

const DATA_API_BASE = 'https://data-api.polymarket.com';
const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/';

export type OnTradeCallback = (trade: ParsedTrade) => void;

export class TradeMonitor {
  private config: BotConfig;
  private onTrade: OnTradeCallback;
  private seenTradeIds: Set<string> = new Set();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private ws: WebSocket | null = null;
  private wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private wsImmediatePollTimer: ReturnType<typeof setTimeout> | null = null;
  private lastWsTriggerTime = 0;
  private polling = false;
  private running = false;

  /** Minimum interval between WS-triggered polls (debounce) */
  private readonly WS_POLL_DEBOUNCE_MS = 500;

  constructor(config: BotConfig, onTrade: OnTradeCallback) {
    this.config = config;
    this.onTrade = onTrade;
  }

  /**
   * Start monitoring target wallets.
   */
  async start(): Promise<void> {
    this.running = true;
    log.info(`Starting trade monitor for ${this.config.targetWallets.length} wallet(s)...`);

    // Always start REST polling (primary discovery mechanism)
    this.startPolling();

    // Optionally start WebSocket for faster updates
    // Note: WebSocket does not route through the proxy — skip if proxy is active
    if (this.config.useWebsocket && !isProxyEnabled()) {
      this.startWebSocket();
    } else if (this.config.useWebsocket && isProxyEnabled()) {
      log.warn('WebSocket disabled when proxy is active (REST polling only)');
    }
  }

  /**
   * Stop all monitoring.
   */
  stop(): void {
    this.running = false;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    if (this.wsReconnectTimer) {
      clearTimeout(this.wsReconnectTimer);
      this.wsReconnectTimer = null;
    }

    if (this.wsImmediatePollTimer) {
      clearTimeout(this.wsImmediatePollTimer);
      this.wsImmediatePollTimer = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    log.info('Trade monitor stopped');
  }

  // ──────────────────────────────────────────────
  // REST Polling (Primary Discovery)
  // ──────────────────────────────────────────────

  private startPolling(): void {
    log.info(`REST polling started (interval: ${this.config.pollInterval}ms)`);

    // Poll immediately on start
    this.pollAllWallets();

    // Then poll at interval
    this.pollTimer = setInterval(() => {
      this.pollAllWallets();
    }, this.config.pollInterval);
  }

  private async pollAllWallets(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
    for (const wallet of this.config.targetWallets) {
      try {
        await this.pollWallet(wallet);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error(`Error polling wallet ${wallet.slice(0, 8)}...: ${msg}`);
      }
    }
    } finally {
      this.polling = false;
    }
  }

  private async pollWallet(walletAddress: string): Promise<void> {
    const params = new URLSearchParams({
      user: walletAddress,
      type: 'TRADE',
      limit: '50',
      sortBy: 'TIMESTAMP',
      sortDirection: 'DESC',
    });

    const url = `${DATA_API_BASE}/activity?${params.toString()}`;
    const response = await proxyFetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`Data API returned ${response.status}: ${response.statusText}`);
    }

    const trades = (await response.json()) as DataApiTrade[];
    if (!Array.isArray(trades)) return;

    for (const raw of trades) {
      // Deduplicate — only process each trade once
      if (this.seenTradeIds.has(raw.id)) continue;
      this.seenTradeIds.add(raw.id);

      const parsed = this.parseTrade(raw);
      if (parsed) {
        log.trade(
          `Detected: ${parsed.side} ${parsed.size.toFixed(2)} USDC @ ${parsed.price.toFixed(4)}` +
          ` | ${parsed.outcome.slice(0, 30)} | from ${parsed.user.slice(0, 8)}...`,
        );
        this.onTrade(parsed);
      }
    }

    // Evict old trade IDs to prevent memory leak (keep last 10k)
    if (this.seenTradeIds.size > 10_000) {
      const idsArray = Array.from(this.seenTradeIds);
      this.seenTradeIds = new Set(idsArray.slice(-5_000));
    }
  }

  /**
   * Parse a raw Data API trade into our internal format.
   */
  private parseTrade(raw: DataApiTrade): ParsedTrade | null {
    try {
      const size = parseFloat(raw.size);
      const price = parseFloat(raw.price);

      if (isNaN(size) || isNaN(price) || size <= 0 || price <= 0) {
        log.debug(`Skipping invalid trade: size=${raw.size}, price=${raw.price}`);
        return null;
      }

      return {
        id: raw.id,
        timestamp: new Date(raw.timestamp).getTime(),
        market: raw.market,
        tokenId: raw.asset_id,
        side: raw.side,
        size,
        price,
        user: raw.user.toLowerCase(),
        outcome: raw.outcome || raw.title || 'Unknown',
        title: raw.title || '',
      };
    } catch {
      log.debug(`Failed to parse trade: ${JSON.stringify(raw).slice(0, 100)}`);
      return null;
    }
  }

  // ──────────────────────────────────────────────
  // WebSocket (Real-time Updates)
  // ──────────────────────────────────────────────

  private startWebSocket(): void {
    log.info('WebSocket connection starting...');
    this.connectWebSocket();
  }

  private connectWebSocket(): void {
    if (!this.running) return;

    try {
      this.ws = new WebSocket(WS_URL);

      this.ws.on('open', () => {
        log.success('WebSocket connected');

        // Subscribe to market channel — empty assets_ids means we get all market updates
        // We filter relevant trades in the polling layer (primary discovery)
        const subscribeMsg = {
          type: 'market',
          assets_ids: [] as string[],
        };
        this.ws?.send(JSON.stringify(subscribeMsg));
        log.debug('WebSocket subscription sent (all markets)');
      });

      this.ws.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString()) as Record<string, unknown>;
          this.handleWsMessage(msg);
        } catch {
          // Ignore malformed messages
        }
      });

      this.ws.on('close', () => {
        log.warn('WebSocket disconnected');
        this.scheduleReconnect();
      });

      this.ws.on('error', (error: Error) => {
        log.error(`WebSocket error: ${error.message}`);
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`WebSocket connection failed: ${msg}`);
      this.scheduleReconnect();
    }
  }

  private handleWsMessage(msg: Record<string, unknown>): void {
    if (msg.event_type === 'last_trade_price') {
      const assetId = msg.asset_id as string;
      const price = msg.price as string;
      log.debug(`WS price update: ${assetId?.slice(0, 12)}... → ${price}`);

      // Trigger immediate poll (debounced) — a price movement means a trade just happened
      this.triggerImmediatePoll();
    }
  }

  /**
   * Trigger an immediate poll of all wallets, debounced to avoid flooding.
   * When the WebSocket detects a price movement, a trade just happened —
   * we poll immediately instead of waiting for the next interval.
   */
  private triggerImmediatePoll(): void {
    const now = Date.now();
    if (now - this.lastWsTriggerTime < this.WS_POLL_DEBOUNCE_MS) {
      return; // Debounce: too soon since last trigger
    }
    this.lastWsTriggerTime = now;

    // Cancel any pending immediate poll
    if (this.wsImmediatePollTimer) {
      clearTimeout(this.wsImmediatePollTimer);
    }

    // Schedule immediate poll with small delay to batch rapid-fire events
    this.wsImmediatePollTimer = setTimeout(() => {
      log.debug('WS-triggered immediate poll');
      this.pollAllWallets();
    }, 100); // 100ms delay to batch rapid-fire WS events
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    const delay = 5000;
    log.info(`WebSocket reconnecting in ${delay / 1000}s...`);
    this.wsReconnectTimer = setTimeout(() => {
      this.connectWebSocket();
    }, delay);
  }
}

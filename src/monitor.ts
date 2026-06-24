/**
 * Trade Monitor
 * Watches target wallets for new trades using:
 * 1. Data API polling (reliable, slightly slower)
 * 2. WebSocket (fast, for real-time detection)
 */

import WebSocket from 'ws';
import { BotConfig, ParsedTrade, DataApiTrade } from './types';
import { log } from './logger';
import { proxyFetch, isProxyEnabled, getProxyAgent, getProxyUrl, customLookup } from './proxy';

const DATA_API_BASE = 'https://data-api.polymarket.com';
const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

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

  /** Cache: conditionId → market metadata (title, volume, category) */
  private marketMetaCache: Map<string, { title: string; volume24hr?: number; category?: string }> = new Map();
  /** Set of conditionIds currently being fetched (avoid duplicate requests) */
  private pendingTitleFetches: Set<string> = new Set();

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
    // When proxy is active, route WebSocket through the proxy agent
    if (this.config.useWebsocket) {
      this.startWebSocket();
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
    log.debug(`Polling: ${url}`);
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
      // Generate a stable ID from available fields (API doesn't return an id)
      const tradeId = `${raw.conditionId}-${raw.proxyWallet}-${raw.timestamp}-${raw.transactionHash || ''}`;
      if (this.seenTradeIds.has(tradeId)) continue;
      this.seenTradeIds.add(tradeId);

      const parsed = this.parseTrade(raw, tradeId);
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
   * Maps the actual API fields (proxyWallet, asset, conditionId, etc.)
   * to the internal ParsedTrade format.
   */
  private parseTrade(raw: DataApiTrade, tradeId: string): ParsedTrade | null {
    try {
      const size = typeof raw.size === 'number' ? raw.size : parseFloat(String(raw.size));
      const price = typeof raw.price === 'number' ? raw.price : parseFloat(String(raw.price));

      if (isNaN(size) || isNaN(price) || size <= 0 || price <= 0) {
        log.debug(`Skipping invalid trade: size=${raw.size}, price=${raw.price}`);
        return null;
      }

      // Resolve market title: use API field, or cache from Gamma API
      const conditionId = raw.conditionId as string;
      const cachedMeta = this.marketMetaCache.get(conditionId);
      const title = (raw.title as string) || cachedMeta?.title || '';

      // If we don't have a title yet, fetch it asynchronously from Gamma API
      if (!title && conditionId && !this.pendingTitleFetches.has(conditionId)) {
        this.fetchMarketTitle(conditionId, raw.asset as string);
      }

      return {
        id: tradeId,
        timestamp: typeof raw.timestamp === 'number' ? raw.timestamp * 1000 : new Date(raw.timestamp).getTime(),
        market: conditionId,
        tokenId: raw.asset,
        side: raw.side,
        size,
        price,
        user: (raw.proxyWallet as string || '').toLowerCase(),
        outcome: (raw.outcome as string) || (raw.title as string) || 'Unknown',
        title,
        slug: raw.slug as string || undefined,
        volume24hr: cachedMeta?.volume24hr,
        category: cachedMeta?.category,
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
      // Route WebSocket through proxy if configured
      const wsAgent = getProxyAgent();
      // `lookup` is supported by ws at runtime but not in TypeScript types
      const wsOptions: WebSocket.ClientOptions = wsAgent
        ? { agent: wsAgent, ...(getProxyUrl()?.startsWith('socks') ? { rejectUnauthorized: false } : {}) }
        : { lookup: customLookup } as WebSocket.ClientOptions;
      this.ws = new WebSocket(WS_URL, wsOptions);

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

  /**
   * Fetch market title from Gamma API and cache it.
   * Called lazily when we encounter a conditionId with no cached title.
   */
  private fetchMarketTitle(conditionId: string, tokenId?: string): void {
    this.pendingTitleFetches.add(conditionId);

    // Try condition_id first, fall back to token_id (both are valid Gamma API filters)
    const urls = [
      `https://gamma-api.polymarket.com/markets?condition_id=${conditionId}&limit=1`,
    ];
    if (tokenId) {
      urls.push(`https://gamma-api.polymarket.com/markets?token_id=${tokenId}&limit=1`);
    }

    const resolve = async (): Promise<void> => {
      for (const url of urls) {
        try {
          const resp = await proxyFetch(url, {
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(8_000),
          });
          if (!resp.ok) continue;
          const markets = (await resp.json()) as Array<Record<string, unknown>>;
          if (Array.isArray(markets) && markets.length > 0) {
            const m = markets[0];
            const question = String(m.question || '');
            if (question) {
              const meta: { title: string; volume24hr?: number; category?: string } = { title: question };
              // Gamma API uses both camelCase and snake_case at different versions
              const vol = m.volume24hr ?? m.volume_24hr;
              if (typeof vol === 'number') meta.volume24hr = vol;
              else if (vol) meta.volume24hr = Number(vol);
              // Category: try groupItemTitle, groupTitle, then first tag from events
              if (typeof m.groupItemTitle === 'string' && m.groupItemTitle) {
                meta.category = m.groupItemTitle;
              } else if (typeof m.groupTitle === 'string' && m.groupTitle) {
                meta.category = m.groupTitle;
              } else if (Array.isArray(m.tags) && m.tags.length > 0) {
                meta.category = String(m.tags[0]);
              } else if (Array.isArray(m.events) && m.events.length > 0) {
                const evt = m.events[0] as Record<string, unknown>;
                if (Array.isArray(evt.tags) && evt.tags.length > 0) meta.category = String(evt.tags[0]);
              }
              this.marketMetaCache.set(conditionId, meta);
              log.debug(`Market title resolved: ${conditionId.slice(0, 12)}… → ${question.slice(0, 60)}`);
              return;
            }
          }
        } catch {
          continue;
        }
      }
    };

    resolve().finally(() => {
      this.pendingTitleFetches.delete(conditionId);
    });
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

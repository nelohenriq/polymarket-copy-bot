/**
 * Cross-Platform Probability Consensus
 * Queries external prediction markets (Manifold, Kalshi) for probability data
 * to enrich the AI filter with multi-platform consensus signals.
 *
 * If Kalshi says 70% and Polymarket says 45%, that's a strong signal
 * the market is mispriced.
 */

import { log } from './logger';
import { proxyFetch } from './proxy';

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

export interface ExternalProbability {
  platform: string;
  marketTitle: string;
  probability: number;
  volume: number;
  url: string;
}

export interface ConsensusResult {
  probabilities: ExternalProbability[];
  avgProbability: number | null;
  spread: number; // Max difference between platforms
  sourceCount: number;
}

// ──────────────────────────────────────────────
// Manifold Markets API (free, no auth)
// ──────────────────────────────────────────────

const MANIFOLD_API = 'https://api.manifold.markets/v0';

interface ManifoldMarket {
  id: string;
  question: string;
  probability: number;
  volume: number;
  url: string;
  isResolved: boolean;
  closeTime?: number;
}

/**
 * Search Manifold Markets for a matching question.
 * Returns the most relevant active market's probability.
 */
async function searchManifold(query: string): Promise<ExternalProbability | null> {
  try {
    // Manifold search endpoint — limit to 5 results, pick best match
    const params = new URLSearchParams({ term: query.slice(0, 100), limit: '5' });
    const response = await proxyFetch(
      `${MANIFOLD_API}/search-markets?${params}`,
      { signal: AbortSignal.timeout(8_000) },
    );

    if (!response.ok) return null;

    const raw = (await response.json()) as ManifoldMarket[] | { data?: ManifoldMarket[] };
    const markets = Array.isArray(raw) ? raw : (raw?.data || []);
    if (markets.length === 0) return null;

    // Pick the best active, unresolved market
    const active = markets.find((m) => !m.isResolved);
    if (!active) return null;

    return {
      platform: 'Manifold',
      marketTitle: active.question,
      probability: active.probability,
      volume: active.volume,
      url: active.url,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.debug(`Manifold search failed: ${msg}`);
    return null;
  }
}

// ──────────────────────────────────────────────
// Kalshi API (public market data, no auth for basic queries)
// ──────────────────────────────────────────────

const KALSHI_API = 'https://trading-api.kalshi.com/trade-api/v2';

interface KalshiEvent {
  event_ticker: string;
  title: string;
  markets: KalshiMarket[];
}

interface KalshiMarket {
  ticker: string;
  subtitle: string;
  yes_ask: number;
  last_price: number;
  volume: number;
  status: string;
}

/**
 * Search Kalshi for a matching event.
 * Note: Kalshi's search is limited; we try keyword matching.
 */
async function searchKalshi(query: string): Promise<ExternalProbability | null> {
  try {
    // Kalshi events endpoint — search by keyword
    const params = new URLSearchParams({
      limit: '10',
      status: 'open',
      with_nested_markets: 'true',
    });

    // Kalshi doesn't have a great search endpoint, so we use series_ticker or cursor
    // For now, try the events endpoint with a title filter
    const response = await proxyFetch(
      `${KALSHI_API}/events?${params}`,
      {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(8_000),
      },
    );

    if (!response.ok) return null;

    const data = (await response.json()) as { events?: KalshiEvent[] };
    const events = data.events || [];
    if (events.length === 0) return null;

    // Simple keyword matching — check if query words appear in title
    const queryWords = query.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    let bestMatch: { event: KalshiEvent; score: number } | null = null;

    for (const event of events) {
      const title = event.title.toLowerCase();
      let score = 0;
      for (const word of queryWords) {
        if (title.includes(word)) score++;
      }
      if (score > 0 && (!bestMatch || score > bestMatch.score)) {
        bestMatch = { event, score };
      }
    }

    if (!bestMatch) return null;

    // Get the first active market from the matched event
    const market = bestMatch.event.markets?.find((m) => m.status === 'open');
    if (!market) return null;

    const probability = market.last_price > 0
      ? market.last_price / 100
      : market.yes_ask > 0 ? market.yes_ask / 100 : 0.5;

    return {
      platform: 'Kalshi',
      marketTitle: bestMatch.event.title,
      probability,
      volume: market.volume,
      url: `https://kalshi.com/markets/${market.ticker}`,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.debug(`Kalshi search failed: ${msg}`);
    return null;
  }
}

// ──────────────────────────────────────────────
// FinFeedAPI (paid, requires API key)
// ──────────────────────────────────────────────

const FINFEED_API = 'https://api.prediction-markets.finfeedapi.com/v1';

let finfeedApiKey: string | undefined;

/**
 * Configure FinFeedAPI access. Call once at startup.
 */
export function configureFinFeed(apiKey: string | undefined): void {
  finfeedApiKey = apiKey;
}

/**
 * Search FinFeedAPI for a matching market across Polymarket and Kalshi.
 * Returns the best match with OHLCV data.
 */
async function searchFinFeed(query: string): Promise<ExternalProbability[]> {
  if (!finfeedApiKey) return [];

  const results: ExternalProbability[] = [];
  const queryLower = query.toLowerCase();

  // Only query Polymarket via FinFeedAPI (Kalshi is already queried natively)
  try {
    const params = new URLSearchParams({ limit: '20' });
    const response = await proxyFetch(
      `${FINFEED_API}/markets/polymarket/active?${params}`,
      {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${finfeedApiKey}`,
        },
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (response.ok) {
      const data = (await response.json()) as { markets?: Array<{ market_id?: string; title?: string; last_price?: number; volume?: number }> };
      const markets = data.markets || [];

      // Keyword matching
      const queryWords = queryLower.split(/\s+/).filter((w) => w.length > 3);
      let best: { market: typeof markets[0]; score: number } | null = null;

      for (const market of markets) {
        const title = (market.title || '').toLowerCase();
        let score = 0;
        for (const word of queryWords) {
          if (title.includes(word)) score++;
        }
        if (score > 0 && (!best || score > best.score)) {
          best = { market, score };
        }
      }

      if (best && best.market.last_price && best.market.last_price > 0) {
        results.push({
          platform: 'FinFeed (Polymarket)',
          marketTitle: best.market.title || 'Unknown',
          probability: best.market.last_price,
          volume: best.market.volume || 0,
          url: `https://finfeedapi.com/markets/${best.market.market_id || ''}`,
        });
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.debug(`FinFeedAPI search failed: ${msg}`);
  }

  return results;
}

// ──────────────────────────────────────────────
// Consensus Builder
// ──────────────────────────────────────────────

/**
 * Fetch cross-platform probability consensus for a market question.
 * Queries Manifold and Kalshi in parallel, returns aggregated results.
 */
export async function fetchConsensus(marketQuestion: string): Promise<ConsensusResult> {
  const results: ExternalProbability[] = [];

  // Query all platforms in parallel
  const [manifold, kalshi, finfeed] = await Promise.allSettled([
    searchManifold(marketQuestion),
    searchKalshi(marketQuestion),
    searchFinFeed(marketQuestion),
  ]);

  if (manifold.status === 'fulfilled' && manifold.value) {
    results.push(manifold.value);
  }
  if (kalshi.status === 'fulfilled' && kalshi.value) {
    results.push(kalshi.value);
  }
  if (finfeed.status === 'fulfilled' && finfeed.value.length > 0) {
    results.push(...finfeed.value);
  }

  // Calculate consensus
  if (results.length === 0) {
    return { probabilities: [], avgProbability: null, spread: 0, sourceCount: 0 };
  }

  const probs = results.map((r) => r.probability);
  const avgProbability = probs.reduce((s, p) => s + p, 0) / probs.length;
  const spread = Math.max(...probs) - Math.min(...probs);

  if (results.length > 0) {
    log.debug(
      `Cross-platform consensus: ${results.length} sources, ` +
      `avg=${(avgProbability * 100).toFixed(1)}%, spread=${(spread * 100).toFixed(1)}%`,
    );
  }

  return {
    probabilities: results,
    avgProbability,
    spread,
    sourceCount: results.length,
  };
}

/**
 * Format consensus data for inclusion in an LLM prompt.
 */
export function formatConsensusForPrompt(consensus: ConsensusResult): string {
  if (consensus.sourceCount === 0) return '';

  const lines = ['## Cross-Platform Probability Consensus', ''];

  for (const p of consensus.probabilities) {
    lines.push(
      `- **${p.platform}**: ${(p.probability * 100).toFixed(1)}% — "${p.marketTitle.slice(0, 60)}"`,
    );
  }

  if (consensus.sourceCount > 1) {
    lines.push('');
    lines.push(
      `- **Average**: ${(consensus.avgProbability! * 100).toFixed(1)}% | ` +
      `**Spread**: ${(consensus.spread * 100).toFixed(1)}%`,
    );
    if (consensus.spread > 0.15) {
      lines.push('- ⚠️ **High spread** (>15%) — significant disagreement between platforms');
    }
  }

  lines.push('');
  return lines.join('\n');
}

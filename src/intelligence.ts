/**
 * Market Intelligence System
 * Monitors RSS/news feeds for market-moving events, classifies them
 * by category and sentiment, correlates with active Polymarket markets,
 * and generates alerts for high-impact events.
 *
 * Architecture:
 * 1. RSS Parser — Fetch and parse RSS/Atom feeds (no external deps)
 * 2. Sentiment Analyzer — Keyword-based + optional LLM-powered sentiment
 * 3. Event Correlator — Match events to active markets by keyword overlap
 * 4. Alert System — Severity classification, Telegram integration
 * 5. Correlation Tracker — Learn from historical event-price relationships
 */

import { MarketEvent, MarketAlert, EventCategory, SentimentScore, IntelligenceConfig, CorrelationRecord } from './types';
import { log } from './logger';
import { proxyFetch } from './proxy';

// ──────────────────────────────────────────────
// Default RSS Feeds (prediction-market and crypto relevant)
// ──────────────────────────────────────────────

const DEFAULT_RSS_FEEDS = [
  'https://feeds.bbci.co.uk/news/world/rss.xml',
  'https://feeds.bbci.co.uk/news/politics/rss.xml',
  'https://rss.nytimes.com/services/xml/rss/nyt/Politics.xml',
  'https://rss.nytimes.com/services/xml/rss/nyt/Economy.xml',
  'https://cointelegraph.com/rss',
  'https://www.coindesk.com/arc/outboundfeeds/rss/',
  'https://feeds.reuters.com/reuters/topNews',
  'https://feeds.reuters.com/reuters/politicsNews',
];

// ──────────────────────────────────────────────
// Sentiment Keywords
// ──────────────────────────────────────────────

const BULLISH_KEYWORDS = [
  'approve', 'approved', 'passes', 'passed', 'wins', 'won', 'victory',
  'surge', 'surges', 'soar', 'soars', 'rally', 'rallies', 'bullish',
  'breakthrough', 'success', 'landslide', 'triumph', 'record high',
  'adoption', 'partnership', 'launch', 'approval', 'greenlit',
  'positive', 'optimism', 'optimistic', 'growth', 'recovery',
];

const BEARISH_KEYWORDS = [
  'reject', 'rejected', 'fails', 'failed', 'crash', 'crashes', 'plunge',
  'bearish', 'collapse', 'crisis', 'scandal', 'ban', 'banned', 'halt',
  'suspend', 'suspended', 'delay', 'delayed', 'veto', 'vetoed',
  'negative', 'pessimism', 'decline', 'recession', 'bankruptcy',
  'hack', 'exploit', 'vulnerability', 'lawsuit', 'investigation',
];

// Category detection keywords
const CATEGORY_KEYWORDS: Record<EventCategory, string[]> = {
  political: ['election', 'president', 'congress', 'senate', 'vote', 'poll', 'candidate', 'campaign', 'democrat', 'republican', 'parliament', 'governor', 'legislation', 'bill', 'law'],
  economic: ['gdp', 'inflation', 'fed', 'interest rate', 'unemployment', 'jobs', 'recession', 'tariff', 'trade', 'economy', 'fiscal', 'monetary', 'cpi', 'ppi'],
  sports: ['nba', 'nfl', 'mlb', 'nhl', 'soccer', 'football', 'basketball', 'baseball', 'tennis', 'f1', 'formula', 'championship', 'playoffs', 'world cup', 'olympics'],
  crypto: ['bitcoin', 'btc', 'ethereum', 'eth', 'solana', 'sol', 'crypto', 'blockchain', 'defi', 'nft', 'token', 'binance', 'coinbase', 'sec crypto'],
  regulatory: ['sec', 'cftc', 'regulation', 'regulator', 'enforcement', 'compliance', 'lawsuit', 'ruling', 'verdict', 'court', 'judge', 'fine', 'penalty'],
  technology: ['ai', 'artificial intelligence', 'openai', 'google', 'apple', 'meta', 'microsoft', 'tech', 'startup', 'ipo', 'acquisition', 'merger'],
  geopolitical: ['war', 'conflict', 'sanctions', 'nato', 'china', 'russia', 'ukraine', 'iran', 'north korea', 'missile', 'military', 'treaty', 'ceasefire'],
  social: ['protest', 'movement', 'viral', 'trending', 'controversy', 'boycott', 'petition', 'social media', 'twitter', 'tiktok'],
  weather: ['hurricane', 'tornado', 'earthquake', 'flood', 'wildfire', 'drought', 'tsunami', 'storm', 'climate', 'weather'],
  entertainment: ['oscar', 'grammy', 'emmy', 'box office', 'movie', 'album', 'concert', 'celebrity', 'broadway', 'streaming'],
  other: [],
};

// ──────────────────────────────────────────────
// RSS/Atom Parser (no external dependencies)
// ──────────────────────────────────────────────

interface RssItem {
  title: string;
  description: string;
  link: string;
  pubDate: string;
  guid: string;
}

/**
 * Parse RSS/Atom XML into structured items.
 * Handles both RSS 2.0 and Atom feed formats.
 */
function parseRssXml(xml: string, feedUrl: string): RssItem[] {
  const items: RssItem[] = [];

  // RSS 2.0: <item> elements
  const rssItemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let match: RegExpExecArray | null;

  while ((match = rssItemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = extractTag(block, 'title');
    const description = stripHtml(extractTag(block, 'description') || extractTag(block, 'content:encoded') || '');
    const link = extractTag(block, 'link') || extractTag(block, 'guid') || '';
    const pubDate = extractTag(block, 'pubDate') || extractTag(block, 'dc:date') || '';
    const guid = extractTag(block, 'guid') || link || `${feedUrl}-${items.length}`;

    if (title) {
      items.push({ title, description, link, pubDate, guid });
    }
  }

  // Atom: <entry> elements (if no RSS items found)
  if (items.length === 0) {
    const atomItemRegex = /<entry[^>]*>([\s\S]*?)<\/entry>/gi;
    while ((match = atomItemRegex.exec(xml)) !== null) {
      const block = match[1];
      const title = extractTag(block, 'title');
      const content = stripHtml(extractTag(block, 'content') || extractTag(block, 'summary') || '');
      const linkMatch = block.match(/<link[^>]*href="([^"]*)"/);
      const link = linkMatch ? linkMatch[1] : '';
      const updated = extractTag(block, 'updated') || extractTag(block, 'published') || '';
      const id = extractTag(block, 'id') || link || `${feedUrl}-${items.length}`;

      if (title) {
        items.push({ title, description: content, link, pubDate: updated, guid: id });
      }
    }
  }

  return items;
}

function extractTag(xml: string, tag: string): string {
  // Handle CDATA: <tag><![CDATA[content]]></tag>
  const cdataRegex = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`, 'i');
  const cdataMatch = xml.match(cdataRegex);
  if (cdataMatch) return cdataMatch[1].trim();

  // Handle regular: <tag>content</tag>
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const match = xml.match(regex);
  return match ? match[1].trim() : '';
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ──────────────────────────────────────────────
// Sentiment Analyzer
// ──────────────────────────────────────────────

function analyzeSentiment(text: string, watchKeywords: string[]): {
  sentiment: SentimentScore;
  confidence: number;
  impactScore: number;
  keywords: string[];
} {
  const lower = text.toLowerCase();
  const words = lower.split(/\s+/);

  // Count bullish and bearish keyword matches
  let bullishCount = 0;
  let bearishCount = 0;
  const matchedKeywords: string[] = [];

  for (const keyword of BULLISH_KEYWORDS) {
    if (lower.includes(keyword)) {
      bullishCount++;
      matchedKeywords.push(keyword);
    }
  }

  for (const keyword of BEARISH_KEYWORDS) {
    if (lower.includes(keyword)) {
      bearishCount++;
      matchedKeywords.push(keyword);
    }
  }

  // Boost impact for watch keywords
  let watchKeywordBoost = 0;
  for (const keyword of watchKeywords) {
    if (lower.includes(keyword.toLowerCase())) {
      watchKeywordBoost += 0.15;
      matchedKeywords.push(keyword);
    }
  }

  // Determine sentiment
  const total = bullishCount + bearishCount;
  let sentiment: SentimentScore;
  let confidence: number;

  if (total === 0) {
    sentiment = 'neutral';
    confidence = 0.3;
  } else if (bullishCount > bearishCount) {
    sentiment = 'bullish';
    confidence = Math.min(0.9, 0.4 + (bullishCount - bearishCount) * 0.1);
  } else if (bearishCount > bullishCount) {
    sentiment = 'bearish';
    confidence = Math.min(0.9, 0.4 + (bearishCount - bullishCount) * 0.1);
  } else {
    sentiment = 'neutral';
    confidence = 0.4;
  }

  // Impact score: based on keyword density + watch keyword boost + text length signals
  const keywordDensity = total / Math.max(words.length, 1);
  const capsRatio = (text.match(/[A-Z]{2,}/g) || []).length / Math.max(words.length, 1);
  let impactScore = Math.min(1, keywordDensity * 5 + capsRatio * 2 + watchKeywordBoost);

  // Boost for breaking/urgent language
  if (lower.includes('breaking') || lower.includes('urgent') || lower.includes('just in')) {
    impactScore = Math.min(1, impactScore + 0.2);
  }

  return {
    sentiment,
    confidence: Math.round(confidence * 100) / 100,
    impactScore: Math.round(impactScore * 100) / 100,
    keywords: [...new Set(matchedKeywords)].slice(0, 10),
  };
}

// ──────────────────────────────────────────────
// Category Classifier
// ──────────────────────────────────────────────

function classifyCategory(text: string): EventCategory {
  const lower = text.toLowerCase();
  let bestCategory: EventCategory = 'other';
  let bestScore = 0;

  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    let score = 0;
    for (const keyword of keywords) {
      if (lower.includes(keyword)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestCategory = category as EventCategory;
    }
  }

  return bestCategory;
}

// ──────────────────────────────────────────────
// Market Correlator
// ──────────────────────────────────────────────

interface ActiveMarket {
  slug: string;
  question: string;
  conditionId?: string;
}

/**
 * Find active Polymarket markets that might be affected by a news event.
 * Uses keyword overlap between event text and market question.
 */
function correlateToMarkets(
  eventText: string,
  activeMarkets: ActiveMarket[],
  maxMatches = 5,
): string[] {
  const eventWords = new Set(
    eventText
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3 && !STOP_WORDS.has(w)),
  );

  const scored: Array<{ slug: string; score: number }> = [];

  for (const market of activeMarkets) {
    const marketWords = new Set(
      market.question
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 3 && !STOP_WORDS.has(w)),
    );

    // Count overlapping keywords
    let overlap = 0;
    for (const word of eventWords) {
      if (marketWords.has(word)) overlap++;
    }

    if (overlap > 0) {
      scored.push({ slug: market.slug, score: overlap });
    }
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, maxMatches)
    .map((s) => s.slug);
}

const STOP_WORDS = new Set([
  'the', 'and', 'that', 'this', 'with', 'from', 'will', 'been', 'have',
  'for', 'are', 'was', 'were', 'not', 'but', 'can', 'had', 'has', 'its',
  'they', 'their', 'them', 'than', 'then', 'what', 'when', 'where', 'which',
  'who', 'how', 'all', 'each', 'every', 'both', 'few', 'more', 'most',
  'other', 'some', 'such', 'only', 'own', 'same', 'into', 'over', 'after',
  'before', 'between', 'under', 'about', 'would', 'could', 'should',
]);

// ──────────────────────────────────────────────
// Market Intelligence Engine
// ──────────────────────────────────────────────

export type AlertCallback = (alert: MarketAlert) => void;

export class MarketIntelligence {
  private config: IntelligenceConfig;
  private activeMarkets: ActiveMarket[] = [];
  private seenGuids: Set<string> = new Set();
  private correlationRecords: CorrelationRecord[] = [];
  private events: MarketEvent[] = [];
  private alerts: MarketAlert[] = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private onAlert: AlertCallback | null = null;
  private running = false;

  constructor(config: IntelligenceConfig, onAlert?: AlertCallback) {
    this.config = config;
    this.onAlert = onAlert || null;
  }

  /**
   * Update the list of active Polymarket markets for event correlation.
   * Call this periodically or whenever the market list changes.
   */
  updateActiveMarkets(markets: ActiveMarket[]): void {
    this.activeMarkets = markets;
    log.debug(`Intelligence: updated active markets (${markets.length} markets)`);
  }

  /**
   * Start monitoring RSS feeds on a polling interval.
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    const feeds = this.config.rssFeeds.length > 0
      ? this.config.rssFeeds
      : DEFAULT_RSS_FEEDS;

    log.info(`📰 Market intelligence starting — monitoring ${feeds.length} RSS feeds`);
    log.info(`   Poll interval: ${this.config.pollIntervalMs / 1000}s`);
    log.info(`   Alert threshold: ${this.config.alertThreshold}`);
    log.info(`   Categories: ${this.config.categories.length > 0 ? this.config.categories.join(', ') : 'all'}`);
    log.info(`   Watch keywords: ${this.config.watchKeywords.length > 0 ? this.config.watchKeywords.join(', ') : 'none'}`);
    log.info(`   LLM analysis: ${this.config.useLLM ? 'enabled' : 'disabled'}`);

    // Initial fetch
    this.pollFeeds(feeds);

    // Periodic polling
    this.pollTimer = setInterval(() => {
      this.pollFeeds(feeds);
    }, this.config.pollIntervalMs);
  }

  /**
   * Stop monitoring.
   */
  stop(): void {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    log.info(`📰 Market intelligence stopped (${this.events.length} events, ${this.alerts.length} alerts)`);
  }

  /**
   * Get all detected events.
   */
  getEvents(): MarketEvent[] {
    return [...this.events];
  }

  /**
   * Get all generated alerts.
   */
  getAlerts(): MarketAlert[] {
    return [...this.alerts];
  }

  /**
   * Get correlation records for learning.
   */
  getCorrelations(): CorrelationRecord[] {
    return [...this.correlationRecords];
  }

  // ──────────────────────────────────────────────
  // Internal
  // ──────────────────────────────────────────────

  private async pollFeeds(feeds: string[]): Promise<void> {
    const results = await Promise.allSettled(
      feeds.map((feed) => this.fetchAndParseFeed(feed)),
    );

    let newEvents = 0;
    for (const result of results) {
      if (result.status === 'fulfilled') {
        for (const item of result.value) {
          if (!this.seenGuids.has(item.guid)) {
            this.seenGuids.add(item.guid);
            const event = this.processItem(item);
            if (event) {
              this.events.push(event);
              newEvents++;

              // Check if this event should trigger an alert
              if (event.impactScore >= this.config.alertThreshold) {
                const alert = this.createAlert(event);
                this.alerts.push(alert);
                this.onAlert?.(alert);
              }
            }
          }
        }
      }
    }

    // Trim memory: keep last 1000 events and 100 alerts
    if (this.events.length > 1000) {
      this.events = this.events.slice(-1000);
    }
    if (this.alerts.length > 100) {
      this.alerts = this.alerts.slice(-100);
    }
    // Trim seen GUIDs to prevent memory leak
    if (this.seenGuids.size > 5000) {
      const guids = Array.from(this.seenGuids);
      this.seenGuids = new Set(guids.slice(-2500));
    }

    if (newEvents > 0) {
      log.info(`📰 Intelligence: ${newEvents} new events detected (total: ${this.events.length})`);
    }
  }

  private async fetchAndParseFeed(feedUrl: string): Promise<RssItem[]> {
    try {
      const response = await proxyFetch(feedUrl, {
        headers: {
          Accept: 'application/rss+xml, application/xml, text/xml, */*',
          'User-Agent': 'PolymarketBot/1.0',
        },
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        log.debug(`RSS feed ${feedUrl} returned ${response.status}`);
        return [];
      }

      const xml = await response.text();
      return parseRssXml(xml, feedUrl);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.debug(`RSS fetch failed for ${feedUrl}: ${msg}`);
      return [];
    }
  }

  private processItem(item: RssItem): MarketEvent | null {
    const text = `${item.title} ${item.description}`;

    // Classify category
    const category = classifyCategory(text);

    // Filter by configured categories (empty = all)
    if (this.config.categories.length > 0 && !this.config.categories.includes(category)) {
      return null;
    }

    // Analyze sentiment
    const { sentiment, confidence, impactScore, keywords } = analyzeSentiment(
      text,
      this.config.watchKeywords,
    );

    // Skip low-impact events (below a minimum threshold to reduce noise)
    if (impactScore < 0.1 && keywords.length === 0) {
      return null;
    }

    // Correlate to active markets
    const relatedMarkets = correlateToMarkets(text, this.activeMarkets);

    const event: MarketEvent = {
      id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      source: item.link || 'RSS',
      sourceUrl: item.link,
      timestamp: item.pubDate ? new Date(item.pubDate).getTime() : Date.now(),
      title: item.title,
      content: item.description.slice(0, 500),
      category,
      sentiment,
      sentimentConfidence: confidence,
      impactScore,
      keywords,
      relatedMarkets,
    };

    // Log significant events
    if (impactScore >= 0.3 || relatedMarkets.length > 0) {
      const emoji = sentiment === 'bullish' ? '🟢' : sentiment === 'bearish' ? '🔴' : '⚪';
      log.info(
        `${emoji} [${category}] ${item.title.slice(0, 60)} | ` +
        `impact=${(impactScore * 100).toFixed(0)}% sentiment=${sentiment} ` +
        `markets=${relatedMarkets.length}`,
      );
    }

    return event;
  }

  private createAlert(event: MarketEvent): MarketAlert {
    let severity: MarketAlert['severity'];
    if (event.impactScore >= 0.8) severity = 'critical';
    else if (event.impactScore >= 0.6) severity = 'high';
    else if (event.impactScore >= 0.4) severity = 'medium';
    else severity = 'low';

    const action = event.sentiment === 'bullish'
      ? `Consider BUY positions on affected markets`
      : event.sentiment === 'bearish'
        ? `Consider SELL/avoid affected markets`
        : `Monitor affected markets for movement`;

    const alert: MarketAlert = {
      id: `alert-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      severity,
      event,
      suggestedAction: action,
      affectedMarkets: event.relatedMarkets,
    };

    const emoji = severity === 'critical' ? '🚨' : severity === 'high' ? '⚠️' : '📋';
    log.info(
      `${emoji} ALERT [${severity.toUpperCase()}]: ${event.title.slice(0, 50)} | ` +
      `${event.relatedMarkets.length} markets affected`,
    );

    return alert;
  }
}

// ──────────────────────────────────────────────
// Prompt Formatter (for AI filter integration)
// ──────────────────────────────────────────────

/**
 * Format recent intelligence events for inclusion in an AI filter prompt.
 * Provides context about recent news that might affect market pricing.
 */
export function formatIntelligenceForPrompt(events: MarketEvent[], maxEvents = 5): string {
  if (events.length === 0) return '';

  // Sort by impact score, take top N
  const topEvents = [...events]
    .sort((a, b) => b.impactScore - a.impactScore)
    .slice(0, maxEvents);

  const lines = ['## Recent Market Intelligence', ''];

  for (const event of topEvents) {
    const emoji = event.sentiment === 'bullish' ? '🟢' : event.sentiment === 'bearish' ? '🔴' : '⚪';
    lines.push(
      `${emoji} **[${event.category}]** ${event.title}`,
      `   Impact: ${(event.impactScore * 100).toFixed(0)}% | Sentiment: ${event.sentiment} (${(event.sentimentConfidence * 100).toFixed(0)}%)`,
    );
    if (event.relatedMarkets.length > 0) {
      lines.push(`   Related markets: ${event.relatedMarkets.slice(0, 3).join(', ')}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Get a summary of intelligence stats for status reports.
 */
export function getIntelligenceSummary(events: MarketEvent[], alerts: MarketAlert[]): {
  totalEvents: number;
  byCategory: Record<string, number>;
  bySentiment: Record<string, number>;
  highImpactCount: number;
  alertCount: number;
  marketsAffected: number;
} {
  const byCategory: Record<string, number> = {};
  const bySentiment: Record<string, number> = { bullish: 0, bearish: 0, neutral: 0 };
  let highImpactCount = 0;
  const affectedMarkets = new Set<string>();

  for (const event of events) {
    byCategory[event.category] = (byCategory[event.category] || 0) + 1;
    bySentiment[event.sentiment]++;
    if (event.impactScore >= 0.5) highImpactCount++;
    for (const market of event.relatedMarkets) {
      affectedMarkets.add(market);
    }
  }

  return {
    totalEvents: events.length,
    byCategory,
    bySentiment,
    highImpactCount,
    alertCount: alerts.length,
    marketsAffected: affectedMarkets.size,
  };
}

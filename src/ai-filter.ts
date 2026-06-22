/**
 * AI Trade Filter
 * Uses LLMs (GPT-4, Claude, or both in ensemble) to estimate the true probability
 * of a market event and only approves trades where the AI consensus aligns with
 * the target trader's direction.
 *
 * Architecture:
 * 1. Fetch market context from Gamma API (question, current prices, recent activity)
 * 2. Send structured prompt to LLM(s) requesting probability estimate
 * 3. Aggregate estimates via confidence-weighted ensemble
 * 4. Compare AI probability vs market price → approve if edge > threshold
 * 5. Cache results to avoid redundant API calls
 */

import { AIFilterConfig, AIFilterResult, AIProbabilityEstimate, ParsedTrade } from './types';
import { log } from './logger';
import { proxyFetch } from './proxy';

const GAMMA_API = 'https://gamma-api.polymarket.com';

// ──────────────────────────────────────────────
// Rate Limiter
// ──────────────────────────────────────────────

class RateLimiter {
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
// Cache
// ──────────────────────────────────────────────

interface CacheEntry {
  result: AIFilterResult;
  expiresAt: number;
}

class AnalysisCache {
  private cache: Map<string, CacheEntry> = new Map();
  private ttlMs: number;

  constructor(ttlMinutes: number) {
    this.ttlMs = ttlMinutes * 60_000;
  }

  get(cacheKey: string): AIFilterResult | undefined {
    const entry = this.cache.get(cacheKey);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(cacheKey);
      return undefined;
    }
    return entry.result;
  }

  set(cacheKey: string, result: AIFilterResult): void {
    this.cache.set(cacheKey, {
      result,
      expiresAt: Date.now() + this.ttlMs,
    });

    if (this.cache.size > 100) {
      const now = Date.now();
      for (const [key, entry] of this.cache) {
        if (now > entry.expiresAt) this.cache.delete(key);
      }
    }
  }
}

// ──────────────────────────────────────────────
// LLM Client
// ──────────────────────────────────────────────

interface LLMResponse {
  probability: number;
  confidence: number;
  reasoning: string;
  key_factors: string[];
}

function getApiUrl(provider: string, baseUrl?: string): string {
  // Custom provider: use base URL directly (assumes OpenAI-compatible /v1/chat/completions)
  if (provider === 'custom' && baseUrl) {
    const trimmed = baseUrl.replace(/\/$/, '');
    return trimmed.endsWith('/v1/chat/completions') ? trimmed : `${trimmed}/v1/chat/completions`;
  }
  if (provider === 'openai') return 'https://api.openai.com/v1/chat/completions';
  if (provider === 'anthropic') return 'https://api.anthropic.com/v1/messages';
  return 'https://openrouter.ai/api/v1/chat/completions';
}

function buildHeaders(config: AIFilterConfig): Record<string, string> {
  if (config.provider === 'anthropic') {
    return {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
    };
  }
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.apiKey}`,
  };
}

function buildRequestBody(config: AIFilterConfig, prompt: string, model: string): string {
  const systemPrompt = `You are a prediction market analyst. Analyze the given market and provide a probability estimate for the event occurring.

You MUST respond with valid JSON only, no markdown, no explanation outside the JSON:
{
  "probability": <number 0.0 to 1.0>,
  "confidence": <number 0.0 to 1.0>,
  "reasoning": "<brief explanation>",
  "key_factors": ["<factor1>", "<factor2>", ...]
}

Rules:
- probability: your best estimate of the true likelihood of the event
- confidence: how certain you are in your estimate (0.5 = guessing, 1.0 = very certain)
- reasoning: 2-3 sentences explaining your logic
- key_factors: list of 3-5 most important factors influencing your estimate
- Consider historical base rates, current events, polling data, market dynamics
- Be calibrated: if you say 70%, the event should happen ~70% of the time`;

  if (config.provider === 'anthropic') {
    return JSON.stringify({
      model,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: prompt }],
    });
  }
  return JSON.stringify({
    model,
    max_tokens: 1024,
    temperature: 0.3,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt },
    ],
  });
}

async function callLLM(
  config: AIFilterConfig,
  prompt: string,
  model: string,
  retries = 2,
): Promise<AIProbabilityEstimate> {
  const url = getApiUrl(config.provider, config.baseUrl);
  const headers = buildHeaders(config);
  const body = buildRequestBody(config, prompt, model);

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutSeconds * 1000);

    try {
      const response = await proxyFetch(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });

      // Retryable: rate limit or server error
      if ((response.status === 429 || response.status >= 500) && attempt < retries) {
        clearTimeout(timeout);
        const delay = Math.pow(2, attempt) * 1000;
        log.debug(`LLM API ${response.status}, retrying in ${delay}ms (${attempt + 1}/${retries})`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      if (!response.ok) {
        const errText = await response.text().catch(() => 'unknown');
        throw new Error(`LLM API error ${response.status}: ${errText.slice(0, 200)}`);
      }

      const data = (await response.json()) as Record<string, unknown>;

      // Extract content from response based on provider
      // Extract content: anthropic uses different response format than openai-compatible
      let content: string;
      if (config.provider === 'anthropic') {
        const msg = data as { content?: Array<{ text?: string }> };
        content = msg.content?.[0]?.text || '';
      } else {
        const msg = data as { choices?: Array<{ message?: { content?: string } }> };
        content = msg.choices?.[0]?.message?.content || '';
      }

      // Parse JSON from content (handle markdown code blocks)
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error(`LLM did not return valid JSON: ${content.slice(0, 200)}`);
      }

      const parsed = JSON.parse(jsonMatch[0]) as LLMResponse;

      // Validate and clamp values
      const probability = Math.min(Math.max(Number(parsed.probability) || 0.5, 0), 1);
      const confidence = Math.min(Math.max(Number(parsed.confidence) || 0.5, 0), 1);

      clearTimeout(timeout);
      return {
        model,
        probability,
        confidence,
        reasoning: String(parsed.reasoning || 'No reasoning provided'),
        keyFactors: Array.isArray(parsed.key_factors) ? parsed.key_factors.map(String) : [],
        timestamp: Date.now(),
      };
    } catch (error) {
      clearTimeout(timeout);
      lastError = error instanceof Error ? error : new Error(String(error));

      // Don't retry non-network errors (e.g. JSON parse failure)
      if (!lastError.message.includes('fetch') && !lastError.message.includes('abort') && attempt > 0) {
        break;
      }

      if (attempt < retries) {
        const delay = Math.pow(2, attempt) * 1000;
        log.debug(`LLM call failed, retrying in ${delay}ms: ${lastError.message}`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  throw lastError || new Error('LLM call failed after all retries');
}

// ──────────────────────────────────────────────
// Market Context Fetcher
// ──────────────────────────────────────────────

interface MarketContext {
  question: string;
  description: string;
  yesPrice: number;
  noPrice: number;
  volume24h: number;
  endDate: string | null;
  category: string;
  outcomes: string[];
  slug: string;
}

function parseMarket(market: Record<string, unknown>): MarketContext {
  const outcomes = typeof market.outcomes === 'string'
    ? JSON.parse(market.outcomes) as string[]
    : (market.outcomes as string[]) || ['Yes', 'No'];

  const prices = typeof market.outcomePrices === 'string'
    ? JSON.parse(market.outcomePrices) as string[]
    : (market.outcomePrices as string[]) || ['0.5', '0.5'];

  return {
    question: String(market.question || 'Unknown market'),
    description: String(market.description || ''),
    yesPrice: parseFloat(prices[0] || '0.5'),
    noPrice: parseFloat(prices[1] || '0.5'),
    volume24h: Number(market.volume24hr || 0),
    endDate: market.endDate ? String(market.endDate) : null,
    category: String(market.groupItemTitle || market.category || 'general'),
    outcomes,
    slug: String(market.slug || ''),
  };
}

async function fetchMarketContext(tokenId: string): Promise<MarketContext | null> {
  try {
    // Try the specific token_id query first (most efficient)
    const params = new URLSearchParams({ token_id: tokenId, limit: '1' });
    let response = await proxyFetch(`${GAMMA_API}/markets?${params}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) return null;

    let markets = (await response.json()) as Array<Record<string, unknown>>;

    // Fallback: broader search if token_id filter didn't work
    if (!Array.isArray(markets) || markets.length === 0) {
      const params2 = new URLSearchParams({
        active: 'true',
        limit: '100',
        order: 'volume24hr',
        ascending: 'false',
      });
      response = await proxyFetch(`${GAMMA_API}/markets?${params2}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return null;
      markets = (await response.json()) as Array<Record<string, unknown>>;

      const market = markets.find((m) => {
        const tokens = m.tokens as Array<{ token_id: string }> | undefined;
        return tokens?.some((t) => t.token_id === tokenId);
      });
      if (!market) return null;
      return parseMarket(market);
    }

    return parseMarket(markets[0]);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.debug(`Failed to fetch market context: ${msg}`);
    return null;
  }
}

// ──────────────────────────────────────────────
// Prompt Builder
// ──────────────────────────────────────────────

function buildAnalysisPrompt(trade: ParsedTrade, context: MarketContext | null): string {
  const parts = [
    '## Market Question',
    context ? context.question : trade.outcome || trade.title,
    '',
  ];

  if (context) {
    parts.push(
      '## Current Market Prices',
      `- YES: $${context.yesPrice.toFixed(2)} (${(context.yesPrice * 100).toFixed(0)}% implied probability)`,
      `- NO:  $${context.noPrice.toFixed(2)} (${(context.noPrice * 100).toFixed(0)}% implied probability)`,
      '',
      '## Market Details',
      `- Volume (24h): $${context.volume24h.toLocaleString()}`,
      context.endDate ? `- End Date: ${context.endDate}` : '- End Date: Open',
      `- Category: ${context.category}`,
      `- Outcomes: ${context.outcomes.join(', ')}`,
      '',
    );
  }

  parts.push(
    '## Trade Signal',
    'A top-performing Polymarket trader just made this trade:',
    `- Side: ${trade.side}`,
    `- Price: $${trade.price.toFixed(4)} (${(trade.price * 100).toFixed(1)}% implied probability)`,
    `- Size: $${trade.size.toFixed(2)}`,
    `- Outcome: ${trade.outcome}`,
    '',
    '## Your Task',
    'Estimate the TRUE probability that this event will occur. Consider:',
    '1. Current news and events affecting this outcome',
    '2. Historical base rates for similar events',
    '3. Whether the market price seems overpriced or underpriced',
    '4. The reliability of the information available',
    '5. Whether the whale trader\'s position makes sense given available data',
    '',
    'Provide your probability estimate as a number between 0 and 1.',
  );

  return parts.join('\n');
}

// ──────────────────────────────────────────────
// Ensemble Aggregation
// ──────────────────────────────────────────────

function aggregateEstimates(estimates: AIProbabilityEstimate[]): {
  probability: number;
  confidence: number;
  reasoning: string;
} {
  if (estimates.length === 0) {
    return { probability: 0.5, confidence: 0, reasoning: 'No estimates available' };
  }

  if (estimates.length === 1) {
    return {
      probability: estimates[0].probability,
      confidence: estimates[0].confidence,
      reasoning: estimates[0].reasoning,
    };
  }

  // Confidence-weighted average
  let totalWeight = 0;
  let weightedProb = 0;
  let weightedConf = 0;

  for (const est of estimates) {
    const weight = est.confidence;
    weightedProb += est.probability * weight;
    weightedConf += est.confidence * weight;
    totalWeight += weight;
  }

  const probability = totalWeight > 0 ? weightedProb / totalWeight : 0.5;
  const confidence = totalWeight > 0 ? weightedConf / totalWeight : 0;

  const reasoning = estimates
    .map((e) => `[${e.model}] ${e.reasoning}`)
    .join('\n');

  return { probability, confidence, reasoning };
}

// ──────────────────────────────────────────────
// AI Filter (Main Export)
// ──────────────────────────────────────────────

export class AITradeFilter {
  private config: AIFilterConfig;
  private cache: AnalysisCache;
  private rateLimiter: RateLimiter;

  constructor(config: AIFilterConfig) {
    this.config = config;
    this.cache = new AnalysisCache(config.cacheMinutes);
    this.rateLimiter = new RateLimiter(config.maxCallsPerMinute);
  }

  /**
   * Evaluate a trade signal through the AI filter.
   * Returns an AIFilterResult with approve/reject decision.
   */
  async evaluate(trade: ParsedTrade): Promise<AIFilterResult> {
    const startTime = Date.now();

    // Check cache first (keyed by market + side)
    const cacheKey = `${trade.tokenId}:${trade.side}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      log.debug(`AI filter cache hit for ${trade.outcome.slice(0, 30)}`);
      return { ...cached, cached: true, latencyMs: Date.now() - startTime };
    }

    // Rate limit check
    if (!this.rateLimiter.tryAcquire()) {
      log.warn('AI filter rate limit reached');
      return this.buildFallbackResult(trade, 'Rate limit exceeded', startTime);
    }

    try {
      // Fetch market context from Gamma API
      const context = await fetchMarketContext(trade.tokenId);
      if (context) {
        log.debug(`Market context: ${context.question.slice(0, 50)}...`);
      }

      // Build the analysis prompt
      const prompt = buildAnalysisPrompt(trade, context);

      // Call LLM(s) for probability estimates
      const estimates: AIProbabilityEstimate[] = [];

      // Primary model
      const primaryEstimate = await callLLM(this.config, prompt, this.config.model);
      estimates.push(primaryEstimate);
      log.info(
        `AI [${this.config.model}]: prob=${(primaryEstimate.probability * 100).toFixed(1)}% ` +
        `conf=${(primaryEstimate.confidence * 100).toFixed(0)}%`,
      );

      // Optional second model for ensemble
      if (this.config.secondModel) {
        try {
          const secondaryEstimate = await callLLM(this.config, prompt, this.config.secondModel);
          estimates.push(secondaryEstimate);
          log.info(
            `AI [${this.config.secondModel}]: prob=${(secondaryEstimate.probability * 100).toFixed(1)}% ` +
            `conf=${(secondaryEstimate.confidence * 100).toFixed(0)}%`,
          );
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          log.warn(`Second model failed, using primary only: ${msg}`);
        }
      }

      // Aggregate estimates
      const { probability, confidence, reasoning } = aggregateEstimates(estimates);

      // Calculate edge: how much does AI probability differ from market price
      const marketPrice = trade.price;
      const edge = trade.side === 'BUY'
        ? probability - marketPrice
        : marketPrice - probability;

      // Decision: approve if confidence and edge both exceed thresholds
      const confidenceOk = confidence >= this.config.minConfidence;
      const edgeOk = edge >= this.config.minEdge;
      const approved = confidenceOk && edgeOk;

      const result: AIFilterResult = {
        approved,
        ensembleProbability: probability,
        marketPrice,
        edge,
        confidence,
        reasoning,
        estimates,
        cached: false,
        latencyMs: Date.now() - startTime,
      };

      this.cache.set(cacheKey, result);

      log.info(
        `AI Filter: ${approved ? '✅ APPROVED' : '❌ REJECTED'} | ` +
        `prob=${(probability * 100).toFixed(1)}% | ` +
        `market=${(marketPrice * 100).toFixed(1)}% | ` +
        `edge=${(edge * 100).toFixed(1)}% | ` +
        `conf=${(confidence * 100).toFixed(0)}%`,
      );

      if (!approved) {
        if (!confidenceOk) {
          log.info(`  Rejected: confidence ${(confidence * 100).toFixed(0)}% < ${(this.config.minConfidence * 100).toFixed(0)}% threshold`);
        }
        if (!edgeOk) {
          log.info(`  Rejected: edge ${(edge * 100).toFixed(1)}% < ${(this.config.minEdge * 100).toFixed(1)}% threshold`);
        }
      }

      return result;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`AI filter error: ${msg}`);
      return this.buildFallbackResult(trade, msg, startTime);
    }
  }

  /**
   * Build a fallback result when the AI filter fails.
   * Respects the failOpen configuration.
   */
  private buildFallbackResult(trade: ParsedTrade, reason: string, startTime: number): AIFilterResult {
    const approved = this.config.failOpen;
    log[approved ? 'warn' : 'error'](
      `AI filter fallback: ${approved ? 'APPROVING' : 'REJECTING'} (failOpen=${this.config.failOpen}) — ${reason}`,
    );

    return {
      approved,
      ensembleProbability: 0.5,
      marketPrice: trade.price,
      edge: 0,
      confidence: 0,
      reasoning: `AI filter unavailable: ${reason}`,
      estimates: [],
      cached: false,
      latencyMs: Date.now() - startTime,
    };
  }
}

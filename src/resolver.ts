/**
 * Market Resolution Detection & Token Redemption
 * ──────────────────────────────────────────────
 *
 * Periodically polls the Polymarket Gamma API to detect when markets
 * where we hold open positions have resolved. For winning positions,
 * optionally redeems ERC1155 conditional tokens for USDC via the CTF
 * `redeemPositions` function on Polygon.
 *
 * Architecture:
 * - Polls Gamma API by token_id to fetch market metadata + resolution status
 * - Caches conditionId lookups to minimize API calls
 * - Determines winning outcome from outcomePrices ("1" = winner)
 * - Calls CTF redeemPositions for winning tokens (if AUTO_REDEEM_ENABLED)
 * - Records journal exits at $1.00 for winners, $0.00 for losers
 * - Sends Telegram notifications for all resolutions
 */

import { ethers } from 'ethers';
import { TradeJournal } from './journal';
import { RiskManager } from './risk';
import { TelegramNotifier } from './telegram';
import { log } from './logger';
import { proxyFetch } from './proxy';

// ──────────────────────────────────────────────
// Contract Addresses (Polygon Mainnet)
// ──────────────────────────────────────────────

const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

// Minimal ABI for redeemPositions
const CTF_REDEEM_ABI = [
  'function redeemPositions(IERC20 collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint[] calldata indexSets) external',
  'function payoutDenominator(bytes32 conditionId) external view returns (uint256)',
];

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

interface GammaMarket {
  conditionId: string;
  question: string;
  slug?: string;
  tokens?: Array<{
    token_id: string;
    outcome: string;
    price?: number | string;
    winner?: boolean;
  }>;
  outcomes?: string;    // JSON string: '["Yes","No"]'
  outcomePrices?: string; // JSON string: '["1","0"]' when resolved
  resolved?: boolean;
  active?: boolean;
  closed?: boolean;
  negRisk?: boolean;
}

interface CachedMarket {
  conditionId: string;
  question: string;
  tokens: GammaMarket['tokens'];
  resolved: boolean;
  outcomes: string[];
  outcomePrices: number[];
  lastChecked: number;
}

export interface ResolutionResult {
  tokenId: string;
  outcome: string;
  title: string;
  won: boolean;
  entryPrice: number;
  shares: number;
  pnl: number;
  redeemed: boolean;
  redemptionAttempted: boolean;
  redeemTxHash?: string;
}

export type ResolutionCallback = (result: ResolutionResult) => void;

// ──────────────────────────────────────────────
// Resolver Configuration
// ──────────────────────────────────────────────

export interface ResolverConfig {
  enabled: boolean;
  checkIntervalMs: number;
  autoRedeem: boolean;
}

// ──────────────────────────────────────────────
// Market Resolution Resolver
// ──────────────────────────────────────────────

export class MarketResolver {
  private config: ResolverConfig;
  private journal: TradeJournal;
  private riskManager: RiskManager;
  private wallet: ethers.Wallet;
  private rpcUrl: string;
  private telegram: TelegramNotifier | null;
  private onResolution: ResolutionCallback;
  private marketCache: Map<string, CachedMarket> = new Map(); // tokenId -> cached market data
  private resolvedTokenIds: Set<string> = new Set(); // already processed
  private ctfContract: ethers.Contract | null = null;

  // Reconciliation stats (exposed for dashboard)
  public stats = {
    positionsChecked: 0,
    marketsResolved: 0,
    positionsWon: 0,
    positionsLost: 0,
    redemptionAttempts: 0,
    redemptionSuccesses: 0,
    redemptionFailures: 0,
    lastCheckTime: null as string | null,
  };

  constructor(opts: {
    config: ResolverConfig;
    journal: TradeJournal;
    riskManager: RiskManager;
    wallet: ethers.Wallet;
    rpcUrl: string;
    telegram: TelegramNotifier | null;
    onResolution: ResolutionCallback;
  }) {
    this.config = opts.config;
    this.journal = opts.journal;
    this.riskManager = opts.riskManager;
    this.wallet = opts.wallet;
    this.rpcUrl = opts.rpcUrl;
    this.telegram = opts.telegram;
    this.onResolution = opts.onResolution;

    // Initialize CTF contract for on-chain redemption
    if (this.config.autoRedeem && this.rpcUrl) {
      try {
        const provider = new ethers.providers.JsonRpcProvider(this.rpcUrl);
        const signer = this.wallet.connect(provider);
        this.ctfContract = new ethers.Contract(CTF_ADDRESS, CTF_REDEEM_ABI, signer);
        log.info('[RESOLVER] CTF contract initialized for auto-redemption');
      } catch (err) {
        log.warn(`[RESOLVER] Failed to initialize CTF contract: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * Check all open positions for market resolution.
   * Called periodically by the main orchestrator.
   */
  async checkResolutions(): Promise<void> {
    if (!this.config.enabled) return;

    const openPositions = this.journal.getOpenPositions();
    if (openPositions.length === 0) return;

    this.stats.lastCheckTime = new Date().toISOString();
    log.debug(`[RESOLVER] Checking ${openPositions.length} open position(s) for resolution...`);

    for (const pos of openPositions) {
      // Skip already-resolved positions
      if (this.resolvedTokenIds.has(pos.tokenId)) continue;

      try {
        this.stats.positionsChecked++;
        const market = await this.fetchMarketByTokenId(pos.tokenId);
        if (!market) continue;

        // Cache the market data
        this.marketCache.set(pos.tokenId, market);

        if (!market.resolved) continue;

        // Market has resolved! Determine outcome
        this.resolvedTokenIds.add(pos.tokenId);
        const result = await this.processResolution(pos.tokenId, market);

        if (result) {
          this.onResolution(result);
        }
      } catch (err) {
        log.debug(`[RESOLVER] Error checking ${pos.outcome.slice(0, 30)}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * Look up a market on the Gamma API by its token ID.
   * Returns cached data if fresh enough (within 5 minutes).
   */
  private async fetchMarketByTokenId(tokenId: string): Promise<CachedMarket | null> {
    // Check cache freshness (5 min TTL)
    const cached = this.marketCache.get(tokenId);
    if (cached && Date.now() - cached.lastChecked < 300_000) {
      return cached;
    }

    try {
      const url = `https://gamma-api.polymarket.com/markets?token_id=${tokenId}&limit=1`;
      const resp = await proxyFetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });

      if (!resp.ok) {
        log.debug(`[RESOLVER] Gamma API returned ${resp.status} for token ${tokenId.slice(0, 12)}…`);
        return cached || null;
      }

      const data = await resp.json();
      const markets = Array.isArray(data) ? data : [data];
      if (markets.length === 0) return cached || null;

      const raw = markets[0] as Record<string, unknown>;

      // Parse outcomePrices (may be JSON string or array)
      let outcomePrices: number[] = [];
      const rawPrices = raw.outcomePrices;
      if (typeof rawPrices === 'string') {
        try {
          outcomePrices = (JSON.parse(rawPrices) as string[]).map(Number);
        } catch { /* ignore parse errors */ }
      } else if (Array.isArray(rawPrices)) {
        outcomePrices = (rawPrices as (number | string)[]).map(Number);
      }

      // Parse outcomes
      let outcomes: string[] = [];
      const rawOutcomes = raw.outcomes;
      if (typeof rawOutcomes === 'string') {
        try {
          outcomes = JSON.parse(rawOutcomes) as string[];
        } catch { /* ignore */ }
      } else if (Array.isArray(rawOutcomes)) {
        outcomes = rawOutcomes as string[];
      }

      // Parse tokens array
      const tokens = (raw.tokens as GammaMarket['tokens']) || [];

      const market: CachedMarket = {
        conditionId: (raw.conditionId as string) || '',
        question: (raw.question as string) || (raw.title as string) || 'Unknown',
        tokens,
        resolved: Boolean(raw.resolved),
        outcomes,
        outcomePrices,
        lastChecked: Date.now(),
      };

      return market;
    } catch (err) {
      log.debug(`[RESOLVER] Failed to fetch market for ${tokenId.slice(0, 12)}…: ${err instanceof Error ? err.message : String(err)}`);
      return cached || null;
    }
  }

  /**
   * Process a resolved market: determine win/loss, attempt redemption, update journal.
   */
  private async processResolution(
    tokenId: string,
    market: CachedMarket,
  ): Promise<ResolutionResult | null> {
    const openPos = this.journal.findOpenPosition(tokenId);
    if (!openPos) return null;

    this.stats.marketsResolved++;

    // Determine if our position won
    // Method 1: Check outcomePrices — "1" means winner
    let won = false;
    if (market.outcomePrices.length > 0 && market.tokens) {
      for (let i = 0; i < market.tokens.length; i++) {
        if (market.tokens[i].token_id === tokenId) {
          won = market.outcomePrices[i] === 1;
          break;
        }
      }
    }

    // Method 2: Check token winner flag
    if (!won && market.tokens) {
      const ourToken = market.tokens.find(t => t.token_id === tokenId);
      if (ourToken?.winner) won = true;
    }

    // Update stats
    if (won) {
      this.stats.positionsWon++;
    } else {
      this.stats.positionsLost++;
    }

    // Record journal exit: $1.00 for winners, $0.00 for losers
    const exitPrice = won ? 1.0 : 0.0;
    const exitTimestamp = Date.now();
    const pnl = (exitPrice - openPos.entryPrice) * openPos.size;

    this.journal.recordExit(tokenId, exitPrice, exitTimestamp);
    this.riskManager.reduceSessionNotional(openPos.entryPrice * openPos.size);
    this.riskManager.addSessionPnl(pnl);

    const emoji = won ? '🏆' : '💀';
    const pnlEmoji = pnl >= 0 ? '✅' : '❌';
    log.info(
      `${emoji} [RESOLVED] ${openPos.outcome.slice(0, 30)} | ` +
      `${won ? 'WON' : 'LOST'} | P&L: ${pnlEmoji} $${pnl.toFixed(2)} | ` +
      `Entry: $${openPos.entryPrice.toFixed(4)} → Exit: $${exitPrice.toFixed(2)}`
    );

    // Telegram notification
    this.telegram?.notifyRisk({
      type: won ? 'blocked' : 'drawdown',
      message: [
        `${emoji} *Market Resolved: ${won ? 'WON' : 'LOST'}*`,
        '',
        `*Market:* ${this.safeName(market.question)}`,
        `*Outcome:* ${openPos.outcome}`,
        `*Entry:* $${openPos.entryPrice.toFixed(4)}`,
        `*Exit:* $${exitPrice.toFixed(2)} (${won ? 'redeemed at par' : 'worthless'})`,
        `*Shares:* ${openPos.size.toFixed(4)}`,
        `*P&L:* ${pnlEmoji} $${pnl.toFixed(2)}`,
        won ? `\n🏆 _Winning tokens can be redeemed for $1.00 each_` : '',
      ].filter(Boolean).join('\n'),
      trade: openPos.outcome,
    });

    // Attempt on-chain redemption for winners
    let redeemed = false;
    let redeemTxHash: string | undefined;

    if (won && this.config.autoRedeem && this.ctfContract) {
      const redeemResult = await this.redeemTokens(tokenId, market);
      redeemed = redeemResult.success;
      redeemTxHash = redeemResult.txHash;
    }

    return {
      tokenId,
      outcome: openPos.outcome,
      title: market.question,
      won,
      entryPrice: openPos.entryPrice,
      shares: openPos.size,
      pnl,
      redeemed,
      redemptionAttempted: won && this.config.autoRedeem && !!this.ctfContract,
      redeemTxHash,
    };
  }

  /**
   * Redeem winning ERC1155 tokens via CTF `redeemPositions`.
   *
   * This calls the ConditionalTokens contract on Polygon to burn our
   * winning tokens and receive USDC.e back at $1.00 per share.
   *
   * Note: Requires the wallet (EOA or proxy) to hold the tokens directly.
   * If tokens are in a Polymarket proxy wallet, redemption must go through
   * the proxy. In that case, this will fail gracefully and the user can
   * redeem via the Polymarket UI or enable auto-redeem in their profile.
   */
  private async redeemTokens(
    tokenId: string,
    market: CachedMarket,
  ): Promise<{ success: boolean; txHash?: string }> {
    if (!this.ctfContract) return { success: false };

    this.stats.redemptionAttempts++;

    try {
      // Determine the outcome index for our token
      let outcomeIndex = -1;
      if (market.tokens) {
        for (let i = 0; i < market.tokens.length; i++) {
          if (market.tokens[i].token_id === tokenId) {
            outcomeIndex = i;
            break;
          }
        }
      }

      if (outcomeIndex < 0) {
        log.warn(`[REDEEM] Could not determine outcome index for token ${tokenId.slice(0, 12)}…`);
        this.stats.redemptionFailures++;
        return { success: false };
      }

      // indexSet is a bitmask: 2^outcomeIndex
      const indexSet = Math.pow(2, outcomeIndex);
      const parentCollectionId = ethers.constants.HashZero; // bytes32(0) for top-level markets
      const conditionId = market.conditionId;

      if (!conditionId) {
        log.warn(`[REDEEM] No conditionId for market — cannot redeem`);
        this.stats.redemptionFailures++;
        return { success: false };
      }

      // Check if the condition has been resolved on-chain (payoutDenominator > 0)
      try {
        const payoutDenom = await this.ctfContract.payoutDenominator(conditionId);
        if (payoutDenom.isZero()) {
          log.warn(`[REDEEM] Market not yet resolved on-chain (payoutDenominator = 0) — may need to wait for dispute window`);
          this.stats.redemptionFailures++;
          return { success: false };
        }
      } catch (checkErr) {
        log.debug(`[REDEEM] Could not check payoutDenominator: ${checkErr instanceof Error ? checkErr.message : String(checkErr)}`);
      }

      log.info(`[REDEEM] Redeeming tokens: conditionId=${conditionId.slice(0, 12)}… indexSet=${indexSet}`);

      // Call redeemPositions
      const tx = await this.ctfContract.redeemPositions(
        USDC_ADDRESS,
        parentCollectionId,
        conditionId,
        [indexSet],
        { gasLimit: 500_000 }, // Conservative gas limit
      );

      log.info(`[REDEEM] Transaction submitted: ${tx.hash}`);
      const receipt = await tx.wait(2); // Wait for 2 confirmations

      if (receipt.status === 1) {
        this.stats.redemptionSuccesses++;
        log.success(`[REDEEM] ✅ Tokens redeemed! tx=${tx.hash} | gas=${receipt.gasUsed.toString()}`);

        this.telegram?.notifyRisk({
          type: 'blocked',
          message: [
            `💰 *Tokens Redeemed*`,
            '',
            `*Condition:* \`${conditionId.slice(0, 16)}…\``,
            `*Index Set:* ${indexSet}`,
            `*Tx:* \`${tx.hash.slice(0, 16)}…\``,
            `*Gas:* ${receipt.gasUsed.toString()}`,
            '',
            `_USDC.e has been returned to your wallet_`,
          ].join('\n'),
          trade: '',
        });

        return { success: true, txHash: tx.hash };
      } else {
        this.stats.redemptionFailures++;
        log.error(`[REDEEM] Transaction reverted: ${tx.hash}`);
        return { success: false, txHash: tx.hash };
      }
    } catch (err) {
      this.stats.redemptionFailures++;
      const msg = err instanceof Error ? err.message : String(err);

      // Common error: tokens not in this wallet (proxy wallet holds them)
      if (msg.includes('execution reverted') || msg.includes('ERC1155')) {
        log.warn(`[REDEEM] Redemption failed — tokens may be held by Polymarket proxy wallet (not EOA). Redeem via polymarket.com/redeem`);
      } else {
        log.error(`[REDEEM] Redemption error: ${msg}`);
      }

      this.telegram?.notifyError('Redemption Failed', `Failed to redeem winning tokens: ${msg.slice(0, 200)}`);
      return { success: false };
    }
  }

  /**
   * On-demand redemption: attempt to redeem a specific resolved winning token.
   * Called from the dashboard's "Redeem Now" button.
   * Returns success/failure with details.
   */
  async redeemOnDemand(tokenId: string): Promise<{ success: boolean; txHash?: string; error?: string }> {
    if (!this.ctfContract) {
      return { success: false, error: 'CTF contract not initialized (check RPC_URL and wallet)' };
    }

    const cached = this.marketCache.get(tokenId);
    if (!cached) {
      return { success: false, error: 'Market data not cached — wait for next resolution check' };
    }

    if (!cached.resolved) {
      return { success: false, error: 'Market has not resolved yet' };
    }

    // Check if this token is a winner
    let isWinner = false;
    if (cached.outcomePrices.length > 0 && cached.tokens) {
      for (let i = 0; i < cached.tokens.length; i++) {
        if (cached.tokens[i].token_id === tokenId) {
          isWinner = cached.outcomePrices[i] === 1;
          break;
        }
      }
    }
    if (!isWinner && cached.tokens) {
      const ourToken = cached.tokens.find(t => t.token_id === tokenId);
      if (ourToken?.winner) isWinner = true;
    }

    if (!isWinner) {
      return { success: false, error: 'This position lost — nothing to redeem' };
    }

    this.stats.redemptionAttempts++;
    const result = await this.redeemTokens(tokenId, cached);
    if (result.success) {
      this.stats.redemptionSuccesses++;
    } else {
      this.stats.redemptionFailures++;
    }
    return result;
  }

  /**
   * Get resolution statistics for dashboard display.
   */
  getStats() {
    return { ...this.stats };
  }

  /**
   * Get the set of already-resolved token IDs.
   */
  getResolvedTokenIds(): Set<string> {
    return new Set(this.resolvedTokenIds);
  }

  /**
   * Mark a token ID as already resolved (used during state restore).
   */
  markResolved(tokenId: string): void {
    this.resolvedTokenIds.add(tokenId);
  }

  /**
   * Safely format a market name for Telegram.
   */
  private safeName(text: string): string {
    return text.replace(/[*_`\[]/g, '\\$&').slice(0, 60);
  }
}

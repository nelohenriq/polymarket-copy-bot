/**
 * Trade Executor
 * Places copy orders on the Polymarket CLOB, handles order sizing,
 * price calculation, and execution with retry logic.
 *
 * SDK methods:
 * - createAndPostOrder: GTC/GTD (limit orders that rest on book)
 * - createAndPostMarketOrder: FOK/FAK (immediate fill or cancel)
 */

import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
import { BotConfig, ParsedTrade, CopyTradeResult, CopyOrderType } from './types';
import { log } from './logger';
import { calculateCopySize, calculateExecutionPrice } from './sizing';

/** Map our config order type strings to SDK OrderType enum */
const ORDER_TYPE_MAP: Record<CopyOrderType, OrderType> = {
  FOK: OrderType.FOK,
  GTC: OrderType.GTC,
  FAK: OrderType.FAK,
};

/** Whether an order type is a market order (FOK/FAK) vs limit order (GTC/GTD) */
function isMarketOrderType(orderType: OrderType): boolean {
  return orderType === OrderType.FOK || orderType === OrderType.FAK;
}

export class TradeExecutor {
  private config: BotConfig;
  private clob: ClobClient;

  constructor(config: BotConfig, clob: ClobClient) {
    this.config = config;
    this.clob = clob;
  }

  /**
   * Calculate the copy trade size based on target's position and our multiplier.
   * Delegates to shared helper in sizing.ts.
   */
  calculateCopySize(targetSize: number): number {
    return calculateCopySize(this.config, targetSize);
  }

  /**
   * Calculate the execution price with slippage tolerance.
   * Delegates to shared helper in sizing.ts.
   */
  calculateExecutionPrice(price: number, side: 'BUY' | 'SELL'): number {
    return calculateExecutionPrice(this.config.slippageTolerance, price, side);
  }

  /**
   * Execute a copy trade.
   * Handles sizing, pricing, order submission, and error handling.
   */
  async executeCopyTrade(trade: ParsedTrade): Promise<CopyTradeResult> {
    const copyNotional = this.calculateCopySize(trade.size);
    const execPrice = this.calculateExecutionPrice(trade.price, trade.side);

    // Calculate shares from notional and price
    const copyShares = execPrice > 0 ? copyNotional / execPrice : 0;

    log.info(
      `Executing copy trade: ${trade.side} ${copyNotional.toFixed(2)} USDC ` +
      `@ ${execPrice.toFixed(4)} (${copyShares.toFixed(4)} shares)`,
    );

    // ── DRY RUN MODE ──
    if (this.config.dryRun) {
      log.success(`[DRY RUN] Would execute: ${trade.side} ${copyShares.toFixed(4)} shares @ $${execPrice}`);
      return {
        success: true,
        orderId: `dry-run-${Date.now()}`,
        copyNotional,
        copyShares,
        price: execPrice,
        side: trade.side,
      };
    }

    // ── LIVE EXECUTION ──
    return this.submitOrder(trade.tokenId, trade.side, execPrice, copyNotional, copyShares);
  }

  /**
   * Fetch the order book for a token to get tickSize and negRisk.
   * These are required by the CLOB SDK for order creation.
   */
  private async getOrderBookInfo(tokenId: string): Promise<{ tickSize: '0.01' | '0.001' | '0.0001'; negRisk: boolean }> {
    try {
      const book = await this.clob.getOrderBook(tokenId);
      // Access order book fields via unknown cast for SDK version flexibility
      const bookRecord = book as unknown as Record<string, unknown>;
      const rawTick = typeof bookRecord.tick_size === 'string' ? bookRecord.tick_size : '0.01';
      // Normalize to one of the valid tick sizes
      const tickSize: '0.01' | '0.001' | '0.0001' =
        rawTick === '0.001' ? '0.001' :
        rawTick === '0.0001' ? '0.0001' :
        '0.01';
      if (rawTick !== tickSize) {
        log.debug(`Unknown tick size '${rawTick}', normalized to '${tickSize}'`);
      }
      const negRisk = typeof bookRecord.neg_risk === 'boolean' ? bookRecord.neg_risk : false;
      return { tickSize, negRisk };
    } catch {
      log.warn('Could not fetch order book, using defaults (tickSize=0.01, negRisk=false)');
      return { tickSize: '0.01', negRisk: false };
    }
  }

  /**
   * Map our config order type to the SDK OrderType enum.
   */
  private getOrderType(): OrderType {
    return ORDER_TYPE_MAP[this.config.orderType] || OrderType.FOK;
  }

  /**
   * Submit the actual order to Polymarket CLOB.
   * Uses the correct SDK method based on order type:
   * - FOK/FAK → createAndPostMarketOrder (immediate fill)
   * - GTC/GTD → createAndPostOrder (resting limit order)
   */
  private async submitOrder(
    tokenId: string,
    tradeSide: 'BUY' | 'SELL',
    price: number,
    notional: number,
    shares: number,
    retries = 2,
  ): Promise<CopyTradeResult> {
    // Fetch order book metadata (tickSize, negRisk) — required by SDK
    const { tickSize, negRisk } = await this.getOrderBookInfo(tokenId);
    const orderType = this.getOrderType();
    const side = tradeSide === 'BUY' ? Side.BUY : Side.SELL;
    const useMarketOrder = isMarketOrderType(orderType);

    log.debug(
      `Order params: tickSize=${tickSize}, negRisk=${negRisk}, ` +
      `orderType=${this.config.orderType}, marketOrder=${useMarketOrder}`,
    );

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        log.debug(`Order submission attempt ${attempt + 1}/${retries + 1}...`);

        let response: unknown;

        if (useMarketOrder) {
          // FOK/FAK: Use createAndPostMarketOrder for immediate execution
          // UserMarketOrder uses `amount` (not `size`):
          //   BUY  → amount = USDC to spend (notional)
          //   SELL → amount = shares to sell
          response = await this.clob.createAndPostMarketOrder(
            {
              tokenID: tokenId,
              price: price,
              side: side,
              amount: tradeSide === 'BUY' ? notional : shares,
            },
            { tickSize, negRisk },
            orderType as OrderType.FOK | OrderType.FAK,
          );
        } else {
          // GTC/GTD: Use createAndPostOrder for resting limit orders
          // UserOrder.size is in conditional tokens (shares), NOT USDC
          response = await this.clob.createAndPostOrder(
            {
              tokenID: tokenId,
              price: price,
              side: side,
              size: shares,
            },
            { tickSize, negRisk },
            orderType as OrderType.GTC | OrderType.GTD,
          );
        }

        const respRecord = response as Record<string, unknown>;
        const orderId = (respRecord.orderID as string)
          || (respRecord.id as string)
          || 'unknown';

        log.success(`Order submitted: ${orderId} | ${tradeSide} ${shares.toFixed(4)} shares @ $${price}`);

        return {
          success: true,
          orderId,
          copyNotional: notional,
          copyShares: shares,
          price,
          side: tradeSide,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);

        // Non-retryable errors
        if (this.isNonRetryableError(msg)) {
          log.error(`Order failed (non-retryable): ${msg}`);
          return {
            success: false,
            copyNotional: notional,
            copyShares: shares,
            price,
            side: tradeSide,
            error: msg,
          };
        }

        // Retryable errors
        if (attempt < retries) {
          const delay = Math.pow(2, attempt) * 1000;
          log.warn(`Order failed (retryable): ${msg}. Retrying in ${delay}ms...`);
          await this.sleep(delay);
        } else {
          log.error(`Order failed after ${retries + 1} attempts: ${msg}`);
          return {
            success: false,
            copyNotional: notional,
            copyShares: shares,
            price,
            side: tradeSide,
            error: msg,
          };
        }
      }
    }

    // Should never reach here, but TypeScript needs it
    return {
      success: false,
      copyNotional: notional,
      copyShares: shares,
      price,
      side: tradeSide,
      error: 'Max retries exceeded',
    };
  }

  /**
   * Determine if an error should NOT be retried.
   */
  private isNonRetryableError(msg: string): boolean {
    const lower = msg.toLowerCase();
    return (
      lower.includes('unauthorized') ||
      lower.includes('401') ||
      lower.includes('403') ||
      lower.includes('cloudflare') ||
      lower.includes('blocked') ||
      lower.includes('insufficient') ||
      lower.includes('allowance') ||
      lower.includes('invalid') ||
      lower.includes('bad request') ||
      lower.includes('duplicate')
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

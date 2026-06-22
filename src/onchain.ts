/**
 * On-Chain Settlement Verification
 * Monitors Polymarket CTF Exchange contract events on Polygon
 * for trade settlement verification.
 *
 * Architecture:
 * - CLOB WebSocket detects trades instantly (primary)
 * - REST polling catches trades WebSocket missed (backup)
 * - On-chain events verify settlement happened (verification)
 *
 * This module does NOT replace the CLOB — blockchain events are SLOWER
 * than the CLOB because they only fire at settlement (after matching).
 * Instead, this provides verification that trades actually settled on-chain.
 *
 * Contract addresses (Polygon Mainnet):
 * - CTFExchange: 0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E
 * - NegRiskCtfExchange: 0xC5d563A36AE78145C45a50134d48A1215220f80a
 */

import { ethers } from 'ethers';
import { log } from './logger';

// ──────────────────────────────────────────────
// Contract ABIs (events only — minimal)
// ──────────────────────────────────────────────

const CTF_EXCHANGE_ABI = [
  'event OrderFilled(bytes32 indexed orderHash, address indexed maker, address taker, uint8 side, uint256 tokenId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee)',
];

const NEG_RISK_EXCHANGE_ABI = [
  'event OrderFilled(bytes32 indexed orderHash, address indexed maker, address taker, uint8 side, uint256 tokenId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee)',
];

// Contract addresses on Polygon Mainnet
const CTF_EXCHANGE_ADDRESS = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const NEG_RISK_EXCHANGE_ADDRESS = '0xC5d563A36AE78145C45a50134d48A1215220f80a';

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

export interface OnChainFill {
  orderHash: string;
  maker: string;
  taker: string;
  side: 'BUY' | 'SELL';
  tokenId: string;
  makerAmount: string; // USDC (6 decimals)
  takerAmount: string;
  fee: string;
  txHash: string;
  blockNumber: number;
  contract: 'CTFExchange' | 'NegRiskCtfExchange';
  timestamp: number;
}

export type OnChainFillCallback = (fill: OnChainFill) => void;

// ──────────────────────────────────────────────
// On-Chain Monitor
// ──────────────────────────────────────────────

export class OnChainMonitor {
  private provider: ethers.providers.WebSocketProvider | null = null;
  private ctfContract: ethers.Contract | null = null;
  private negRiskContract: ethers.Contract | null = null;
  private targetAddresses: Set<string>;
  private onFill: OnChainFillCallback;
  private running = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stats = {
    totalEvents: 0,
    targetMatches: 0,
    reconnects: 0,
  };

  constructor(targetAddresses: string[], onFill: OnChainFillCallback) {
    this.targetAddresses = new Set(targetAddresses.map((a) => a.toLowerCase()));
    this.onFill = onFill;
  }

  /**
   * Start monitoring on-chain events.
   * Requires a WebSocket RPC endpoint (Alchemy, Infura, etc.)
   */
  async start(wsRpcUrl: string): Promise<void> {
    if (!wsRpcUrl || wsRpcUrl.trim() === '') {
      log.info('On-chain monitoring disabled (no WS_RPC_URL configured)');
      return;
    }

    this.running = true;
    log.info('Starting on-chain settlement monitor...');

    try {
      await this.connect(wsRpcUrl);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`On-chain monitor failed to start: ${msg}`);
      this.scheduleReconnect(wsRpcUrl);
    }
  }

  /**
   * Stop monitoring.
   */
  stop(): void {
    this.running = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.provider) {
      this.provider.destroy();
      this.provider = null;
    }

    this.ctfContract = null;
    this.negRiskContract = null;

    log.info('On-chain monitor stopped');
    log.info(
      `  On-chain stats: ${this.stats.totalEvents} events, ` +
      `${this.stats.targetMatches} target matches, ` +
      `${this.stats.reconnects} reconnects`,
    );
  }

  /**
   * Get monitoring statistics.
   */
  getStats() {
    return { ...this.stats };
  }

  // ──────────────────────────────────────────────
  // Private
  // ──────────────────────────────────────────────

  private async connect(wsRpcUrl: string): Promise<void> {
    this.provider = new ethers.providers.WebSocketProvider(wsRpcUrl);

    // Verify connection
    const blockNumber = await this.provider.getBlockNumber();
    log.info(`On-chain monitor connected (block: ${blockNumber})`);

    // Create contract instances
    this.ctfContract = new ethers.Contract(
      CTF_EXCHANGE_ADDRESS,
      CTF_EXCHANGE_ABI,
      this.provider,
    );

    this.negRiskContract = new ethers.Contract(
      NEG_RISK_EXCHANGE_ADDRESS,
      NEG_RISK_EXCHANGE_ABI,
      this.provider,
    );

    // Subscribe to OrderFilled events on both contracts
    this.subscribeToContract(this.ctfContract, 'CTFExchange');
    this.subscribeToContract(this.negRiskContract, 'NegRiskCtfExchange');

    log.success('On-chain event listeners active (CTFExchange + NegRiskCtfExchange)');
  }

  private subscribeToContract(contract: ethers.Contract, contractName: string): void {
    contract.on('OrderFilled', (
      orderHash: string,
      maker: string,
      taker: string,
      side: number,
      tokenId: ethers.BigNumber,
      makerAmountFilled: ethers.BigNumber,
      takerAmountFilled: ethers.BigNumber,
      fee: ethers.BigNumber,
      event: ethers.Event,
    ) => {
      this.stats.totalEvents++;

      const fill: OnChainFill = {
        orderHash,
        maker: maker.toLowerCase(),
        taker: taker.toLowerCase(),
        side: side === 0 ? 'BUY' : 'SELL',
        tokenId: tokenId.toString(),
        makerAmount: ethers.utils.formatUnits(makerAmountFilled, 6),
        takerAmount: ethers.utils.formatUnits(takerAmountFilled, 6),
        fee: ethers.utils.formatUnits(fee, 6),
        txHash: event.transactionHash,
        blockNumber: event.blockNumber,
        contract: contractName as 'CTFExchange' | 'NegRiskCtfExchange',
        timestamp: Date.now(),
      };

      // Check if this fill involves any of our target wallets
      const isTarget = this.targetAddresses.has(fill.maker) ||
                       this.targetAddresses.has(fill.taker);

      if (isTarget) {
        this.stats.targetMatches++;
        log.debug(
          `On-chain settlement: ${fill.side} token=${fill.tokenId.slice(0, 12)}... ` +
          `maker=${fill.maker.slice(0, 8)}... amount=${fill.makerAmount} USDC ` +
          `(${contractName})`,
        );
        this.onFill(fill);
      }
    });
  }

  private scheduleReconnect(wsRpcUrl: string): void {
    if (!this.running) return;
    this.stats.reconnects++;
    const delay = 10_000;
    log.info(`On-chain monitor reconnecting in ${delay / 1000}s...`);
    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect(wsRpcUrl);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error(`On-chain reconnect failed: ${msg}`);
        this.scheduleReconnect(wsRpcUrl);
      }
    }, delay);
  }
}

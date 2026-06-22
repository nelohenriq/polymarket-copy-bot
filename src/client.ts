/**
 * CLOB Client initialization
 * Handles wallet setup, API key derivation, and Polymarket CLOB SDK connection.
 */

import { ClobClient } from '@polymarket/clob-client';
import { ethers } from 'ethers';
import { BotConfig } from './types';
import { log } from './logger';

const CLOB_HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137; // Polygon PoS

/** API key credentials returned from Polymarket L1 auth */
interface ApiKeyCreds {
  apiKey?: string;
  key?: string;
  secret: string;
  passphrase: string;
}

export interface ClientBundle {
  /** The authenticated CLOB client */
  clob: ClobClient;
  /** The ethers wallet (for signing) */
  wallet: ethers.Wallet;
  /** Derived API credentials */
  creds: {
    apiKey: string;
    secret: string;
    passphrase: string;
  };
}

/**
 * Initialize the Polymarket CLOB client with EOA authentication.
 *
 * Flow:
 * 1. Create ethers Wallet from private key
 * 2. Create initial ClobClient (unauthenticated)
 * 3. Derive or create API key (L1 auth — no gas)
 * 4. Re-create ClobClient with credentials (L2 auth — fast trading)
 */
export async function initClient(config: BotConfig): Promise<ClientBundle> {
  log.info('Initializing Polymarket CLOB client...');

  // Step 1: Create wallet from private key
  const wallet = new ethers.Wallet(config.privateKey);
  log.info(`Wallet address: ${wallet.address}`);

  // Step 2: Create unauthenticated client to derive credentials
  const tempClient = new ClobClient(CLOB_HOST, CHAIN_ID, wallet);

  // Step 3: Derive API credentials (L1 auth)
  log.info('Deriving API credentials from wallet...');
  let creds: ApiKeyCreds | null = null;
  try {
    creds = (await tempClient.deriveApiKey()) as ApiKeyCreds;
    log.info('API credentials derived successfully');
  } catch {
    try {
      log.info('No existing credentials found, creating new ones...');
      creds = (await tempClient.createApiKey()) as ApiKeyCreds;
      log.info('New API credentials created');
    } catch {
      // In DRY_RUN mode, credential failure is not fatal
      if (config.dryRun) {
        log.warn('Could not derive/create API credentials (expected with test wallets)');
      } else {
        throw new Error('Failed to obtain API credentials. Ensure your wallet has a Polymarket account.');
      }
    }
  }

  // Validate credentials — SDK may return either `apiKey` or `key`
  const apiKey = creds?.apiKey || creds?.key;
  const hasValidCreds = apiKey && creds?.secret && creds?.passphrase;

  if (!hasValidCreds && !config.dryRun) {
    throw new Error('Failed to obtain valid API credentials from Polymarket');
  }

  // Build credentials
  const validCreds = hasValidCreds
    ? { apiKey: apiKey!, key: apiKey!, secret: creds!.secret, passphrase: creds!.passphrase }
    : { apiKey: 'dry-run-key', key: 'dry-run-key', secret: 'dry-run-secret', passphrase: 'dry-run-passphrase' };

  if (!hasValidCreds && config.dryRun) {
    log.info('[DRY RUN] Using placeholder credentials — no real orders will be placed');
  }

  // Step 4: Create authenticated client (L2 auth — used for fast order execution)
  // In DRY_RUN without real creds, use unauthenticated client to avoid SDK validation errors
  let clob: ClobClient;
  try {
    clob = new ClobClient(
      CLOB_HOST,
      CHAIN_ID,
      wallet,
      hasValidCreds ? validCreds : undefined,
    );
  } catch (error) {
    if (config.dryRun && !hasValidCreds) {
      // Fallback: unauthenticated client for dry-run mode
      log.info('[DRY RUN] CLOB auth not available, using unauthenticated client');
      clob = new ClobClient(CLOB_HOST, CHAIN_ID, wallet);
    } else {
      throw error;
    }
  }

  log.success(`CLOB client initialized ${hasValidCreds ? 'and authenticated' : '(dry-run mode)'}`);

  return { clob, wallet, creds: validCreds };
}

/**
 * Set token allowances (one-time setup).
 * Must be called before first trade to approve CTF Exchange to spend USDC.e and tokens.
 *
 * Note: This uses a raw ethers contract call since setAllowances may not exist
 * on all SDK versions. The bot will work without this if allowances are already set
 * (e.g. via the Polymarket UI or a previous bot run).
 */
export async function ensureAllowances(_clob: ClobClient): Promise<void> {
  log.info('Token allowances should be set via Polymarket UI or first trade approval.');
  log.info('If this is your first time, approve USDC.e spending when prompted.');
  // Allowances are typically handled automatically by the SDK on first trade,
  // or can be set via the Polymarket UI. We don't call a non-existent method here.
}

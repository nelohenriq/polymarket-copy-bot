/**
 * Proxy Support
 * Provides a proxy-aware fetch function that routes traffic through
 * a SOCKS5 or HTTP(S) proxy when PROXY_URL is configured.
 *
 * Supports:
 * - HTTP proxy:  http://proxy:8080
 * - HTTPS proxy: https://proxy:8080
 * - SOCKS5:      socks5://proxy:1080
 *
 * Usage:
 *   import { proxyFetch } from './proxy';
 *   const response = await proxyFetch('https://data-api.polymarket.com/...');
 */

import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { log } from './logger';

let proxyAgent: ProxyAgent | null = null;

/**
 * Configure the global proxy agent.
 * Safe to call multiple times — only creates the agent once.
 */
export function configureProxy(proxyUrl: string | undefined): void {
  if (proxyAgent) return; // Already configured

  if (!proxyUrl || proxyUrl.trim() === '') {
    return;
  }

  const url = proxyUrl.trim();
  log.info(`Proxy configured: ${url}`);
  proxyAgent = new ProxyAgent({
    uri: url,
    requestTls: {
      // Don't reject certs behind the proxy (the proxy terminates TLS)
      rejectUnauthorized: false,
    },
  });
}

/**
 * Proxy-aware fetch function.
 * Routes through the configured proxy if one is set, otherwise uses native fetch.
 */
export async function proxyFetch(
  url: string,
  options?: globalThis.RequestInit,
): Promise<globalThis.Response> {
  if (!proxyAgent) {
    return globalThis.fetch(url, options);
  }

  // Route through proxy — cast options to undici's RequestInit
  const response = await undiciFetch(url, {
    ...options,
    dispatcher: proxyAgent,
  } as Parameters<typeof undiciFetch>[1]);

  // Node 22: undici Response and global Response are compatible
  return response as unknown as globalThis.Response;
}

/**
 * Check if a proxy is configured (for diagnostics / WebSocket fallback).
 */
export function isProxyEnabled(): boolean {
  return proxyAgent !== null;
}

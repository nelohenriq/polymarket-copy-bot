/**
 * Proxy Support (Enhanced)
 * Routes ALL traffic through a SOCKS5 or HTTP(S) proxy when PROXY_URL is configured.
 *
 * Fixes network bypass issues by covering:
 * 1. REST API calls — via undici ProxyAgent (proxyFetch)
 * 2. CLOB SDK internal HTTP — via global undici dispatcher + env vars
 * 3. WebSocket connections — via socks-proxy-agent / HTTP CONNECT agent
 * 4. Backtest/historical fetch — via proxyFetch
 *
 * Supports:
 * - HTTP proxy:  http://proxy:8080
 * - HTTPS proxy: https://proxy:8080
 * - SOCKS5:      socks5://proxy:1080
 */

import { Agent, ProxyAgent, fetch as undiciFetch, setGlobalDispatcher } from 'undici';
import * as dns from 'dns';
import { log } from './logger';

// ──────────────────────────────────────────────
// DNS Hijacking Fix (Windows)
// Node's dns.lookup() uses OS getaddrinfo which follows system DNS.
// On Windows, DNS resolvers like joindns4.eu intercept Polymarket domains.
// dns.resolve4/resolve6 use c-ares which respects dns.setServers(),
// so we override the DNS servers and provide a custom lookup function.
// ──────────────────────────────────────────────

dns.setServers(['8.8.8.8', '1.1.1.1', '1.0.0.1', '8.8.4.4']);

// ──────────────────────────────────────────────
// Fix ALL HTTP clients in the process (including @polymarket/clob-client SDK)
// by replacing http.globalAgent and https.globalAgent with agents that use
// our custom c-ares lookup. This bypasses OS getaddrinfo which on Windows
// follows the joindns4.eu DNS that intercepts Polymarket domains.
// ──────────────────────────────────────────────

try {
  const http = require('http') as typeof import('http');
  const https = require('https') as typeof import('https');

  // Replace the default global agents with ones that use c-ares DNS
  http.globalAgent = new http.Agent({ lookup: customLookup as typeof dns.lookup });
  https.globalAgent = new https.Agent({ lookup: customLookup as typeof dns.lookup });
} catch {
  // Non-fatal — globalThis.fetch still uses the undici dispatcher with customLookup
}

/**
 * Custom DNS lookup that uses c-ares (dns.resolve4/resolve6) instead of
 * OS getaddrinfo. This bypasses Windows DNS interception (e.g. joindns4.eu).
 * Falls back to system dns.lookup for localhost and other local names.
 */
export function customLookup(
  hostname: string,
  options: dns.LookupOneOptions | dns.LookupAllOptions | dns.LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family: number) => void,
): void {
  // Try IPv4 first (most common)
  dns.resolve4(hostname, (err4, addresses4) => {
    if (!err4 && addresses4 && addresses4.length > 0) {
      const all = typeof options === 'object' && 'all' in options && options.all;
      if (all) {
        callback(null, addresses4.map(addr => ({ address: addr, family: 4 })), 4);
      } else {
        callback(null, addresses4[0]!, 4);
      }
      return;
    }

    // Try IPv6
    dns.resolve6(hostname, (err6, addresses6) => {
      if (!err6 && addresses6 && addresses6.length > 0) {
        const all = typeof options === 'object' && 'all' in options && options.all;
        if (all) {
          callback(null, addresses6.map(addr => ({ address: addr, family: 6 })), 6);
        } else {
          callback(null, addresses6[0]!, 6);
        }
        return;
      }

      // Fallback to system DNS (needed for localhost, .local, etc.)
      dns.lookup(hostname, options, callback);
    });
  });
}

// ──────────────────────────────────────────────
// State
// ──────────────────────────────────────────────

let proxyAgent: ProxyAgent | null = null;
let proxyUrl: string | null = null;
let cachedWsAgent: import('http').Agent | undefined = undefined;
let wsAgentCached = false;

// Lazily imported SocksProxyAgent — only loaded when SOCKS5 proxy is configured
let SocksProxyAgentClass: (new (uri: string) => import('http').Agent) | null = null;

// ──────────────────────────────────────────────
// Configure
// ──────────────────────────────────────────────

/**
 * Configure the global proxy agent.
 * Sets up ALL proxy paths: REST dispatcher, env vars, and WebSocket agent.
 * Safe to call multiple times — only creates the agent once.
 */
export function configureProxy(url: string | undefined): void {
  if (proxyAgent) return; // Already configured

  if (!url || url.trim() === '') {
    // Even without a proxy, set a global dispatcher with custom DNS
    // so CLOB SDK internal fetch calls use c-ares resolution.
    try {
      const secureAgent = new Agent({ connect: { lookup: customLookup } });
      setGlobalDispatcher(secureAgent);
      log.info('Global dispatcher set with custom DNS (no proxy configured)');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warn(`Failed to set DNS-protected dispatcher: ${msg}`);
    }
    return;
  }

  proxyUrl = url.trim();
  log.info(`Proxy configured: ${proxyUrl}`);

  // ── 1. Create undici ProxyAgent for REST calls ──
  proxyAgent = new ProxyAgent({
    uri: proxyUrl,
    requestTls: {
      rejectUnauthorized: false, // Proxy terminates TLS
    },
    connect: {
      lookup: customLookup, // Use c-ares DNS even through proxy
    },
  });

  // ── 2. Set as global dispatcher ──
  // This routes ALL undici/globalThis.fetch calls through the proxy,
  // including those made by @polymarket/clob-client SDK internally.
  try {
    setGlobalDispatcher(proxyAgent);
    log.info('Global dispatcher set — all HTTP requests will route through proxy');
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.warn(`Failed to set global dispatcher: ${msg} (proxyFetch will still work)`);
  }

  // ── 3. Set env vars for HTTP clients that respect them ──
  // axios, got, node-fetch, and some SDK internals check these env vars.
  const envKey = proxyUrl.startsWith('https') ? 'HTTPS_PROXY' : 'HTTP_PROXY';
  process.env[envKey] = proxyUrl;
  process.env['ALL_PROXY'] = proxyUrl; // Some clients use ALL_PROXY
  // Also set lowercase variants
  process.env[envKey.toLowerCase()] = proxyUrl;
  process.env['all_proxy'] = proxyUrl;
  log.info(`Set ${envKey} and ALL_PROXY env vars for SDK compatibility`);
}

// ──────────────────────────────────────────────
// REST Fetch
// ──────────────────────────────────────────────

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

// ──────────────────────────────────────────────
// WebSocket Agent
// ──────────────────────────────────────────────

/**
 * Get an HTTP agent suitable for the `ws` library that routes through the proxy.
 * - SOCKS5 proxy → uses socks-proxy-agent
 * - HTTP/HTTPS proxy → uses standard http.Agent with CONNECT tunneling
 * - No proxy → returns undefined (ws uses default direct connection)
 *
 * Usage:
 *   const agent = getProxyAgent();
 *   const ws = new WebSocket(url, { agent });
 */
export function getProxyAgent(): import('http').Agent | undefined {
  if (!proxyUrl) return undefined;

  // Return cached agent if available
  if (wsAgentCached) return cachedWsAgent;

  if (proxyUrl.startsWith('socks')) {
    // SOCKS5 proxy — use socks-proxy-agent
    try {
      // Dynamic import to avoid loading when not needed
      const mod = require('socks-proxy-agent') as { SocksProxyAgent: new (uri: string) => import('http').Agent };
      SocksProxyAgentClass = mod.SocksProxyAgent;
      cachedWsAgent = new SocksProxyAgentClass(proxyUrl);
      wsAgentCached = true;
      log.debug('Loaded socks-proxy-agent for WebSocket proxy');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`Failed to load socks-proxy-agent: ${msg} — WebSocket will not use proxy`);
      wsAgentCached = true;
      cachedWsAgent = undefined;
    }
    return cachedWsAgent;
  }

  // HTTP/HTTPS proxy — use http.request with CONNECT method for WebSocket tunneling
  try {
    const http = require('http') as typeof import('http');

    const parsed = new URL(proxyUrl);

    cachedWsAgent = new http.Agent({
      // @ts-expect-error — ws library uses createConnection to establish CONNECT tunnel
      createConnection: (
        opts: { host: string; port: number },
        callback: (err: Error | null, socket?: import('net').Socket) => void,
      ) => {
        const connectOpts = {
          host: parsed.hostname,
          port: Number(parsed.port) || 8080,
          method: 'CONNECT' as const,
          path: `${opts.host}:${opts.port}`,
          headers: { Host: `${opts.host}:${opts.port}` },
          lookup: customLookup as typeof dns.lookup, // Use c-ares DNS for proxy tunnel
        };

        const req = http.request(connectOpts);
        req.on('connect', (_res: unknown, socket: import('net').Socket) => {
          callback(null, socket);
        });
        req.on('error', (err: Error) => {
          callback(err);
        });
        req.end();
      },
    });

    wsAgentCached = true;
    log.debug('Created HTTP CONNECT agent for WebSocket proxy');
    return cachedWsAgent;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.warn(`Failed to create WebSocket proxy agent: ${msg}`);
    wsAgentCached = true;
    cachedWsAgent = undefined;
    return undefined;
  }
}

// ──────────────────────────────────────────────
// Diagnostics
// ──────────────────────────────────────────────

/**
 * Check if a proxy is configured.
 */
export function isProxyEnabled(): boolean {
  return proxyAgent !== null;
}

/**
 * Get the configured proxy URL (for diagnostics).
 */
export function getProxyUrl(): string | null {
  return proxyUrl;
}

/**
 * Test proxy connectivity by making a lightweight request to Polymarket.
 * Returns true if reachable, false otherwise.
 */
export async function testProxyConnectivity(): Promise<{
  reachable: boolean;
  latencyMs: number;
  error?: string;
  endpoint: string;
}> {
  const testUrl = 'https://data-api.polymarket.com/v1/leaderboard?limit=1';
  const start = Date.now();

  try {
    const response = await proxyFetch(testUrl, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });

    const latencyMs = Date.now() - start;

    if (response.ok) {
      log.success(`Proxy connectivity OK (${latencyMs}ms via ${proxyUrl || 'direct'})`);
      return { reachable: true, latencyMs, endpoint: testUrl };
    }

    const error = `HTTP ${response.status}: ${response.statusText}`;
    log.warn(`Proxy connectivity issue: ${error}`);
    return { reachable: false, latencyMs, error, endpoint: testUrl };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const error = err instanceof Error ? err.message : String(err);
    log.error(`Proxy connectivity FAILED: ${error} (${latencyMs}ms)`);
    return { reachable: false, latencyMs, error, endpoint: testUrl };
  }
}

/**
 * Run comprehensive proxy diagnostics at startup.
 * Tests REST, CLOB, and WebSocket connectivity.
 */
export async function runProxyDiagnostics(): Promise<void> {
  if (!proxyUrl) {
    log.info('No proxy configured — skipping diagnostics');
    return;
  }

  log.info('🔍 Running proxy diagnostics...');

  // Test 1: Data API (REST via proxyFetch)
  const dataApi = await testProxyConnectivity();
  log.info(`  Data API:      ${dataApi.reachable ? '✅' : '❌'} ${dataApi.latencyMs}ms${dataApi.error ? ` — ${dataApi.error}` : ''}`);

  // Test 2: CLOB API (via global dispatcher — same path as SDK)
  const clobStart = Date.now();
  try {
    const resp = await globalThis.fetch('https://clob.polymarket.com/time', {
      signal: AbortSignal.timeout(10_000),
    });
    const clobLatency = Date.now() - clobStart;
    log.info(`  CLOB API:      ${resp.ok ? '✅' : '❌'} ${clobLatency}ms`);
  } catch (err) {
    const clobLatency = Date.now() - clobStart;
    const msg = err instanceof Error ? err.message : String(err);
    log.info(`  CLOB API:      ❌ ${clobLatency}ms — ${msg}`);
  }

  // Test 3: Gamma API (REST)
  const gammaStart = Date.now();
  try {
    const resp = await proxyFetch('https://gamma-api.polymarket.com/markets?limit=1&active=true', {
      signal: AbortSignal.timeout(10_000),
    });
    const gammaLatency = Date.now() - gammaStart;
    log.info(`  Gamma API:     ${resp.ok ? '✅' : '❌'} ${gammaLatency}ms`);
  } catch (err) {
    const gammaLatency = Date.now() - gammaStart;
    const msg = err instanceof Error ? err.message : String(err);
    log.info(`  Gamma API:     ❌ ${gammaLatency}ms — ${msg}`);
  }

  // Test 4: WebSocket (quick connect test)
  const wsAgent = getProxyAgent();
  if (wsAgent) {
    const wsStart = Date.now();
    try {
      const WebSocket = require('ws') as typeof import('ws');
      const ws = new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market', {
        agent: wsAgent,
      });

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          ws.close();
          reject(new Error('WebSocket connection timeout (10s)'));
        }, 10_000);

        ws.on('open', () => {
          clearTimeout(timeout);
          ws.close();
          resolve();
        });
        ws.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

      const wsLatency = Date.now() - wsStart;
      log.info(`  WebSocket:     ✅ ${wsLatency}ms`);
    } catch (err) {
      const wsLatency = Date.now() - wsStart;
      const msg = err instanceof Error ? err.message : String(err);
      log.info(`  WebSocket:     ❌ ${wsLatency}ms — ${msg}`);
    }
  } else {
    log.info('  WebSocket:     ⚠️  No proxy agent available');
  }

  log.info('🔍 Proxy diagnostics complete');
}

/**
 * Test: /api/health endpoint
 *
 * Spins up a minimal HTTP server replicating the health endpoint logic from index.ts,
 * hits it with a GET request, and validates the response shape.
 *
 * Usage: npx tsx test-health.ts
 */

import * as http from 'http';
import * as fs from 'fs';

const PORT = 13456; // Use a non-standard port to avoid conflicts

function buildHealthResponse(): { statusCode: number; body: Record<string, unknown> } {
  const strategiesFile = process.env['STRATEGIES_FILE'] || '';
  const stateFile = process.env['STATE_FILE_PATH'] || 'bot-state.json';
  const checkFiles = [
    { name: 'dashboard', path: 'dry-run-trades.json' },
    { name: 'state', path: stateFile },
    { name: 'strategies', path: strategiesFile },
    { name: 'aiCalibration', path: 'ai-calibration.json' },
  ].filter(f => f.path);

  const files: Record<string, { exists: boolean; path: string }> = {};
  for (const f of checkFiles) {
    files[f.name] = { exists: fs.existsSync(f.path), path: f.path };
  }

  const allPresent = Object.values(files).every(f => f.exists);
  const missing = Object.values(files).filter(f => !f.exists).length;

  const health = {
    status: allPresent ? 'ok' : 'degraded',
    uptime: 12345,
    mode: 'dry-run',
    dataFiles: files,
    summary: { total: checkFiles.length, present: checkFiles.length - missing, missing },
    timestamp: new Date().toISOString(),
  };

  return { statusCode: allPresent ? 200 : 207, body: health };
}

async function main(): Promise<void> {
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, message: string): void {
    if (condition) {
      console.log(`  ✅ ${message}`);
      passed++;
    } else {
      console.error(`  ❌ ${message}`);
      failed++;
    }
  }

  // Start a minimal HTTP server with just the health endpoint
  const server = http.createServer((req, res) => {
    const reqPath = req.url?.split('?')[0] || '/';
    if (reqPath === '/api/health') {
      const { statusCode, body } = buildHealthResponse();
      res.writeHead(statusCode, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(body, null, 2));
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  await new Promise<void>((resolve) => server.listen(PORT, resolve));
  console.log(`\n🧪 Testing /api/health on port ${PORT}\n`);

  try {
    // ── Test 1: Basic response ──
    console.log('Test 1: Response is valid JSON with expected shape');
    const resp = await fetch(`http://localhost:${PORT}/api/health`, {
      signal: AbortSignal.timeout(5000),
    });
    assert(resp.ok || resp.status === 207, `Status is 200 or 207 (got ${resp.status})`);

    const contentType = resp.headers.get('content-type') || '';
    assert(contentType.includes('application/json'), `Content-Type is application/json (got "${contentType}")`);

    const cors = resp.headers.get('access-control-allow-origin') || '';
    assert(cors === '*', `CORS header is * (got "${cors}")`);

    const cache = resp.headers.get('cache-control') || '';
    assert(cache.includes('no-cache'), `Cache-Control includes no-cache (got "${cache}")`);

    // ── Test 2: Response body shape ──
    console.log('\nTest 2: Response body has required fields');
    const body = await resp.json() as Record<string, unknown>;

    assert(typeof body['status'] === 'string', `status is a string (got ${typeof body['status']})`);
    assert(body['status'] === 'ok' || body['status'] === 'degraded', `status is "ok" or "degraded" (got "${body['status']}")`);

    assert(typeof body['uptime'] === 'number', `uptime is a number (got ${typeof body['uptime']})`);
    assert((body['uptime'] as number) >= 0, `uptime is >= 0`);

    assert(typeof body['mode'] === 'string', `mode is a string (got ${typeof body['mode']})`);
    assert(['paper', 'dry-run', 'live'].includes(body['mode'] as string), `mode is paper/dry-run/live (got "${body['mode']}")`);

    assert(typeof body['timestamp'] === 'string', `timestamp is a string (got ${typeof body['timestamp']})`);
    assert(!isNaN(Date.parse(body['timestamp'] as string)), `timestamp is a valid ISO date`);

    // ── Test 3: dataFiles structure ──
    console.log('\nTest 3: dataFiles structure');
    const dataFiles = body['dataFiles'] as Record<string, unknown>;
    assert(typeof dataFiles === 'object' && dataFiles !== null, `dataFiles is an object`);

    const fileNames = Object.keys(dataFiles);
    assert(fileNames.length > 0, `dataFiles has at least one entry (got ${fileNames.length})`);

    for (const name of fileNames) {
      const entry = dataFiles[name] as Record<string, unknown>;
      assert(typeof entry['exists'] === 'boolean', `dataFiles.${name}.exists is a boolean`);
      assert(typeof entry['path'] === 'string', `dataFiles.${name}.path is a string`);
    }

    // ── Test 4: summary structure ──
    console.log('\nTest 4: summary structure');
    const summary = body['summary'] as Record<string, unknown>;
    assert(typeof summary === 'object' && summary !== null, `summary is an object`);
    assert(typeof summary['total'] === 'number', `summary.total is a number`);
    assert(typeof summary['present'] === 'number', `summary.present is a number`);
    assert(typeof summary['missing'] === 'number', `summary.missing is a number`);
    assert((summary['total'] as number) === (summary['present'] as number) + (summary['missing'] as number), `total === present + missing`);

    // ── Test 5: CORS preflight ──
    console.log('\nTest 5: 404 for unknown routes');
    const notFound = await fetch(`http://localhost:${PORT}/api/nonexistent`, {
      signal: AbortSignal.timeout(5000),
    });
    assert(notFound.status === 404, `Unknown route returns 404 (got ${notFound.status})`);

  } catch (err) {
    console.error(`\n💥 Test error: ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  } finally {
    server.close();
  }

  // ── Summary ──
  console.log(`\n${'═'.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`${'═'.repeat(40)}\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Fatal: ${err}`);
  process.exit(1);
});

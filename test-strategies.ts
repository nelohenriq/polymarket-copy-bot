/**
 * Unit tests for loadStrategies() — ENOENT handling and validation
 *
 * Tests the loadStrategies() function from src/config.ts with various
 * file states and content scenarios.
 *
 * Usage: npx tsx test-strategies.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadStrategies } from './src/config';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'strategies-test-'));
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

function writeTmpFile(name: string, content: string): string {
  const filePath = path.join(TMP_DIR, name);
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

function cleanup(): void {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

async function main(): Promise<void> {
  const originalEnv = process.env['STRATEGIES_FILE'];

  try {
    // ── Test 1: No STRATEGIES_FILE env var → returns undefined ──
    console.log('\nTest 1: No STRATEGIES_FILE env var');
    delete process.env['STRATEGIES_FILE'];
    const result1 = loadStrategies();
    assert(result1 === undefined, 'Returns undefined when STRATEGIES_FILE is not set');

    // ── Test 2: File does not exist (ENOENT) → returns undefined ──
    console.log('\nTest 2: File does not exist (ENOENT)');
    process.env['STRATEGIES_FILE'] = path.join(TMP_DIR, 'nonexistent.json');
    const result2 = loadStrategies();
    assert(result2 === undefined, 'Returns undefined when file does not exist');

    // ── Test 3: Valid strategies file → returns parsed array ──
    console.log('\nTest 3: Valid strategies file');
    const validStrategies = JSON.stringify([
      { name: 'aggressive', enabled: true, routing: { isDefault: true, categories: ['crypto'] } },
      { name: 'conservative', routing: { traders: ['0xabc'] } },
    ]);
    const validPath = writeTmpFile('valid.json', validStrategies);
    process.env['STRATEGIES_FILE'] = validPath;
    const result3 = loadStrategies();
    assert(Array.isArray(result3), 'Returns an array');
    assert(result3!.length === 2, 'Array has 2 strategies');
    assert(result3![0].name === 'aggressive', 'First strategy name is "aggressive"');
    assert(result3![1].name === 'conservative', 'Second strategy name is "conservative"');

    // ── Test 4: enabled defaults to true when omitted ──
    console.log('\nTest 4: enabled defaults to true');
    assert(result3![0].enabled === true, 'Explicitly set enabled=true preserved');
    assert(result3![1].enabled === true, 'Omitted enabled defaults to true');

    // ── Test 5: Invalid JSON → throws ──
    console.log('\nTest 5: Invalid JSON');
    const invalidPath = writeTmpFile('invalid.json', '{not valid json!!!}');
    process.env['STRATEGIES_FILE'] = invalidPath;
    let threw5 = false;
    try { loadStrategies(); } catch (err) {
      threw5 = true;
      const msg = err instanceof Error ? err.message : String(err);
      assert(msg.includes('invalid JSON'), `Error mentions invalid JSON (got: "${msg.slice(0, 80)}")`);
    }
    assert(threw5, 'Throws on invalid JSON');

    // ── Test 6: Empty array → throws ──
    console.log('\nTest 6: Empty array');
    const emptyPath = writeTmpFile('empty.json', '[]');
    process.env['STRATEGIES_FILE'] = emptyPath;
    let threw6 = false;
    try { loadStrategies(); } catch { threw6 = true; }
    assert(threw6, 'Throws on empty array');

    // ── Test 7: Strategy missing name → throws ──
    console.log('\nTest 7: Strategy missing name');
    const noNamePath = writeTmpFile('noname.json', JSON.stringify([{ routing: { isDefault: true } }]));
    process.env['STRATEGIES_FILE'] = noNamePath;
    let threw7 = false;
    try { loadStrategies(); } catch (err) {
      threw7 = true;
      const msg = err instanceof Error ? err.message : String(err);
      assert(msg.includes('name'), `Error mentions missing name (got: "${msg}")`);
    }
    assert(threw7, 'Throws when strategy missing name');

    // ── Test 8: Strategy missing routing → throws ──
    console.log('\nTest 8: Strategy missing routing');
    const noRoutingPath = writeTmpFile('norouting.json', JSON.stringify([{ name: 'test' }]));
    process.env['STRATEGIES_FILE'] = noRoutingPath;
    let threw8 = false;
    try { loadStrategies(); } catch (err) {
      threw8 = true;
      const msg = err instanceof Error ? err.message : String(err);
      assert(msg.includes('routing'), `Error mentions missing routing (got: "${msg}")`);
    }
    assert(threw8, 'Throws when strategy missing routing');

    // ── Test 9: Multiple defaults → throws ──
    console.log('\nTest 9: Multiple defaults');
    const multiDefaultPath = writeTmpFile('multidefault.json', JSON.stringify([
      { name: 'a', routing: { isDefault: true } },
      { name: 'b', routing: { isDefault: true } },
    ]));
    process.env['STRATEGIES_FILE'] = multiDefaultPath;
    let threw9 = false;
    try { loadStrategies(); } catch (err) {
      threw9 = true;
      const msg = err instanceof Error ? err.message : String(err);
      assert(msg.includes('isDefault'), `Error mentions isDefault (got: "${msg}")`);
    }
    assert(threw9, 'Throws when multiple strategies have isDefault=true');

    // ── Test 10: Valid single strategy → returns array with 1 element ──
    console.log('\nTest 10: Valid single strategy');
    const singlePath = writeTmpFile('single.json', JSON.stringify([
      { name: 'solo', routing: { isDefault: true } },
    ]));
    process.env['STRATEGIES_FILE'] = singlePath;
    const result10 = loadStrategies();
    assert(Array.isArray(result10), 'Returns an array');
    assert(result10!.length === 1, 'Array has 1 strategy');
    assert(result10![0].name === 'solo', 'Strategy name is "solo"');

  } catch (err) {
    console.error(`\n💥 Test error: ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  } finally {
    // Restore original env
    if (originalEnv !== undefined) {
      process.env['STRATEGIES_FILE'] = originalEnv;
    } else {
      delete process.env['STRATEGIES_FILE'];
    }
    cleanup();
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
  cleanup();
  process.exit(1);
});

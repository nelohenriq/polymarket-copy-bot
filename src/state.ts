/**
 * State Persistence
 * Saves and loads bot state to/from disk so positions survive restarts.
 *
 * Persisted state includes:
 * - Journal entries (all trades — open and closed)
 * - Position tracker snapshots
 * - Per-wallet lastProcessedTimestamp for catch-up replay
 * - Risk manager state (session notional, P&L, streaks)
 * - Session stats
 */

import * as fs from 'fs';
import { TradeJournalEntry, Position, RiskState, SessionStats, PersistedStrategyState } from './types';
import { log } from './logger';

/** The complete persisted bot state */
export interface BotState {
  version: number;
  savedAt: string; // ISO timestamp
  entries: TradeJournalEntry[];
  positions: Position[];
  lastProcessedTimestamps: Record<string, number>; // walletAddress -> epoch ms
  riskState: RiskState;
  sessionStats: SessionStats;
  counter: number; // journal entry counter for ID continuity
  /** Per-strategy positions + risk state (multi-strategy mode only) */
  strategies?: PersistedStrategyState[];
}

const STATE_VERSION = 1;
const DEFAULT_STATE_PATH = 'bot-state.json';

/**
 * Save the current bot state to disk.
 * Called on every trade and periodically.
 */
export function saveState(
  statePath: string,
  entries: TradeJournalEntry[],
  positions: Position[],
  lastProcessedTimestamps: Map<string, number>,
  riskState: RiskState,
  sessionStats: SessionStats,
  counter: number,
  strategies?: PersistedStrategyState[],
): void {
  try {
    const state: BotState = {
      version: STATE_VERSION,
      savedAt: new Date().toISOString(),
      entries,
      positions: positions.filter(p => p.shares > 0), // Only persist open positions
      lastProcessedTimestamps: Object.fromEntries(lastProcessedTimestamps),
      riskState,
      sessionStats,
      counter,
      ...(strategies && strategies.length > 0 ? { strategies } : {}),
    };
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`Failed to save state: ${msg}`);
  }
}

/**
 * Load bot state from disk.
 * Returns null if file doesn't exist or is invalid.
 */
export function loadState(statePath: string): BotState | null {
  try {
    if (!fs.existsSync(statePath)) {
      return null;
    }
    const raw = fs.readFileSync(statePath, 'utf-8');
    const state = JSON.parse(raw) as BotState;

    // Validate version
    if (!state.version || state.version > STATE_VERSION) {
      log.warn(`State file version mismatch (${state.version} vs ${STATE_VERSION}) — ignoring`);
      return null;
    }

    // Validate required fields
    if (!Array.isArray(state.entries)) {
      log.warn('State file missing entries array — ignoring');
      return null;
    }

    return state;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`Failed to load state from ${statePath}: ${msg}`);
    return null;
  }
}

/**
 * Get the default state file path, allowing override via env var.
 */
export function getStatePath(): string {
  return process.env['STATE_FILE_PATH'] || DEFAULT_STATE_PATH;
}

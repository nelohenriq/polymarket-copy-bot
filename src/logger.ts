/**
 * Simple logger with configurable log levels.
 */

import { LogLevel } from './types';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[currentLevel];
}

function timestamp(): string {
  return new Date().toISOString();
}

export const log = {
  debug(message: string, ...args: unknown[]): void {
    if (shouldLog('debug')) {
      console.log(`[${timestamp()}] 🔍 ${message}`, ...args);
    }
  },

  info(message: string, ...args: unknown[]): void {
    if (shouldLog('info')) {
      console.log(`[${timestamp()}] ℹ️  ${message}`, ...args);
    }
  },

  warn(message: string, ...args: unknown[]): void {
    if (shouldLog('warn')) {
      console.warn(`[${timestamp()}] ⚠️  ${message}`, ...args);
    }
  },

  error(message: string, ...args: unknown[]): void {
    if (shouldLog('error')) {
      console.error(`[${timestamp()}] ❌ ${message}`, ...args);
    }
  },

  trade(message: string, ...args: unknown[]): void {
    if (shouldLog('info')) {
      console.log(`[${timestamp()}] 🎯 ${message}`, ...args);
    }
  },

  success(message: string, ...args: unknown[]): void {
    if (shouldLog('info')) {
      console.log(`[${timestamp()}] ✅ ${message}`, ...args);
    }
  },

  risk(message: string, ...args: unknown[]): void {
    if (shouldLog('warn')) {
      console.warn(`[${timestamp()}] 🛡️  ${message}`, ...args);
    }
  },
};

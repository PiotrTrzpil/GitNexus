/**
 * Global Logger
 *
 * Provides rotating file logging for GitNexus with a pino-compatible API.
 * Uses pino internally but exports a stable interface for easy swapping.
 *
 * Usage:
 *   import { logger } from '../util/logger.js';
 *   logger.error({ err, context: 'db' }, 'Query failed');
 *   logger.info({ repo: 'MyApp' }, 'Index complete');
 *
 * Log location: ~/.gitnexus/logs/gitnexus.log (rotated at 5MB, 3 files kept)
 *
 * Configuration via env:
 *   GITNEXUS_LOG_LEVEL=debug|info|warn|error (default: info)
 *   GITNEXUS_LOG_PRETTY=1  (pretty-print to stderr, useful for dev)
 */

import { statSync, unlinkSync, renameSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import pino, { type DestinationStream, type StreamEntry } from 'pino';

// ─── Types ─────────────────────────────────────────────────────────────────

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LogContext {
  /** Error object - will be serialized properly */
  err?: Error | unknown;
  /** Component/subsystem name */
  context?: string;
  /** Repository name */
  repo?: string;
  /** Duration in ms */
  durationMs?: number;
  /** Any additional structured data */
  [key: string]: unknown;
}

/**
 * Logger interface - matches pino's API subset.
 * If we ever swap implementations, callers won't need changes.
 */
export interface Logger {
  trace(ctx: LogContext, msg: string): void;
  trace(msg: string): void;
  debug(ctx: LogContext, msg: string): void;
  debug(msg: string): void;
  info(ctx: LogContext, msg: string): void;
  info(msg: string): void;
  warn(ctx: LogContext, msg: string): void;
  warn(msg: string): void;
  error(ctx: LogContext, msg: string): void;
  error(msg: string): void;
  fatal(ctx: LogContext, msg: string): void;
  fatal(msg: string): void;

  /** Create a child logger with preset context */
  child(bindings: LogContext): Logger;

  /** Current log level */
  level: LogLevel;

  /** Flush pending writes (call before exit) */
  flush(): void;
}

// ─── Paths ─────────────────────────────────────────────────────────────────

const GLOBAL_DIR = join(homedir(), '.gitnexus');
const LOG_DIR = join(GLOBAL_DIR, 'logs');
const LOG_FILE = join(LOG_DIR, 'gitnexus.log');

const MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5MB
const MAX_FILES = 3;

// ─── Log Rotation ──────────────────────────────────────────────────────────

/**
 * Simple size-based rotation.
 * Called before each write batch to check if rotation is needed.
 */
function rotateIfNeeded(): void {
  try {
    const stats = statSync(LOG_FILE);
    if (stats.size < MAX_SIZE_BYTES) return;

    // Rotate: gitnexus.log -> gitnexus.log.1 -> gitnexus.log.2 -> (deleted)
    for (let i = MAX_FILES - 1; i >= 1; i--) {
      const older = `${LOG_FILE}.${i}`;
      const newer = i === 1 ? LOG_FILE : `${LOG_FILE}.${i - 1}`;
      try {
        if (i === MAX_FILES - 1) {
          unlinkSync(older); // Delete oldest
        }
        renameSync(newer, older);
      } catch {
        // File may not exist, that's fine
      }
    }
  } catch {
    // Log file doesn't exist yet, nothing to rotate
  }
}

// ─── Initialization ────────────────────────────────────────────────────────

function ensureLogDir(): void {
  mkdirSync(LOG_DIR, { recursive: true });
}

function getLogLevel(): LogLevel {
  const env = process.env.GITNEXUS_LOG_LEVEL?.toLowerCase();
  if (env && ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].includes(env)) {
    return env as LogLevel;
  }
  return 'info';
}

function createLogger(): pino.Logger {
  ensureLogDir();

  const level = getLogLevel();
  const pretty = process.env.GITNEXUS_LOG_PRETTY === '1';

  // Build streams array
  const streams: StreamEntry[] = [];

  // Always write to file
  rotateIfNeeded();
  streams.push({
    level,
    stream: pino.destination({
      dest: LOG_FILE,
      sync: false, // Async for performance
      mkdir: true,
    }),
  });

  // Optionally pretty-print to stderr (dev mode)
  // Uses pino.transport() for ESM compatibility
  if (pretty) {
    streams.push({
      level,
      stream: pino.transport({
        target: 'pino-pretty',
        options: {
          destination: 2, // stderr
          colorize: true,
          translateTime: 'HH:MM:ss',
          ignore: 'pid,hostname',
        },
      }) as DestinationStream,
    });
  }

  return pino(
    {
      level,
      base: { pid: process.pid },
      timestamp: pino.stdTimeFunctions.isoTime,
      // Serialize errors properly
      serializers: {
        err: pino.stdSerializers.err,
      },
    },
    pino.multistream(streams),
  );
}

// ─── Singleton ─────────────────────────────────────────────────────────────

let _logger: pino.Logger | null = null;

function getLogger(): pino.Logger {
  if (!_logger) {
    _logger = createLogger();

    // Rotate check on interval (every 60s) for long-running processes
    const rotateInterval = setInterval(() => {
      rotateIfNeeded();
    }, 60_000);
    rotateInterval.unref(); // Don't keep process alive

    // Flush on exit
    process.on('beforeExit', () => {
      _logger?.flush();
    });
  }
  return _logger;
}

// ─── Exported Logger ───────────────────────────────────────────────────────

/**
 * Global logger instance.
 *
 * @example
 * logger.info({ repo: 'MyApp' }, 'Indexing started');
 * logger.error({ err, context: 'db' }, 'Query failed');
 *
 * // Child logger for a subsystem
 * const dbLog = logger.child({ context: 'lbug' });
 * dbLog.warn('Connection pool exhausted');
 */
export const logger: Logger = {
  trace: (ctxOrMsg: LogContext | string, msg?: string) => {
    const l = getLogger();
    if (typeof ctxOrMsg === 'string') l.trace(ctxOrMsg);
    else l.trace(ctxOrMsg, msg!);
  },
  debug: (ctxOrMsg: LogContext | string, msg?: string) => {
    const l = getLogger();
    if (typeof ctxOrMsg === 'string') l.debug(ctxOrMsg);
    else l.debug(ctxOrMsg, msg!);
  },
  info: (ctxOrMsg: LogContext | string, msg?: string) => {
    const l = getLogger();
    if (typeof ctxOrMsg === 'string') l.info(ctxOrMsg);
    else l.info(ctxOrMsg, msg!);
  },
  warn: (ctxOrMsg: LogContext | string, msg?: string) => {
    const l = getLogger();
    if (typeof ctxOrMsg === 'string') l.warn(ctxOrMsg);
    else l.warn(ctxOrMsg, msg!);
  },
  error: (ctxOrMsg: LogContext | string, msg?: string) => {
    const l = getLogger();
    if (typeof ctxOrMsg === 'string') l.error(ctxOrMsg);
    else l.error(ctxOrMsg, msg!);
  },
  fatal: (ctxOrMsg: LogContext | string, msg?: string) => {
    const l = getLogger();
    if (typeof ctxOrMsg === 'string') l.fatal(ctxOrMsg);
    else l.fatal(ctxOrMsg, msg!);
  },
  child: (bindings: LogContext): Logger => {
    const childPino = getLogger().child(bindings);
    // Return a new logger instance wrapping the child
    return {
      trace: (ctxOrMsg: LogContext | string, msg?: string) => {
        if (typeof ctxOrMsg === 'string') childPino.trace(ctxOrMsg);
        else childPino.trace(ctxOrMsg, msg!);
      },
      debug: (ctxOrMsg: LogContext | string, msg?: string) => {
        if (typeof ctxOrMsg === 'string') childPino.debug(ctxOrMsg);
        else childPino.debug(ctxOrMsg, msg!);
      },
      info: (ctxOrMsg: LogContext | string, msg?: string) => {
        if (typeof ctxOrMsg === 'string') childPino.info(ctxOrMsg);
        else childPino.info(ctxOrMsg, msg!);
      },
      warn: (ctxOrMsg: LogContext | string, msg?: string) => {
        if (typeof ctxOrMsg === 'string') childPino.warn(ctxOrMsg);
        else childPino.warn(ctxOrMsg, msg!);
      },
      error: (ctxOrMsg: LogContext | string, msg?: string) => {
        if (typeof ctxOrMsg === 'string') childPino.error(ctxOrMsg);
        else childPino.error(ctxOrMsg, msg!);
      },
      fatal: (ctxOrMsg: LogContext | string, msg?: string) => {
        if (typeof ctxOrMsg === 'string') childPino.fatal(ctxOrMsg);
        else childPino.fatal(ctxOrMsg, msg!);
      },
      child: (b: LogContext) => logger.child({ ...bindings, ...b }),
      get level() {
        return childPino.level as LogLevel;
      },
      set level(l: LogLevel) {
        childPino.level = l;
      },
      flush: () => childPino.flush(),
    };
  },
  get level() {
    return getLogger().level as LogLevel;
  },
  set level(l: LogLevel) {
    getLogger().level = l;
  },
  flush: () => getLogger().flush(),
};

// ─── Subsystem Loggers (pre-configured children) ───────────────────────────

/** Database operations logger */
export const dbLogger = logger.child({ context: 'db' });

/** MCP server logger */
export const mcpLogger = logger.child({ context: 'mcp' });

/** Ingestion pipeline logger */
export const pipelineLogger = logger.child({ context: 'pipeline' });

/** Worker pool logger */
export const workerLogger = logger.child({ context: 'worker' });

/** CLI command logger */
export const cliLogger = logger.child({ context: 'cli' });

/** Rename operations logger */
export const renameLogger = logger.child({ context: 'rename' });

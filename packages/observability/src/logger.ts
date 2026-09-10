import { redact } from './redaction.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface LogRecord {
  readonly level: LogLevel;
  readonly time: string;
  readonly message: string;
  readonly context: Readonly<Record<string, unknown>>;
}

export type LogSink = (record: LogRecord) => void;

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  /** Returns a logger that adds `bindings` to every record it emits. */
  child(bindings: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  readonly level: LogLevel;
  readonly sink: LogSink;
  readonly bindings?: Record<string, unknown>;
  readonly now?: () => Date;
}

/**
 * Structured JSON logger with mandatory redaction.
 *
 * There is deliberately no "raw" escape hatch: every context object passes
 * through `redact` before it reaches the sink, including the bindings attached
 * by `child`. A developer cannot opt out of redaction by accident, and a
 * reviewer does not have to check each call site for leaked secrets.
 */
export function createLogger(options: LoggerOptions): Logger {
  const { level, sink, bindings = {}, now = () => new Date() } = options;
  const threshold = LEVEL_ORDER[level];

  function emit(recordLevel: LogLevel, message: string, context?: Record<string, unknown>): void {
    if (LEVEL_ORDER[recordLevel] < threshold) return;
    const merged = { ...bindings, ...(context ?? {}) };
    sink({
      level: recordLevel,
      time: now().toISOString(),
      message,
      context: redact(merged) as Record<string, unknown>,
    });
  }

  return {
    debug: (m, c) => emit('debug', m, c),
    info: (m, c) => emit('info', m, c),
    warn: (m, c) => emit('warn', m, c),
    error: (m, c) => emit('error', m, c),
    child: (extra) => createLogger({ level, sink, bindings: { ...bindings, ...extra }, now }),
  };
}

/** Writes one JSON object per line — the shape log shippers expect. */
export const stdoutJsonSink: LogSink = (record) => {
  process.stdout.write(`${JSON.stringify(record)}\n`);
};

/**
 * The same JSON, on stderr.
 *
 * Used for FATAL startup failure only (see apps/api/src/main.ts). Ordinary logs
 * belong on stdout, where a log shipper reads them; a process that dies before
 * it can serve anything is a different kind of message, and an operator running
 * the binary by hand — or an orchestrator capturing a crash — looks at stderr
 * for it. Same shape, same mandatory redaction, different stream.
 */
export const stderrJsonSink: LogSink = (record) => {
  process.stderr.write(`${JSON.stringify(record)}\n`);
};

/** Collects records in memory. Used by tests to assert on what was logged. */
export function createMemorySink(): { sink: LogSink; records: LogRecord[] } {
  const records: LogRecord[] = [];
  return { sink: (r) => void records.push(r), records };
}

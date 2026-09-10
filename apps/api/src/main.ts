import { createLogger, stderrJsonSink, stdoutJsonSink } from '@edu/observability';
import { loadConfig } from './platform/config.ts';
import { buildApp } from './app.ts';

/**
 * Process entry point. Kept separate from `app.ts` so that tests can build the
 * application without binding a socket or installing signal handlers.
 *
 * ---------------------------------------------------------------------------
 * EVERYTHING HERE GOES THROUGH THE REDACTING LOGGER (Task 016)
 * ---------------------------------------------------------------------------
 *
 * This file used `console.warn` and `console.error` for boot, shutdown and
 * startup failure. Three problems, in increasing order of seriousness:
 *
 *   1. Those lines are not JSON, so a log shipper that parses every other line
 *      of this application's output drops or mangles exactly the lines that say
 *      whether it started.
 *   2. They carry no level and no timestamp, so they cannot be filtered or
 *      correlated with anything.
 *   3. `console.error('Failed to start:', error)` PRINTS A RAW ERROR. The most
 *      likely startup failure is the database refusing a connection, and a
 *      `pg` connection error carries the connection string — which carries the
 *      password. The redacting logger in @edu/observability exists precisely so
 *      that no context object reaches a sink unredacted, and there was one file
 *      going around it: the one that runs first.
 *
 * Only the message is logged for a startup failure, never the error object, and
 * the message goes through `redact` like everything else.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: config.LOG_LEVEL, sink: stdoutJsonSink });
  const { app, db } = await buildApp({ config, logger });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    // A second SIGTERM during a drain must not start a second drain: closing an
    // already-closing server races the pool shutdown and turns a clean rolling
    // deploy into dropped in-flight requests.
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });
    try {
      // Stop accepting connections first, then drain the pool. The other order
      // kills in-flight requests.
      await app.close();
      await db.close();
      logger.info('shutdown complete');
      process.exit(0);
    } catch (error) {
      logger.error('shutdown failed', {
        reason: error instanceof Error ? error.message : 'unknown',
      });
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: config.PORT, host: config.HOST });
  logger.info('listening', { host: config.HOST, port: config.PORT, environment: config.NODE_ENV });
}

main().catch((error: unknown) => {
  // The MESSAGE, never the error object: a driver error carries the connection
  // string, and a connection string carries the password. The logger redacts as
  // well, so this is two layers rather than one.
  // stderr, not stdout: a process that dies before it can serve anything is not
  // an ordinary log line, and an operator running the binary by hand — or an
  // orchestrator capturing a crash — looks at stderr for it.
  const logger = createLogger({ level: 'error', sink: stderrJsonSink });
  logger.error('failed to start', {
    reason: error instanceof Error ? error.message : 'unknown',
  });
  process.exit(1);
});

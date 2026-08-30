import { loadConfig } from './platform/config.js';
import { buildApp } from './app.js';

/**
 * Process entry point. Kept separate from `app.ts` so that tests can build the
 * application without binding a socket or installing signal handlers.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const { app, db } = await buildApp({ config });

  const shutdown = async (signal: string): Promise<void> => {
    console.warn(`Received ${signal}, shutting down...`);
    try {
      // Stop accepting connections first, then drain the pool. The other order
      // kills in-flight requests.
      await app.close();
      await db.close();
      process.exit(0);
    } catch (error) {
      console.error('Error during shutdown', error);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: config.PORT, host: config.HOST });
  console.warn(`API listening on ${config.HOST}:${config.PORT}`);
}

main().catch((error: unknown) => {
  console.error('Failed to start:', error instanceof Error ? error.message : error);
  process.exit(1);
});

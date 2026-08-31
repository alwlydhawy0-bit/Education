import { afterAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { request } from 'node:http';
import { resolve } from 'node:path';
import { TEST_APP_URL } from '../setup/env.ts';

/**
 * Boot smoke test.
 *
 * Every other test in this repository builds the app in-process via `buildApp`.
 * That is fast and precise, but it never exercises `main.ts`, never resolves
 * modules the way Node does at runtime, and never binds a socket.
 *
 * Task 001 shipped an API that could not start: relative imports carried `.js`
 * extensions, which Node's type stripping does not rewrite, so `pnpm start`
 * failed with ERR_MODULE_NOT_FOUND. All 208 tests passed anyway, because Vitest
 * resolved those specifiers through a plugin. A green suite over an application
 * that cannot boot is the failure mode this test exists to prevent.
 */
const ROOT = resolve(import.meta.dirname, '../..');
const PORT = 3247;

let server: ChildProcess | null = null;

function get(path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, reject) => {
    const req = request(
      { host: '127.0.0.1', port: PORT, path, method: 'GET', timeout: 5_000 },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += String(chunk)));
        res.on('end', () => resolvePromise({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

async function waitForServer(attempts = 60): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await get('/api/v1/health');
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error('server did not become ready');
}

afterAll(() => {
  server?.kill('SIGTERM');
});

describe('the API process starts and serves requests', () => {
  it('boots main.ts, binds a port and answers /health', async () => {
    const output: string[] = [];

    server = spawn(process.execPath, ['--experimental-strip-types', 'apps/api/src/main.ts'], {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'development',
        DATABASE_URL: TEST_APP_URL,
        HOST: '127.0.0.1',
        PORT: String(PORT),
        SESSION_COOKIE_SECURE: 'false',
        ALLOWED_ORIGINS: 'http://localhost:5173',
        LOG_LEVEL: 'info',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout?.on('data', (chunk) => output.push(String(chunk)));
    server.stderr?.on('data', (chunk) => output.push(String(chunk)));

    try {
      await waitForServer();
    } catch (error) {
      // Surface the child's output; otherwise a boot failure is an opaque timeout.
      throw new Error(`Server failed to start.\n${output.join('')}\n${String(error)}`);
    }

    const health = await get('/api/v1/health');
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toEqual({ status: 'ok' });
  });

  it('enforces authentication on a protected route in the real process', async () => {
    const response = await get('/api/v1/notes');
    expect(response.status).toBe(401);
  });

  it('refuses to start when required configuration is missing', async () => {
    // Fail-fast configuration is a security control: a server that boots without
    // DATABASE_URL would be running in an undefined state.
    const result = await new Promise<{ code: number | null; stderr: string }>((done) => {
      const child = spawn(
        process.execPath,
        ['--experimental-strip-types', 'apps/api/src/main.ts'],
        {
          cwd: ROOT,
          env: { PATH: process.env['PATH'] ?? '', NODE_ENV: 'development' },
          stdio: ['ignore', 'ignore', 'pipe'],
        },
      );
      let stderr = '';
      child.stderr?.on('data', (chunk) => (stderr += String(chunk)));
      child.on('close', (code) => done({ code, stderr }));
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/DATABASE_URL/);
  });
});

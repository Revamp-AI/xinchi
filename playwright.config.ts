import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// Focus only answers requests whose Host is 127.0.0.1:3210 (lib/auth.mjs), so
// the smoke test has to run its own server on that exact origin.
const port = 3210;
export const baseURL = `http://127.0.0.1:${port}`;
export const ownerEmail = 'owner@example.com';

// One fresh, isolated data directory per run. The main Playwright process
// picks it and publishes it through the environment so that the web server,
// global setup, and every worker process (which re-evaluates this file) agree
// on the same location. Nothing here ever touches the real data/ directory.
export const dataDir =
  process.env.FOCUS_E2E_DATA_DIR ??
  (process.env.FOCUS_E2E_DATA_DIR = path.join(
    os.tmpdir(),
    `focus-e2e-${process.pid}`,
  ));
export const storageState = path.join(dataDir, 'storage-state.json');

function portInUse(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

// Fail before the build starts when the owner's app already holds the port.
// Playwright would refuse the port as well (reuseExistingServer is false), but
// its hint to reuse the running server must never be followed for Focus: the
// suite has to run against the isolated data directory above.
if (
  !process.env.TEST_WORKER_INDEX &&
  !process.argv.includes('--list') &&
  (await portInUse())
) {
  throw new Error(
    `Port ${port} is already in use. Focus binds to ${baseURL}, and the smoke ` +
      'test starts its own server there against a temporary data directory; ' +
      'it never attaches to a running app. Stop the app on that port, then ' +
      'run npm run test:e2e again.',
  );
}

export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  outputDir: path.join(dataDir, 'results'),
  reporter: 'list',
  forbidOnly: !!process.env.CI,
  retries: 0,
  use: {
    baseURL,
    storageState,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'desktop-chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile-chromium',
      use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } },
    },
  ],
  webServer: {
    command: 'npm run build && npm start',
    url: baseURL,
    reuseExistingServer: false,
    timeout: 300_000,
    env: { XIN_DATA_DIR: dataDir, XIN_ALLOWED_EMAIL: ownerEmail },
  },
});

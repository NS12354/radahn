import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

/**
 * End-to-end tests drive the real app in Chromium: studio, 3D modeler,
 * device IDE windows, the emulators and the dev-server APIs.
 * Locally, point FF_CHROMIUM at any Chromium build to skip the download;
 * otherwise run `npx playwright install chromium` once.
 */
const PORT = 5174;
export default defineConfig({
  testDir: 'e2e',
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1, // the emulators are CPU-heavy; run one at a time
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}/`,
    viewport: { width: 1400, height: 880 },
    trace: 'retain-on-failure',
    launchOptions: { executablePath: process.env.FF_CHROMIUM || undefined, args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] },
  },
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { FF_ALLOW_LOCAL_FETCH: '1', CLAUDE_PATH: fileURLToPath(new URL('./e2e/fixtures/fake-claude.mjs', import.meta.url)), FF_WORKSPACES: path.join(os.tmpdir(), 'formframe-e2e-workspaces') },
  },
});

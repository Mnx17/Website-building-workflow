import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env['E2E_PORT'] ?? 3210);
const baseURL = `http://127.0.0.1:${PORT}`;

/**
 * Escape hatch for environments that ship a Chromium build Playwright did not
 * download itself (a preinstalled image, an air-gapped runner). CI leaves this
 * unset and uses `playwright install` as normal.
 */
const executablePath = process.env['PLAYWRIGHT_CHROMIUM_PATH'];
const launchOptions = executablePath ? { launchOptions: { executablePath } } : {};

/**
 * E2E runs against a production build, not `next dev`.
 *
 * The dev server behaves differently enough around RSC, caching and dynamic
 * rendering that a suite passing there can still fail in production — which is
 * precisely the failure this suite exists to catch.
 */
export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  testMatch: '**/*.spec.ts',
  fullyParallel: false, // one database, shared stock
  workers: 1,
  retries: process.env['CI'] ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env['CI'] ? 'line' : 'list',

  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], ...launchOptions } },
    // Mobile viewport: this market is mobile-heavy, and the checkout form's
    // layout is the part most likely to break narrow.
    { name: 'mobile', use: { ...devices['Pixel 5'], ...launchOptions } },
  ],

  webServer: {
    command: `npx next start -p ${PORT}`,
    url: baseURL,
    reuseExistingServer: !process.env['CI'],
    timeout: 120_000,
    env: {
      PAYMENT_PROVIDER: 'mock',
      // `next start` sets NODE_ENV=production, and the mock provider refuses to
      // run there by design so a misconfigured deploy cannot accept unsigned
      // payments. The suite opts in explicitly — which is also a live check
      // that the guard is doing its job.
      ALLOW_MOCK_PAYMENTS: 'true',
      MOCK_WEBHOOK_SECRET: process.env['MOCK_WEBHOOK_SECRET'] ?? 'mock-webhook-secret',
      SUPABASE_JWT_SECRET: process.env['SUPABASE_JWT_SECRET'] ?? 'e2e-jwt-secret',
      DATABASE_URL: process.env['DATABASE_URL'] ?? '',
    },
  },
});

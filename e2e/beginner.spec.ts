import { test, expect } from '@playwright/test';
import { home, errors } from './helpers';

test('beginners: the coach says what to do next, and Run works from any tab', async ({ page }) => {
  const errs = errors(page);
  await home(page);
  await page.click('#hRobots button[data-k="rover-line"]');
  await page.waitForFunction(() => !!(window as any).formframe?.projectId);
  // simple mode by default: expert tabs and tools are hidden
  await expect(page.locator('body')).toHaveClass(/simple/);
  await expect(page.locator('#modes [data-m=github]')).toBeHidden();
  await expect(page.locator('#coach')).toContainText('Press ▶ Run');
  // Show me highlights the Run button
  await page.click('#coachShow');
  await expect(page.locator('#bRunTop')).toHaveClass(/coach-pulse/);
  // Run from the Design tab: the code runs and the robot drives, without leaving Design
  await page.click('#bRunTop');
  await expect(page.locator('#bRunTop')).toHaveText('■ Stop');
  await expect(page.locator('#modes [data-m=design]')).toHaveClass(/on/);
  await expect.poll(() => page.evaluate(() => (globalThis as any).__robot?.().body.z ?? 0), { timeout: 60_000 }).toBeGreaterThan(100);
  await expect(page.locator('#coach')).toContainText('Watch it move', { timeout: 10_000 });
  await page.click('#bRunTop');
  await expect(page.locator('#bRunTop')).toHaveText('▶ Run');
  // Advanced shows everything
  await page.check('#bAdvanced');
  await expect(page.locator('#modes [data-m=github]')).toBeVisible();
  expect(errs).toEqual([]);
});

test('photo mode and quality controls are in the 3D view', async ({ page }) => {
  await home(page);
  await page.click('#hRobots button[data-k="arm"]');
  await page.waitForFunction(() => !!(window as any).formframe?.projectId);
  await expect(page.locator('#vpPhoto')).toBeVisible();
  await page.click('#vpQuality');
  await expect(page.locator('#vpQuality')).toContainText('Fast');
  await page.click('#vpQuality');
  await expect(page.locator('#vpQuality')).toContainText('High quality');
});

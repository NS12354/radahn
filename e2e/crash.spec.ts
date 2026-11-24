import { test, expect } from '@playwright/test';
import { home, errors } from './helpers';

test('crash test: a robot dog dropped from 1 m strips its servo gears; Repair puts it right', async ({ page }) => {
  const errs = errors(page);
  await home(page);
  await page.click('#hRobots button[data-k="dog"]');
  await page.waitForFunction(() => !!(window as any).formframe?.projectId);
  await page.click('#modes [data-m=review]');
  await expect(page.locator('#secCrash')).toContainText('Crash test');
  await page.fill('#crH', '1000'); await page.press('#crH', 'Tab');
  await page.click('#crRun');
  await page.click('#crSkip');
  await expect(page.locator('.crsum')).toContainText('broke', { timeout: 60_000 });
  await expect(page.locator('.crrow.broken').first()).toContainText('gears strip');
  // the damage is saved on the model
  expect(await page.evaluate(() => Object.keys((window as any).formframe.project.product.built.damage ?? {}).length)).toBeGreaterThan(0);
  await page.click('#crDone');
  await page.click('#crFix');
  expect(await page.evaluate(() => (window as any).formframe.project.product.built.damage)).toBeUndefined();
  expect(errs).toEqual([]);
});

test('crash test needs a built model: the parametric thermostat points to Auto build', async ({ page }) => {
  await home(page);
  await page.click('#hExample b');
  await page.waitForFunction(() => !!(window as any).formframe?.projectId);
  await page.click('#modes [data-m=review]');
  await expect(page.locator('#secCrash')).toContainText('Auto build');
});

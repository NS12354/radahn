import { test, expect } from '@playwright/test';
import { newProject, mode, errors } from './helpers';

// The Home / Set temp / Eco / Away interaction prototype belongs to the thermostat example only.
test('blank projects have no thermostat state machine', async ({ page }) => {
  const errs = errors(page);
  await newProject(page, 'blank');
  await expect(page.locator('#modes [data-m=proto]')).toBeHidden();
  await expect(page.locator('#graphwrap')).toBeHidden();
  await expect(page.locator('#statebadge')).toBeHidden();
  // nothing visible anywhere mentions the thermostat, including the Project menu
  for (const m of ['design', 'elec', 'review'] as const) {
    await mode(page, m);
    await page.click('#bMenu');
    const text = await page.evaluate(() => document.body.innerText);
    expect(text).not.toMatch(/thermostat|Set temp|\bEco\b/i);
    await page.keyboard.press('Escape'); await page.mouse.click(5, 300);
  }
  expect(errs).toEqual([]);
});

test('the thermostat example keeps its state machine', async ({ page }) => {
  await newProject(page, 'example');
  await expect(page.locator('#modes [data-m=proto]')).toBeVisible();
  await mode(page, 'proto');
  await expect(page.locator('#graphwrap')).toBeVisible();
  await expect(page.locator('#graph')).toContainText('Set temp');
  await expect(page.locator('#screenList')).toContainText('Eco');
});

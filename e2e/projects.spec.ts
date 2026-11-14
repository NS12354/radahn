import { test, expect } from '@playwright/test';
import { home, newProject, mode, errors } from './helpers';

test('blank project: no model, no parts, an empty starter file', async ({ page }) => {
  const errs = errors(page);
  await newProject(page, 'blank');
  await expect(page.locator('#pname')).toHaveValue('Untitled project');
  await expect(page.locator('#vpEmpty')).toBeVisible();
  await mode(page, 'elec');
  await expect(page.locator('#code')).toHaveValue(/print\("ready"\)/);
  await page.click('#libList button[data-t=button]');
  await expect(page.locator('#code')).not.toHaveValue(/thermostat/i); // adding parts keeps the blank starter
  expect(errs).toEqual([]);
});

test('home screen lists, duplicates, deletes and keeps projects across reloads', async ({ page }) => {
  await newProject(page, 'blank');
  await page.fill('#pname', 'My widget');
  await page.click('#bHome');
  await page.click('#hExample b');
  await page.click('#bHome');
  const names = page.locator('.pcard .pi b');
  await expect(names).toHaveText(['Thermostat concept', 'My widget']);
  await page.locator('.pcard').first().hover();
  await page.locator('.pcard').first().locator('[data-x=dup]').click();
  await expect(names).toHaveCount(3);
  await page.locator('.pcard', { hasText: 'Thermostat concept copy' }).hover();
  await page.locator('.pcard', { hasText: 'Thermostat concept copy' }).locator('[data-x=del]').click();
  await expect(names).toHaveCount(2);
  await page.reload();
  await expect(names).toHaveText(['Thermostat concept', 'My widget']);
});

test('tutorial walks every step and returns home without saving a project', async ({ page }) => {
  await home(page);
  await page.click('#hTour');
  await expect(page.locator('#tour .tcard')).toBeVisible();
  for (let i = 0; i < 13; i++) await page.click('#tour [data-t=next]');
  await expect(page.locator('#home')).toBeVisible();
  await expect(page.locator('.pcard')).toHaveCount(0);
});

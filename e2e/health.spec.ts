import { test, expect } from '@playwright/test';
import { newProject, mode, errors } from './helpers';

test.describe('Is it working?', () => {
  test('Test it runs the example, exercises every input and turns the light green', async ({ page }) => {
    const errs = errors(page);
    await newProject(page, 'example');
    await expect(page.locator('#bHealth')).toHaveText('Not tested yet');
    await page.click('#bHealth');
    await page.click('#bTest');
    await expect(page.locator('#ptest')).toContainText('Test results', { timeout: 150_000 });
    const rows = page.locator('#ptest .ptr');
    await expect(rows.filter({ hasText: 'Your code is running' })).toHaveClass(/ok/);
    await expect(rows.filter({ hasText: 'Turning the dial changes' })).toHaveClass(/ok/);
    await expect(rows.filter({ hasText: 'The display is getting signals' })).toHaveClass(/ok/);
    await expect(rows.filter({ hasText: 'No errors while running' })).toHaveClass(/ok/);
    await expect(page.locator('#bHealth')).toHaveText('Working');
    expect(errs).toEqual([]);
  });

  test('a typo is caught, explained with a suggestion, and Show line selects it', async ({ page }) => {
    await newProject(page, 'example');
    await mode(page, 'elec');
    await page.evaluate(() => { const ta = document.querySelector('#code') as HTMLTextAreaElement; ta.value = ta.value.replace('print("thermostat ready")', 'pritn("thermostat ready")'); ta.dispatchEvent(new Event('input')); });
    await page.click('#bRun');
    await expect(page.locator('#bHealth')).toHaveText('1 thing broken', { timeout: 60_000 });
    await page.click('#bHealth');
    const card = page.locator('#plist .pcard2.bad').first();
    await expect(card.locator('.pt')).toHaveText(/Line \d+ uses pritn, which doesn't exist/);
    await expect(card.locator('.pf')).toContainText('Did you mean print');
    await card.locator('button', { hasText: 'Show line' }).click();
    expect(await page.evaluate(() => { const ta = document.querySelector('#code') as HTMLTextAreaElement; return ta.value.slice(ta.selectionStart, ta.selectionEnd); })).toBe('pritn("thermostat ready")');
    // editing the code clears the stale error
    await page.evaluate(() => { const ta = document.querySelector('#code') as HTMLTextAreaElement; ta.value = ta.value.replace('pritn(', 'print('); ta.dispatchEvent(new Event('input')); });
    await expect(page.locator('#plist .pcard2.bad')).toHaveCount(0);
  });

  test('two parts on one pin are flagged and Fix it moves one to a free pin', async ({ page }) => {
    await newProject(page, 'example');
    await mode(page, 'elec');
    const clk = await page.locator('.card:has-text("Rotary encoder") select[data-role=CLK]').inputValue();
    await page.locator('.card:has-text("Push button") select[data-role=SIG]').selectOption(clk);
    await expect(page.locator('#bHealth')).toHaveText(/broken/);
    await page.click('#bHealth');
    await page.locator('#plist .pcard2.bad', { hasText: 'same pin' }).locator('button', { hasText: 'Move to a free pin' }).click();
    await expect(page.locator('#plist .pcard2', { hasText: 'same pin' })).toHaveCount(0);
    expect(await page.locator('.card:has-text("Push button") select[data-role=SIG]').inputValue()).not.toBe(clk);
  });
});

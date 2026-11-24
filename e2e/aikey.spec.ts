import { test, expect } from '@playwright/test';
import { newProject, mode, errors } from './helpers';

// AI access on a hosted site: the site's access code, or the visitor's own Anthropic key.
// The server side is unit-tested (tests/hosted.test.ts); here its answers are stubbed.
test('an AI feature asks for access, and a visitor can use their own Anthropic key', async ({ page }) => {
  const errs = errors(page);
  let saved = false;
  await page.route('**/api/ai-key', async r => {
    if (r.request().method() === 'GET') return r.fulfill({ json: { ownKey: saved, hint: saved ? 'sk-ant-api…abcd' : null, ownerKey: true } });
    const body = r.request().postDataJSON();
    if (body.remove) { saved = false; return r.fulfill({ json: { ownKey: false } }); }
    if (body.key === 'sk-ant-bad') return r.fulfill({ status: 400, json: { error: 'Anthropic says that key isn’t valid. Check you copied all of it.' } });
    saved = true; return r.fulfill({ json: { ownKey: true, hint: 'sk-ant-api…abcd' } });
  });
  await page.route('**/api/plan', r => saved
    ? r.fulfill({ json: { summary: 'Ran on your own key.', nextStep: 'Keep going.', taskUpdates: [], completed: [], suggestions: [], risks: [] } })
    : r.fulfill({ status: 401, json: { error: 'This feature needs the access code or your own Anthropic API key.', needCode: true } }));

  await newProject(page, 'example');
  await mode(page, 'plan');
  await page.click('#plAiBtn');
  const dlg = page.locator('dialog.ffcode');
  await expect(dlg).toContainText('Enter the site’s access code, or use your own Anthropic API key');
  await dlg.locator('.fftabs button', { hasText: 'Your own API key' }).click();
  await dlg.locator('input').fill('sk-ant-bad'); await dlg.locator('button[value=ok]').click();
  await expect(dlg.locator('.fferr')).toContainText('isn’t valid');
  await dlg.locator('input').fill('sk-ant-api03-good'); await dlg.locator('button[value=ok]').click();
  await expect(dlg).toHaveCount(0);
  await expect(page.locator('#plAi')).toContainText('Ran on your own key');
  // the key never lands in the page's storage
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('sk-ant');

  // Project menu: see and remove it
  await page.click('#bMenu'); await page.click('#menu [data-a=aikey]');
  await expect(dlg.locator('.ffkey')).toContainText('sk-ant-api…abcd');
  await dlg.locator('#ffRemove').click();
  await expect(dlg.locator('.ffkey')).toHaveCount(0);
  await dlg.locator('button[value=cancel]').click();
  expect(saved).toBe(false);
  expect(errs).toEqual([]);
});

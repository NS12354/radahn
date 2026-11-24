import { test, expect } from '@playwright/test';
import { newProject, mode, errors } from './helpers';

// The test server runs e2e/fixtures/fake-claude.mjs in place of the real `claude` CLI.
test('Claude Code terminal in Electronics edits the project files both ways', async ({ page }) => {
  const errs = errors(page);
  await newProject(page, 'example');
  await mode(page, 'elec');
  await page.click('#tabClaude');
  await expect(page.locator('#claudePane')).toBeVisible();
  await expect(page.locator('#clStatus')).toHaveText('Claude Code is running');
  const screen = page.locator('#claudeTerm .xterm-rows');
  await expect(screen).toContainText('FAKE CLAUDE ready');
  await expect(screen).toContainText('board: Raspberry Pi Pico'); // CLAUDE.md describes the board
  // Claude creates a file → it appears as a tab in the studio
  await page.locator('#claudeTerm').click();
  await page.keyboard.type('please add a helper'); await page.keyboard.press('Enter');
  await expect(page.locator('#fileTabs button', { hasText: 'lib/helper.py' })).toBeVisible();
  expect(await page.evaluate(() => (window as any).formframe.project.electronics.files['lib/helper.py'])).toContain('hi from claude');
  // an edit in the studio reaches Claude's folder
  await page.locator('#fileTabs button', { hasText: /^main\.py$/ }).click();
  await page.evaluate(() => { const ta = document.querySelector('#code') as HTMLTextAreaElement; ta.value = '# edited in studio\n' + ta.value; ta.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.waitForTimeout(800);
  await page.locator('#claudeTerm').click();
  await page.keyboard.type('what is in main'); await page.keyboard.press('Enter');
  await expect(screen).toContainText('main.py first line: # edited in studio');
  // logged in the Plan
  await mode(page, 'plan');
  await expect(page.locator('#plLog')).toContainText('Claude created lib/helper.py');
  expect(errs).toEqual([]);
});

test('Claude Code can rewire, and asks before adding hardware', async ({ page }) => {
  const errs = errors(page);
  await newProject(page, 'example');
  await mode(page, 'elec');
  await page.click('#tabClaude');
  const screen = page.locator('#claudeTerm .xterm-rows');
  await expect(screen).toContainText('FAKE CLAUDE ready');
  const say = async (t: string) => { await page.locator('#claudeTerm').click(); await page.keyboard.type(t); await page.keyboard.press('Enter'); };
  // a status question has no side effects, so if the terminal drops the keystrokes under load, just ask again
  const status = async (want: string) => {
    for (let i = 0; i < 3; i++) {
      await say('wiring status');
      try { await expect(screen).toContainText(want, { timeout: 6000 }); return; } catch { /* ask again */ }
    }
    await expect(screen).toContainText(want);
  };
  const comps = () => page.evaluate(() => (window as any).formframe.project.electronics.comps.map((c: any) => ({ type: c.type, pins: c.pins })));
  const before = (await comps()).length;
  await say('parts catalog');
  await expect(screen).toContainText('CATALOG HAS NEOPIXEL: true');

  // pin moves apply straight away
  await say('please move the button');
  await expect.poll(async () => (await comps()).find((c: any) => c.type === 'button')?.pins.SIG).toBe(7);
  await expect(page.locator('#clAsk')).toBeHidden();
  await status('STATUS: Applied: move Push button (to GND) SIG → GP7.');

  // new hardware waits for approval
  await say('please add an led');
  await expect(page.locator('#clAsk')).toBeVisible();
  await expect(page.locator('#clAsk')).toContainText('Add LED');
  expect((await comps()).length).toBe(before);
  await page.click('#clYes');
  await expect.poll(async () => (await comps()).some((c: any) => c.type === 'led' && c.pins.SIG === 20)).toBe(true);
  await expect(page.locator('#bench .card', { hasText: 'LED + 220' })).toBeVisible(); // on the bench
  await status('STATUS: Approved by the user and applied: add a LED');

  // declining leaves the bench alone and tells Claude
  await say('please add a servo');
  await expect(page.locator('#clAsk')).toContainText('Add SG90');
  await page.click('#clNo');
  await expect(page.locator('#clAsk')).toBeHidden();
  expect((await comps()).some((c: any) => c.type === 'servo')).toBe(false);
  await status('STATUS: The user declined: add a SG90');

  await mode(page, 'plan');
  await expect(page.locator('#plLog')).toContainText('Claude added a LED + 220 Ω (you approved)');
  await expect(page.locator('#plLog')).toContainText("You declined Claude's hardware change");
  expect(errs).toEqual([]);
});

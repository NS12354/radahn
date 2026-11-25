import { test, expect } from '@playwright/test';
import { home, mode, errors, newProject } from './helpers';

/** The wider parts catalog: add parts to a blank project and run the generated demo. */
test('an OLED and a 7-segment display run real MicroPython on the emulated Pico', async ({ page }) => {
  const errs = errors(page);
  await home(page);
  await page.selectOption('#homeBoard', 'picow');
  await page.click('#hBlank b');
  await page.waitForFunction(() => !!(window as any).formframe?.projectId);
  await mode(page, 'elec');
  await page.fill('#libFind', 'segment');
  await expect(page.locator('#libList button:visible')).toHaveCount(1);
  await page.fill('#libFind', '');
  for (const t of ['oled', 'tm1637']) await page.click(`#libList button[data-t="${t}"]`);
  // the starter program now demos both parts, with their drivers alongside
  await expect(page.locator('#fileTabs')).toContainText('lib/ssd1306.py');
  await page.click('#bRun');
  const state = (t: string) => page.evaluate(t => { const A = (window as any).formframe; const c = A.project.electronics.comps.find((x: any) => x.type === t); return A.bench.model(c.uid).state; }, t);
  await expect.poll(async () => (await state('oled')).on, { timeout: 45_000 }).toBe(true);
  await expect.poll(async () => (await state('tm1637')).text, { timeout: 30_000 }).toMatch(/^\d\d:\d\d$/);
  expect(errs).toEqual([]);
});

test('switching boards offers more than 20, grouped by family', async ({ page }) => {
  await home(page);
  const groups = await page.locator('#homeBoard optgroup').evaluateAll(gs => gs.map(g => g.getAttribute('label')));
  expect(groups).toEqual(['Raspberry Pi Pico & RP2040', 'Arduino', 'ESP32 & ESP8266', 'Raspberry Pi (Linux)']);
  expect(await page.locator('#homeBoard option').count()).toBeGreaterThanOrEqual(20);
});

test('removing a part in Electronics removes it from the 3D model too', async ({ page }) => {
  test.setTimeout(120_000);
  const errs = errors(page);
  await newProject(page, 'blank');
  await mode(page, 'elec');
  await page.click('#libList button[data-t="oled"]');
  await mode(page, 'design');
  await page.click('#bAutoBuild');
  const names = () => page.evaluate(() => (window as any).formframe.project.product.built?.parts.map((p: any) => p.name) ?? []);
  await expect.poll(async () => (await names()).filter((n: string) => /OLED/.test(n)).length).toBe(2); // the module and its window
  await mode(page, 'elec');
  await page.locator('#bench .x').last().click();
  await expect.poll(async () => (await names()).filter((n: string) => /OLED/.test(n)).length).toBe(0);
  expect((await names()).some((n: string) => /Pico/.test(n))).toBe(true); // the rest stays
  await expect.poll(() => page.evaluate(() => [...(window as any).formframe.product.roots.values()].filter((r: any) => /OLED/.test(r.userData.part?.name ?? '')).length)).toBe(0);
  expect(errs).toEqual([]);
});

test('added electronics appear in the 3D model to move, with no case until Auto build', async ({ page }) => {
  test.setTimeout(120_000);
  const errs = errors(page);
  await newProject(page, 'blank');
  const parts = () => page.evaluate(() => (window as any).formframe.project.product.built?.parts.map((p: any) => ({ name: p.name, comp: p.comp, parent: p.parent, pos: p.pos })) ?? []);
  // Auto build with nothing wired builds nothing
  await page.click('#eAuto');
  expect(await parts()).toEqual([]);
  await expect(page.locator('#vpEmpty')).toBeVisible();
  // add parts: they show up as parts, and no housing
  await mode(page, 'elec');
  await page.click('#libList button[data-t="button"]');
  await page.click('#libList button[data-t="oled"]');
  await mode(page, 'design');
  await expect.poll(async () => (await parts()).filter((p: any) => /OLED/.test(p.name)).length).toBeGreaterThan(0);
  const ps = await parts();
  expect(ps.some((p: any) => p.comp === 'board')).toBe(true);
  expect(ps.some((p: any) => /housing|front panel|shell/i.test(p.name))).toBe(false);
  await expect(page.locator('#vpEmpty')).toBeHidden();
  // select the display and move it with the inspector: its pieces move together
  const oled = ps.find((p: any) => /OLED/.test(p.name) && !p.parent)!;
  // it can be selected, so the Design handles move it
  await page.evaluate((n) => { const a = (window as any).formframe; a.selectPart(a.project.product.built.parts.find((p: any) => p.name === n && !p.parent).id); }, oled.name);
  await expect.poll(() => page.evaluate(() => (window as any).formframe.selected)).toBeTruthy();
  // Auto build now makes a case around them, laying the electronics out inside it (no duplicates)
  await page.click('#bAutoBuild');
  await expect.poll(async () => (await parts()).some((p: any) => /housing/i.test(p.name))).toBe(true);
  const after = await parts();
  expect(after.filter((p: any) => p.comp === after.find((q: any) => /OLED.*I2C/.test(q.name))?.comp && /I2C/.test(p.name)).length).toBe(1);
  expect(errs).toEqual([]);
});

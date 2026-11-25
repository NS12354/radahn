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
  await page.click('#vpEmpty button:has-text("Auto build")');
  const names = () => page.evaluate(() => (window as any).formframe.project.product.built?.parts.map((p: any) => p.name) ?? []);
  await expect.poll(async () => (await names()).filter((n: string) => /OLED/.test(n)).length).toBe(2); // the module and its window
  await mode(page, 'elec');
  await page.locator('#bench .x').last().click();
  await expect.poll(async () => (await names()).filter((n: string) => /OLED/.test(n)).length).toBe(0);
  expect((await names()).some((n: string) => /Pico/.test(n))).toBe(true); // the rest stays
  await expect.poll(() => page.evaluate(() => [...(window as any).formframe.product.roots.values()].filter((r: any) => /OLED/.test(r.userData.part?.name ?? '')).length)).toBe(0);
  expect(errs).toEqual([]);
});

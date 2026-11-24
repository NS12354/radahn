import { test, expect } from '@playwright/test';
import { home, errors } from './helpers';

const twin = (page: any) => page.evaluate(() => { const t = (globalThis as any).__scene?.(); return t ? t.robots.map((r: any) => ({ name: r.def.name, status: r.status, x: r.sim.body.m.elements[12], z: r.sim.body.m.elements[14] })) : null; });

test('scenes: several named robots in one world, run together, saved and reopened', async ({ page }) => {
  test.setTimeout(400_000);
  const errs = errors(page);
  await home(page);
  await page.click('#sceneGrid .scenenew');
  await expect(page.locator('#sceneWs')).toBeVisible();
  await page.fill('#swName', 'Cell 1');
  // an arm and two copies of one rover design
  const addTemplate = async (k: string) => { await page.click('#swAdd'); await page.click(`#swMenu button[data-k="${k}"]`); };
  await addTemplate('arm');
  await addTemplate('rover-avoid');
  await expect(page.locator('#swList .swr')).toHaveCount(2);
  await page.locator('#swList .swr.on [data-x="dup"]').click();
  await expect(page.locator('#swList .swr')).toHaveCount(3);
  // rename the selected copy
  const name = page.locator('#swList .swr.on input[data-f="name"]');
  await name.fill('Scout'); await name.press('Enter');
  await expect(page.locator('#swTags .swtagl', { hasText: 'Scout' })).toBeVisible();
  let rs = (await twin(page))!;
  expect(rs.map((r: any) => r.name)).toEqual(['Robot arm', 'Obstacle-avoiding rover', 'Scout']);
  expect(new Set(rs.map((r: any) => `${Math.round(r.x)},${Math.round(r.z)}`)).size).toBe(3); // each on its own spot
  // dispatch in the page: with several emulators running, the page answers slowly in headless (software GL) Chromium
  await page.evaluate(() => (document.querySelector('#swRunAll') as HTMLButtonElement).click());
  await expect.poll(async () => (await twin(page))!.filter((r: any) => r.status === 'running').length, { timeout: 120_000 }).toBe(3);
  await expect(page.locator('#swLog')).toContainText('Scout', { timeout: 60_000 }); // serial lines carry the robot's name
  await page.screenshot({ path: 'test-results/scene-running.png' });
  await page.evaluate(() => (document.querySelector('#swStopAll') as HTMLButtonElement).click());
  await expect.poll(async () => (await twin(page))!.every((r: any) => r.status === 'stopped')).toBe(true);
  // back home: the scene is listed, and reopening it brings the same robots back
  await page.click('#swHome');
  await expect(page.locator('#home')).toBeVisible();
  await expect(page.locator('#sceneGrid .pcard', { hasText: 'Cell 1' })).toContainText('3 robots');
  await page.locator('#sceneGrid .pcard', { hasText: 'Cell 1' }).click();
  await expect.poll(async () => (await twin(page))?.map((r: any) => r.name)).toEqual(['Robot arm', 'Obstacle-avoiding rover', 'Scout']);
  await expect(page.locator('#swList .swr')).toHaveCount(3);
  expect(errs).toEqual([]);
});

test('scenes: realistic physics puts every robot in one shared world, and is saved with the scene', async ({ page }) => {
  test.setTimeout(240_000);
  const errs = errors(page);
  await home(page);
  await page.click('#sceneGrid .scenenew');
  await page.fill('#swName', 'Physics cell');
  for (const k of ['arm', 'rover-avoid']) { await page.click('#swAdd'); await page.click(`#swMenu button[data-k="${k}"]`); }
  await expect(page.locator('#swList .swr')).toHaveCount(2);
  await page.selectOption('#swPhys', '1');
  const phys = () => page.evaluate(() => { const t = (globalThis as any).__scene?.(); return t?.physics ? { robots: t.physics.robots.length, shared: t.robots.every((r: any) => r.sim.phys?.pw === t.physics), blockY: t.objects[0]?.m.elements[13] } : null; });
  await expect.poll(async () => (await phys())?.robots, { timeout: 60_000 }).toBe(2);
  expect((await phys())!.shared).toBe(true);
  await page.waitForTimeout(1500);
  const y = (await phys())!.blockY;
  expect(y).toBeGreaterThan(8); expect(y).toBeLessThan(12); // the block rests on the floor
  await page.screenshot({ path: 'test-results/scene-physics.png' });
  await page.click('#swHome');
  await page.locator('#sceneGrid .pcard', { hasText: 'Physics cell' }).click();
  await expect.poll(async () => (await phys())?.robots, { timeout: 60_000 }).toBe(2);
  await expect(page.locator('#swPhys')).toHaveValue('1');
  expect(errs).toEqual([]);
});

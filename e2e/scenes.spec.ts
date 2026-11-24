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
  await expect(page.locator('#swList .swr')).toHaveCount(3);
  expect((await twin(page))!.map((r: any) => r.name)).toEqual(['Robot arm', 'Obstacle-avoiding rover', 'Scout']);
  expect(errs).toEqual([]);
});

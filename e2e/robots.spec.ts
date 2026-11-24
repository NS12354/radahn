import { test, expect } from '@playwright/test';
import { home, mode, errors } from './helpers';

const sim = (page: any) => page.evaluate(() => { const s = (globalThis as any).__robot?.(); return s ? { x: s.body.x, z: s.body.z, joints: s.joints.map((j: any) => ({ name: j.name, q: j.q, driven: j.driven })) } : null; });

test('robot arm: the firmware drives the joints through the PCA9685 (real MicroPython)', async ({ page }) => {
  const errs = errors(page);
  await home(page);
  await expect(page.locator('#hRobots button')).toHaveCount(5);
  await page.click('#hRobots button[data-k="arm"]');
  await page.waitForFunction(() => !!(window as any).formframe?.projectId);
  await expect(page.locator('#robotPanel')).toBeVisible();
  await expect(page.locator('#robotPanel .rpr')).toHaveCount(6);
  await mode(page, 'elec');
  await page.click('#bRun');
  await expect.poll(async () => (await sim(page))!.joints.find((j: any) => j.name === 'Upper arm').q, { timeout: 60_000 }).toBeGreaterThan(10);
  await expect(page.locator('#rpState')).toHaveText('firmware driving');
  expect(errs).toEqual([]);
});

test('robot arm: the firmware picks up the block and sets it on the pad; the block can be removed', async ({ page }) => {
  test.setTimeout(180_000);
  const errs = errors(page);
  await home(page);
  await page.click('#hRobots button[data-k="arm"]');
  await page.waitForFunction(() => !!(window as any).formframe?.projectId);
  const block = () => page.evaluate(() => { const s = (globalThis as any).__robot?.(); const o = s?.objects[0]; return o ? { x: o.m.elements[12], y: o.m.elements[13], z: o.m.elements[14], held: !!o.held } : null; });
  await mode(page, 'elec');
  await page.click('#bRun');
  await expect.poll(async () => (await block())?.held, { timeout: 120_000 }).toBe(true);
  await expect.poll(async () => { const b = await block(); return !!b && !b.held && b.x > 100; }, { timeout: 120_000 }).toBe(true);
  const b = (await block())!;
  expect(Math.abs(b.y - 14)).toBeLessThan(1.5); // resting on the 4 mm pad
  await page.screenshot({ path: 'test-results/arm-placed.png' });
  await page.click('#bRun'); // stop
  await page.locator('#robotPanel .rpobj', { hasText: 'Block' }).locator('.rpdel').click();
  await expect(page.locator('#robotPanel .rpobj')).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).formframe.project.product.built.robot.world.obstacles.some((o: any) => o.pick))).toBe(false);
  expect(await block()).toBeNull();
  await page.click('#rpAddBlock');
  await expect(page.locator('#robotPanel .rpobj', { hasText: 'Block' })).toHaveCount(1);
  expect(errs).toEqual([]);
});

test('line follower drives itself along the track', async ({ page }) => {
  await home(page);
  await page.click('#hRobots button[data-k="rover-line"]');
  await page.waitForFunction(() => !!(window as any).formframe?.projectId);
  await mode(page, 'elec');
  await page.click('#bRun');
  await expect.poll(async () => (await sim(page))!.z, { timeout: 60_000 }).toBeGreaterThan(200);
});

test('teach mode: sliders move joints, poses are recorded and go into the code', async ({ page }) => {
  await home(page);
  await page.click('#hRobots button[data-k="arm"]');
  await page.waitForFunction(() => !!(window as any).formframe?.projectId);
  const slider = page.locator('#robotPanel .rpr', { hasText: 'Upper arm' }).locator('input');
  await slider.fill('40');
  await expect.poll(async () => (await sim(page))!.joints.find((j: any) => j.name === 'Upper arm').q).toBeGreaterThan(39);
  await page.click('#rpRec');
  await slider.fill('-20');
  await page.click('#rpRec');
  await expect(page.locator('#robotPanel .rppose')).toHaveCount(2);
  await page.click('#rpIns');
  const code = await page.evaluate(() => (window as any).formframe.project.electronics.files['main.py']);
  expect(code).toMatch(/POSES = \[.*\n\s+\[0, 40, 0, 0, -90\],\s+# Pose 1\n\s+\[0, -20, 0, 0, -90\],\s+# Pose 2/);
});

test('any part can become a joint in the Design inspector', async ({ page }) => {
  await home(page);
  await page.click('#hRobots button[data-k="dog"]');
  await page.waitForFunction(() => !!(window as any).formframe?.projectId);
  await mode(page, 'design');
  await page.locator('#partList .item', { hasText: 'FL lower leg' }).click();
  await expect(page.locator('#bjType')).toHaveValue('revolute');
  await expect(page.locator('#bjDrive')).toHaveValue(/:2$/); // PCA9685 channel 2
  await expect(page.locator('#bjFoot')).not.toBeChecked();
});

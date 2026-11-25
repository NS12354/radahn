import { test, expect, type Page } from '@playwright/test';
import { home, errors } from './helpers';

/** Screen point of a floor point (world mm) in the robot's world. */
const scr = (page: Page, x: number, z: number) => page.evaluate(([x, z]) => {
  const a = (window as any).formframe, THREE_V = a.product.mm.localToWorld(a.product.mm.position.clone().set(x, 0, z));
  return a.viewport.project(THREE_V);
}, [x, z]);
/** Look at the whole floor from above-ish, so the test can reach it. */
const overview = (page: Page) => page.evaluate(() => { const v = (window as any).formframe.viewport; const t = v.controls.target; v.camera.position.set(t.x, t.y + 220, t.z + 140); v.controls.update(); });
const w = (page: Page) => page.evaluate(() => (window as any).formframe.project.product.built.robot.world);

test('a new box comes in with move handles, and moving it updates the world', async ({ page }) => {
  const errs = errors(page);
  await home(page);
  await page.click('#hRobots button[data-k="rover-avoid"]');
  await page.waitForFunction(() => !!(window as any).formframe?.projectId);
  const n = (await w(page)).obstacles.length;
  await page.click('#rpAddBox');
  await overview(page); await page.waitForTimeout(300);
  await expect(page.locator('#weBar')).toBeVisible();
  await expect(page.locator('#weName')).toHaveText('Cardboard box');
  await expect.poll(() => page.evaluate(() => !!(globalThis as any).__worldGizmo())).toBe(true);
  // drag the box itself to move it
  const o = (await w(page)).obstacles[n];
  const a = await scr(page, o.pos[0] + 40, o.pos[1] + 40), b = await scr(page, o.pos[0] + 190, o.pos[1] + 40); // on the box, off the handles' centre
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 8 }); await page.mouse.up();
  await expect.poll(async () => (await w(page)).obstacles[n].pos[0]).toBeGreaterThan(o.pos[0] + 60);
  // Resize, then Delete
  await page.click('#weMode [data-g=scale]');
  await expect(page.locator('#weMode [data-g=scale]')).toHaveClass(/on/);
  await page.click('#weDel');
  await expect.poll(async () => (await w(page)).obstacles.length).toBe(n);
  await expect(page.locator('#weBar')).toBeHidden();
  expect(errs).toEqual([]);
});

test('draw a line, a wall, a start and a finish on the floor; erase them', async ({ page }) => {
  const errs = errors(page);
  await home(page);
  await page.click('#hRobots button[data-k="rover-line"]');
  await page.waitForFunction(() => !!(window as any).formframe?.projectId);
  await page.click('#rpDraw');
  await expect(page.locator('#drawBar')).toBeVisible();
  await overview(page); await page.waitForTimeout(300);
  const drag = async (pts: [number, number][]) => {
    const s = await Promise.all(pts.map(([x, z]) => scr(page, x, z)));
    await page.mouse.move(s[0].x, s[0].y); await page.mouse.down();
    for (const p of s.slice(1)) await page.mouse.move(p.x, p.y, { steps: 6 });
    await page.mouse.up();
  };
  // Line (the default tool): line sensors see it
  await drag([[-300, 300], [-100, 350], [100, 300], [300, 350]]);
  await expect.poll(async () => (await w(page)).lines?.length ?? 0).toBe(1);
  expect((await w(page)).lines[0].points.length).toBeGreaterThan(3);
  // Wall
  await page.click('#drawBar [data-t=wall]');
  await drag([[-300, -400], [300, -400]]);
  await expect.poll(async () => (await w(page)).obstacles.filter((o: any) => o.name === 'Wall').length).toBe(1);
  const wall = (await w(page)).obstacles.find((o: any) => o.name === 'Wall');
  expect(wall.size[0]).toBeGreaterThan(450); expect(Math.abs(wall.rot % 180)).toBeLessThan(10);
  // Start: the robot moves there
  await page.click('#drawBar [data-t=start]');
  await drag([[200, -200], [300, -200]]); // facing +X
  await expect.poll(async () => (await w(page)).start?.pos[0] ?? 0).toBeGreaterThan(150);
  expect(Math.abs((await w(page)).start.yaw - 90)).toBeLessThan(20);
  await expect.poll(() => page.evaluate(() => { const b = (globalThis as any).__robot().body; return Math.round(b.x); })).toBeGreaterThan(150);
  // Finish
  await page.click('#drawBar [data-t=finish]');
  await drag([[-200, -200], [-200, -200]]);
  await expect.poll(async () => (await w(page)).finish?.r ?? 0).toBeGreaterThanOrEqual(50);
  // Erase the line
  await page.click('#drawBar [data-t=erase]');
  const lp = (await w(page)).lines[0].points[1];
  await drag([lp, lp]);
  await expect.poll(async () => (await w(page)).lines?.length ?? 0).toBe(0);
  // Done closes the toolbar; Ctrl+Z brings the line back
  await page.click('#dbDone');
  await expect(page.locator('#drawBar')).toBeHidden();
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await w(page)).lines?.length ?? 0).toBe(1);
  expect(errs).toEqual([]);
});

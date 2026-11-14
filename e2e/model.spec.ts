import { test, expect } from '@playwright/test';
import { newProject, mode, popup, errors } from './helpers';

test('auto build makes a fitting enclosure with a dial, screen and lit ring', async ({ page }) => {
  await newProject(page, 'example');
  await page.click('#bMenu'); await page.click('#menu [data-a=autobuild]');
  await expect(page.locator('#mFitBadge')).toHaveText('Fits');
  const roles = await page.evaluate(() => (window as any).formframe.project.product.built.parts.map((p: any) => p.role));
  for (const r of ['dial', 'screen', 'led']) expect(roles).toContain(r);
  await expect(page.locator('#autoNotes li').first()).toContainText('Round enclosure');
});

test('exploded view shows the wired electronics', async ({ page }) => {
  await newProject(page, 'example');
  await page.click('#bExplode');
  await expect.poll(() => page.evaluate(() => { const e = (window as any).formframe.elec; return e.count > 0 && e.group.visible; })).toBe(true);
});

test('3D modeler: Blender-style edits sync back to the studio', async ({ page, context }) => {
  const errs = errors(page);
  await newProject(page, 'blank');
  await page.click('#eBuild');
  const md = await popup(context, page, '#bModeler');
  const mErrs = errors(md);
  await expect(md.locator('#outliner .orow', { hasText: 'Housing' })).toBeVisible();
  await md.locator('#outliner .orow', { hasText: 'Housing' }).click();
  await md.mouse.move(700, 400);
  await md.keyboard.press('g'); await md.keyboard.press('x'); await md.keyboard.type('10'); await md.keyboard.press('Enter');
  await md.keyboard.press('Shift+A'); await md.locator('.bmenu .mi', { hasText: 'Mesh' }).hover(); await md.locator('.bmenu .mi', { hasText: /^Cube$/ }).first().click();
  await md.keyboard.press('r'); await md.keyboard.press('z'); await md.keyboard.type('45'); await md.keyboard.press('Enter');
  await md.keyboard.press('Control+z'); // undo the rotate
  const cube = await md.evaluate(() => { const S = (window as any).modeler.S; return S.built.parts.find((p: any) => p.id === S.active); });
  expect(cube.rot).toEqual([0, 0, 0]);
  await expect.poll(() => page.evaluate(() => (window as any).formframe.project.product.built?.parts.length), { timeout: 15_000 }).toBe(2);
  expect(await page.evaluate(() => (window as any).formframe.project.product.built.parts.find((p: any) => p.name === 'Housing').pos[0])).toBe(10);
  expect([...errs, ...mErrs]).toEqual([]);
});

test('Edit Mode: inset and extrude a face, then leave an untouched primitive alone', async ({ page, context }) => {
  await newProject(page, 'blank');
  await page.click('#eBuild');
  const md = await popup(context, page, '#bModeler');
  await md.locator('#outliner .orow', { hasText: 'Housing' }).click();
  await md.mouse.move(700, 380); await md.keyboard.press('Tab');
  await expect(md.locator('#modeDrop')).toHaveText('Edit Mode ▾');
  await md.keyboard.press('3'); await md.keyboard.press('Numpad1'); await md.keyboard.press('Alt+a');
  const vp = (await md.locator('#vp').boundingBox())!;
  await md.mouse.click(vp.x + vp.width / 2, vp.y + vp.height / 2);
  await expect(md.locator('#stRight')).toContainText('Faces 1/');
  const faces0 = await md.evaluate(() => (window as any).modeler.S.built.parts[0].mesh.f.length);
  await md.mouse.move(vp.x + vp.width / 2 + 100, vp.y + vp.height / 2);
  await md.keyboard.press('i'); await md.keyboard.type('4'); await md.keyboard.press('Enter');
  await md.keyboard.press('e'); await md.keyboard.type('-6'); await md.keyboard.press('Enter');
  expect(await md.evaluate(() => (window as any).modeler.S.built.parts[0].mesh.f.length)).toBe(faces0 + 8);
  await md.keyboard.press('Tab');
  await md.keyboard.press('Shift+A'); await md.locator('.bmenu .mi', { hasText: 'Mesh' }).hover(); await md.locator('.bmenu .mi', { hasText: /^Cylinder$/ }).first().click();
  await md.keyboard.press('Tab'); await md.keyboard.press('Tab');
  expect(await md.evaluate(() => { const S = (window as any).modeler.S; return S.built.parts.find((p: any) => p.id === S.active).shape; })).toBe('cyl');
});

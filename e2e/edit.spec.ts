import { test, expect, type Page } from '@playwright/test';
import { home, newProject, mode, errors } from './helpers';

/** Screen point of world object `i` (studio: the robot's world; scene: the shared world), if it is the first thing hit there. */
const objPoint = (page: Page, where: 'studio' | 'scene', i: number) => page.evaluate(([where, i]) => {
  const g = globalThis as any;
  const v = where === 'studio' ? g.formframe.viewport : g.__sceneView().vp;
  const meshes: any[] = [];
  (where === 'studio' ? g.formframe.product.worldObjects() : (() => { const out: any[] = []; g.__sceneView().worldG.traverse((o: any) => { if (o.userData.obstacle !== undefined) out.push(o); }); return out; })()).forEach((m: any) => meshes.push(m));
  const m = meshes.find(x => x.userData.obstacle === i); if (!m) return null;
  const p = v.project(m.getWorldPosition(m.position.clone()));
  const hit = v.hit({ clientX: p.x, clientY: p.y }, meshes);
  const onCanvas = document.elementFromPoint(p.x, p.y) === v.renderer.domElement; // not under a panel or card
  return hit?.object === m && onCanvas ? { x: p.x, y: p.y } : null;
}, [where, i] as const);

async function dragBy(page: Page, from: { x: number; y: number }, dx: number) {
  await page.mouse.move(from.x, from.y); await page.mouse.down();
  for (let k = 1; k <= 6; k++) await page.mouse.move(from.x + dx * k / 6, from.y + 10 * k / 6);
  await page.mouse.up();
}

test('any object in a robot world can be dragged, and Cmd/Ctrl+Z / Cmd/Ctrl+Y undo and redo it', async ({ page }) => {
  const errs = errors(page);
  await home(page);
  await page.click('#hRobots button[data-k="arm"]');
  await page.waitForFunction(() => !!(window as any).formframe?.projectId && (window as any).formframe.product.worldObjects?.().length);
  const world = () => page.evaluate(() => JSON.parse(JSON.stringify((window as any).formframe.project.product.built.robot.world.obstacles)));
  const before = await world();
  // find an object that's in plain view
  let idx = -1, pt: { x: number; y: number } | null = null;
  for (let i = 0; i < before.length && !pt; i++) { pt = await objPoint(page, 'studio', i); if (pt) idx = i; }
  expect(pt).not.toBeNull();
  await dragBy(page, pt!, 90);
  await expect.poll(async () => (await world())[idx].pos).not.toEqual(before[idx].pos);
  const moved = (await world())[idx].pos;
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await world())[idx].pos).toEqual(before[idx].pos);
  await page.keyboard.press('ControlOrMeta+y');
  await expect.poll(async () => (await world())[idx].pos).toEqual(moved);
  await page.keyboard.press('ControlOrMeta+Shift+z'); // nothing more to redo
  await expect(page.locator('#toast')).toContainText('Nothing to redo');
  expect(errs).toEqual([]);
});

test('undo and redo work for other edits too, and leave text boxes alone', async ({ page }) => {
  const errs = errors(page);
  await newProject(page, 'blank');
  await mode(page, 'elec');
  const files = () => page.evaluate(() => Object.keys((window as any).formframe.project.electronics.files).length);
  const comps = () => page.evaluate(() => (window as any).formframe.project.electronics.comps.length);
  const n0 = await comps();
  await page.click('#libList button[data-t=button]');
  await expect.poll(comps).toBe(n0 + 1);
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(comps).toBe(n0);
  await page.keyboard.press('ControlOrMeta+y');
  await expect.poll(comps).toBe(n0 + 1);
  // in the code editor, Cmd/Ctrl+Z is the editor's own undo (the project history is untouched)
  expect(await files()).toBeGreaterThan(0);
  await page.click('#code'); await page.keyboard.type('# hi');
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(comps).toBe(n0 + 1);
  expect(errs).toEqual([]);
});

test('any object in a scene can be dragged, and undo puts it back', async ({ page }) => {
  test.setTimeout(120_000);
  const errs = errors(page);
  await home(page);
  await page.click('#sceneGrid .scenenew');
  await expect(page.locator('#sceneWs')).toBeVisible();
  await page.waitForFunction(() => (globalThis as any).__sceneView?.().scene?.world.obstacles.length > 0);
  const obs = () => page.evaluate(() => JSON.parse(JSON.stringify((globalThis as any).__sceneView().scene.world.obstacles)));
  const before = await obs();
  let idx = -1, pt: { x: number; y: number } | null = null;
  for (let i = 0; i < before.length && !pt; i++) { pt = await objPoint(page, 'scene', i); if (pt) idx = i; }
  expect(pt).not.toBeNull();
  await dragBy(page, pt!, 120);
  await expect.poll(async () => (await obs())[idx].pos).not.toEqual(before[idx].pos);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await obs())[idx].pos, { timeout: 30_000 }).toEqual(before[idx].pos);
  expect(errs).toEqual([]);
});

test('the Claude chat is saved with the project and comes back after a reload', async ({ page }) => {
  const nd = (...evs: unknown[]) => evs.map(e => JSON.stringify(e)).join('\n') + '\n';
  await page.route('**/api/assistant', r => r.fulfill({ contentType: 'application/x-ndjson', body: nd({ t: 'done', stop: 'end_turn', content: [{ type: 'text', text: 'Your board is a Pico.' }], edits: [] }) }));
  await newProject(page, 'blank');
  await mode(page, 'elec');
  await page.click('#tabAsst');
  await page.fill('#asInput', 'Which board is this?'); await page.press('#asInput', 'Enter');
  await expect(page.locator('#asLog')).toContainText('Your board is a Pico.');
  await page.waitForTimeout(300);
  await page.reload();
  await expect(page.locator('#home')).toBeVisible();
  await page.locator('.pcard').first().click();
  await page.waitForFunction(() => !!(window as any).formframe?.projectId);
  await mode(page, 'elec');
  await page.click('#tabAsst');
  await expect(page.locator('#asLog')).toContainText('Which board is this?');
  await expect(page.locator('#asLog')).toContainText('Your board is a Pico.');
  // New chat clears it, also after a reload
  await page.click('#asNew');
  await page.waitForTimeout(300);
  await page.reload();
  await page.locator('.pcard').first().click();
  await mode(page, 'elec');
  await page.click('#tabAsst');
  await expect(page.locator('#asLog')).toContainText('Ask Claude about this project');
});

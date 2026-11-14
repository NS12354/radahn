import { test, expect } from '@playwright/test';
import http from 'node:http';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newProject, mode } from './helpers';

const here = path.dirname(fileURLToPath(import.meta.url));

test('Add from a link reads a product page and adds a wireable part', async ({ page }) => {
  const html = fs.readFileSync(path.join(here, 'fixtures', 'bme280.html'), 'utf8');
  const srv = http.createServer((_q, r) => { r.setHeader('content-type', 'text/html'); r.end(html); }).listen(0);
  const port = (srv.address() as any).port;
  try {
    await newProject(page, 'blank');
    await mode(page, 'elec');
    await page.fill('#partUrl', `http://127.0.0.1:${port}/bme280`);
    await page.click('#bPartUrl');
    await expect(page.locator('#prAdd')).toBeVisible({ timeout: 90_000 });
    await expect(page.locator('#partReview select[data-f=interface]')).toHaveValue('i2c');
    await page.fill('#partReview [data-f=i2c]', '0x77'); await page.press('#partReview [data-f=i2c]', 'Tab');
    await page.click('#prAdd');
    const comps = await page.evaluate(() => (window as any).formframe.project.electronics.comps.map((c: any) => c.pins));
    expect(comps).toEqual([{ SDA: expect.any(Number), SCL: expect.any(Number) }]);
    await page.reload(); // the part travels with the project
    await page.locator('.pcard').first().click();
    await expect.poll(() => page.evaluate(() => Object.keys((window as any).formframe?.project?.electronics?.custom ?? {}).length)).toBe(1);
  } finally { srv.close(); }
});

const BLENDER = process.env.BLENDER_PATH || '/Applications/Blender.app/Contents/MacOS/Blender';
test('Blender live link round-trips edits and keeps Blender modifiers', async ({ page, baseURL }) => {
  test.skip(!fs.existsSync(BLENDER), 'Blender is not installed');
  await newProject(page, 'blank');
  await page.click('#eBuild');
  const id = await page.evaluate(() => (window as any).formframe.projectId);
  await page.evaluate(() => { const f = (window as any).formframe; f.blender.start(f.projectId); return f.blender.push(true); });
  const out = await new Promise<string>(res => {
    const p = spawn(BLENDER, ['-b', '--factory-startup', '--python', path.join(here, 'fixtures', 'blender_harness.py'), '--', baseURL!.replace(/\/$/, ''), id]);
    let o = ''; p.stdout.on('data', d => (o += d)); p.stderr.on('data', d => (o += d)); p.on('close', () => res(o));
  });
  expect(out).toContain('AFTER_ECHO modifiers [\'BEVEL\']');
  await expect.poll(() => page.evaluate(() => (window as any).formframe.project.product.built.parts.map((p: any) => p.name).sort())).toEqual(['Housing', 'Knob']);
});

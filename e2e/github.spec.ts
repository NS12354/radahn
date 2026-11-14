import { test, expect, type Page } from '@playwright/test';
import { newProject, mode, errors } from './helpers';

/** Stand-in for the server's /api/github (the real one talks to api.github.com with your token). */
async function fakeGitHub(page: Page) {
  let signedIn = false;
  const user = { login: 'octo', name: 'Octo Cat', avatar: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' };
  const files: Record<string, string> = {
    'firmware/main.py': 'from machine import Pin\nled = Pin(25, Pin.OUT)\nled.toggle()\n',
    'firmware/lib/ring.py': 'def spin():\n    pass\n',
    'README.md': '# thermo',
  };
  await page.route('**/api/github/**', async r => {
    const u = new URL(r.request().url()), route = u.pathname.split('/api/github/')[1];
    if (route === 'status') return r.fulfill({ json: { signedIn, user: signedIn ? user : null, deviceFlow: false } });
    if (route === 'token') { expect(r.request().headers()['content-type']).toContain('application/json'); signedIn = true; return r.fulfill({ json: { signedIn, user } }); }
    if (route === 'repos') return r.fulfill({ json: { repos: [{ full: 'octo/thermo', private: true, branch: 'main', updated: new Date().toISOString(), language: 'Python' }, { full: 'octo/other', private: false, branch: 'main', updated: '2024-01-01T00:00:00Z' }] } });
    if (route === 'branches') return r.fulfill({ json: { branches: ['main', 'dev'] } });
    if (route === 'tree') return r.fulfill({ json: { ref: u.searchParams.get('ref') || 'main', truncated: false, items: [
      { path: 'firmware', dir: true, size: 0 }, { path: 'firmware/lib', dir: true, size: 0 },
      ...Object.entries(files).map(([path, c]) => ({ path, dir: false, size: c.length })) ] } });
    if (route === 'file') { const p = u.searchParams.get('path')!; return r.fulfill({ json: { path: p, content: files[p] } }); }
    if (route === 'logout') { signedIn = false; return r.fulfill({ json: { signedIn } }); }
    return r.fulfill({ status: 404, json: { error: 'not found' } });
  });
}

test('GitHub tab: sign in, browse a repo, drag files into Electronics', async ({ page }) => {
  const errs = errors(page);
  await fakeGitHub(page);
  await newProject(page, 'example');
  await mode(page, 'github');
  await expect(page.locator('#ghView')).toBeVisible();
  await expect(page.locator('#ghDevice')).toBeDisabled(); // no OAuth app configured: token path only
  await page.fill('#ghTok', 'ghp_' + 'a'.repeat(36));
  await page.click('#ghTokBtn');
  await expect(page.locator('.ghme')).toContainText('@octo');
  await page.fill('#ghQ', 'therm');
  await expect(page.locator('.ghrepo')).toHaveCount(1);
  await page.click('.ghrepo');
  // code-only filter hides README; folders with code open themselves
  await expect(page.locator('.ghrow', { hasText: 'main.py' })).toBeVisible();
  await expect(page.locator('.ghrow', { hasText: 'README.md' })).toHaveCount(0);
  await page.click('.ghrow:has-text("main.py")');
  await expect(page.locator('.ghcodev')).toContainText('led.toggle()');
  // drag the firmware folder onto the Electronics tab
  await page.locator('.ghrow', { hasText: 'firmware/' }).first().dragTo(page.locator('#modes [data-m=elec]'));
  await expect(page.locator('body')).toHaveClass(/m-elec/);
  await expect.poll(() => page.evaluate(() => (window as any).formframe.project.electronics.files['main.py'])).toContain('led.toggle()');
  await expect.poll(() => page.evaluate(() => (window as any).formframe.project.electronics.files['lib/ring.py'])).toContain('def spin');
  // and it is logged in the Plan
  await mode(page, 'plan');
  await expect(page.locator('#plLog')).toContainText('Imported 2 files from octo/thermo@main');
  // the last repo is remembered; Add button path with a checkbox
  await mode(page, 'github');
  await expect(page.locator('.ghrh')).toContainText('octo/thermo');
  await page.click('.ghrow:has-text("lib/")');
  await page.locator('.ghrow', { hasText: 'ring.py' }).locator('input').check();
  await expect(page.locator('#ghAddSel')).toHaveText(/Add 1 to Electronics/);
  await page.click('#ghOut');
  await expect(page.locator('#ghTok')).toBeVisible();
  expect(errs).toEqual([]);
});

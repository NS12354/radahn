import { test, expect } from '@playwright/test';
import { home, mode, errors } from './helpers';

// a browser where WebGL is off (policy, driver, or no GPU): the studio must still work
const noWebGL = () => {
  const orig = HTMLCanvasElement.prototype.getContext;
  (HTMLCanvasElement.prototype as any).getContext = function (this: HTMLCanvasElement, kind: string, ...a: any[]) { return /webgl/i.test(kind) ? null : (orig as any).call(this, kind, ...a); };
};

test('without WebGL the 3D view explains itself and everything else still works', async ({ page }) => {
  test.setTimeout(120_000);
  const errs = errors(page);
  await page.addInitScript(noWebGL);
  await home(page);
  await page.click('#hExample b');
  await page.waitForFunction(() => !!(window as any).formframe?.projectId);
  const notice = page.locator('#viewport .glfail');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('3D view unavailable');
  await expect(notice).toContainText('Your project is safe');
  await expect(notice).toContainText('Rotary encoder'); // what's in the project, without the 3D picture
  // navigation and the rest of the workflow
  await notice.locator('[data-go]').click();
  await expect(page.locator('#modes [data-m=elec]')).toHaveClass(/on/);
  await page.click('#bRun');
  await expect(page.locator('#bRun')).toHaveText('Stop');
  await expect(page.locator('#serial')).toContainText(/\S/, { timeout: 60_000 });
  await page.click('#bRun');
  for (const m of ['design', 'proto', 'review']) { const b = page.locator(`#modes [data-m=${m}]`); if (await b.isVisible()) { await b.click(); await expect(b).toHaveClass(/on/); } }
  await page.fill('#pname', 'Works without 3D');
  await page.click('#bSave'); await expect(page.locator('#bSave')).toHaveText('Saved');
  await page.click('#bHome'); await expect(page.locator('#home')).toBeVisible();
  await expect(page.locator('.pcard', { hasText: 'Works without 3D' })).toHaveCount(1);
  expect(errs).toEqual([]);
});

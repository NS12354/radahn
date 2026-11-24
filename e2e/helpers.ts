import { expect, type Page, type BrowserContext } from '@playwright/test';

/** Fresh studio: open the home screen (each test gets its own empty browser storage). */
export async function home(page: Page, opts: { simple?: boolean } = {}) {
  page.on('dialog', d => d.accept());
  // most specs drive expert tools; the beginner spec asks for the default Simple view
  if (!opts.simple) await page.addInitScript(() => { try { localStorage.setItem('ff.advanced', '1'); } catch { /* */ } });
  await page.goto('/');
  await expect(page.locator('#home')).toBeVisible();
}
/** Start a project from the home screen. */
export async function newProject(page: Page, kind: 'blank' | 'example') {
  await home(page);
  await page.click(kind === 'blank' ? '#hBlank b' : '#hExample b');
  await expect(page.locator('#home')).toBeHidden();
  await page.waitForFunction(() => !!(window as any).formframe?.projectId);
}
export const mode = (page: Page, m: 'design' | 'proto' | 'elec' | 'review' | 'plan' | 'github') => page.click(`#modes [data-m=${m}]`);
/** Open a window the studio launches (modeler, device IDE) and wait for it to load. */
export async function popup(ctx: BrowserContext, page: Page, selector: string) {
  const [w] = await Promise.all([ctx.waitForEvent('page'), page.click(selector)]);
  w.on('dialog', d => d.accept());
  await w.waitForLoadState();
  return w;
}
/** Collect uncaught errors on a page; assert none at the end of a test. */
export function errors(page: Page) {
  const out: string[] = [];
  page.on('pageerror', e => out.push(e.message));
  return out;
}

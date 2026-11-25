import { test, expect } from '@playwright/test';
import { home, newProject, mode, errors, save } from './helpers';

test('blank project: no model, no parts, an empty starter file', async ({ page }) => {
  const errs = errors(page);
  await newProject(page, 'blank');
  await expect(page.locator('#pname')).toHaveValue('Untitled project');
  await expect(page.locator('#vpEmpty')).toBeVisible();
  await mode(page, 'elec');
  await expect(page.locator('#code')).toHaveValue(/print\("ready"\)/);
  await page.click('#libList button[data-t=button]');
  await expect(page.locator('#code')).not.toHaveValue(/thermostat/i); // adding parts keeps the blank starter
  expect(errs).toEqual([]);
});

test('home screen lists, duplicates, deletes and keeps projects across reloads', async ({ page }) => {
  await newProject(page, 'blank');
  await page.fill('#pname', 'My widget'); await save(page);
  await page.click('#bHome');
  await page.click('#hExample b');
  await page.click('#bHome');
  const names = page.locator('.pcard .pi b');
  await expect(names).toHaveText(['Thermostat concept', 'My widget']);
  await page.locator('.pcard').first().hover();
  await page.locator('.pcard').first().locator('[data-x=dup]').click();
  await expect(names).toHaveCount(3);
  await page.locator('.pcard', { hasText: 'Thermostat concept copy' }).hover();
  await page.locator('.pcard', { hasText: 'Thermostat concept copy' }).locator('[data-x=del]').click();
  await expect(names).toHaveCount(2);
  await page.reload();
  await expect(names).toHaveText(['Thermostat concept', 'My widget']);
});

test('tutorial walks every step and returns home without saving a project', async ({ page }) => {
  await home(page);
  await page.click('#hTour');
  await expect(page.locator('#tour .tcard')).toBeVisible();
  for (let i = 0; i < 13; i++) await page.click('#tour [data-t=next]');
  await expect(page.locator('#home')).toBeVisible();
  await expect(page.locator('.pcard')).toHaveCount(0);
});

test('opening a project without editing saves nothing; closing with edits asks to save', async ({ page }) => {
  test.setTimeout(120_000);
  const errs = errors(page);
  await newProject(page, 'blank');
  await page.fill('#pname', 'Kept name'); await save(page);
  await page.click('#bHome');
  const stamp = async () => page.evaluate(async () => {
    const db: IDBDatabase = await new Promise((res, rej) => { const r = indexedDB.open('formframe'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const store = [...db.objectStoreNames].find(n => /meta/i.test(n))!;
    const all: any[] = await new Promise(res => { const q = db.transaction(store).objectStore(store).getAll(); q.onsuccess = () => res(q.result); });
    db.close();
    return JSON.stringify(all.map(m => [m.name, m.updated, !!m.thumb]));
  });
  const before = await stamp();

  // open, look around, run it, close: nothing is written and nothing is asked
  await page.locator('.pcard', { hasText: 'Kept name' }).click();
  await page.waitForFunction(() => !!(window as any).formframe?.projectId);
  await expect(page.locator('#bSave')).toHaveText('Saved');
  await mode(page, 'elec'); await mode(page, 'design');
  await page.waitForTimeout(1500);
  await page.click('#bHome');
  await expect(page.locator('#home')).toBeVisible();
  await expect(page.locator('.savedlg')).toHaveCount(0);
  expect(await stamp()).toBe(before);

  // edit, then close: asked. Cancel stays; Don't save leaves it as it was
  await page.locator('.pcard', { hasText: 'Kept name' }).click();
  await page.waitForFunction(() => !!(window as any).formframe?.projectId);
  await page.fill('#pname', 'Changed name');
  await expect(page.locator('#bSave')).toHaveText('Save');
  await page.click('#bHome');
  await expect(page.locator('.savedlg')).toContainText('Changed name');
  await page.click('.savedlg [data-r=cancel]');
  await expect(page.locator('#home')).toBeHidden();
  await page.click('#bHome');
  await page.click('.savedlg [data-r=discard]');
  await expect(page.locator('#home')).toBeVisible();
  await expect(page.locator('.pcard .pi b', { hasText: 'Kept name' })).toHaveCount(1);
  expect(await stamp()).toBe(before);

  // edit, then open something else from the menu: asked, and Save keeps it
  await page.locator('.pcard', { hasText: 'Kept name' }).click();
  await page.waitForFunction(() => !!(window as any).formframe?.projectId);
  await page.fill('#pname', 'Saved name');
  await page.click('#bMenu'); await page.click('#menu [data-a=newExample]');
  await page.click('.savedlg [data-r=save]');
  await expect(page.locator('#pname')).toHaveValue('Thermostat concept');
  await page.click('#bHome');
  await expect(page.locator('.pcard .pi b', { hasText: 'Saved name' })).toHaveCount(1);
  expect(errs).toEqual([]);
});

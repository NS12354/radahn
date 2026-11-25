import { test, expect, type Page } from '@playwright/test';
import { home, errors } from './helpers';
import { fakeSupabase } from './fakesupabase';

// Accounts run against a stand-in Supabase (e2e/fakesupabase.ts): two browser contexts are two computers.
const signInWith = async (page: Page, email: string, password: string, create = false) => {
  await page.click('#hAccount');
  await expect(page.locator('#auth')).toBeVisible();
  if (create) await page.click('#auth [data-go=signup]');
  await page.fill('#auth input[name=email]', email);
  await page.fill('#auth input[name=password]', password);
  await page.click('#auth button[type=submit]');
};

test('sign up, projects save to the account, open on another computer, sign out clears them', async ({ browser }) => {
  test.setTimeout(120_000);
  const fake = fakeSupabase();
  // computer 1: work without an account first; nothing leaves the browser
  const c1 = await browser.newContext(); await fake.attach(c1);
  const p1 = await c1.newPage(); const errs = errors(p1);
  await home(p1);
  await expect(p1.locator('#hAccount')).toHaveText('Sign in');
  await p1.click('#hBlank b');
  await p1.waitForFunction(() => !!(window as any).formframe?.projectId);
  await p1.fill('#pname', 'Cloud test'); await p1.press('#pname', 'Enter');
  await p1.waitForTimeout(800);
  expect(fake.db).toHaveLength(0);
  // create an account: this browser's projects go up to it
  await p1.click('#bHome');
  await signInWith(p1, 'ana@example.com', 'correct horse', true);
  await expect(p1.locator('#auth')).toBeHidden();
  await expect(p1.locator('#hAccount')).toContainText('ana');
  await expect.poll(() => fake.db.find(r => r.kind === 'project' && r.name === 'Cloud test')?.body ?? '', { timeout: 15_000 }).toContain('"name": "Cloud test"');
  // later edits follow
  await p1.locator('.pcard', { hasText: 'Cloud test' }).click();
  await p1.waitForFunction(() => !!(window as any).formframe?.projectId);
  await p1.fill('#pname', 'Cloud test v2'); await p1.press('#pname', 'Enter');
  await expect.poll(() => fake.db.find(r => r.kind === 'project')?.name, { timeout: 15_000 }).toBe('Cloud test v2');
  expect(errs).toEqual([]);

  // computer 2: a wrong password is refused, the right one brings the project down
  const c2 = await browser.newContext(); await fake.attach(c2);
  const p2 = await c2.newPage();
  await home(p2);
  await expect(p2.locator('.pcard', { hasText: 'Cloud test' })).toHaveCount(0);
  await signInWith(p2, 'ana@example.com', 'wrong password');
  await expect(p2.locator('#auth .auerr')).toContainText('don’t match');
  await expect(p2.locator('#auth input[name=email]')).toHaveValue('ana@example.com'); // kept for the retry
  await p2.fill('#auth input[name=password]', 'correct horse'); await p2.click('#auth button[type=submit]');
  await expect(p2.locator('.pcard', { hasText: 'Cloud test v2' })).toBeVisible({ timeout: 15_000 });
  await p2.locator('.pcard', { hasText: 'Cloud test v2' }).click();
  await p2.waitForFunction(() => (window as any).formframe?.project?.name === 'Cloud test v2');
  // signing out removes the account's projects from this computer
  await p2.click('#bHome');
  await p2.click('#hAccount'); await p2.click('#acMenu [data-a=out]');
  await expect(p2.locator('#hAccount')).toHaveText('Sign in');
  await expect(p2.locator('.pcard', { hasText: 'Cloud test' })).toHaveCount(0);
  // ... and they're still in the account
  expect(fake.db.filter(r => r.kind === 'project' && !r.deleted)).toHaveLength(1);
  await c1.close(); await c2.close();
});

test('the sign-in page can be skipped, and offers a code and a password reset', async ({ browser }) => {
  const fake = fakeSupabase();
  const c = await browser.newContext(); await fake.attach(c);
  const page = await c.newPage();
  await home(page);
  await page.click('#hAccount');
  await expect(page.locator('#auth h1')).toHaveText('Sign in');
  await page.click('#auth [data-go=reset]');
  await expect(page.locator('#auth h1')).toHaveText('Reset your password');
  await page.click('#auth [data-go=signin]');
  await page.click('#auth [data-go=code]');
  await expect(page.locator('#auth h1')).toHaveText('Email me a sign-in code');
  await page.click('#auth [data-close]');
  await expect(page.locator('#auth')).toBeHidden();
  await expect(page.locator('#home')).toBeVisible();
  await c.close();
});

test('emails carry 6-digit codes: confirm a sign-up, sign in without a password, reset a password', async ({ browser }) => {
  test.setTimeout(90_000);
  const fake = fakeSupabase({ confirmEmail: true });
  const c = await browser.newContext(); await fake.attach(c);
  const page = await c.newPage(); const errs = errors(page);
  await home(page);
  const enter = async (code: string) => { await page.fill('#auth input[name=code]', code); await page.click('#auth button[type=submit]'); };

  // sign up: the account waits for the code from the email
  await signInWith(page, 'bo@example.com', 'first password', true);
  await expect(page.locator('#auth h1')).toHaveText('Check your email');
  await expect(page.locator('#auth .aulead')).toContainText('bo@example.com');
  await enter('000000');
  await expect(page.locator('#auth .auerr')).toContainText('wrong or has expired');
  await enter(fake.codeFor('bo@example.com'));
  await expect(page.locator('#auth')).toBeHidden();
  await expect(page.locator('#hAccount')).toHaveText('bo');
  await page.click('#hAccount'); await page.click('#acMenu [data-a=out]');
  await expect(page.locator('#hAccount')).toHaveText('Sign in');

  // sign in with a code instead of the password
  await page.click('#hAccount');
  await page.click('#auth [data-go=code]');
  await page.fill('#auth input[name=email]', 'bo@example.com');
  await page.click('#auth button[type=submit]');
  await expect(page.locator('#auth input[name=code]')).toBeFocused();
  await enter(fake.codeFor('bo@example.com'));
  await expect(page.locator('#hAccount')).toHaveText('bo');
  await page.click('#hAccount'); await page.click('#acMenu [data-a=out]');

  // forgot password: code, then choose a new one, then it works
  await page.click('#hAccount');
  await page.click('#auth [data-go=reset]');
  await page.fill('#auth input[name=email]', 'bo@example.com');
  await page.click('#auth button[type=submit]');
  await expect(page.locator('#auth button[type=submit]')).toHaveText('Continue');
  await enter(fake.codeFor('bo@example.com'));
  await expect(page.locator('#auth h1')).toHaveText('Choose a new password');
  await page.fill('#auth input[name=password]', 'second password');
  await page.click('#auth button[type=submit]');
  await expect(page.locator('#auth')).toBeHidden();
  expect(fake.users.get('bo@example.com')!.password).toBe('second password');
  expect(errs).toEqual([]);
  await c.close();
});

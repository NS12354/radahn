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

test('guests only get The First Step until they make a free account', async ({ browser }) => {
  test.setTimeout(90_000);
  const fake = fakeSupabase();
  const c = await browser.newContext(); await fake.attach(c);
  const page = await c.newPage(); const errs = errors(page);
  await home(page, { guest: true });
  // home: The First Step and an offer of a free account; everything else is hidden
  await expect(page.locator('#hExample')).toBeVisible();
  await expect(page.locator('#hGuest')).toBeVisible();
  for (const s of ['#hBlank', '#hOpen', '#hFolder', '#hRobots', '#sceneGrid', '#homeGrid']) await expect(page.locator(s)).toBeHidden();
  await page.click('#hGuest [data-auth=signup]');
  await expect(page.locator('#auth h1')).toHaveText('Create your account');
  await page.click('#auth [data-close]');

  // The First Step opens, and coming back to it opens the same copy rather than a new one
  await page.click('#hExample b');
  await page.waitForFunction(() => !!(window as any).formframe?.projectId);
  const first = await page.evaluate(() => (window as any).formframe.projectId);
  // anything else from the studio menu asks for an account
  await page.click('#bMenu'); await page.click('#menu [data-a=newBlank]');
  await expect(page.locator('#auth')).toBeVisible();
  await expect(page.locator('#auth .aulead')).toContainText('free account');
  await page.click('#auth [data-close]');
  expect(await page.evaluate(() => (window as any).formframe.projectId)).toBe(first);
  await page.click('#bHome');
  await expect(page.locator('#home')).toBeVisible();
  await page.click('#hExample b');
  await page.waitForFunction(() => !!(window as any).formframe?.projectId);
  expect(await page.evaluate(() => (window as any).formframe.projectId)).toBe(first);
  await page.click('#bHome');

  // with an account everything opens, and the guest's First Step goes up to it
  await signInWith(page, 'cy@example.com', 'correct horse', true);
  await expect(page.locator('#hBlank')).toBeVisible();
  await expect(page.locator('#hGuest')).toBeHidden();
  await expect.poll(() => fake.db.filter(r => r.kind === 'project').map(r => r.id)).toEqual([first]);
  expect(errs).toEqual([]);
  await c.close();
});

test('signing out with a project open closes it and leaves nothing behind for the next person', async ({ browser }) => {
  test.setTimeout(90_000);
  const fake = fakeSupabase();
  const c = await browser.newContext(); await fake.attach(c);
  const page = await c.newPage(); const errs = errors(page);
  await home(page);
  await signInWith(page, 'di@example.com', 'correct horse', true);
  await expect(page.locator('#hAccount')).toHaveText('di');
  await page.click('#hBlank b');
  await page.waitForFunction(() => !!(window as any).formframe?.projectId);
  await page.fill('#pname', 'Private work'); await page.press('#pname', 'Enter');
  // sign out from the studio, straight after an edit
  await page.click('#bAccount'); await page.click('#acMenu [data-a=out]');
  await expect(page.locator('#home')).toBeVisible();
  await expect(page.locator('#hAccount')).toHaveText('Sign in');
  await page.waitForTimeout(1500); // any late save would land by now
  await expect(page.locator('.pcard', { hasText: 'Private work' })).toHaveCount(0);
  expect(fake.db.filter(r => r.kind === 'project' && r.name === 'Private work')).toHaveLength(1); // it's safe in the account
  // the next person to sign in on this browser doesn't get it
  await signInWith(page, 'eve@example.com', 'another horse', true);
  await expect(page.locator('#hAccount')).toHaveText('eve');
  await page.waitForTimeout(2500);
  expect(fake.db.filter(r => r.user_id !== fake.users.get('di@example.com')!.id && r.name === 'Private work')).toHaveLength(0);
  expect(errs).toEqual([]);
  await c.close();
});

test('two accounts on one browser never see or receive each other’s projects', async ({ browser }) => {
  test.setTimeout(120_000);
  const fake = fakeSupabase();
  const c = await browser.newContext(); await fake.attach(c);
  const page = await c.newPage(); const errs = errors(page);
  await home(page);
  const make = async (name: string) => {
    await page.click('#hBlank b');
    await page.waitForFunction(() => !!(window as any).formframe?.projectId);
    await page.fill('#pname', name); await page.press('#pname', 'Enter');
    await page.waitForTimeout(600);
    await page.click('#bHome'); await expect(page.locator('#home')).toBeVisible();
  };
  const names = async () => page.locator('#homeGrid .pcard .pi b').allTextContents();
  const signOut = async () => { await page.click('#hAccount'); await page.click('#acMenu [data-a=out]'); await expect(page.locator('#hAccount')).toHaveText('Sign in'); };
  const inAccount = (email: string) => fake.db.filter(r => r.user_id === fake.users.get(email)?.id && r.kind === 'project' && !r.deleted).map(r => r.name).sort();

  // work from before anyone signed in here joins the first account
  await make('Before accounts');
  await signInWith(page, 'ann@example.com', 'correct horse', true);
  await expect(page.locator('#hAccount')).toHaveText('ann');
  await make('Ann work');
  await expect.poll(() => inAccount('ann@example.com')).toEqual(['Ann work', 'Before accounts']);
  await signOut();
  expect(await names()).toEqual([]);

  // someone works signed out, then a second person signs in: nobody else's work shows or uploads
  await make('Signed-out work');
  await signInWith(page, 'ben@example.com', 'another horse', true);
  await expect(page.locator('#hAccount')).toHaveText('ben');
  await page.waitForTimeout(2500);
  expect(await names()).toEqual([]);
  await make('Ben work');
  expect(await names()).toEqual(['Ben work']);
  await expect.poll(() => inAccount('ben@example.com')).toEqual(['Ben work']);
  expect(inAccount('ann@example.com')).toEqual(['Ann work', 'Before accounts']);

  // switching back: Ann sees only hers
  await signOut();
  await signInWith(page, 'ann@example.com', 'correct horse');
  await expect(page.locator('#hAccount')).toHaveText('ann');
  await expect.poll(async () => (await names()).sort()).toEqual(['Ann work', 'Before accounts']);
  expect(errs).toEqual([]);
  await c.close();
});

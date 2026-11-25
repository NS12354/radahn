import { test, expect } from '@playwright/test';
import { newProject, mode, popup, errors } from './helpers';

test('Pico opens Thonny; F5 runs the real MicroPython firmware', async ({ page, context }) => {
  await newProject(page, 'example');
  await mode(page, 'elec');
  await expect(page.locator('#bIde')).toHaveText('Code window ↗');
  const ide = await popup(context, page, '#bIde');
  const errs = errors(ide);
  await expect(ide.locator('.tinterp')).toHaveText(/MicroPython \(Raspberry Pi Pico\)/);
  await ide.keyboard.press('F5');
  await expect(ide.locator('.tsout')).toContainText('thermostat ready', { timeout: 90_000 });
  expect(errs).toEqual([]);
});

test('Thonny explains a crash in plain language', async ({ page, context }) => {
  await newProject(page, 'example');
  await mode(page, 'elec');
  const ide = await popup(context, page, '#bIde');
  await ide.evaluate(() => { const ta = document.querySelector('.thonny-ed textarea') as HTMLTextAreaElement; ta.value = ta.value.replace('print("thermostat ready")', 'print(tempp)'); ta.dispatchEvent(new Event('input')); });
  await ide.keyboard.press('F5');
  await expect(ide.locator('.sl.assist')).toHaveCount(1, { timeout: 90_000 });
  await expect(ide.locator('.sl.assist')).toContainText("uses tempp, which doesn't exist");
  await expect(page.locator('#bHealth')).toHaveText(/broken/);
});

test('Uno opens the Arduino IDE; Upload runs and the Serial Monitor reads it at the right baud', async ({ page, context }) => {
  await newProject(page, 'example');
  await mode(page, 'elec');
  await page.selectOption('#board', 'uno');
  await expect(page.locator('#bIde')).toHaveText('Code window ↗');
  const ide = await popup(context, page, '#bIde');
  await ide.click('[data-a=upload]');
  await expect(ide.locator('.aout')).toContainText('Done uploading.', { timeout: 150_000 });
  await ide.click('[data-a=monitor]');
  await expect(ide.locator('.awarn')).toBeVisible(); // sketch uses 115200, monitor starts at 9600
  await ide.selectOption('.abaud', '115200');
  await expect(ide.locator('.amon')).toContainText('target 22.0', { timeout: 60_000 });
});

test('a compile error is explained under the compiler output', async ({ page, context }) => {
  test.skip(!process.env.CI && !(await page.request.post('/api/compile', { data: { files: { 'a.ino': 'void setup(){}void loop(){}' }, board: 'uno' } })).ok(), 'needs an AVR toolchain (npm run setup:toolchain)');
  await newProject(page, 'example');
  await mode(page, 'elec');
  await page.selectOption('#board', 'uno');
  const ide = await popup(context, page, '#bIde');
  await ide.evaluate(() => { const ta = document.querySelector('.ard-ed textarea') as HTMLTextAreaElement; ta.value = ta.value.replace('Serial.begin(115200);', 'Serial.begin(115200)\n  int ledPin = 3;\n  digitalWrite(ledPn, HIGH);'); ta.dispatchEvent(new Event('input')); });
  await ide.click('[data-a=verify]');
  const hints = ide.locator('.aout .hint');
  await expect(hints).toHaveCount(2, { timeout: 120_000 }); // the missing semicolon and the typo
  await expect(hints.filter({ hasText: 'semicolon' })).toHaveCount(1);
  await expect(hints.filter({ hasText: 'ledPn' })).toContainText('Did you mean ledPin');
  await expect(page.locator('#bHealth')).toHaveText(/broken/);
});

test('Raspberry Pi opens a desktop with a working terminal', async ({ page, context }) => {
  await newProject(page, 'example');
  await mode(page, 'elec');
  await page.selectOption('#board', 'pi5');
  await expect(page.locator('#bIde')).toHaveText('Code window ↗');
  const ide = await popup(context, page, '#bIde');
  await expect(ide.locator('.pwin .ptt', { hasText: 'Thonny' })).toBeVisible();
  await ide.click('.plaunch [data-l=term]');
  const term = ide.locator('.pwin:has(.pterm) .ptout');
  const run = async (cmd: string) => { await ide.keyboard.type(cmd); await ide.keyboard.press('Enter'); };
  await run('cd thermostat-concept'); await run('ls');
  await expect(term).toContainText('main.py');
  await run('i2cdetect -y 1');
  await expect(term).toContainText('Could not open file');
  await run('pinout');
  await expect(term).toContainText('(SHT40 temp SDA) GPIO2'); // pins are labelled with the wired parts
});

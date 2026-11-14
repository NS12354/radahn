import { test, expect } from '@playwright/test';
import { newProject, mode, errors } from './helpers';

test('Plan tab tracks activity and milestones, and applies an AI update', async ({ page }) => {
  const errs = errors(page);
  await newProject(page, 'example');
  await page.click('#bHealth'); await page.click('#bTest');
  await expect(page.locator('#ptest')).toContainText('Test results', { timeout: 150_000 });
  await page.click('#pClose');
  await mode(page, 'plan');
  // milestones tick themselves
  await expect(page.locator('.plm.done', { hasText: 'Test it passes' })).toBeVisible();
  await expect(page.locator('.plm.done', { hasText: 'Code runs without errors' })).toBeVisible();
  // activity was recorded automatically
  await expect(page.locator('#plLog')).toContainText('Ran the code on the Raspberry Pi Pico');
  await expect(page.locator('#plLog')).toContainText('Test it passed');
  // your own tasks, moved across the board
  await page.fill('#plNew', 'Finish the thermostat firmware'); await page.press('#plNew', 'Enter');
  await page.fill('#plNew', 'Design the wall plate'); await page.press('#plNew', 'Enter');
  await expect(page.locator('#plCol-todo .plcard')).toHaveCount(2);
  await page.locator('#plCol-todo .plcard', { hasText: 'Design the wall plate' }).dragTo(page.locator('#plCol-doing'));
  await expect(page.locator('#plCol-doing .plcard')).toHaveCount(1);
  // the AI tracker (stubbed reply: the real one is a Claude call)
  const firmware = await page.evaluate(() => (window as any).formframe.project.plan.tasks.find((t: any) => t.title.startsWith('Finish')).id);
  await page.route('**/api/plan', r => r.fulfill({ json: {
    summary: 'The thermostat code runs and every part responds.', nextStep: 'Make the wall plate thicker for screws.',
    taskUpdates: [{ id: firmware, status: 'done', evidence: 'main.py ran without errors and Test it passed.' }],
    completed: [{ title: 'Wire all 8 parts', area: 'electronics', evidence: 'Milestone "Wire every part" reached.' }],
    suggestions: [{ title: 'Add a pairing screen', area: 'interactions', why: 'There is no way to set up Wi-Fi yet.' }], risks: [],
  } }));
  await page.click('#plAiBtn');
  await expect(page.locator('#plAi')).toContainText('every part responds');
  const done = page.locator('#plCol-done .plcard');
  await expect(done).toHaveCount(2);
  await expect(done.filter({ hasText: 'Finish the thermostat firmware' })).toContainText('Test it passed');
  await page.locator('.plsg', { hasText: 'pairing screen' }).locator('button.primary').click();
  await expect(page.locator('#plCol-todo .plcard', { hasText: 'pairing screen' })).toHaveCount(1);
  await page.click('#plUndo');
  await expect(page.locator('#plCol-done .plcard')).toHaveCount(0);
  // the plan is saved with the project
  await page.click('#bHome'); await page.reload(); await page.locator('.pcard').first().click(); await mode(page, 'plan');
  await expect(page.locator('#plCol-doing .plcard', { hasText: 'Design the wall plate' })).toHaveCount(1);
  expect(errs).toEqual([]);
});

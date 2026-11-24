import { test, expect } from '@playwright/test';
import { newProject, mode, errors } from './helpers';

// The Claude chat in Electronics. Claude's replies are stubbed (the server side is unit-tested).
test('Claude chat sees the project, proposes a change, and the change can be applied', async ({ page }) => {
  const errs = errors(page);
  const bodies: any[] = [];
  const nd = (...evs: unknown[]) => evs.map(e => JSON.stringify(e)).join('\n') + '\n';
  await page.route('**/api/assistant', r => {
    const body = r.request().postDataJSON(); bodies.push(body);
    if (bodies.length === 1) return r.fulfill({ contentType: 'application/x-ndjson', body: nd(
      { t: 'text', d: 'I will make it ' }, { t: 'text', d: 'print a greeting.' },
      { t: 'done', stop: 'tool_use', content: [{ type: 'text', text: 'I will make it print a greeting.' }, { type: 'tool_use', id: 'tu1', name: 'write_file', input: { path: 'main.py', content: 'print("hello from Claude")\n', summary: 'Print a greeting' } }],
        edits: [{ id: 'tu1', path: 'main.py', content: 'print("hello from Claude")\n', summary: 'Print a greeting' }] }) });
    return r.fulfill({ contentType: 'application/x-ndjson', body: nd({ t: 'done', stop: 'end_turn', content: [{ type: 'text', text: 'Glad it worked.' }], edits: [] }) });
  });
  await newProject(page, 'blank');
  await mode(page, 'elec');
  await page.click('#tabAsst');
  await expect(page.locator('#asLog')).toContainText('Ask Claude about this project');
  await page.fill('#asInput', 'Make it say hello'); await page.press('#asInput', 'Enter');
  await expect(page.locator('#asLog .asmsg.claude')).toContainText('print a greeting');
  // Claude saw the board and the code
  const first = bodies[0].messages[0].content.map((b: any) => b.text ?? '').join('\n');
  expect(first).toContain('<project_state>'); expect(first).toContain('## Board');
  // apply the proposed change
  const card = page.locator('.asedit', { hasText: 'main.py' });
  await expect(card).toContainText('Print a greeting');
  await card.locator('[data-app]').click();
  await expect(card).toContainText('Applied');
  expect(await page.evaluate(() => (window as any).formframe.project.electronics.files['main.py'])).toBe('print("hello from Claude")\n');
  // next turn: Claude's turn goes back unchanged, the tool call is answered, and the new code is sent
  await page.fill('#asInput', 'Thanks'); await page.click('#asSend');
  await expect(page.locator('#asLog')).toContainText('Glad it worked');
  const m = bodies[1].messages;
  expect(m).toHaveLength(3);
  expect(m[1]).toEqual({ role: 'assistant', content: bodies[0] && m[1].content });
  expect(m[1].content[1]).toMatchObject({ type: 'tool_use', id: 'tu1' });
  expect(m[2].content[0]).toEqual({ type: 'tool_result', tool_use_id: 'tu1', content: 'Applied.' });
  expect(m[2].content.map((b: any) => b.text ?? '').join('')).toContain('hello from Claude');
  // back to the serial monitor
  await page.click('#tabSerial');
  await expect(page.locator('#asstPane')).toBeHidden();
  expect(errs).toEqual([]);
});

test('Claude chat asks for the visitor\'s own key when the server needs one', async ({ page }) => {
  await page.route('**/api/assistant', r => r.fulfill({ status: 401, json: { error: 'AI features need your own Anthropic API key.', needKey: true } }));
  await page.route('**/api/ai-key', r => r.fulfill({ json: { ownKey: false, hint: null } }));
  await newProject(page, 'blank');
  await mode(page, 'elec');
  await page.click('#tabAsst');
  await page.fill('#asInput', 'Hello'); await page.press('#asInput', 'Enter');
  const dlg = page.locator('dialog.ffcode');
  await expect(dlg).toContainText('Add your own Anthropic API key');
  await dlg.locator('button[value=cancel]').click();
  await expect(page.locator('#asLog .asmsg.err')).toContainText('own Anthropic API key');
  await expect(page.locator('#asInput')).toHaveValue('Hello'); // kept for a retry
});

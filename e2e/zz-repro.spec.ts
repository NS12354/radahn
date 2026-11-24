import { test } from '@playwright/test';
import { home, mode } from './helpers';
test('repro', async ({ page }) => {
  await home(page);
  await page.click('#hRobots button[data-k="arm"]');
  await page.waitForFunction(() => !!(window as any).formframe?.projectId);
  await mode(page, 'elec');
  for (const t of ['button', 'oled']) await page.click(`#libList button[data-t="${t}"]`);
  await page.waitForTimeout(1500);
  const info = await page.evaluate(() => {
    const f = (window as any).formframe, uids = f.project.electronics.comps.filter((c: any) => c.type === 'button' || c.type === 'oled').map((c: any) => c.uid);
    const out: any[] = [];
    f.viewport.scene.traverse((o: any) => {
      const ud = JSON.stringify(o.userData ?? {});
      if (uids.some((u: string) => ud.includes(u) || (o.name ?? '').includes(u))) {
        const chain: string[] = []; let p = o; while (p) { chain.push(`${p.type}:${p.name || ''}:${Object.keys(p.userData || {}).join('/')}`); p = p.parent; }
        out.push({ name: o.name, ud, chain: chain.slice(0, 6) });
      }
    });
    return { uids, out: out.slice(0, 6), benchProduct: Object.keys(f.bench ?? {}).slice(0, 20) };
  });
  console.log('INFO', JSON.stringify(info));
});

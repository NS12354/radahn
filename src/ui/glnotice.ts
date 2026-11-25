/**
 * What the 3D view shows when it can't draw (no WebGL, a failed renderer, a lost GPU
 * context): what failed, that the project is safe, what still works, what to try, and
 * a retry. The rest of the studio keeps working underneath.
 */
import { webglAvailable, type Viewport } from '../scene/viewport';
import { esc, toast } from './dom';

export function glNotice(vp: Viewport, host: HTMLElement, opts: { works: string; summary?: () => string; go?: { label: string; act: () => void } }) {
  const box = document.createElement('div');
  box.className = 'glfail'; box.setAttribute('role', 'alert'); box.hidden = true;
  host.appendChild(box);
  const paint = (why: string | null) => {
    box.hidden = !why; if (!why) return;
    const sum = opts.summary?.() ?? '';
    box.innerHTML = `<div class="glcard">
      <h2>3D view unavailable</h2>
      <p class="glwhy">${esc(why)}</p>
      <p><b>Your project is safe.</b> ${esc(opts.works)}</p>
      ${sum ? `<div class="glsum">${sum}</div>` : ''}
      <details><summary>What to try</summary><ul>
        <li>Turn on hardware acceleration (Chrome or Edge: Settings → System → Use graphics acceleration), then retry.</li>
        <li>Update the browser, or open Formframe in Chrome, Edge or Firefox.</li>
        <li>On a work computer, a policy may block WebGL: ask IT, or use another device.</li>
      </ul></details>
      <div class="glacts">${opts.go ? `<button class="btn" data-go>${esc(opts.go.label)}</button>` : ''}<button class="btn primary" data-retry>Retry 3D</button></div>
    </div>`;
    box.querySelector<HTMLElement>('[data-retry]')!.onclick = () => {
      const r = webglAvailable();
      if (!r.ok) { toast(`Still unavailable: ${r.why}`); return; }
      if (window.confirm('3D is available now. Reload the page to start it? You will be asked about unsaved changes first.')) location.reload();
    };
    box.querySelector<HTMLElement>('[data-go]')?.addEventListener('click', () => opts.go!.act());
  };
  vp.onFailure = why => paint(why);
  paint(vp.failure);
  return { refresh: () => paint(vp.failure) };
}

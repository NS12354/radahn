/** Tools in the corner of the 3D view: render quality and photo mode. */
import type { App } from './app';
import { $, download, toast } from './dom';
import { startPhoto, type PhotoSession } from '../scene/photo';

let session: PhotoSession | null = null;

export function initViewTools(A: App) {
  const V = A.viewport;
  const stored = (() => { try { return localStorage.getItem('ff.quality'); } catch { return null; } })();
  if (stored === 'fast' || (!stored && softwareGpu(V.renderer))) V.quality = 'fast';
  const q = $('#vpQuality');
  const show = () => { q.textContent = V.quality === 'high' ? 'High quality' : 'Fast'; q.dataset.ico = V.quality === 'high' ? 'spark' : 'bolt'; q.classList.toggle('on', V.quality === 'high'); };
  show();
  q.onclick = () => { V.quality = V.quality === 'high' ? 'fast' : 'high'; try { localStorage.setItem('ff.quality', V.quality); } catch { /* private mode */ } show(); };

  const bar = $('#photoBar'), prog = $('#photoProg'), msg = $('#photoMsg');
  const TARGET = 300;
  $('#vpPhoto').onclick = () => {
    if (session) return;
    if (V.failure) { toast('Photo mode needs the 3D view, which isn\'t available here'); return; }
    bar.style.display = ''; $('#vpTools').style.display = 'none';
    msg.textContent = 'Path tracing… move nothing, it gets sharper every pass';
    session = startPhoto(V, n => { if (n < 0) { msg.textContent = 'Preparing the scene for path tracing (a few seconds on a GPU)…'; return; } prog.style.width = `${Math.min(100, (n / TARGET) * 100)}%`; msg.textContent = n >= TARGET ? `Done: ${n} samples` : `Path tracing: ${n} / ${TARGET} samples`; }, TARGET);
  };
  $('#photoSave').onclick = () => {
    if (!session) return;
    const url = session.save();
    fetch(url).then(r => r.blob()).then(b => download(`${A.project.name.replace(/[^\w-]+/g, '_') || 'formframe'}-photo.png`, b, 'image/png'));
    toast('Saved the photo');
  };
  const close = () => { session?.stop(); session = null; bar.style.display = 'none'; $('#vpTools').style.display = ''; };
  $('#photoClose').onclick = close;
  // leaving the view (mode switch, orbit) ends the photo
  V.renderer.domElement.addEventListener('pointerdown', () => { if (session) close(); });
}

/** No real GPU (SwiftShader, llvmpipe …): start in Fast so the studio stays responsive. */
function softwareGpu(r: { getContext(): WebGLRenderingContext | WebGL2RenderingContext }) {
  try {
    const gl = r.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
    return /swiftshader|llvmpipe|software|basic render/i.test(name);
  } catch { return false; }
}

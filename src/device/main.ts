import './device.css';
import { connect, on, pid, state } from './client';
import { Workspace } from './workspace';
import { mountThonny } from './thonny';
import { mountArduino } from './arduino';
import { mountPiDesktop } from './pidesktop';

/**
 * Device window: the coding environment you'd use with the selected board.
 *   Raspberry Pi (Linux)   → Raspberry Pi OS-style desktop with Thonny, Terminal, Files
 *   Pico / ESP32 (MicroPython) → Thonny
 *   Arduino Uno            → Arduino IDE 2-style editor
 * The studio window runs the code; this window edits and controls it.
 */
const root = document.getElementById('dev')!;
async function boot() {
  const s = await connect();
  if (!s) {
    root.className = 'nostudio';
    root.innerHTML = `<div class="nsbox"><h2>Open the studio first</h2><p>This window edits and runs code through the Formframe studio, which runs the board emulator and the 3D model. Keep the studio open with this project.</p><button>Open the studio</button></div>`;
    root.querySelector('button')!.onclick = () => { window.open(`${import.meta.env.BASE_URL}index.html?project=${encodeURIComponent(pid)}`, 'formframe-studio'); setTimeout(() => location.reload(), 2500); };
    return;
  }
  const ws = new Workspace();
  const lang = s.board.lang;
  document.body.dataset.lang = lang;
  if (lang === 'python') mountPiDesktop(root, ws);
  else if (lang === 'arduino') mountArduino(root, ws);
  else { document.title = `Thonny - ${s.name} @ ${s.board.name}`; mountThonny(root, ws, { pi: false }); }
  // the studio switched boards: reopen with the matching environment
  on('state', () => { if (state && state.board.lang !== lang) location.reload(); else if (state) document.body.dataset.board = state.board.id; });
  document.body.dataset.board = s.board.id;
}
boot();

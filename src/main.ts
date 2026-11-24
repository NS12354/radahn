import './styles.css';
import * as THREE from 'three';
import { Viewport } from './scene/viewport';
import { ParametricProduct } from './scene/parametric';
import { ImportedProduct, formatOf, loadCad } from './scene/imported';
import type { Product } from './scene/product';
import { Bench } from './hw/bench';
import { BOARDS } from './hw/library/boards';
import { audio } from './hw/audio';
import { blankProject, defaultProject, parseProject, serializeProject, type Project } from './app/project';
import { deleteProject, getMeta, loadProject, migrateLegacy, newProjectId, saveProject, journalWrite, journalClear, journalRecover } from './app/store';
import { EmptyProduct } from './scene/empty';
import { BuiltProduct } from './scene/built';
import { initRobot, robotFrame } from './ui/robot';
import { robotProject, type RobotKind } from './app/robots';
import { ElectronicsView } from './scene/electronics';
import { gizmoBusy, initModeler, newBuiltModel, runAutoBuild, syncGizmo } from './ui/modeler';
import { atHome, initHome, renderHome, showHome, hideHome } from './ui/home';
import { endTour, initTour, startTour, tourSeen, touring } from './ui/tour';
import { listen, modelerUrl, post } from './app/sync';
import { BlenderLink } from './app/blenderlink';
import { initDeviceBridge, notifyDevice } from './ui/devicebridge';
import { initHealth, refreshStatic, resetHealth } from './ui/health';
import { initGitHub, showGitHub } from './ui/github';
import { displayComps } from './app/screenpart';
import { initClaude, claudeFilesChanged, claudeContextChanged, closeClaude } from './ui/claude';
import { initPlan, render as renderPlan, resetPlanUndo } from './ui/plan';
import { track } from './ui/track';
import type { App, Mode } from './ui/app';
import { $, $$, b64decode, b64encode, closeModal, copyText, download, modal, toast } from './ui/dom';
import { initDesign, renderDesign } from './ui/design';
import { armIdle, drawGraph, fire, initProto, redrawScreen, renderLive, renderScreens, renderTrs, stopIdle } from './ui/proto';
import { drawWires, elecDial, elecFrame, elecPress, initElec, renderElec, stopElec } from './ui/elec';
import { addComment, placePins, renderComments, renderPins } from './ui/review';
import { exportFirmware } from './proto/stateMachine';

const BASE = import.meta.env.BASE_URL;

const HINTS: Record<Mode, string> = {
  design: '<b>Design</b> · click a part to edit it · import your own CAD from the Project menu or the left panel',
  proto: '<b>Prototype</b> · drag the dial to turn · click the display to press · hold to long-press',
  elec: '<b>Electronics</b> · wire a board, press <b>Run</b>, then turn the dial and press the display: they drive the firmware',
  review: '<b>Review</b> · click the model to pin a comment',
  plan: '<b>Plan</b> · what\'s done and what\'s left',
  github: '<b>GitHub</b> · drag code from your repositories into Electronics',
};

class FormframeApp implements App {
  project: Project;
  viewport: Viewport;
  product!: Product;
  bench: Bench;
  mode: Mode = 'design';
  sm = { state: 'home', target: 22, room: 20.5 };
  base = BASE;
  selected: string | null = null;
  private exploded = false;
  /** Wired electronics, shown in the exploded view. */
  private elec = new ElectronicsView();
  private elecT: any = null;
  private devT: any = null;
  private hT: any = null;
  private clT: any = null;
  private saveT: any = null;
  private dirHandle: any = null;
  /** Store id of the open project; null for a scratch session (the tour) that is never saved. */
  projectId: string | null = null;
  private lastThumb = 0;

  constructor() {
    this.project = blankProject();
    this.viewport = new Viewport($('#viewport'));
    this.bench = new Bench(this.board(), this.project.env, null);
  }

  board() { return BOARDS[this.project.electronics.board]; }

  async boot() {
    await migrateLegacy();
    const restored = await journalRecover();
    if (restored) setTimeout(() => toast(`Recovered unsaved changes from your last session`), 800);
    await this.rebuildProduct();
    initModeler(this);
    initDeviceBridge(this, () => this.projectId);
    initHealth(this);
    initPlan(this);
    initGitHub(this);
    initClaude(this);
    initDesign(this, f => this.importCad(f));
    initProto(this);
    initElec(this);
    initRobot(this);
    this.wireUI();
    this.renderAll();
    this.setMode('design');
    this.viewport.onTick((dt, now) => { robotFrame(dt); this.product.tick(dt, now); this.elec.tick(dt); elecFrame(dt); placePins(this); });
    if (document.fonts?.ready) document.fonts.ready.then(() => { if (this.mode !== 'elec') redrawScreen(this); });
    initTour(m => this.setMode(m));
    initHome({
      openProject: id => this.openProject(id),
      newBlank: board => this.createProject(blankProject(board), 'Blank project'),
      newExample: () => this.createProject(defaultProject(), 'The First Step'),
      newRobot: (k: string) => this.createProject(robotProject(k as RobotKind), robotProject(k as RobotKind).name),
      openFile: () => $('#fileProject').click(),
      openFolder: () => this.openFolder(),
      duplicateProject: id => this.duplicateProject(id),
      deleteProject: (id, name) => this.removeProject(id, name),
      startTour: () => this.tourFromHome(),
    });
    $('#hTour').classList.toggle('nudge', !tourSeen());
    listen(m => {
      if (m.type === 'built' && m.id === this.projectId) this.syncBuilt();
      if (m.type === 'blender-open' && m.id === this.projectId) this.openBlender();
    });
    const want = new URLSearchParams(location.search).get('project');
    if (want && await getMeta(want)) { history.replaceState(null, '', location.pathname); await this.openProject(want); }
    else showHome();
  }

  changed(what?: string) {
    if (what === 'electronics' || what === 'product') { clearTimeout(this.hT); this.hT = setTimeout(() => refreshStatic(), 150); }
    if (what === 'electronics' || what === 'meta') { clearTimeout(this.devT); this.devT = setTimeout(() => notifyDevice(), 200); }
    if (what === 'electronics' || what === 'product') { clearTimeout(this.elecT); this.elecT = setTimeout(() => this.refreshElectronics(), 150); }
    if (what === 'electronics') { clearTimeout(this.clT); this.clT = setTimeout(() => { claudeFilesChanged(); claudeContextChanged(); }, 250); }
    clearTimeout(this.saveT);
    this.saveT = setTimeout(() => this.flush(), 400);
  }

  /** Write the open project to the store now. Refreshes the thumbnail at most every few seconds. */
  async flush(forceThumb = false, edited = true) {
    clearTimeout(this.saveT); this.saveT = null;
    if (!this.projectId) return;
    let thumb: string | null | undefined;
    if (!atHome() && (forceThumb || Date.now() - this.lastThumb > 5000)) { thumb = this.thumbnail(); this.lastThumb = Date.now(); }
    const b = this.project.product.built;
    if (b) { const sig = JSON.stringify({ ...b, rev: 0 }); if (sig !== this.builtSig) { b.rev = (b.rev ?? 0) + 1; this.builtSig = sig; } }
    try { await saveProject(this.projectId, this.project, thumb, edited); journalClear(this.projectId); post({ type: 'saved', id: this.projectId }); this.blender.changed(); }
    catch (e: any) { toast('Could not save: ' + (e?.message ?? e)); }
  }

  /** The modeler window saved a newer built model: show it here without reframing the camera. */
  private async syncBuilt() {
    const id = this.projectId; if (!id) return;
    const p = await loadProject(id); const nb = p?.product.built;
    if (!p || !nb || id !== this.projectId) return;
    if ((nb.rev ?? 0) <= (this.project.product.built?.rev ?? -1)) return;
    if (this.saveT) await this.flush(false); // keep our own pending edits (name, wiring…) before taking the model
    this.project.product.built = nb; this.project.product.source = 'built';
    this.builtSig = JSON.stringify({ ...nb, rev: 0 });
    if (this.product instanceof BuiltProduct) { this.product.model = nb; this.product.build(); this.selected = null; renderDesign(this); }
    else { await this.rebuildProduct(); renderDesign(this); }
    this.refreshElectronics();
    track('model', 'Edited the model in the 3D modeler');
    this.blender.changed();
  }
  private builtSig = '';

  // ------------------------------------------------------------ Blender live link
  blender = new BlenderLink({
    projectId: () => this.projectId,
    projectName: () => this.project.name,
    built: () => this.project.product.built,
    apply: async (b, note) => {
      this.project.product.built = b; this.project.product.source = 'built';
      if (this.product instanceof BuiltProduct) { this.product.model = b; this.product.build(); renderDesign(this); }
      else { await this.rebuildProduct(); renderDesign(this); }
      this.refreshElectronics();
      track('model', note);
      await this.flush(false, true);
      toast(note);
    },
    status: s => {
      const btn = $('#bBlender'); btn.classList.toggle('on', s.linked);
      btn.innerHTML = s.linked ? `<i style="${s.blender ? '' : 'opacity:.4'}"></i>Blender` : 'Blender ↗';
      btn.title = s.linked ? `${s.text}. Click to stop the link.` : 'Open this project in Blender with a live two-way link';
    },
  }, BASE);
  async openBlender() {
    if (!this.projectId) { toast('Open a saved project first'); return; }
    if (!this.project.product.built) { this.project.product.built = newBuiltModel(); this.project.product.source = 'built'; await this.rebuildProduct(); renderDesign(this); }
    await this.flush(false, !!this.saveT);
    try { const r = await this.blender.open(); toast(r.already ? 'Linked with the open Blender window' : 'Starting Blender with the Formframe link…'); }
    catch (e: any) { toast(e.message); }
  }

  /** The board's own coding environment (Pi desktop, Thonny or Arduino IDE) in its own window. */
  private openDevice() {
    if (!this.projectId) { toast('Save this as a project first (the tour runs on a scratch copy)'); return; }
    const w = window.open(`${BASE}device.html?project=${encodeURIComponent(this.projectId)}`, 'ffdevice-' + this.projectId);
    if (!w) toast('The browser blocked the window. Allow pop-ups for this site.');
    this.flush(false, !!this.saveT);
  }

  private async openModeler() {
    if (!this.projectId) { toast('Save this as a project first (the tour runs on a scratch copy)'); return; }
    // open first: browsers only allow popups straight from the click, not after an await
    const w = window.open(modelerUrl(BASE, this.projectId), 'ffmodeler-' + this.projectId);
    if (!w) toast('The browser blocked the modeler window. Allow pop-ups for this site.');
    this.flush(true, !!this.saveT); // the modeler reloads when this save lands
  }

  private thumbnail(): string | null {
    if (this.product instanceof EmptyProduct) return null;
    const src = this.viewport.renderer.domElement, W = 400, H = 250;
    if (!src.width || !src.height) return undefined as any;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d')!;
    const bg = g.createRadialGradient(W / 2, H * 0.4, 0, W / 2, H * 0.4, W * 0.6); bg.addColorStop(0, '#3a3a3e'); bg.addColorStop(1, '#232325');
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    const k = Math.max(W / src.width, H / src.height), w = src.width * k, h = src.height * k;
    g.drawImage(src, (W - w) / 2, (H - h) / 2, w, h);
    return c.toDataURL('image/jpeg', 0.8);
  }

  // ------------------------------------------------------------ project library
  private async openProject(id: string) {
    try {
      const p = await loadProject(id);
      if (!p) { toast('That project could not be found'); renderHome(); return; }
      this.dirHandle = null;
      await this.load(p, 'Opened ' + p.name, id);
    } catch (e: any) { toast('Could not open: ' + e.message); }
  }
  /** Add a project to the library and open it. */
  private async createProject(p: Project, msg: string) {
    const id = newProjectId();
    await saveProject(id, p, null);
    await this.load(p, msg, id);
    if (p.product.source === 'none') this.setMode('design');
  }
  private async duplicateProject(id: string) {
    const p = await loadProject(id), meta = await getMeta(id);
    if (!p) return;
    p.name = p.name + ' copy';
    await saveProject(newProjectId(), p, meta?.thumb ?? null);
    toast('Duplicated'); renderHome();
  }
  private async removeProject(id: string, name: string) {
    if (!window.confirm?.(`Delete "${name}"? This can't be undone. Download it first from the Project menu if you want a copy.`)) return;
    await deleteProject(id);
    if (this.projectId === id) this.projectId = null;
    renderHome();
  }
  async goHome() {
    if (touring()) endTour();
    if (document.body.classList.contains('present')) $('#bPresent').click();
    await this.flush(true, !!this.saveT);
    stopElec(); stopIdle(); closeClaude();
    this.dirHandle = null;
    this.blender.stop();
    showHome();
  }
  private async tourFromHome() {
    // Run the tour on a fresh copy of the example that is not saved, so the walkthrough has something to show.
    const p = defaultProject(); p.name = 'Tour: The First Step';
    await this.load(p, 'Tutorial', null);
    startTour(() => { $('#hTour').classList.remove('nudge'); if (!this.projectId) this.goHome(); });
  }

  async rebuildProduct() {
    if (this.product) { this.viewport.scene.remove(this.product.group); this.product.dispose(); }
    const imp = this.project.product.imported;
    if (this.project.product.source === 'built' && !this.project.product.built) this.project.product.source = 'none';
    if (this.project.product.source === 'none') this.product = new EmptyProduct();
    else if (this.project.product.source === 'built') this.product = new BuiltProduct(this.project.product.built!, displayComps(this.project));
    else if (this.project.product.source === 'imported' && imp?.data) {
      try {
        const root = await loadCad(b64decode(imp.data), imp.format, BASE);
        this.product = new ImportedProduct(root, imp.bindings);
      } catch (e: any) {
        toast('Could not load the CAD model: ' + e.message);
        this.project.product.source = 'parametric';
        this.product = new ParametricProduct(this.project);
      }
    } else this.product = new ParametricProduct(this.project);
    this.viewport.scene.add(this.product.group);
    const empty = this.product instanceof EmptyProduct;
    document.body.classList.toggle('no-model', empty);
    this.viewport.scene.getObjectByName('__ground')!.visible = !empty;
    this.bench.product = this.product;
    this.bench.load(this.board(), this.project.electronics.comps);
    this.selected = null;
    if (this.mode !== 'elec') redrawScreen(this);
    this.viewport.frame(this.product.group);
    this.refreshElectronics();
    refreshStatic();
  }

  /** (Re)build the exploded-view electronics for the current product and wiring. */
  refreshElectronics() {
    const p = this.product; if (!p) return;
    if (p instanceof BuiltProduct) p.setDisplays(displayComps(this.project));
    const skip = new Set<string>();
    if (p instanceof BuiltProduct) for (const part of this.project.product.built?.parts ?? []) if (part.kind === 'internal' && part.comp) skip.add(part.comp);
    // imported models are normalised to ~8 units across; everything else is 1 unit = 10 mm
    const scale = p instanceof ImportedProduct ? 0.07 : 0.1;
    this.elec.build(this.project, scale, skip);
    if (p instanceof BuiltProduct) { // label the electronics the model already contains
      const seen = new Set<string>(), boardName = BOARDS[this.project.electronics.board]?.name ?? 'Board';
      const labels = (this.project.product.built?.parts ?? []).filter(x => x.kind === 'internal' && x.comp && !/connector|standoff|chip/i.test(x.name) && !seen.has(x.comp) && seen.add(x.comp))
        .map(x => ({ obj: p.roots.get(x.id)!, text: x.comp === 'board' ? boardName : x.name.replace(/ \(under display\)| module| PCB$/, ''), above: x.size[1] / 2 })).filter(e => e.obj);
      this.elec.attachLabels(labels);
    }
    if (this.elec.group.parent !== p.group) p.group.add(this.elec.group);
    if (p instanceof ParametricProduct) p.genericInternals = this.elec.count === 0;
    this.elec.explode(this.exploded ? 1 : 0); p.explode(this.exploded ? 1 : 0);
  }

  selectPart(part: string | null) {
    this.selected = part;
    this.product.highlight(this.mode === 'design' ? part : null);
    renderDesign(this);
  }

  setMode(m: Mode) {
    const prev = this.mode;
    this.mode = m;
    document.body.className = document.body.className.replace(/m-\w+/, 'm-' + m);
    $$('#modes button').forEach(b => b.classList.toggle('on', b.dataset.m === m));
    $('#hint').innerHTML = document.body.classList.contains('present') ? 'Drag the dial · press the display' : HINTS[m];
    if (prev === 'elec' && m !== 'elec') { stopElec(); this.product.setLeds(null); redrawScreen(this); }
    if (m === 'elec' && prev !== 'elec') {
      renderElec(this);
      const g = this.product.screen.getContext('2d')!; g.fillStyle = '#000'; g.fillRect(0, 0, 512, 512);
      g.fillStyle = '#3a3f47'; g.font = '500 22px Inter'; g.textAlign = 'center'; g.fillText('Display off · press Run', 256, 256); this.product.screenUpdated();
    }
    stopIdle(); if (m === 'proto') armIdle(this);
    if (m === 'plan') renderPlan();
    if (m === 'github') showGitHub();
    syncGizmo(this);
    this.product.highlight(m === 'design' ? this.selected : null);
    renderPins(this); renderLive(this);
  }

  renderAll() {
    ($('#pname') as HTMLInputElement).value = this.project.name;
    renderDesign(this); renderLive(this); renderScreens(this); renderTrs(this); drawGraph(this); renderComments(this);
    if (this.mode === 'elec') renderElec(this);
  }

  /** Show a project in the editor. `id` is its store id, or null for an unsaved scratch session. */
  async load(p: Project, msg: string, id: string | null) {
    stopElec();
    if (id !== this.projectId) closeClaude();
    if (this.projectId && this.projectId !== id) await this.flush(true, !!this.saveT);
    if (this.blender.linked && id !== this.projectId) this.blender.stop();
    this.projectId = id; this.lastThumb = 0;
    this.project = p;
    if (id) this.blender.resume(id);
    setTimeout(() => notifyDevice(), 0);
    resetHealth(); resetPlanUndo();
    this.builtSig = p.product.built ? JSON.stringify({ ...p.product.built, rev: 0 }) : '';
    this.bench.env = p.env;
    this.sm = { state: 'home', target: 22, room: p.env.roomC };
    await this.rebuildProduct();
    this.renderAll();
    renderElec(this);
    this.setMode(this.mode);
    hideHome(); this.viewport.resize(); toast(msg);
    if (id) setTimeout(() => { if (this.projectId === id && !this.saveT) this.flush(true, false); }, 800); // first thumbnail once rendered
  }
  /** Bring an outside project (file, folder, drop) into the library. */
  private async importProject(p: Project, msg: string) {
    const id = newProjectId();
    await saveProject(id, p, null);
    await this.load(p, msg, id);
  }

  async importCad(f: File) {
    const fmt = formatOf(f.name);
    if (!fmt) { toast('Unsupported file. Use GLB, GLTF, STL or STEP.'); return; }
    if (f.size > 60e6) { toast('Model is over 60 MB. Decimate it first.'); return; }
    toast(`Importing ${f.name}…`);
    const buf = await f.arrayBuffer();
    try {
      const root = await loadCad(buf, fmt, BASE);
      this.project.product.source = 'imported';
      this.project.product.imported = { fileName: f.name, format: fmt, data: b64encode(buf), bindings: {} };
      if (this.product) { this.viewport.scene.remove(this.product.group); this.product.dispose(); }
      this.product = new ImportedProduct(root, this.project.product.imported.bindings);
      this.viewport.scene.add(this.product.group);
      document.body.classList.remove('no-model');
      this.viewport.scene.getObjectByName('__ground')!.visible = true;
      this.bench.product = this.product;
      this.bench.load(this.board(), this.project.electronics.comps);
      this.viewport.frame(this.product.group);
      this.setMode('design'); this.selectPart(null); redrawScreen(this);
      this.refreshElectronics();
      track('model', `Imported the CAD model ${f.name}`);
      this.changed('product');
      toast(`${f.name}: ${(this.product as ImportedProduct).meshes.size} meshes. Assign roles in the Parts list.`);
    } catch (e: any) { toast('Import failed: ' + e.message); }
  }

  private partName(o: THREE.Object3D) {
    const k = this.product.partOf(o);
    if (this.product instanceof ParametricProduct) return this.project.product.parametric.parts[k as 'body']?.name ?? 'Part';
    if (this.product instanceof BuiltProduct) return this.project.product.built?.parts.find(p => p.id === k)?.name ?? 'Part';
    return k.split('#')[0];
  }

  /** Switch to an in-app built model: the one this project had before, or a fresh housing. */
  async startBuild() {
    const pr = this.project.product;
    if (pr.source === 'built') { toast('Already building: add shapes from the left panel'); return; }
    if ((pr.source === 'parametric' || pr.source === 'imported') && !window.confirm?.('Switch this project to a model you build from shapes? The current model is kept, and you can switch back from the Project menu.')) return;
    const fresh = !pr.built;
    pr.built ??= newBuiltModel();
    pr.source = 'built';
    await this.rebuildProduct();
    this.setMode('design');
    this.selectPart(fresh ? pr.built.parts[0]?.id ?? null : null);
    renderDesign(this); this.changed('product');
    track('model', fresh ? 'Started building a model' : 'Switched back to the built model');
    toast(fresh ? 'Started with a housing. Add shapes from the left panel.' : 'Back to your built model');
  }

  // ------------------------------------------------------------ project files
  private async saveFolder() {
    const w = window as any;
    if (!w.showDirectoryPicker) { toast('Folder save needs Chrome or Edge (File System Access API).'); return; }
    try {
      const dir = this.dirHandle ?? (this.dirHandle = await w.showDirectoryPicker({ mode: 'readwrite' }));
      const write = async (path: string, data: string | ArrayBuffer) => {
        const parts = path.split('/'); let d = dir;
        for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
        const fh = await d.getFileHandle(parts.at(-1)!, { create: true }); const ws = await fh.createWritable(); await ws.write(data); await ws.close();
      };
      const p: Project = JSON.parse(serializeProject(this.project));
      const fw = p.electronics.files; p.electronics.files = Object.fromEntries(Object.keys(fw).map(k => [k, `@file firmware/${k}`]));
      for (const [k, v] of Object.entries(fw)) await write('firmware/' + k, v);
      if (p.product.imported?.data) { await write('model/' + p.product.imported.fileName, b64decode(p.product.imported.data)); p.product.imported.data = `@file model/${p.product.imported.fileName}`; }
      await write('project.formframe.json', JSON.stringify(p, null, 2) + '\n');
      await write('.gitattributes', '*.glb binary\n*.step binary\n*.stl binary\n*.uf2 binary\n');
      toast(`Saved to folder ${dir.name}/`);
    } catch (e: any) { if (e.name !== 'AbortError') toast('Save failed: ' + e.message); }
  }
  private async openFolder() {
    const w = window as any;
    if (!w.showDirectoryPicker) { toast('Folder open needs Chrome or Edge.'); return; }
    try {
      const dir = await w.showDirectoryPicker({ mode: 'readwrite' });
      const read = async (path: string, bin = false) => {
        const parts = path.split('/'); let d = dir;
        for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p);
        const f = await (await d.getFileHandle(parts.at(-1)!)).getFile(); return bin ? f.arrayBuffer() : f.text();
      };
      const raw = JSON.parse(await read('project.formframe.json'));
      for (const [k, v] of Object.entries<string>(raw.electronics?.files ?? {})) if (v.startsWith('@file ')) raw.electronics.files[k] = await read(v.slice(6));
      if (raw.product?.imported?.data?.startsWith('@file ')) raw.product.imported.data = b64encode(await read(raw.product.imported.data.slice(6), true) as ArrayBuffer);
      await this.importProject(parseProject(JSON.stringify(raw)), `Opened ${dir.name}/`);
      this.dirHandle = dir;
    } catch (e: any) { if (e.name !== 'AbortError') toast('Open failed: ' + e.message); }
  }
  private saveDownload() {
    const name = this.project.name.replace(/[^\w-]+/g, '-').toLowerCase() + '.formframe.json';
    if (!download(name, serializeProject(this.project))) { copyText(serializeProject(this.project)); toast('Downloads are blocked here, so the project JSON was copied instead'); }
  }

  // ------------------------------------------------------------ UI wiring
  private wireUI() {
    $$('#modes button').forEach(b => (b.onclick = () => this.setMode(b.dataset.m as Mode)));
    $('#bHome').onclick = () => this.goHome();
    $('#bModeler').onclick = () => this.openModeler();
    $('#bIde').onclick = () => this.openDevice();
    $('#bBlender').onclick = () => { if (this.blender.linked) { this.blender.stop(); toast('Stopped the Blender link (Blender stays open)'); } else this.openBlender(); };
    $('#eImport').onclick = () => $('#fileCad').click();
    $('#eAuto').onclick = () => runAutoBuild();
    $('#eBuild').onclick = () => this.startBuild();
    $('#eParam').onclick = async () => { this.project.product.source = 'parametric'; await this.rebuildProduct(); renderDesign(this); this.changed('product'); };
    $$('#vpEmpty a[data-m]').forEach(a => (a.onclick = () => this.setMode(a.dataset.m as Mode)));
    // closing or hiding the tab: journal pending changes synchronously, then try the normal save
    const unload = () => { if (this.saveT && this.projectId) { journalWrite(this.projectId, this.project); this.flush(); } };
    document.addEventListener('visibilitychange', () => { if (document.hidden) unload(); });
    window.addEventListener('pagehide', unload);
    ($('#pname') as HTMLInputElement).oninput = e => { this.project.name = (e.target as HTMLInputElement).value; this.changed('meta'); };
    $('#bExplode').onclick = () => {
      this.exploded = !this.exploded; $('#bExplode').classList.toggle('on', this.exploded);
      this.product.explode(this.exploded ? 1 : 0); this.elec.explode(this.exploded ? 1 : 0);
      if (this.exploded && !this.elec.count && !this.project.electronics.comps.length && !(this.product instanceof BuiltProduct && this.project.product.built?.parts.some(x => x.kind === 'internal'))) toast('No electronics yet: wire a board and parts in Electronics to see them here');
    };
    $('#bPresent').onclick = () => {
      const on = !document.body.classList.contains('present');
      document.body.classList.toggle('present', on);
      $('#bPresent').textContent = on ? 'Exit present' : 'Present';
      this.setMode(on ? 'proto' : 'design'); this.viewport.resize();
    };
    const menu = $('#menu');
    $('#bMenu').onclick = e => { e.stopPropagation(); menu.classList.toggle('show'); };
    document.addEventListener('click', () => menu.classList.remove('show'));
    $$('#menu button').forEach(b => (b.onclick = async () => {
      menu.classList.remove('show');
      const a = b.dataset.a;
      if (a === 'home') this.goHome();
      if (a === 'newBlank') this.createProject(blankProject(this.project.electronics.board), 'Blank project');
      if (a === 'newExample') this.createProject(defaultProject(), 'The First Step');
      if (a === 'tour') startTour();
      if (a === 'open') $('#fileProject').click();
      if (a === 'openFolder') this.openFolder();
      if (a === 'save') this.saveDownload();
      if (a === 'saveFolder') this.saveFolder();
      if (a === 'copy') copyText(serializeProject(this.project));
      if (a === 'importCad') $('#fileCad').click();
      if (a === 'build') this.startBuild();
      if (a === 'modeler') this.openModeler();
      if (a === 'blender') this.openBlender();
      if (a === 'ide') this.openDevice();
      if (a === 'autobuild') runAutoBuild();
      if (a === 'parametric') { this.project.product.source = 'parametric'; await this.rebuildProduct(); renderDesign(this); this.changed('product'); }
      if (a === 'snapshot') { const url = this.viewport.snapshot(); if (!download(this.project.name + '.png', await (await fetch(url)).blob(), 'image/png')) toast('Downloads are blocked in this frame'); }
      if (a === 'firmware') modal('Interaction firmware (Arduino C++)', '· generated from the interaction table', exportFirmware(this.project.interactions, this.project.name, this.sm.target));
    }));
    ($('#fileProject') as HTMLInputElement).onchange = async e => {
      const f = (e.target as HTMLInputElement).files?.[0]; if (!f) return;
      try { await this.importProject(parseProject(await f.text()), 'Opened ' + f.name); } catch (err: any) { toast(err.message); }
      (e.target as HTMLInputElement).value = '';
    };
    ($('#fileCad') as HTMLInputElement).onchange = e => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) this.importCad(f); (e.target as HTMLInputElement).value = ''; };
    $('#mClose').onclick = closeModal;
    $('#modal').onclick = e => { if ((e.target as HTMLElement).id === 'modal') closeModal(); };
    $('#mCopy').onclick = () => copyText($('#mBody').textContent ?? '');
    window.addEventListener('keydown', e => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); if (atHome()) return; this.dirHandle ? this.saveFolder() : this.saveDownload(); }
      if (e.key === 'Escape') { if ($('#modal').classList.contains('show')) closeModal(); else if (document.body.classList.contains('present')) $('#bPresent').click(); }
    });
    window.addEventListener('dragover', e => e.preventDefault());
    window.addEventListener('drop', e => {
      e.preventDefault();
      const f = e.dataTransfer?.files[0]; if (!f) return;
      if (f.name.endsWith('.json')) f.text().then(t => this.importProject(parseProject(t), 'Opened ' + f.name)).catch(err => toast(err.message));
      else if (formatOf(f.name) && !atHome()) this.importCad(f);
    });
    this.wirePointer();
  }

  private wirePointer() {
    const vp = $('#viewport'), cv = this.viewport.renderer.domElement;
    let down: { x: number; y: number } | null = null, drag: any = null, pressTimer: any = null, longFired = false;
    const centerPx = () => this.viewport.project(this.product.dialCenter());
    vp.addEventListener('pointerdown', e => {
      if (e.target !== cv) return;
      down = { x: e.clientX, y: e.clientY };
      audio.unlock();
      if (this.mode !== 'proto' && this.mode !== 'elec') return;
      const h = this.viewport.hit(e, this.product.pickables()); if (!h) return;
      const role = this.product.roleOf(h.object);
      if (role === 'dial') { this.viewport.controls.enabled = false; const c = centerPx(); drag = { type: 'dial', c, last: Math.atan2(e.clientY - c.y, e.clientX - c.x), acc: 0 }; }
      else if (role === 'press' || role === 'screen' || role === 'led') {
        this.viewport.controls.enabled = false; drag = { type: 'press' }; longFired = false; this.product.setPressed(true);
        if (this.mode === 'elec') elecPress(true); else pressTimer = setTimeout(() => { longFired = true; fire(this, 'long'); }, 600);
      }
    }, true);
    window.addEventListener('pointermove', e => {
      if (!drag || drag.type !== 'dial') return;
      const a = Math.atan2(e.clientY - drag.c.y, e.clientX - drag.c.x);
      let d = a - drag.last; if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI;
      drag.last = a; drag.acc += d; this.product.rotateDial(d);
      const step = Math.PI / 10;
      while (drag.acc > step) { drag.acc -= step; this.mode === 'elec' ? elecDial(1) : fire(this, 'dial_cw'); }
      while (drag.acc < -step) { drag.acc += step; this.mode === 'elec' ? elecDial(-1) : fire(this, 'dial_ccw'); }
    });
    window.addEventListener('pointerup', e => {
      if (drag?.type === 'press') { clearTimeout(pressTimer); this.product.setPressed(false); if (this.mode === 'elec') elecPress(false); else if (!longFired) fire(this, 'press'); }
      const wasDrag = !!drag; drag = null; this.viewport.controls.enabled = true;
      if (!down || e.target !== cv) { down = null; return; }
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4; down = null;
      if (moved || wasDrag || gizmoBusy()) return;
      const h = this.viewport.hit(e, this.product.pickables());
      if (this.mode === 'design') this.selectPart(h ? this.product.partOf(h.object) : null);
      else if (this.mode === 'review' && h) addComment(this, h.point as THREE.Vector3, this.partName(h.object));
    });
    new ResizeObserver(() => { if (this.mode === 'elec') drawWires(); }).observe($('#bottom'));
  }
}

const app = new FormframeApp();
(window as any).formframe = app; // handy for debugging from the console
app.boot();

import * as THREE from 'three';
import type { Project } from '../app/project';
import { autoBuild } from '../app/autobuild';
import { defaultAutoOpts } from '../app/project';
import { BOARDS } from '../hw/library/boards';
import { shapeGeometry } from './built';
import { FINISHES } from './parametric';

/**
 * The wired electronics (dev board + every part on the bench), shown in the
 * exploded view. Positions and sizes come from auto build's layout, so it
 * matches what an auto-built enclosure would hold; parts the model already
 * contains (auto-built internals) are skipped. Each layer slides out along
 * the product's front axis and gets a name label.
 */
export class ElectronicsView {
  group = new THREE.Group();
  private items: { o: THREE.Object3D; z: number; layer: number }[] = [];
  private labels: THREE.Sprite[] = [];
  private t = 0;
  private goal = 0;
  private step = 1;
  count = 0;

  constructor() { this.group.visible = false; this.group.name = 'electronics'; }

  /** Rebuild from the project's wiring. `scale` = scene units per mm; `skip` = comp ids the model already shows. */
  build(p: Project, scale: number, skip: Set<string>) {
    this.clear();
    const board = BOARDS[p.electronics.board];
    if (!board) return;
    const r = autoBuild(board, p.electronics.comps, p.product.built?.auto ?? defaultAutoOpts());
    const parts = r.parts.filter(x => x.kind === 'internal' && !skip.has(x.comp ?? ''));
    this.group.scale.setScalar(scale);
    const depth = r.size[2];
    this.step = Math.max(10, Math.min(40, depth * 0.7));
    const labelled = new Set<string>();
    for (const part of parts) {
      const f = FINISHES[part.finish] ?? FINISHES.satin;
      const mesh = new THREE.Mesh(shapeGeometry(part), new THREE.MeshStandardMaterial({ color: part.color, roughness: f.r, metalness: f.m }));
      mesh.position.set(...part.pos);
      mesh.rotation.set(...part.rot.map(d => d * Math.PI / 180) as [number, number, number]);
      // electronics layers: front parts (1) → board (0) → packed modules (−1)
      const layer = part.comp === 'board' ? 0 : part.layer ?? 0;
      this.group.add(mesh);
      this.items.push({ o: mesh, z: part.pos[2], layer });
      const key = part.comp ?? part.name;
      if (!labelled.has(key) && !/connector|standoff|chip/i.test(part.name)) {
        labelled.add(key);
        const label = this.label(part.comp === 'board' ? board.name : part.name.replace(/ \(under display\)| module| PCB$/, ''), scale);
        label.position.set(part.pos[0], part.pos[1] + part.size[1] / 2 + 3, part.pos[2]);
        this.group.add(label);
        this.items.push({ o: label, z: part.pos[2], layer });
        this.labels.push(label);
      }
    }
    this.count = parts.length;
  }

  /** Name labels for electronics that are real parts of a built model (they move with the part when exploded). */
  attachLabels(entries: { obj: THREE.Object3D; text: string; above: number }[]) {
    for (const e of entries) {
      const l = this.label(e.text, e.obj.getWorldScale(new THREE.Vector3()).x || 1); l.position.set(0, e.above + 3, 0); l.userData.overlay = true;
      e.obj.add(l); this.labels.push(l); this.attached.push(l);
    }
  }
  private attached: THREE.Sprite[] = [];

  private label(text: string, parentScale = 1) {
    const c = document.createElement('canvas'), g = c.getContext('2d')!, fs = 26;
    g.font = `500 ${fs}px Inter, system-ui, sans-serif`;
    const w = Math.ceil(g.measureText(text).width) + 22; c.width = w; c.height = fs + 16;
    g.font = `500 ${fs}px Inter, system-ui, sans-serif`;
    g.fillStyle = 'rgba(16,17,20,.82)'; g.beginPath(); (g as any).roundRect?.(0, 0, w, c.height, 8) ?? g.rect(0, 0, w, c.height); g.fill();
    g.fillStyle = '#e8eaf0'; g.textBaseline = 'middle'; g.fillText(text, 11, c.height / 2 + 1);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, sizeAttenuation: false }));
    const k = 0.0145 / parentScale; // screen-size labels; cancel the mm→scene scale of the parent
    s.scale.set((w / c.height) * k, k, 1); s.center.set(0.5, 0); s.renderOrder = 20;
    return s;
  }

  explode(goal: number) { this.goal = goal; }

  tick(dt: number) {
    if (this.t !== this.goal) { const d = this.goal - this.t; this.t = Math.abs(d) < 0.002 ? this.goal : this.t + d * Math.min(1, dt * 7); }
    this.group.visible = this.t > 0.02 && this.count > 0;
    for (const l of this.attached) l.visible = this.t > 0.02;
    if (this.t <= 0.02) return;
    for (const it of this.items) it.o.position.z = it.z + it.layer * this.step * this.t;
    for (const l of this.labels) (l.material as THREE.SpriteMaterial).opacity = Math.min(1, this.t * 1.6);
  }

  clear() {
    for (const l of this.attached) { l.parent?.remove(l); l.material.map?.dispose(); l.material.dispose(); }
    this.attached = [];
    this.group.traverse((o: any) => { o.geometry?.dispose(); o.material?.map?.dispose(); o.material?.dispose(); });
    this.group.clear(); this.items = []; this.labels = []; this.count = 0;
  }
}

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { Product, type Role } from './product';
import type { BindRole } from '../app/project';

/**
 * A product built from your own CAD (GLB/GLTF/STL/STEP). Every mesh gets a
 * stable path; you bind meshes to roles (dial, screen, press, led) and the rest
 * of Formframe drives them exactly like the parametric model.
 */
export type CadFormat = 'glb' | 'gltf' | 'stl' | 'step';

export function formatOf(name: string): CadFormat | null {
  const e = name.toLowerCase().split('.').pop();
  if (e === 'glb') return 'glb'; if (e === 'gltf') return 'gltf'; if (e === 'stl') return 'stl';
  if (e === 'step' || e === 'stp') return 'step';
  return null;
}

let occtPromise: Promise<any> | null = null;
function loadOcct(base: string) {
  if (!occtPromise) occtPromise = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = base + 'vendor/occt-import-js.js';
    s.onload = () => (window as any).occtimportjs({ locateFile: (f: string) => base + 'vendor/' + f }).then(res, rej);
    s.onerror = () => rej(new Error('Failed to load the STEP importer'));
    document.head.appendChild(s);
  });
  return occtPromise;
}

export async function loadCad(data: ArrayBuffer, format: CadFormat, base: string): Promise<THREE.Object3D> {
  if (format === 'glb' || format === 'gltf') {
    const gltf = await new GLTFLoader().parseAsync(format === 'glb' ? data : new TextDecoder().decode(data), '');
    return gltf.scene;
  }
  if (format === 'stl') {
    const g = new STLLoader().parse(data);
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, new THREE.MeshPhysicalMaterial({ color: 0xd9d6d0, roughness: 0.6 }));
    m.name = 'stl';
    return m;
  }
  const occt = await loadOcct(base);
  const res = occt.ReadStepFile(new Uint8Array(data), { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: 0.002 });
  if (!res.success) throw new Error('Could not read the STEP file');
  const root = new THREE.Group();
  res.meshes.forEach((m: any, i: number) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(m.attributes.position.array, 3));
    if (m.attributes.normal) g.setAttribute('normal', new THREE.Float32BufferAttribute(m.attributes.normal.array, 3));
    else g.computeVertexNormals();
    g.setIndex(new THREE.Uint32BufferAttribute(Uint32Array.from(m.index.array), 1));
    const col = m.color ? new THREE.Color(m.color[0], m.color[1], m.color[2]) : new THREE.Color(0xd9d6d0);
    const mesh = new THREE.Mesh(g, new THREE.MeshPhysicalMaterial({ color: col, roughness: 0.55, metalness: 0.05 }));
    mesh.name = m.name || 'part' + i;
    root.add(mesh);
  });
  return root;
}

/** Give a mesh planar UVs across its two largest local extents (so a canvas maps onto it). */
function planarUVs(mesh: THREE.Mesh) {
  const g = mesh.geometry as THREE.BufferGeometry;
  g.computeBoundingBox();
  const b = g.boundingBox!, size = b.getSize(new THREE.Vector3());
  const axes = [0, 1, 2].sort((i, j) => size.getComponent(j) - size.getComponent(i));
  const [u, v] = axes; // two largest
  const pos = g.attributes.position;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const p = [pos.getX(i), pos.getY(i), pos.getZ(i)];
    uv[i * 2] = (p[u] - b.min.getComponent(u)) / (size.getComponent(u) || 1);
    uv[i * 2 + 1] = (p[v] - b.min.getComponent(v)) / (size.getComponent(v) || 1);
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

export class ImportedProduct extends Product {
  meshes = new Map<string, THREE.Mesh>();
  private origMat = new Map<string, THREE.Material | THREE.Material[]>();
  private screenMat = new THREE.MeshBasicMaterial({ map: this.screenTex, toneMapped: false });
  private dialPivot = new THREE.Group();
  private dialMeshes: THREE.Mesh[] = [];
  private ledMats: THREE.MeshStandardMaterial[] = [];
  private pressMeshes: THREE.Mesh[] = [];
  private sel: string | null = null;
  private root: THREE.Object3D;
  private pressBase = new Map<THREE.Mesh, THREE.Vector3>();

  constructor(root: THREE.Object3D, public bindings: Record<string, BindRole>) {
    super();
    // Normalise: centre, scale to ~8 units across, keep original orientation.
    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3()), centre = box.getCenter(new THREE.Vector3());
    const k = 8 / Math.max(size.x, size.y, size.z, 1e-6);
    root.position.sub(centre.multiplyScalar(k)); root.scale.multiplyScalar(k);
    const wrap = new THREE.Group(); wrap.add(root); this.group.add(wrap); this.group.add(this.dialPivot);
    this.root = root;
    let n = 0;
    root.updateMatrixWorld(true);
    root.traverse((o: any) => {
      if (!o.isMesh) return;
      const path = (o.name || 'mesh') + '#' + n++;
      o.userData.path = path;
      this.meshes.set(path, o);
      this.origMat.set(path, o.material);
    });
    this.applyBindings();
  }

  /** Re-apply role bindings after the user changes them. */
  applyBindings() {
    // restore
    for (const m of this.dialMeshes) { this.root.attach(m); }
    this.dialMeshes = []; this.ledMats = []; this.pressMeshes = []; this.pressBase.clear();
    for (const [path, m] of this.meshes) { m.material = this.origMat.get(path)!; m.visible = true; }
    const dial: THREE.Mesh[] = [];
    for (const [path, role] of Object.entries(this.bindings)) {
      const m = this.meshes.get(path); if (!m) continue;
      if (role === 'screen') { if (!m.geometry.attributes.uv) planarUVs(m); m.material = this.screenMat; }
      if (role === 'dial') dial.push(m);
      if (role === 'led') { const mat = new THREE.MeshStandardMaterial({ color: 0x15171b, emissive: 0, roughness: 0.5 }); m.material = mat; this.ledMats.push(mat); }
      if (role === 'press' || role === 'screen') { this.pressMeshes.push(m); this.pressBase.set(m, m.position.clone()); }
      if (role === 'ignore') m.visible = false;
    }
    // Dial pivots around the centre of its parts, about their thinnest world axis.
    if (dial.length) {
      const box = new THREE.Box3(); dial.forEach(m => box.expandByObject(m));
      const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
      const axis = s.x <= s.y && s.x <= s.z ? 'x' : s.y <= s.z ? 'y' : 'z';
      this.dialPivot.position.copy(this.group.worldToLocal(c.clone()));
      this.dialPivot.rotation.set(0, 0, 0);
      this.dialPivot.userData.axis = axis;
      this.dialPivot.updateMatrixWorld(true);
      dial.forEach(m => this.dialPivot.attach(m));
      this.dialMeshes = dial;
    }
    this.applyDial();
    this.highlight(this.sel);
  }

  private exGoal = 0;
  private exT = 0;
  explode(t: number) { this.exGoal = t; }
  tick(dt: number, now: number) {
    super.tick(dt, now);
    if (this.exT === this.exGoal) return;
    const d = this.exGoal - this.exT; this.exT = Math.abs(d) < 0.01 ? this.exGoal : this.exT + d * Math.min(1, dt * 7);
    const op = 1 - this.exT * 0.75;
    for (const m of this.meshes.values()) {
      const mat: any = m.material; if (!mat || mat === this.screenMat || this.ledMats.includes(mat)) continue;
      if (!mat.userData.ffCloned) { m.material = mat.clone(); (m.material as any).userData.ffCloned = true; }
      const mm: any = m.material; mm.transparent = op < 0.99; mm.opacity = op; mm.depthWrite = op > 0.9;
    }
  }

  pickables() { return [...this.meshes.values()].filter(m => m.visible); }
  roleOf(o: THREE.Object3D): Role { const r = this.bindings[o.userData.path]; return (r as Role) ?? 'body'; }
  partOf(o: THREE.Object3D) { return o.userData.path; }
  dialCenter() { return this.dialPivot.getWorldPosition(new THREE.Vector3()); }
  hasRole(r: BindRole) { return Object.values(this.bindings).includes(r); }

  highlight(part: string | null) {
    this.sel = part;
    for (const [path, m] of this.meshes) {
      const mat: any = m.material;
      if (!mat?.emissive || mat === this.screenMat || this.ledMats.includes(mat)) continue;
      if (!mat.userData.ffCloned) { m.material = mat.clone(); (m.material as any).userData.ffCloned = true; }
      (m.material as any).emissive.setHex(path === part ? 0x1c3cff : 0);
      (m.material as any).emissiveIntensity = path === part ? 0.25 : 1;
    }
  }

  protected applyDial() { const a = this.dialPivot.userData.axis ?? 'z'; this.dialPivot.rotation.set(0, 0, 0); (this.dialPivot.rotation as any)[a] = this.dialAngle; }
  protected applyLeds(c: [number, number, number][] | null, pulse: THREE.Color, t: number) {
    if (!this.ledMats.length) return;
    this.ledMats.forEach((mat, i) => {
      if (c) {
        // spread pixels across LED meshes; one mesh shows the ring average
        const per = Math.max(1, Math.floor(c.length / this.ledMats.length));
        let r = 0, g = 0, b = 0; const slice = c.slice(i * per, i * per + per);
        slice.forEach(p => { r += p[0]; g += p[1]; b += p[2]; });
        const n = Math.max(1, slice.length);
        mat.emissive.setRGB(r / n / 255 * 1.4, g / n / 255 * 1.4, b / n / 255 * 1.4);
      } else if (t > 0) mat.emissive.copy(pulse).multiplyScalar(t * 2);
      else mat.emissive.setHex(0);
    });
  }
  protected applyPress(depth: number) {
    for (const [m, base] of this.pressBase) m.position.copy(base).addScaledVector(new THREE.Vector3(0, 0, -1), depth * 0.01 / (m.parent?.scale.x || 1));
  }
  dispose() {
    this.group.traverse((o: any) => { if (o.geometry) o.geometry.dispose(); });
    this.group.clear();
  }
}

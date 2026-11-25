import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three';
import { ElectronicsView } from '../src/scene/electronics';
import { blankProject } from '../src/app/project';

// name labels draw on a canvas; the unit tests run without a DOM
beforeAll(() => {
  const ctx = new Proxy({}, { get: (_t, k) => (k === 'measureText' ? () => ({ width: 40 }) : () => {}), set: () => true });
  (globalThis as any).document ??= { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) };
});

const withScreen = (v: ElectronicsView, tex: THREE.Texture) => {
  const hits: THREE.Mesh[] = [];
  v.group.traverse((o: any) => { if (o.isMesh && o.material?.map === tex) hits.push(o); });
  return hits;
};

describe('wired electronics view', () => {
  it('shows the display image on the wired round LCD itself', () => {
    const p = blankProject();
    p.electronics.comps.push({ uid: 'lcd', type: 'tft', pins: {}, color: '#f80' });
    const tex = new THREE.Texture(), v = new ElectronicsView();
    v.build(p, 0.1, new Set(), tex);
    const hits = withScreen(v, tex);
    expect(hits).toHaveLength(1);
    expect(hits[0].parent).toBeInstanceOf(THREE.Mesh); // on the module, facing the front like it
    v.build(p, 0.1, new Set(), tex);  // rebuilding keeps the shared texture alive
    expect(withScreen(v, tex)).toHaveLength(1);
  });
  it('leaves it off when the model already shows that display', () => {
    const p = blankProject();
    p.electronics.comps.push({ uid: 'lcd', type: 'tft', pins: {}, color: '#f80' });
    const tex = new THREE.Texture(), v = new ElectronicsView();
    v.build(p, 0.1, new Set(['lcd']), tex);
    expect(withScreen(v, tex)).toHaveLength(0);
  });
});

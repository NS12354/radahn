import type { App } from './app';
import { $, el, esc, opts, toast } from './dom';
import { FINISHES, ParametricProduct } from '../scene/parametric';
import { ImportedProduct } from '../scene/imported';
import { EmptyProduct } from '../scene/empty';
import { BuiltProduct } from '../scene/built';
import { renderModel } from './modeler';
import { INTERNALS, bom, fitCheck } from '../app/internals';
import type { BindRole, PartKey } from '../app/project';

const ROLES: Record<BindRole, string> = { body: 'Body (static)', dial: 'Dial (rotates)', screen: 'Screen', press: 'Press surface', led: 'LED / light guide', ignore: 'Hidden' };
const FIN: Record<string, string> = { matte: 'Matte', satin: 'Satin', gloss: 'Gloss', soft: 'Soft-touch', brushed: 'Brushed metal', polished: 'Polished metal' };

export function initDesign(app: App, importCad: (f: File) => void) {
  const drop = $('#drop');
  drop.onclick = () => $('#fileCad').click();
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer?.files[0]; if (f) importCad(f); };

  const syncEnc = () => {
    const p = app.project.product.parametric;
    ($('#eDia') as HTMLInputElement).value = String(p.dia); ($('#eDep') as HTMLInputElement).value = String(p.depth);
    $('#eDiaV').textContent = p.dia + ' mm'; $('#eDepV').textContent = p.depth + ' mm'; ($('#eProc') as HTMLSelectElement).value = p.proc;
    ($('#qty') as HTMLInputElement).value = String(app.project.product.qty);
  };
  const onDims = () => { syncEnc(); (app.product as ParametricProduct).build(); renderDesign(app); app.changed('product'); };
  $('#eDia').oninput = e => { app.project.product.parametric.dia = +(e.target as HTMLInputElement).value; onDims(); };
  $('#eDep').oninput = e => { app.project.product.parametric.depth = +(e.target as HTMLInputElement).value; onDims(); };
  $('#eProc').onchange = e => { app.project.product.parametric.proc = (e.target as HTMLSelectElement).value as any; renderDesign(app); app.changed('product'); };
  $('#qty').oninput = e => { app.project.product.qty = Math.max(1, +(e.target as HTMLInputElement).value || 1); renderDesign(app); app.changed('product'); };
  syncEnc();
}

export function renderDesign(app: App) {
  const prj = app.project, imported = app.product instanceof ImportedProduct, none = app.product instanceof EmptyProduct, built = app.product instanceof BuiltProduct;
  for (const id of ['#secEnclosure', '#secFit', '#secInternals', '#secBom']) $(id).style.display = imported || none || built ? 'none' : '';
  $('#secScreens').style.display = none ? 'none' : '';
  $('#secCad').style.display = built ? 'none' : '';
  renderModel(app);
  if (built) return;
  if (none) {
    $('#cadNote').textContent = 'Blank project. Import a model, or use the built-in enclosure from the Project menu.';
    $('#partsNote').textContent = '';
    $('#partList').innerHTML = '<div class="empty">No model yet.</div>';
    $('#selName').textContent = '';
    $('#inspector').innerHTML = '<div class="empty">Nothing to inspect yet. Import a CAD model or use the built-in enclosure to get started.</div>';
    return;
  }
  $('#cadNote').textContent = imported
    ? `${prj.product.imported!.fileName}: ${(app.product as ImportedProduct).meshes.size} meshes. Bind a Dial, Screen and LED mesh to wire them to electronics.`
    : 'Bind meshes to roles (Dial, Screen, Press, LED) and the electronics will drive them.';

  // ---- parts list
  const list = $('#partList'); list.innerHTML = '';
  if (!imported) {
    $('#partsNote').textContent = '';
    for (const [k, p] of Object.entries(prj.product.parametric.parts)) {
      const d = el('div', 'item' + (app.selected === k ? ' on' : ''), `<span class="sw" style="background:${p.color}"></span>${esc(p.name)}<span class="meta">${p.finish}</span>`);
      d.onclick = () => app.selectPart(k);
      list.appendChild(d);
    }
  } else {
    const ip = app.product as ImportedProduct;
    $('#partsNote').textContent = ip.meshes.size + ' meshes';
    for (const [path, m] of ip.meshes) {
      const role = prj.product.imported!.bindings[path];
      const col = '#' + ((m.material as any)?.color?.getHexString?.() ?? '888888');
      const d = el('div', 'item' + (app.selected === path ? ' on' : ''), `<span class="sw" style="background:${col}"></span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(path.split('#')[0])}</span>${role && role !== 'body' ? `<span class="rolechip">${role}</span>` : ''}`);
      d.onclick = () => app.selectPart(path);
      list.appendChild(d);
    }
  }

  // ---- inspector
  const ins = $('#inspector');
  if (!app.selected) { ins.innerHTML = '<div class="empty">Click a part in the viewport or the list.</div>'; $('#selName').textContent = ''; }
  else if (!imported) {
    const k = app.selected as PartKey, p = prj.product.parametric.parts[k];
    if (!p) { ins.innerHTML = ''; return; }
    $('#selName').textContent = p.name;
    ins.innerHTML = `<div class="row"><label>Color</label><input type="color" id="pColor" value="${p.color}"><span class="v" style="width:auto;margin-left:auto">${p.color.toUpperCase()}</span></div>
      <div class="row"><label>Finish</label><select id="pFinish" style="flex:1" ${k === 'led' ? 'disabled' : ''}>${opts(FIN, p.finish)}</select></div>`;
    $('#pColor').oninput = e => { p.color = (e.target as HTMLInputElement).value; (app.product as ParametricProduct).applyMaterials(); renderDesign(app); app.changed('product'); };
    $('#pFinish').onchange = e => { p.finish = (e.target as HTMLSelectElement).value; (app.product as ParametricProduct).applyMaterials(); renderDesign(app); app.changed('product'); };
  } else {
    const path = app.selected, ip = app.product as ImportedProduct, b = prj.product.imported!.bindings;
    $('#selName').textContent = path.split('#')[0];
    ins.innerHTML = `<div class="row"><label>Role</label><select id="pRole" class="bindsel">${opts(ROLES as any, b[path] ?? 'body')}</select></div>
      <div class="note">Dial meshes rotate about their thinnest axis. Screen gets the display texture (planar UVs are generated if missing). Press triggers the button.</div>`;
    $('#pRole').onchange = e => {
      const r = (e.target as HTMLSelectElement).value as BindRole;
      if (r === 'body') delete b[path]; else b[path] = r;
      ip.bindings = b; ip.applyBindings(); app.bench.load(app.board(), prj.electronics.comps);
      renderDesign(app); app.changed('product'); toast(`${path.split('#')[0]} → ${ROLES[r]}`);
    };
  }
  if (imported) return;

  // ---- internals, fit, BOM (parametric only)
  const fit = fitCheck(prj);
  const badge = fit.ok ? '<span class="badge ok">Fits</span>' : '<span class="badge bad">Interference</span>';
  $('#fitBadge').innerHTML = badge; $('#fitBadgeL').innerHTML = badge;
  $('#fitList').innerHTML = fit.rows.map(r => `<div class="fit ${r.ok ? 'ok' : 'bad'}"><span>${r.n}</span><span class="x">${r.v}</span></div>`).join('');
  const cl = $('#compList'); cl.innerHTML = '';
  for (const c of INTERNALS) {
    const d = el('label', 'comp' + (fit.bad.has(c.id) ? ' fail' : ''), `<input type="checkbox" ${prj.internals[c.id] ? 'checked' : ''} ${c.lock ? 'disabled' : ''}><div><div class="n">${c.name}</div><div class="d">${c.spec} · $${c.cost.toFixed(2)}</div></div>`);
    d.querySelector('input')!.onchange = e => { prj.internals[c.id] = (e.target as HTMLInputElement).checked; (app.product as ParametricProduct).buildInternals(); renderDesign(app); app.changed('product'); };
    cl.appendChild(d);
  }
  const b = bom(prj);
  $('#bom').innerHTML = b.rows.map(r => `<tr><td>${r[0]}</td><td>$${r[1].toFixed(2)}</td></tr>`).join('') + `<tr class="tot"><td>Unit cost</td><td>$${b.total.toFixed(2)}</td></tr>`;
}

export { FINISHES };

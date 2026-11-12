# Formframe Link — live link between Blender and the Formframe studio.
#
# Formframe launches Blender with this file (`blender --python formframe_link.py
# -- --formframe-server URL --formframe-project ID`), or install it yourself:
# Edit ▸ Preferences ▸ Add-ons ▸ Install from Disk. Then open the 3D View
# sidebar (N) ▸ Formframe tab.
#
# The model arrives as mesh objects in millimetres, sorted into Enclosure /
# Details / Internals collections, with the part's role, explode step and
# finish as object properties. Anything you change in Blender (transforms,
# Edit Mode, modifiers such as Boolean / Bevel / Subdivision, new objects,
# deletes, material colours) is sent back to Formframe as evaluated meshes.
# A geometry hash per object means Formframe never overwrites your base mesh
# and modifiers with their own baked result.

bl_info = {
    "name": "Formframe Link",
    "author": "Formframe",
    "version": (0, 1, 0),
    "blender": (4, 2, 0),
    "location": "3D View ▸ Sidebar ▸ Formframe",
    "description": "Live two-way sync with a Formframe hardware prototyping project",
    "category": "Import-Export",
}

import json
import math
import sys
import time
import uuid
import urllib.request
import urllib.error

import bpy
from mathutils import Matrix, Vector

ROLES = [("body", "Body", "Static part"), ("dial", "Dial", "Rotates with the encoder"), ("screen", "Screen", "Shows the firmware's display"),
         ("press", "Press", "Presses a button"), ("led", "LED", "Lights up"), ("ignore", "Hidden", "Hidden in the product")]
FINISHES = {"matte": (0.78, 0.0), "satin": (0.45, 0.0), "gloss": (0.12, 0.0), "soft": (0.95, 0.0), "brushed": (0.32, 0.92), "polished": (0.08, 1.0), "clear": (0.05, 0.0)}
FINISH_ITEMS = [(k, k.title(), "") for k in FINISHES]
KIND_COL = {"shell": "Enclosure", "ext": "Details", "internal": "Internals"}
COL_KIND = {v: k for k, v in KIND_COL.items()}
GEOM_TYPES = {"MESH", "CURVE", "SURFACE", "META", "FONT"}


class _State:
    server = ""
    project = ""
    rev = 0
    linked = False
    applying = False
    dirty = 0.0
    last_sig = ""
    status = "Not linked"
    name = ""
    framed = False
    errors = 0


S = _State()


# ------------------------------------------------------------------ helpers
def _fmt(x):
    s = f"{x:.3f}"
    return "0.000" if s == "-0.000" else s


def geo_hash(verts, faces):
    """FNV-1a over a canonical text form; Formframe computes the same in JavaScript."""
    canon = ";".join(f"{_fmt(v[0])},{_fmt(v[1])},{_fmt(v[2])}" for v in verts) + "|" + ";".join(",".join(str(i) for i in f) for f in faces)
    h = 0x811C9DC5
    for b in canon.encode("ascii"):
        h ^= b
        h = (h * 0x01000193) & 0xFFFFFFFF
    return f"{h:08x}"


def _http(method, path, body=None, timeout=3):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(S.server.rstrip("/") + path, data=data, method=method, headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode() or "{}")


def _mat_from(cols):
    return Matrix([[cols[c * 4 + r] for c in range(4)] for r in range(4)])


def _mat_to(m):
    return [m[r][c] for c in range(4) for r in range(4)]


def _srgb_to_lin(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def _lin_to_srgb(c):
    c = max(0.0, min(1.0, c))
    return c * 12.92 if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055


def _hex_to_lin(h):
    h = h.lstrip("#")
    return tuple(_srgb_to_lin(int(h[i:i + 2], 16) / 255) for i in (0, 2, 4))


def _lin_to_hex(c):
    return "#" + "".join(f"{round(_lin_to_srgb(x) * 255):02x}" for x in c[:3])


def _bsdf(mat):
    if not mat or not mat.use_nodes or not mat.node_tree:
        return None
    return next((n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)


def _set_input(node, name, value):
    if node and name in node.inputs:
        try:
            node.inputs[name].default_value = value
        except Exception:
            pass


def _mark_dirty(*_):
    if not S.applying:
        S.dirty = time.time()


def _prop_update(self, context):
    _mark_dirty()


def _collections():
    sc = bpy.context.scene
    root = bpy.data.collections.get("Formframe") or bpy.data.collections.new("Formframe")
    if root.name not in sc.collection.children:
        sc.collection.children.link(root)
    out = {}
    for kind, name in list(KIND_COL.items()) + [("instances", "FF Instances")]:
        c = bpy.data.collections.get(name) or bpy.data.collections.new(name)
        if c.name not in root.children:
            root.children.link(c)
        out[kind] = c
    out["instances"].hide_select = True
    return out


def _find(fid):
    for o in bpy.data.objects:
        if o.get("ff_id") == fid and not o.get("ff_instance"):
            return o
    return None


def _setup_scene():
    sc = bpy.context.scene
    us = sc.unit_settings
    if us.length_unit != "MILLIMETERS":
        us.system = "METRIC"
        us.scale_length = 0.001
        us.length_unit = "MILLIMETERS"
    for scr in bpy.data.screens:
        for area in scr.areas:
            if area.type == "VIEW_3D":
                for sp in area.spaces:
                    if sp.type == "VIEW_3D":
                        sp.clip_start = 0.1
                        sp.clip_end = max(sp.clip_end, 100000)
    # A fresh Blender scene's default cube would otherwise become a part.
    cube = bpy.data.objects.get("Cube")
    if cube and not cube.get("ff_id") and cube.type == "MESH" and len(cube.data.vertices) == 8 and cube.data.name == "Cube":
        bpy.data.objects.remove(cube, do_unlink=True)


def _frame_all():
    for win in bpy.context.window_manager.windows:
        for area in win.screen.areas:
            if area.type == "VIEW_3D":
                region = next((r for r in area.regions if r.type == "WINDOW"), None)
                if region:
                    try:
                        with bpy.context.temp_override(window=win, area=area, region=region):
                            bpy.ops.view3d.view_all()
                    except Exception:
                        pass


# ------------------------------------------------------------------ Formframe → Blender
def apply_model(model):
    S.applying = True
    try:
        _setup_scene()
        cols = _collections()
        S.name = model.get("name", "")
        keep = set()
        for p in model.get("parts", []):
            fid = p["id"]
            keep.add(fid)
            obj = _find(fid)
            if obj is None:
                me = bpy.data.meshes.new(p["name"])
                obj = bpy.data.objects.new(p["name"], me)
                obj["ff_id"] = fid
                obj["ff_hash"] = ""
                cols.get(p.get("kind") or "ext", cols["ext"]).objects.link(obj)
            if obj.name != p["name"] and not obj.name.startswith(p["name"] + "."):
                obj.name = p["name"]
            obj.matrix_world = _mat_from(p["matrix"])
            if obj.type == "MESH" and p.get("mesh") and p.get("hash") != obj.get("ff_hash"):
                had_sync = bool(obj.get("ff_hash"))
                me = obj.data
                me.clear_geometry()
                v = p["mesh"]["v"]
                me.from_pydata([tuple(v[i:i + 3]) for i in range(0, len(v), 3)], [tuple(e) for e in p["mesh"].get("e", [])], p["mesh"]["f"])
                me.update()
                if had_sync:  # Formframe edited a mesh whose modifiers it had already baked in
                    for m in [m for m in obj.modifiers if m.name != "FF Array"]:
                        obj.modifiers.remove(m)
                obj["ff_hash"] = p["hash"]
                try:
                    me.shade_smooth() if p.get("smooth") else me.shade_flat()
                except AttributeError:
                    for poly in me.polygons:
                        poly.use_smooth = bool(p.get("smooth"))
            # collection = kind
            target = cols.get(p.get("kind") or "ext", cols["ext"])
            for c in list(obj.users_collection):
                if c.name in COL_KIND and c is not target:
                    c.objects.unlink(obj)
            if obj.name not in target.objects:
                target.objects.link(obj)
            obj.ff_role = p.get("role", "body") if p.get("role") in dict((r[0], 1) for r in ROLES) else "body"
            obj.ff_layer = int(p.get("layer") or 0)
            obj.ff_finish = p.get("finish") if p.get("finish") in FINISHES else "satin"
            obj.ff_segments = int(p.get("segments") or 0)
            obj["ff_auto"] = bool(p.get("auto"))
            obj["ff_comp"] = p.get("comp") or ""
            obj["ff_color"] = p.get("color", "#cccccc")
            _apply_material(obj, p)
            _apply_array(obj, p, cols)
        for o in list(bpy.data.objects):
            fid = o.get("ff_id")
            if fid and fid not in keep and not o.get("ff_instance"):
                bpy.data.objects.remove(o, do_unlink=True)
            elif o.get("ff_instance") and o.get("ff_instance") not in keep:
                bpy.data.objects.remove(o, do_unlink=True)
        S.last_sig = json.dumps(collect(), sort_keys=True)
        if not S.framed:
            S.framed = True
            bpy.app.timers.register(_frame_all, first_interval=0.3)
    finally:
        S.applying = False


def _apply_material(obj, p):
    if obj.type not in GEOM_TYPES or not hasattr(obj.data, "materials"):
        return
    mat = bpy.data.materials.get("FF " + p["id"]) or bpy.data.materials.new("FF " + p["id"])
    mat.use_nodes = True
    node = _bsdf(mat)
    rough, metal = FINISHES.get(p.get("finish"), (0.5, 0.0))
    if mat.get("ff_color") != p.get("color") or mat.get("ff_finish") != p.get("finish"):
        _set_input(node, "Base Color", (*_hex_to_lin(p.get("color", "#cccccc")), 1.0))
        _set_input(node, "Roughness", rough)
        _set_input(node, "Metallic", metal)
        _set_input(node, "Alpha", 0.5 if p.get("finish") == "clear" else 1.0)
        mat.diffuse_color = (*_hex_to_lin(p.get("color", "#cccccc")), 1.0)
        mat["ff_color"] = p.get("color")
        mat["ff_finish"] = p.get("finish")
    if not obj.data.materials:
        obj.data.materials.append(mat)
    elif obj.data.materials[0] is None or obj.data.materials[0].name.startswith("FF "):
        obj.data.materials[0] = mat


def _apply_array(obj, p, cols):
    arr = p.get("array")
    mod = obj.modifiers.get("FF Array")
    for o in list(bpy.data.objects):
        if o.get("ff_instance") == p["id"]:
            bpy.data.objects.remove(o, do_unlink=True)
    obj["ff_array"] = json.dumps(arr) if arr else ""
    if arr and arr.get("mode") == "linear" and arr.get("n", 1) > 1:
        if mod is None:
            mod = obj.modifiers.new("FF Array", "ARRAY")
        mod.count = int(arr["n"])
        mod.use_relative_offset = False
        mod.use_constant_offset = True
        mod.constant_offset_displace = Vector(arr["step"])
        return
    if mod is not None:
        obj.modifiers.remove(mod)
    if arr and arr.get("mode") == "radial" and arr.get("n", 1) > 1:
        cx, cy = arr.get("center", [0, 0])
        c = Vector((cx, 0.0, cy))  # Formframe's radial axis (its +Z, the product's front) is Blender's -Y
        for i in range(1, int(arr["n"])):
            ang = i * 2 * math.pi / arr["n"]
            r = Matrix.Translation(c) @ Matrix.Rotation(ang, 4, Vector((0, -1, 0))) @ Matrix.Translation(-c)
            inst = obj.copy()
            inst["ff_instance"] = p["id"]
            inst.name = f"{obj.name} ⟳{i}"
            inst.matrix_world = r @ obj.matrix_world
            cols["instances"].objects.link(inst)


# ------------------------------------------------------------------ Blender → Formframe
def collect():
    sc = bpy.context.scene
    objs = [o for o in sc.objects if o.type in GEOM_TYPES and not o.get("ff_instance")]
    if bpy.context.mode == "EDIT_MESH":
        for o in bpy.context.objects_in_mode:
            o.update_from_editmode()
    was = S.applying
    S.applying = True
    arrays = [m for o in objs for m in o.modifiers if m.name == "FF Array" and m.show_viewport]
    for m in arrays:
        m.show_viewport = False
    dg = bpy.context.evaluated_depsgraph_get()
    dg.update()
    parts = []
    try:
        for o in objs:
            if not o.get("ff_id"):
                o["ff_id"] = "b" + uuid.uuid4().hex[:12]
                o["ff_hash"] = ""
            eo = o.evaluated_get(dg)
            try:
                me = eo.to_mesh()
            except RuntimeError:
                continue
            verts = [tuple(v.co) for v in me.vertices]
            faces = [list(p.vertices) for p in me.polygons]
            smooth = any(p.use_smooth for p in me.polygons)
            eo.to_mesh_clear()
            h = geo_hash(verts, faces)
            kind = next((COL_KIND[c.name] for c in o.users_collection if c.name in COL_KIND), "ext")
            mat = o.active_material
            node = _bsdf(mat)
            color = o.get("ff_color", "#cccccc")
            if node and "Base Color" in node.inputs:
                c = _lin_to_hex(node.inputs["Base Color"].default_value)
                if mat.get("ff_color") is None or c != _lin_to_hex(_hex_to_lin(mat.get("ff_color"))):
                    color = c
            mod = o.modifiers.get("FF Array")
            arr = None
            if mod is not None:
                arr = {"n": mod.count, "mode": "linear", "step": list(mod.constant_offset_displace)}
            elif o.get("ff_array"):
                arr = json.loads(o["ff_array"])
            part = {
                "id": o["ff_id"], "name": o.name, "kind": kind, "role": o.ff_role, "layer": o.ff_layer, "finish": o.ff_finish,
                "segments": o.ff_segments, "auto": bool(o.get("ff_auto")), "comp": o.get("ff_comp") or None, "color": color,
                "smooth": smooth, "matrix": _mat_to(o.matrix_world), "hash": h, "array": arr,
            }
            if h != o.get("ff_hash"):
                part["mesh"] = {"v": [round(x, 4) for v in verts for x in v], "f": faces}
            parts.append(part)
    finally:
        for m in arrays:
            m.show_viewport = True
        S.applying = was
    return parts


def send(force=False):
    parts = collect()
    sig = json.dumps(parts, sort_keys=True)
    if sig == S.last_sig and not force:
        return
    r = _http("POST", "/api/blender/push", {"project": S.project, "from": "blender", "model": {"name": S.name, "units": "mm", "parts": parts}})
    S.rev = r.get("rev", S.rev)
    for p in parts:  # Formframe now has these meshes
        o = _find(p["id"])
        if o is not None:
            o["ff_hash"] = p["hash"]
    S.last_sig = json.dumps(collect(), sort_keys=True)
    S.status = f"Sent {len(parts)} objects"


# ------------------------------------------------------------------ timers
def _tick():
    if not S.linked:
        return 1.0
    try:
        r = _http("GET", f"/api/blender/poll?project={S.project}&since={S.rev}&for=blender", timeout=2)
        S.errors = 0
        if r.get("model"):
            apply_model(r["model"])
            S.rev = r["rev"]
            S.status = f"Received {len(r['model'].get('parts', []))} parts"
        elif not r.get("formframe"):
            S.status = "Waiting for the Formframe studio window"
        if S.dirty and time.time() - S.dirty > 0.6 and not S.applying:
            S.dirty = 0.0
            send()
    except urllib.error.URLError:
        S.errors += 1
        S.status = "Can't reach Formframe (is `npm run dev` running?)"
    except Exception as e:  # keep the timer alive
        S.status = f"Sync error: {e}"
        print("[Formframe]", repr(e))
    for win in bpy.context.window_manager.windows:
        for area in win.screen.areas:
            if area.type == "VIEW_3D":
                area.tag_redraw()
    return 0.5


def connect(server, project):
    S.server, S.project, S.rev, S.linked, S.last_sig, S.framed = server, project, 0, True, "", False
    S.status = "Connecting…"
    sc = bpy.context.scene
    sc.ff_server, sc.ff_project = server, project
    if not bpy.app.timers.is_registered(_tick):
        bpy.app.timers.register(_tick, first_interval=0.2, persistent=True)


# ------------------------------------------------------------------ UI
class FF_OT_connect(bpy.types.Operator):
    bl_idname = "formframe.connect"
    bl_label = "Connect"
    bl_description = "Link this Blender scene with the Formframe project"

    def execute(self, context):
        sc = context.scene
        if not sc.ff_project:
            self.report({"WARNING"}, "Pick a project first (Formframe ▸ Choose Project), or use Open in Blender in the studio")
            return {"CANCELLED"}
        connect(sc.ff_server, sc.ff_project)
        return {"FINISHED"}


class FF_OT_disconnect(bpy.types.Operator):
    bl_idname = "formframe.disconnect"
    bl_label = "Disconnect"

    def execute(self, context):
        S.linked = False
        S.status = "Not linked"
        return {"FINISHED"}


class FF_OT_sync(bpy.types.Operator):
    bl_idname = "formframe.sync"
    bl_label = "Send to Formframe"
    bl_description = "Send every object to Formframe now"

    def execute(self, context):
        if not S.linked:
            return {"CANCELLED"}
        try:
            send(force=True)
        except Exception as e:
            self.report({"ERROR"}, str(e))
            return {"CANCELLED"}
        return {"FINISHED"}


def _project_items(self, context):
    try:
        S.server = context.scene.ff_server
        ps = _http("GET", "/api/blender/projects", timeout=2).get("projects", [])
    except Exception:
        ps = []
    return [(p["id"], p["name"] or p["id"], "") for p in ps] or [("", "No projects: open one in Formframe first", "")]


class FF_OT_choose(bpy.types.Operator):
    bl_idname = "formframe.choose"
    bl_label = "Choose Project"
    bl_property = "project"
    project: bpy.props.EnumProperty(items=_project_items)

    def invoke(self, context, event):
        context.window_manager.invoke_search_popup(self)
        return {"RUNNING_MODAL"}

    def execute(self, context):
        if self.project:
            context.scene.ff_project = self.project
            connect(context.scene.ff_server, self.project)
        return {"FINISHED"}


class FF_PT_panel(bpy.types.Panel):
    bl_label = "Formframe"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Formframe"

    def draw(self, context):
        lay, sc = self.layout, context.scene
        box = lay.box()
        box.label(text=(f"Linked: {S.name or sc.ff_project}" if S.linked else "Not linked"), icon="LINKED" if S.linked else "UNLINKED")
        box.label(text=S.status)
        col = lay.column(align=True)
        col.prop(sc, "ff_server", text="Server")
        row = col.row(align=True)
        row.prop(sc, "ff_project", text="Project")
        row.operator("formframe.choose", text="", icon="VIEWZOOM")
        row = lay.row(align=True)
        if S.linked:
            row.operator("formframe.disconnect", icon="CANCEL")
            row.operator("formframe.sync", icon="EXPORT")
        else:
            row.operator("formframe.connect", icon="LINKED")
        o = context.active_object
        if o and o.type in GEOM_TYPES and not o.get("ff_instance"):
            b = lay.box()
            b.label(text=o.name, icon="OBJECT_DATA")
            b.prop(o, "ff_role")
            b.prop(o, "ff_finish")
            b.prop(o, "ff_layer")
            if o.ff_role == "led":
                b.prop(o, "ff_segments")
            if o.get("ff_auto"):
                b.label(text="Auto-built: replaced when Formframe rebuilds", icon="INFO")
            b.label(text="Collection sets the kind: Enclosure / Details / Internals")


CLASSES = (FF_OT_connect, FF_OT_disconnect, FF_OT_sync, FF_OT_choose, FF_PT_panel)


def register():
    bpy.types.Object.ff_role = bpy.props.EnumProperty(name="Role", items=ROLES, default="body", update=_prop_update, description="How the electronics drive this part")
    bpy.types.Object.ff_finish = bpy.props.EnumProperty(name="Finish", items=FINISH_ITEMS, default="satin", update=_prop_update)
    bpy.types.Object.ff_layer = bpy.props.IntProperty(name="Explode Step", default=0, update=_prop_update)
    bpy.types.Object.ff_segments = bpy.props.IntProperty(name="LED Segments", default=0, min=0, max=256, update=_prop_update)
    bpy.types.Scene.ff_server = bpy.props.StringProperty(name="Server", default="http://localhost:5173")
    bpy.types.Scene.ff_project = bpy.props.StringProperty(name="Project")
    for c in CLASSES:
        bpy.utils.register_class(c)
    if _mark_dirty not in bpy.app.handlers.depsgraph_update_post:
        bpy.app.handlers.depsgraph_update_post.append(_mark_dirty)


def unregister():
    S.linked = False
    if _mark_dirty in bpy.app.handlers.depsgraph_update_post:
        bpy.app.handlers.depsgraph_update_post.remove(_mark_dirty)
    for c in reversed(CLASSES):
        bpy.utils.unregister_class(c)
    for a in ("ff_role", "ff_finish", "ff_layer", "ff_segments"):
        delattr(bpy.types.Object, a)
    for a in ("ff_server", "ff_project"):
        delattr(bpy.types.Scene, a)


def _argv():
    a = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    get = lambda k: a[a.index(k) + 1] if k in a and a.index(k) + 1 < len(a) else None
    return get("--formframe-server"), get("--formframe-project")


if __name__ == "__main__":
    try:
        unregister()
    except Exception:
        pass
    register()
    srv, proj = _argv()
    if srv and proj:
        # wait until Blender's UI is up, then link
        bpy.app.timers.register(lambda: (connect(srv, proj), None)[1], first_interval=0.5)

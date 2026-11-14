# Runs inside background Blender for e2e/integrations.spec.ts: drives the
# Formframe add-on's sync loop by hand (no window, so no timers).
import sys, time, bpy
args = sys.argv[sys.argv.index('--') + 1:]
server, project = args[0], args[1]
sys.path.insert(0, __import__('os').path.join(__import__('os').path.dirname(__file__), '..', '..', 'blender'))
import formframe_link as f
f.register()
f.connect(server, project)
def tick(n=1):
    for _ in range(n):
        f._tick(); time.sleep(0.3)
tick(3)
h = next(o for o in bpy.context.scene.objects if o.name == 'Housing')
h.location.x += 10
h.modifiers.new('Bevel', 'BEVEL').width = 1.0
bpy.ops.mesh.primitive_cube_add(size=10, location=(0, 0, 40))
bpy.context.active_object.name = 'Knob'
f.send(force=True)
time.sleep(2.5)  # the studio polls, merges and echoes back
tick(3)
h = next(o for o in bpy.context.scene.objects if o.name == 'Housing')
print('AFTER_ECHO modifiers', [m.type for m in h.modifiers])

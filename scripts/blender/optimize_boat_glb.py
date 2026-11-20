# Blender 无头优化 GLB：焊接顶点 -> 减面 -> 贴图缩放 -> 材质从纯自发光改成 PBR -> 导出 GLB
# 用法：
#   blender --background --factory-startup --python scripts/blender/optimize_boat_glb.py -- <in.glb> <out.glb> [target_tris] [tex_size]
import bpy, sys, os, math, time

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
if len(argv) < 2:
    print('USAGE: optimize_boat_glb.py <in.glb> <out.glb> [target_tris] [tex_size]')
    sys.exit(1)
src, dst = argv[0], argv[1]
target_tris = int(argv[2]) if len(argv) > 2 else 60000
tex_size = int(argv[3]) if len(argv) > 3 else 1024

t0 = time.time()
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)

meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
print('IMPORTED meshes=%d objects=%d' % (len(meshes), len(bpy.context.scene.objects)))
tri_before = 0
vert_before = 0
for o in meshes:
    o.data.calc_loop_triangles()
    tri_before += len(o.data.loop_triangles)
    vert_before += len(o.data.vertices)
print('BEFORE tris=%d verts=%d' % (tri_before, vert_before))

# ---------- 1) 焊接：把 UV 缝/重复顶点并掉 ----------
for o in meshes:
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.select_all(action='DESELECT')
    o.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.remove_doubles(threshold=1e-5)
    bpy.ops.object.mode_set(mode='OBJECT')

vert_welded = sum(len(o.data.vertices) for o in meshes)
print('WELDED verts=%d' % vert_welded)

# ---------- 2) 减面：按目标三角面数算 collapse 比例 ----------
tri_now = 0
for o in meshes:
    o.data.calc_loop_triangles()
    tri_now += len(o.data.loop_triangles)
ratio = max(0.01, min(1.0, target_tris / max(1, tri_now)))
print('DECIMATE ratio=%.4f (target=%d, now=%d)' % (ratio, target_tris, tri_now))
for o in meshes:
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.select_all(action='DESELECT')
    o.select_set(True)
    m = o.modifiers.new('dec', 'DECIMATE')
    m.decimate_type = 'COLLAPSE'
    m.ratio = ratio
    m.use_collapse_triangulate = True
    bpy.ops.object.modifier_apply(modifier=m.name)
    # 减面后重算平滑：按角度自动分硬边，硬表面才不会出现脏的软阴影
    try:
        bpy.ops.object.shade_auto_smooth(angle=math.radians(35))
    except Exception:
        bpy.ops.object.shade_smooth()

tri_after = 0
vert_after = 0
for o in meshes:
    o.data.calc_loop_triangles()
    tri_after += len(o.data.loop_triangles)
    vert_after += len(o.data.vertices)
print('AFTER tris=%d verts=%d' % (tri_after, vert_after))

# ---------- 3) 贴图：缩到 tex_size，并且把自发光材质改成 PBR ----------
for mat in bpy.data.materials:
    if not mat.use_nodes:
        continue
    nt = mat.node_tree
    bsdf = next((n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if not bsdf:
        continue
    tex = next((n for n in nt.nodes if n.type == 'TEX_IMAGE' and n.image), None)
    if not tex:
        continue
    img = tex.image
    print('IMAGE %s %dx%d packed=%s' % (img.name, img.size[0], img.size[1], bool(img.packed_file)))
    if max(img.size) > tex_size:
        img.scale(tex_size, tex_size)
        print('IMAGE scaled -> %dx%d' % (img.size[0], img.size[1]))
    # 原来的模型是"底色纯黑 + 全靠自发光贴图"，直接进游戏会在夜里整船发光。
    # 改成 baseColor 用同一张贴图，自发光压到 0。
    nt.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
    for sock_name in ('Emission Color', 'Emission Strength'):
        if sock_name in bsdf.inputs:
            try:
                if sock_name == 'Emission Color':
                    bsdf.inputs[sock_name].default_value = (0, 0, 0, 1)
                    for link in list(bsdf.inputs[sock_name].links):
                        nt.links.remove(link)
                elif sock_name == 'Emission Strength':
                    for link in list(bsdf.inputs[sock_name].links):
                        nt.links.remove(link)
                    bsdf.inputs[sock_name].default_value = 0.0
            except Exception as e:
                print('emission fix skip:', e)
    for k, v in (('Metallic', 0.25), ('Roughness', 0.55)):
        if k in bsdf.inputs:
            bsdf.inputs[k].default_value = v
    mat.use_backface_culling = False

# ---------- 4) 导出 ----------
bpy.ops.object.select_all(action='DESELECT')
for o in meshes:
    o.select_set(True)
bpy.context.view_layer.objects.active = meshes[0] if meshes else None

os.makedirs(os.path.dirname(os.path.abspath(dst)), exist_ok=True)
want = dict(
    filepath=dst,
    export_format='GLB',
    use_selection=True,
    export_apply=True,
    export_yup=True,
    export_normals=True,
    export_texcoords=True,
    export_materials='EXPORT',
    export_image_format='JPEG',
    export_jpeg_quality=86,
    export_draco_mesh_compression_enable=False,
    export_animations=False,
    export_skins=False,
    export_cameras=False,
    export_lights=False,
)
props = bpy.ops.export_scene.gltf.get_rna_type().properties.keys()
kw = {k: v for k, v in want.items() if k in props}
dropped = [k for k in want if k not in props]
if dropped:
    print('EXPORT dropped unsupported:', dropped)
bpy.ops.export_scene.gltf(**kw)

size = os.path.getsize(dst)
print('DONE %s  %.2f MB  (tris %d -> %d, verts %d -> %d)  %.1fs' % (
    dst, size / 1048576, tri_before, tri_after, vert_before, vert_after, time.time() - t0))

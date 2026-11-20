# 从 Sketchfab 的「robot_playground」场景里剥出机器人本体，产出一个可以直接当
# 赛道动态障碍用的 GLB。
#
#   blender -b --factory-startup --python-exit-code 1 \
#     --python scripts/robot/extract_robot.py -- <src.glb> <dst.glb> [目标高度m] [目标三角面] [frame]
#
# 为什么要在 Blender 里做：
#   · 源文件 8.7MB，其中一半是一圈全息装饰（holo1 材质、34 个网格、3852 面），
#     全部塞进浏览器当路障太浪费；
#   · 机器人是**带骨骼蒙皮的**（1 个 skin + 1 段 265 通道的动画），InstancedMesh
#     没法这么实例化，必须先把姿势冻结成静态几何；
#   · 原点要挪到"底部中心"、高度要归一，赛道那边才会落在地面上而不是埋进水里。
#
# 做法：depsgraph 求值每个 mesh（这样骨骼变形 + 形态键都会烘进去）→ 全部 join 成
# 一个物体 → Decimate → 归一化 → 导出 GLB（贴图打包在里面）。
import bpy
import sys
import json
import math

argv = sys.argv
argv = argv[argv.index('--') + 1:] if '--' in argv else []
SRC = argv[0]
DST = argv[1]
TARGET_H = float(argv[2]) if len(argv) > 2 else 2.2
TARGET_TRIS = int(argv[3]) if len(argv) > 3 else 3200
FRAME = int(argv[4]) if len(argv) > 4 else 1

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)

scene = bpy.context.scene
scene.frame_set(FRAME)
bpy.context.view_layer.update()
deps = bpy.context.evaluated_depsgraph_get()

# ---------- 1. 收集机器人网格，其余（全息装饰等）丢掉 ----------
# 注意：glTF 导入后物体名会变成 Object_162 这种通用名，`_bot_` 只留在**网格数据**名上。
# 所以三重判定：物体名 / 网格名 / 材质名（机器人用 material，全息件用 holo1）。
def is_bot(o):
    if o.type != 'MESH':
        return False
    if '_bot_' in o.name or '_bot_' in (o.data.name if o.data else ''):
        return True
    mats = [m.name for m in (o.data.materials or []) if m]
    return bool(mats) and not any('holo' in n.lower() for n in mats)


bot = [o for o in bpy.data.objects if is_bot(o)]
if not bot:
    raise SystemExit('没找到 _bot_ 网格，实际网格名：' +
                     ', '.join(o.name for o in bpy.data.objects if o.type == 'MESH')[:900])

baked = []
for ob in bot:
    ev = ob.evaluated_get(deps)
    me = bpy.data.meshes.new_from_object(ev)     # 已含骨骼变形 / 修改器 / 形态键
    if not me or not me.polygons:
        continue
    me.name = ob.name + '_baked'
    new = bpy.data.objects.new(ob.name + '_baked', me)
    new.matrix_world = ob.matrix_world.copy()
    scene.collection.objects.link(new)
    baked.append(new)

# 原对象（含骨架）全部删掉
for ob in list(bpy.data.objects):
    if ob not in baked:
        bpy.data.objects.remove(ob, do_unlink=True)

# ---------- 2. join 成一个物体 ----------
for ob in bpy.data.objects:
    ob.select_set(False)
for ob in baked:
    ob.select_set(True)
bpy.context.view_layer.objects.active = baked[0]
if len(baked) > 1:
    bpy.ops.object.join()
robot = bpy.context.view_layer.objects.active
robot.name = 'hazard_bot'
robot.data.name = 'hazard_bot'

tri_before = sum(len(p.vertices) - 2 for p in robot.data.polygons)

# ---------- 3. 减面 ----------
if tri_before > TARGET_TRIS:
    mod = robot.modifiers.new('dec', 'DECIMATE')
    mod.decimate_type = 'COLLAPSE'
    mod.ratio = max(0.02, TARGET_TRIS / float(tri_before))
    mod.use_collapse_triangulate = True
    bpy.ops.object.modifier_apply(modifier=mod.name)

# ---------- 4. 归一化：高度 = TARGET_H、底面 y=0、水平居中 ----------
bpy.context.view_layer.update()
mw = robot.matrix_world
xs = [(mw @ v.co) for v in robot.data.vertices]
minx = min(v.x for v in xs); maxx = max(v.x for v in xs)
miny = min(v.y for v in xs); maxy = max(v.y for v in xs)
minz = min(v.z for v in xs); maxz = max(v.z for v in xs)
# Blender 是 Z 向上：高度取 z
h = maxz - minz
if h <= 1e-6:
    raise SystemExit('模型高度为 0')
s = TARGET_H / h
cx = (minx + maxx) * 0.5
cy = (miny + maxy) * 0.5
for v in robot.data.vertices:
    w = mw @ v.co
    v.co.x = (w.x - cx) * s
    v.co.y = (w.y - cy) * s
    v.co.z = (w.z - minz) * s
robot.matrix_world.identity()
robot.data.update()
bpy.context.view_layer.update()

tri_after = sum(len(p.vertices) - 2 for p in robot.data.polygons)
zs = [v.co.z for v in robot.data.vertices]

# ---------- 5. 导出 ----------
bpy.ops.export_scene.gltf(
    filepath=DST,
    export_format='GLB',
    use_selection=False,
    export_apply=True,
    export_yup=True,
    export_animations=False,
    export_skins=False,
    export_image_format='AUTO',
)

mats = [m.name for m in robot.data.materials]
print('@@JSON@@' + json.dumps({
    'ok': True,
    'src': SRC,
    'dst': DST,
    'frame': FRAME,
    'meshes': len(baked),
    'tris_before': int(tri_before),
    'tris_after': int(tri_after),
    'height': round(max(zs) - min(zs), 3),
    'materials': mats,
}))

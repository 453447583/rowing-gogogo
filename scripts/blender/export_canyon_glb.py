"""按组导出 6 个资产的 GLB —— 每次重开 .blend 并删掉非本组对象，不依赖 selection 参数
用法：blender -b --python scripts/blender/export_canyon_glb.py

⚠️ 2026-10-30 修：上一版 6 个 GLB 里**全都混进了建模场景的 700×700 水面 Plane**
   （4 顶点、高 0）。游戏里 `Track` 按"横向直径"归一化时，700m 的平面把整组缩到 1/20，
   崖壁进游戏只剩 1.8m 高，看起来就是"资产完全没出现"。
   现在：删除前强制 `view_layer.update()`，用 matrix_world 包围盒判断，
   再显式剔除水面板（扁平且横向 > 150m），并按组从紧凑的 keep 列表出发。
"""
import bpy, os

from mathutils import Vector, noise

ROOT = r"D:\3Dgame - 副本"
BLEND = os.path.join(ROOT, "public", "models", "canyon_assets_preview.blend")
OUT = os.path.join(ROOT, "public", "models", "canyon")
os.makedirs(OUT, exist_ok=True)

GROUPS = [(-80, "cliff"), (-40, "tunnel"), (0, "ramp"), (40, "arch"), (80, "island"), (120, "mountain")]

# 建模场景里的水面/地面：扁平且很大，导出时必须扔掉
WATER_LATERAL = 150.0
WATER_MAX_H = 2.0


def world_bounds(obj):
    """matrix_world 下的包围盒（不用 o.dimensions：刚打开文件时它可能是 0）"""
    pts = [obj.matrix_world @ Vector(c) for c in obj.bound_box]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    return lo, hi


def is_water_plane(obj):
    lo, hi = world_bounds(obj)
    lateral = max(hi.x - lo.x, hi.y - lo.y)
    height = hi.z - lo.z
    if lateral > 500:
        return True
    return lateral > WATER_LATERAL and height < WATER_MAX_H


# ---------- 程序化配色 → 顶点色 ----------
# 建模用的是 Wave/Noise + ColorRamp 的程序化材质，glTF 完全导不出来（baseColorFactor 为空 → 全白）。
# 导出到游戏里就变成"雪白棉花墙"。这里把 ColorRamp 两端颜色按噪声混到顶点色（COLOR_0），
# 同时把 Base Color 打平成两端色的平均值 —— 就算运行时不认顶点色，也不会是白的。
FLATTENED = set()


def material_palette(mat):
    """返回 (暗端色, 亮端色)；找不到 ColorRamp 就用 Base Color 的默认值"""
    nt = getattr(mat, 'node_tree', None)
    if not nt:
        return None
    ramp = next((n for n in nt.nodes if n.type == 'VALTORGB' and len(n.color_ramp.elements) >= 2), None)
    if ramp:
        c0 = tuple(ramp.color_ramp.elements[0].color)[:3]
        c1 = tuple(ramp.color_ramp.elements[-1].color)[:3]
        return c0, c1
    bsdf = next((n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if bsdf:
        c = tuple(bsdf.inputs['Base Color'].default_value)[:3]
        return c, c
    return None


def flatten_base_color(mat, c0, c1):
    """断开程序化 Base Color，改成两端色的平均值（导出后才能有颜色的兜底）"""
    if mat.name in FLATTENED:
        return
    FLATTENED.add(mat.name)
    nt = mat.node_tree
    bsdf = next((n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if not bsdf:
        return
    avg = tuple((a + b) * 0.5 for a, b in zip(c0, c1))
    for link in list(bsdf.inputs['Base Color'].links):
        nt.links.remove(link)
    bsdf.inputs['Base Color'].default_value = (*avg, 1.0)


def lift(c):
    """岩石色在 Blender 里是线性 0.01~0.10，直接进游戏就是"一大坨黑影"。
    做一次 gamma 提亮（0.06 → 0.19、0.10 → 0.26），保留层次但不糊成黑块。"""
    return tuple(min(1.0, max(0.0, v) ** 0.62) for v in c)


def bake_vertex_colors(obj):
    me = obj.data
    if not me.materials:
        return
    pal = None
    for m in me.materials:
        if not m:
            continue
        pal = material_palette(m)
        if pal:
            pal = (lift(pal[0]), lift(pal[1]))
            flatten_base_color(m, *pal)
            break
    if not pal:
        return
    c0, c1 = pal
    attr = me.color_attributes.get('Col')
    if attr is None:
        attr = me.color_attributes.new(name='Col', type='BYTE_COLOR', domain='POINT')
    for i, v in enumerate(me.vertices):
        n = noise.noise(v.co * 0.42)          # 物体局部坐标采样，冰球/球体都只有 ~1 单位
        t = max(0.0, min(1.0, 0.5 + 0.9 * n))
        attr.data[i].color = (
            c0[0] + (c1[0] - c0[0]) * t,
            c0[1] + (c1[1] - c0[1]) * t,
            c0[2] + (c1[2] - c0[2]) * t,
            1.0,
        )
    try:
        me.color_attributes.active_color = attr
    except Exception:
        pass


for cx, name in GROUPS:
    bpy.ops.wm.open_mainfile(filepath=BLEND)
    bpy.context.view_layer.update()

    meshes = [o for o in bpy.data.objects if o.type == 'MESH']
    dropped = [o.name for o in meshes if is_water_plane(o)]
    meshes = [o for o in meshes if not is_water_plane(o)]
    # 归属：显式 x 区间（组间距 40m，用 ±30m 的窗口会重叠，把邻居的模型也导出）
    # 岛（中心 80，最远到 96）与山（中心 120，最左 86）本来就有交叠，
    # 边界取 97：宁可让山的两颗碎岩落到岛上，也不要把岛上的树切走。
    X_RANGES = {
        'cliff': (-1e9, -60), 'tunnel': (-60, -20), 'ramp': (-20, 20),
        'arch': (20, 60), 'island': (60, 97), 'mountain': (97, 1e9),
    }
    lo_x, hi_x = X_RANGES[name]
    keep = []
    for o in meshes:
        lo, hi = world_bounds(o)
        cx_o = (lo.x + hi.x) * 0.5
        if lo_x <= cx_o < hi_x:
            keep.append(o)
    if not keep:
        print("SKIP", name)
        continue
    for o in list(bpy.data.objects):
        if o.type == 'MESH' and o not in keep:
            bpy.data.objects.remove(o, do_unlink=True)
    bpy.context.view_layer.update()

    # 关键：把这一组整体平移到原点（否则模型带着建模时的世界坐标，进游戏会被甩到几百米外）
    pts = []
    for o in keep:
        lo, hi = world_bounds(o)
        pts += [lo, hi]
    ctr = sum(pts, Vector((0, 0, 0))) / len(pts)
    lo_z = min(p.z for p in pts)
    for o in keep:
        o.location = (o.location.x - ctr.x, o.location.y - ctr.y, o.location.z - lo_z)
    bpy.context.view_layer.update()

    # 导出前再量一次，把真实尺寸打进日志（游戏中按横向归一化 → 用来核对高度是否被压扁）
    pts = []
    for o in keep:
        lo, hi = world_bounds(o)
        pts += [lo, hi]
    size = (
        max(p.x for p in pts) - min(p.x for p in pts),
        max(p.y for p in pts) - min(p.y for p in pts),
        max(p.z for p in pts) - min(p.z for p in pts),
    )
    print("SIZE", name, [round(v, 1) for v in size], "| 剔除水面:", dropped[:3])

    # 程序化配色烘成顶点色（每组重新打开过文件，材质是新的，清掉去重表）
    FLATTENED.clear()
    for o in keep:
        bake_vertex_colors(o)
    bpy.context.view_layer.update()

    path = os.path.join(OUT, name + ".glb")
    try:
        bpy.ops.export_scene.gltf(filepath=path, export_apply=True, export_vertex_color='ACTIVE')
    except TypeError:
        # 参数名在旧版本不同，退回默认导出（顶点色仍会作为 COLOR_0 写出）
        bpy.ops.export_scene.gltf(filepath=path, export_apply=True)
    print("EXPORTED", name, len(keep), "obj", round(os.path.getsize(path) / 1024), "KB")
print("ALL_DONE")

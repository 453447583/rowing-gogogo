"""
霓虹海峡石构件重建（Blender 无头）
  blender --background --factory-startup --python scripts/blender/build_strait_stone.py -- <out_dir>

产出（原点在底部中心、进深居中，与 Track.#buildStraitProps 的摆位约定一致）：
  stone_wall.glb    约 14.9 × 6.85 × 5.0   深水堤岸式城墙（砌块 + 勒脚 + 压顶 + 扶壁）
  gate_lintel.glb   约 26.5 × 16.2 × 5.2   城门楼（双墩 + 段落拱 + 檐口 + 垛口）

坐标约定（**踩过坑，别再改**）
------------------------------
* 建模一律用「下游坐标」：X = 横向宽度，Y = 高度（向上），Z = 进深（0 居中）。
* add_box(bm, cx, cy, cz, sw, sh, sd, ...) —— cx/cz/cy 全是中心值；sw 宽、sh 高、sd 深。
* 写顶点时才转成 Blender 的 Z-up：(下游 x, y, z) → Blender (x, z, y)。
  导出时 export_yup=True 再换回 glTF 的 Y-up。**第一版直接按 Blender 轴写坐标，
  结果高度落到 Z 轴上，摆进游戏就是"躺倒的墙"**。
* 进深对称：两张立面都铺砌块，正反看不出区别，朝向就不用纠结。

设计要点
--------
* 真砌块拓扑：每块独立六面体（留 0.026m 灰缝），整体倒角 0.02m 做崩边，平直着色。
* 8 个材质基调按确定性哈希分配 → 导出 8 个 primitive → 游戏侧读成逐块顶点色，
  再叠三平面石纹，才有"石头"的味道（原来 4 种近乎同色的平涂 = 用户说的二维码）。
* 内芯是深色实体：灰缝里看进去是阴影，不会透出天空。
* 城墙顶面 6.85m 与既有松树落点（f.y0 + 6.85）对齐。
"""

import bpy
import bmesh
import math
import os
import sys

ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = ARGS[0] if ARGS else os.path.abspath('public/models/track')


# ---------------- 确定性随机 ----------------
class Rng:
    def __init__(self, seed=0x51A7C3):
        self.s = seed & 0xFFFFFFFF

    def next(self):
        self.s = (self.s * 1664525 + 1013904223) & 0xFFFFFFFF
        return self.s / 4294967296.0

    def range(self, a, b):
        return a + (b - a) * self.next()

    def pick(self, seq):
        return seq[int(self.next() * len(seq)) % len(seq)]


STONE_TONES = [
    (0.212, 0.206, 0.186),
    (0.268, 0.258, 0.232),
    (0.172, 0.168, 0.154),
    (0.236, 0.226, 0.202),
    (0.150, 0.152, 0.142),
    (0.292, 0.282, 0.252),
]
CORE_COLOR = (0.040, 0.045, 0.047)
TRIM_COLOR = (0.150, 0.152, 0.140)
TONES = list(range(6))
IDX_CORE = 6
IDX_TRIM = 7
GAP = 0.026


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.objects):
        for item in list(coll):
            coll.remove(item)


def make_materials():
    colors = list(STONE_TONES) + [CORE_COLOR, TRIM_COLOR]
    names = [f'strait_stone_{chr(97 + i)}' for i in range(6)] + ['strait_core', 'strait_trim']
    mats = []
    for i, name in enumerate(names):
        mat = bpy.data.materials.new(name)
        mat.use_nodes = True
        bsdf = mat.node_tree.nodes.get('Principled BSDF')
        r, g, b = colors[i]
        bsdf.inputs['Base Color'].default_value = (r, g, b, 1.0)
        bsdf.inputs['Roughness'].default_value = 0.95 if i == IDX_CORE else 0.88
        for key in ('Specular IOR Level', 'Specular'):
            if key in bsdf.inputs:
                bsdf.inputs[key].default_value = 0.22
                break
        mats.append(mat)
    return mats


_PATTERN = ((-1, -1, -1), (1, -1, -1), (1, 1, -1), (-1, 1, -1),
            (-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1))
_FACES = ((0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4),
          (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7))


def add_box(bm, cx, cy, cz, sw, sh, sd, mat_index, yaw=0.0, tilt=0.0):
    """下游坐标：cx/cz/cy 均为中心；sw 宽、sh 高、sd 深。
    yaw 绕竖轴（水平面内），tilt 绕进深轴（立面上倾斜，拱券用）。"""
    hw, hh, hd = sw * 0.5, sh * 0.5, sd * 0.5
    ca, sa = math.cos(tilt), math.sin(tilt)
    cb, sb = math.cos(yaw), math.sin(yaw)
    verts = []
    for (ux, uz, uy) in _PATTERN:
        px = ux * hw * ca - uy * hh * sa          # 立面内旋转（宽-高）
        ph = ux * hw * sa + uy * hh * ca
        wx = px * cb + uz * hd * sb               # 水平面内偏航（宽-深）
        wd = -px * sb + uz * hd * cb
        verts.append(bm.verts.new((cx + wx, cz + wd, cy + ph)))   # → Blender Z-up
    for f in _FACES:
        face = bm.faces.new([verts[i] for i in f])
        face.material_index = mat_index


def finish(name, bm, mats, bevel=0.02, segments=2):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(obj)
    for m in mats:
        obj.data.materials.append(m)
    mod = obj.modifiers.new('bev', 'BEVEL')
    mod.width = bevel
    mod.segments = segments
    mod.limit_method = 'ANGLE'
    mod.angle_limit = math.radians(35)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.modifier_apply(modifier=mod.name)
    bpy.ops.object.shade_flat()
    obj.select_set(False)
    return obj


def export(obj, filename):
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    path = os.path.join(OUT, filename)
    want = dict(filepath=path, export_format='GLB', use_selection=True,
                export_apply=True, export_image_format='NONE',
                export_animations=False, export_yup=True)
    props = bpy.ops.export_scene.gltf.get_rna_type().properties.keys()
    bpy.ops.export_scene.gltf(**{k: v for k, v in want.items() if k in props})
    tris = sum(len(p.vertices) - 2 for p in obj.data.polygons)
    print(f'EXPORT {filename}  {os.path.getsize(path) / 1024:.0f} KB  tris={tris}')


# =====================================================================
# 石墙 14.6 × 6.85 × 4.0（+ 压顶/勒脚外挑）
# =====================================================================
W_W, W_H, W_D = 14.6, 6.85, 4.0


def build_wall():
    rng = Rng(0xA51D)
    bm = bmesh.new()
    hd = W_D * 0.5

    add_box(bm, 0, (W_H - 0.05) * 0.5, 0, W_W - 0.08, W_H - 0.05, W_D - 0.08, IDX_CORE)

    courses = [1.32, 1.30, 1.30, 1.28, 1.22]
    y = 0.0
    row = 0
    for ch in courses:
        x = -W_W * 0.5 + (0.62 if row % 2 else 0.0)
        while x < W_W * 0.5 - 0.35:
            bw = min(rng.range(1.5, 2.9), W_W * 0.5 - x)
            cx = x + bw * 0.5
            pool = [4, 2, 0] if y < 2.5 else TONES
            mat = rng.pick(pool)
            dep = rng.range(0.26, 0.36)
            for side in (-1, 1):
                add_box(bm, cx + rng.range(-0.01, 0.01), y + ch * 0.5,
                        side * (hd - dep * 0.5 + 0.02),
                        bw - GAP, ch - GAP, dep, mat, yaw=rng.range(-0.005, 0.005))
            x += bw
        y += ch
        row += 1

    x = -W_W * 0.5
    while x < W_W * 0.5 - 0.25:
        bw = min(rng.range(1.7, 2.6), W_W * 0.5 - x)
        add_box(bm, x + bw * 0.5, W_H - 0.66, 0, bw - 0.03, 0.40, W_D - 0.12, rng.pick(TONES))
        x += bw

    add_box(bm, 0, W_H - 0.22, 0, W_W + 0.22, 0.44, W_D + 0.30, IDX_TRIM)
    add_box(bm, 0, 0.34, 0, W_W + 0.26, 0.68, W_D + 0.34, IDX_CORE)

    for bx in (-4.7, 4.7):
        for k in range(6):
            yc = 0.62 + k * 0.86
            if yc > 5.1:
                break
            out = 0.58 * (1.0 - k / 7.0)
            for side in (-1, 1):
                add_box(bm, bx, yc + 0.43, side * (hd + out * 0.5),
                        1.55, 0.86, 0.30 + out, rng.pick(TONES))

    return finish('stone_wall', bm, MATS, bevel=0.019)


# =====================================================================
# 城门楼 26 × 16.2 × 4.6，门洞净空 ≥12.5m
# =====================================================================
G_W, G_D = 26.0, 4.6
OPEN_HALF = 8.7
PIER_OUT = 13.0
SPRING_Y = 11.2
CROWN_Y = 12.6
ARCH_T = 0.95
BAND_BOT = 14.05
CAP_TOP = 15.05
CRENEL_TOP = 16.2


def arch_y(x):
    """拱腹曲线：两端 SPRING_Y、正中 CROWN_Y（过三点的圆弧）。"""
    x = max(-OPEN_HALF, min(OPEN_HALF, x))
    k = (OPEN_HALF ** 2 + SPRING_Y ** 2 - CROWN_Y ** 2) / (2.0 * (SPRING_Y - CROWN_Y))
    r = CROWN_Y - k
    return k + math.sqrt(max(0.0, r * r - x * x))


def build_gate():
    rng = Rng(0x64A7E)
    bm = bmesh.new()
    hd = G_D * 0.5

    # ⚠ 内芯**不能**横跨整幅：门洞必须是空的。只在两墩里填实，
    # 拱以上的实体由楔石背面的填石一路堆到檐口（见下面的拱券循环）。
    # 第一版偷懒用一个 26m 宽的大方块当内芯，结果整个门洞被堵死，远看像一扇关死的城门。
    for side in (-1, 1):
        lo = min(side * OPEN_HALF, side * (PIER_OUT - 0.5)) + 0.05
        hi = max(side * OPEN_HALF, side * (PIER_OUT - 0.5)) + 0.05
        add_box(bm, (lo + hi) * 0.5, SPRING_Y * 0.5, 0,
                (hi - lo) - 0.06, SPRING_Y, G_D - 0.08, IDX_CORE)

    for side in (-1, 1):
        lo0, hi0 = min(side * OPEN_HALF, side * PIER_OUT), max(side * OPEN_HALF, side * PIER_OUT)
        y = 0.0
        while y < SPRING_Y - 0.05:
            ch = min(rng.range(1.02, 1.34), SPRING_Y - y)
            inset = 0.45 * (y / SPRING_Y)
            a, b = (lo0 + inset, hi0) if side < 0 else (lo0, hi0 - inset)
            # 每层切 2~3 块，切点带抖动（等分太像瓷砖）
            span = b - a
            parts = 3 if span > 3.1 and rng.next() < 0.45 else (2 if span > 2.2 else 1)
            cuts = [a, b]
            for p in range(1, parts):
                frac = p / parts + rng.range(-0.13, 0.13)
                cuts.insert(p, a + span * max(0.18, min(0.82, frac)))
            for p in range(parts):
                pa, pb = cuts[p], cuts[p + 1]
                pool = [4, 2, 0, 3] if y < 2.4 else TONES
                mat = rng.pick(pool)
                dep = rng.range(0.26, 0.36)
                for face in (-1, 1):
                    add_box(bm, (pa + pb) * 0.5, y + ch * 0.5,
                            face * (hd - dep * 0.5 + 0.02),
                            (pb - pa) - GAP, ch - GAP, dep, mat)
            y += ch
        add_box(bm, side * (OPEN_HALF + (PIER_OUT - OPEN_HALF) * 0.5), SPRING_Y - 0.18,
                0, (PIER_OUT - OPEN_HALF) + 0.5, 0.42, G_D + 0.26, IDX_TRIM)

    n = 17
    for i in range(n):
        xa = -OPEN_HALF + (2 * OPEN_HALF) * i / n
        xb = -OPEN_HALF + (2 * OPEN_HALF) * (i + 1) / n
        ya, yb = arch_y(xa), arch_y(xb)
        xm = (xa + xb) * 0.5
        seg = math.hypot(xb - xa, yb - ya)
        tilt = math.atan2(yb - ya, xb - xa)
        cy = (ya + yb) * 0.5 + ARCH_T * 0.5
        mat = rng.pick([1, 3, 5, 0])
        # 通深楔石：一整圈拱券铺满进深，拱腹（门洞顶棚）就是连续弧面。
        # 旧版只做了 0.30 深的面砖、再用一堆轴对齐方块垫背，抬头看到的是"阶梯叠板"。
        add_box(bm, xm, cy, 0, seg - 0.012, ARCH_T - 0.02, G_D - 0.02, mat, tilt=tilt)

    y = SPRING_Y + ARCH_T
    while y < BAND_BOT - 0.25:
        ch = min(rng.range(0.88, 1.18), BAND_BOT - y)
        x = -OPEN_HALF
        while x < OPEN_HALF - 0.3:
            bw = min(rng.range(1.5, 2.5), OPEN_HALF - x)
            cx = x + bw * 0.5
            if y >= arch_y(cx) + ARCH_T - 0.06:
                mat = rng.pick(TONES)
                dep = rng.range(0.26, 0.34)
                for face in (-1, 1):
                    add_box(bm, cx, y + ch * 0.5, face * (hd - dep * 0.5 + 0.02),
                            bw - GAP, ch - GAP, dep, mat)
            x += bw
        y += ch

    add_box(bm, 0, BAND_BOT - 0.02, 0, G_W + 0.30, 0.38, G_D + 0.34, IDX_TRIM)
    add_box(bm, 0, BAND_BOT + 0.42, 0, G_W + 0.10, 0.48, G_D + 0.18, IDX_TRIM)

    add_box(bm, 0, CAP_TOP + 0.34, 0, G_W - 0.5, 0.68, G_D - 0.55, IDX_CORE)
    x = -G_W * 0.5 + 0.35
    while x < G_W * 0.5 - 0.6:
        add_box(bm, x + 0.55, (CAP_TOP + CRENEL_TOP) * 0.5, 0,
                1.10, CRENEL_TOP - CAP_TOP, G_D - 0.22, rng.pick([1, 3, 5]))
        x += 2.05

    for side in (-1, 1):
        add_box(bm, side * (OPEN_HALF + 0.18), 3.4, 0, 0.36, 3.2, G_D + 0.02, IDX_CORE)

    return finish('gate_lintel', bm, MATS, bevel=0.017)


reset_scene()
MATS = make_materials()
os.makedirs(OUT, exist_ok=True)
export(build_wall(), 'stone_wall.glb')
export(build_gate(), 'gate_lintel.glb')
print('DONE strait stone')

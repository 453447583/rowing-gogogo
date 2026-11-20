"""熔岩夜航：3 种火山障碍原型 → 带贴图的 GLB。

原则（blender-race-scene）：**几何进 Blender，逻辑留 JS**。
这里只产出"看得见的石头"，碰撞体、摆位、节奏全部由 Track.js 的 JS 圆形代理负责。

v2（2026-11-14，用户反馈"像啥都没得的几何体，加点贴图、烘焙一下"）：
  * 几何不再是一根光棱柱 —— 细分 2 次 + 沿法线做 fbm 起伏，做出真正的岩体轮廓。
  * 表面走 **盒式投影 UV（box mapping）** + **无缝平铺贴图**：
      岩石底纹 / 火山灰斑 / 蜂窝气孔 / 熔岩裂纹 全烘进一张 1024² sRGB 贴图，
      裂纹自发光单独一张 512²，两张都在 numpy 里按周期噪声生成（保证四边无缝）。
      为什么不用 Cycles 逐物体烘焙：盒式投影的 UV 是重叠的，烘焙必然是脏图；
      平铺贴图 + 世界尺度 UV 既无缝又只需 4 张贴图给 3 个原型共用。
  * 真正的"烘焙"放在顶点色：BVH 射线半球采样烘 **AO**（棱缝/接地暗部），
    再叠一层"越靠近熔岩面越热"的暖色偏移 → COLOR_0，glTF 里与贴图相乘。

硬规则（见项目记忆）：
  * color_attributes[].color 吃线性值，sRGB hex 要先 s2l()。
  * 原点放在「落地面中心」（几何 z 从 0 起）。
  * 导出器 kwargs 先查 get_rna_type().properties，别猜。

用法：
  blender -b --factory-startup --python-exit-code 1 \
    --python scripts/blender/build_magma_obstacles.py
输出：public/models/magma/{volcanic_pillar,lava_spikes,obsidian_shard}.glb
      public/models/magma/tex/{basalt,obsidian}_{albedo,emissive}.{jpg,png}
      stdout 以 @@JSON@@{...} 结尾，含包围盒 / 三角面数 / 贴图清单。
"""

import bpy  # noqa
import bmesh  # noqa
import json
import math
import os
import random

import numpy as np
from mathutils import Vector, noise as mnoise
from mathutils.bvhtree import BVHTree

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT_DIR = os.path.join(ROOT, "public", "models", "magma")
TEX_DIR = os.path.join(OUT_DIR, "tex")
os.makedirs(OUT_DIR, exist_ok=True)
os.makedirs(TEX_DIR, exist_ok=True)

# 贴图分辨率 / 世界跨度：一张图铺满 3.4m，4.6m 宽的岩柱约 1.4 个循环
TEX_ALB = 1024
TEX_EMI = 256
TILE_METERS = 3.4


def s2l(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def lin(rgb):
    return tuple(s2l(int(rgb[i : i + 2], 16) / 255.0) for i in (0, 2, 4))


def rgb(*v):
    """0-255 sRGB → 0-1 float 三元组（贴图直接按 sRGB 写出，不做线性化）"""
    return np.array(v, dtype=np.float32) / 255.0


# ---------- 两套调色板 ----------
# basalt: 玄武岩柱 / 熔岩尖刺（暖褐灰，夜里也读得出棱面）
# obsidian: 黑曜石刃（冷紫黑，高光更硬）
PALETTES = {
    "basalt": {
        "dark": rgb(68, 52, 52),
        "mid": rgb(114, 88, 78),
        "light": rgb(164, 134, 112),
        "ash": rgb(130, 122, 124),
        "char": rgb(24, 18, 20),
        "ember": rgb(168, 48, 10),
        "hot": rgb(255, 152, 44),
        "core": rgb(255, 228, 156),
        "rough": 0.90,
    },
    "obsidian": {
        "dark": rgb(44, 40, 58),
        "mid": rgb(74, 66, 92),
        "light": rgb(126, 118, 148),
        "ash": rgb(112, 110, 130),
        "char": rgb(12, 10, 18),
        "ember": rgb(150, 40, 12),
        "hot": rgb(255, 148, 56),
        "core": rgb(255, 222, 152),
        "rough": 0.55,
    },
}


# ---------- 无缝（周期）噪声 ----------
def _fade(t):
    return t * t * (3.0 - 2.0 * t)


def pnoise2(w, h, freq, rng):
    """周期性 value noise：freq×freq 格点首尾相接，所以贴图四边可无缝平铺。"""
    g = rng.random((freq, freq)).astype(np.float32)
    xs = (np.arange(w, dtype=np.float32) / w) * freq
    ys = (np.arange(h, dtype=np.float32) / h) * freq
    xf = np.floor(xs)
    yf = np.floor(ys)
    x0 = xf.astype(np.int32) % freq
    y0 = yf.astype(np.int32) % freq
    tx = _fade(xs - xf)[None, :]
    ty = _fade(ys - yf)[:, None]
    x1 = (x0 + 1) % freq
    y1 = (y0 + 1) % freq
    a = g[np.ix_(y0, x0)]
    b = g[np.ix_(y0, x1)]
    c = g[np.ix_(y1, x0)]
    d = g[np.ix_(y1, x1)]
    top = a + (b - a) * tx
    bot = c + (d - c) * tx
    return (top + (bot - top) * ty).astype(np.float32)


def fbm(w, h, freq, octaves, rng, gain=0.5):
    total = np.zeros((h, w), np.float32)
    amp, norm, f = 1.0, 0.0, float(freq)
    for _ in range(octaves):
        total += pnoise2(w, h, max(2, int(round(f))), rng) * amp
        norm += amp
        amp *= gain
        f *= 2.0
    return total / norm


def pvoronoi(w, h, freq, rng, want_cell=False):
    """周期 Voronoi：(d1, d2) 距离场 + 可选"最近胞元随机值"。
    d2-d1 越小越靠近胞界 → 天然裂纹；cell 值用来给每个石块一点独立的色偏。"""
    jx = rng.random((freq, freq)).astype(np.float32)
    jy = rng.random((freq, freq)).astype(np.float32)
    cv = rng.random((freq, freq)).astype(np.float32)
    X = (np.arange(w, dtype=np.float32) / w) * freq
    Y = (np.arange(h, dtype=np.float32) / h) * freq
    Xf = np.floor(X)
    Yf = np.floor(Y)
    u = (X - Xf)[None, :]
    v = (Y - Yf)[:, None]
    gi = Yf.astype(np.int32) % freq
    gj = Xf.astype(np.int32) % freq
    d1 = np.full((h, w), 9.0, np.float32)
    d2 = np.full((h, w), 9.0, np.float32)
    cell = np.zeros((h, w), np.float32)
    for oy in (-1, 0, 1):
        for ox in (-1, 0, 1):
            ii = (gi + oy) % freq
            jj = (gj + ox) % freq
            dx = ox + jx[np.ix_(ii, jj)] - u
            dy = oy + jy[np.ix_(ii, jj)] - v
            d = np.sqrt(dx * dx + dy * dy) / freq
            if want_cell:
                cell = np.where(d < d1, cv[np.ix_(ii, jj)], cell)
            d2 = np.minimum(d2, np.maximum(d1, d))
            d1 = np.minimum(d1, d)
    if want_cell:
        return d1, d2, cell
    return d1, d2


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / max(1e-6, (e1 - e0)), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def lerp(a, b, t):
    t = t[..., None] if (hasattr(t, "shape") and t.ndim == 2) else t
    return a * (1.0 - t) + b * t


def make_textures(pal, seed):
    """烘一套可平铺的岩石 albedo + 裂纹 emissive。"""
    w, h = TEX_ALB, TEX_ALB

    # --- 大块色斑：三层 fbm 叠出"深浅不一的火山岩" ---
    n_big = fbm(w, h, 2, 5, np.random.default_rng(seed + 3))
    n_mid = fbm(w, h, 6, 5, np.random.default_rng(seed + 4))
    n_fine = fbm(w, h, 18, 4, np.random.default_rng(seed + 5))
    rock = 0.45 * n_big + 0.33 * n_mid + 0.22 * n_fine
    col = lerp(pal["dark"], pal["mid"], smoothstep(0.34, 0.58, rock))
    col = lerp(col, pal["light"], smoothstep(0.58, 0.78, rock))

    # --- 石块分块：每个 Voronoi 胞元一点色偏；接缝只留很淡的一层，
    #     否则整张图会变成"龟裂的泥地"，远看全是网格 ---
    d1c, d2c, cell = pvoronoi(w, h, 9, np.random.default_rng(seed + 11), want_cell=True)
    col = np.clip(col * (0.90 + 0.18 * cell)[..., None], 0.0, 1.0)
    seam = (1.0 - smoothstep(0.0, 0.012, d2c - d1c)) * 0.20
    col = lerp(col, pal["char"], seam)

    # --- 火山灰斑：阈值块，冷灰，压掉"塑料感" ---
    ash_n = fbm(w, h, 15, 4, np.random.default_rng(seed + 6))
    col = lerp(col, pal["ash"], smoothstep(0.60, 0.84, ash_n) * 0.34)

    # --- 矿物亮粒 + 气孔：高频噪声阈值（不用 Voronoi，避免规整蜂窝） ---
    fleck = pnoise2(w, h, 96, np.random.default_rng(seed + 12))
    col = lerp(col, pal["light"] * 1.12, smoothstep(0.84, 0.96, fleck) * 0.30)
    pore = pnoise2(w, h, 64, np.random.default_rng(seed + 13))
    col = lerp(col, pal["char"], smoothstep(0.80, 0.95, pore) * 0.45)

    # --- 熔岩裂纹：柱状节理。热晕(宽) + 亮芯(窄) 两层，只有一部分节理是裂开的 ---
    d1a, d2a = pvoronoi(w, h, 4, np.random.default_rng(seed + 8))
    gap = np.maximum(0.0, d2a - d1a)                     # 距离单位 = UV（1 图 = 1 循环）
    halo = 1.0 - smoothstep(0.0, 0.042, gap)
    core = 1.0 - smoothstep(0.0, 0.013, gap)
    # 稀疏化：只有一部分节理被岩浆顶开，否则整块石头像个碎玻璃球
    sparse = smoothstep(0.48, 0.70, fbm(w, h, 5, 4, np.random.default_rng(seed + 10)))
    halo *= sparse * (0.72 + 0.40 * n_mid)
    core *= sparse * (0.84 + 0.34 * n_mid)

    # 裂纹内部：暗红 → 橙 → 亮芯
    emi_col = lerp(pal["ember"], pal["hot"], smoothstep(0.24, 0.90, core))
    emi_col = lerp(emi_col, pal["core"], smoothstep(0.72, 1.0, core))
    # 外侧先烤黑一圈，再叠暖色余辉，最后盖亮芯 —— 读起来才像"壳被顶开"
    col = lerp(col, pal["char"], np.clip(halo, 0.0, 1.0) * 0.50)
    col = lerp(col, pal["ember"] * 0.85, np.clip(halo, 0.0, 1.0) * 0.42)
    col = lerp(col, emi_col * 0.88, np.clip(core, 0.0, 1.0) * 0.92)

    alb = np.clip(col, 0.0, 1.0)
    emi = np.clip(emi_col * smoothstep(0.06, 1.0, core)[..., None], 0.0, 1.0)

    # emissive 单独降一档分辨率（它只有亮线，模糊一点反而更柔）
    step = TEX_ALB // TEX_EMI
    if step >= 1:
        emi_small = emi.reshape(TEX_EMI, step, TEX_EMI, step, 3).mean(axis=(1, 3))
    else:
        emi_small = emi
    return alb, emi_small.astype(np.float32)


def write_image(name, arr, path, fmt):
    h, w = arr.shape[0], arr.shape[1]
    img = bpy.data.images.new(name, w, h, alpha=False)
    rgba = np.ones((h, w, 4), np.float32)
    rgba[..., :3] = arr
    img.pixels.foreach_set(rgba.ravel())
    img.filepath_raw = path
    img.file_format = fmt
    img.save()
    img.pack()
    return img


# ---------- 几何 ----------
def make_mesh(name, verts, faces):
    me = bpy.data.meshes.new(name + "_mesh")
    me.from_pydata(verts, [], faces)
    me.update()
    for p in me.polygons:
        p.use_smooth = False  # 低模硬面，别被平滑成泥球
    obj = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(obj)
    obj.location = (0.0, 0.0, 0.0)
    return obj


def roughen(obj, seed, amount, scale=1.0, cuts=2):
    """细分 + 沿法线 fbm 起伏：把光棱柱打成真正的岩体。"""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=cuts, use_grid_fill=True)
    bm.normal_update()
    rng = random.Random(seed)
    off = Vector((rng.random() * 40, rng.random() * 40, rng.random() * 40))
    for v in bm.verts:
        n = v.normal
        if n.length < 1e-5:
            continue
        p = v.co * (0.55 * scale) + off
        d = mnoise.noise(p) * 0.62 + mnoise.noise(p * 3.1) * 0.38
        v.co = v.co + n * (d * amount)
    bm.normal_update()
    bm.to_mesh(obj.data)
    bm.free()
    for p in obj.data.polygons:
        p.use_smooth = False


def box_uv(obj, scale=1.0 / TILE_METERS):
    """按面的主轴做盒式投影：UV 直接是世界米×缩放，平铺贴图自动无缝。"""
    me = obj.data
    if not me.uv_layers:
        me.uv_layers.new(name="UVMap")
    uv = me.uv_layers.active
    for p in me.polygons:
        n = p.normal
        ax = max(range(3), key=lambda i: abs(n[i]))
        for li in p.loop_indices:
            co = me.vertices[me.loops[li].vertex_index].co
            if ax == 0:
                u, v = co.y, co.z
            elif ax == 1:
                u, v = co.x, co.z
            else:
                u, v = co.x, co.y
            uv.data[li].uv = (u * scale, v * scale)


def bake_vertex_color(obj, seed, glow_height):
    """BVH 射线半球采样烘 AO + 近地余热，写进 COLOR_0（线性值）。"""
    deps = bpy.context.evaluated_depsgraph_get()
    bvh = BVHTree.FromObject(obj, deps)
    me = obj.data
    rng = random.Random(seed)
    zmax = max((v.co.z for v in me.vertices), default=1.0) or 1.0
    glow_h = max(0.4, zmax * glow_height)

    attr = me.color_attributes.new(name="COLOR_0", type="FLOAT_COLOR", domain="POINT")
    me.update()

    dirs = []
    for i in range(14):
        # 余弦加权半球（用两个随机角近似），固定种子保证可复现
        u1 = (i + 0.5) / 14.0
        u2 = rng.random()
        r = math.sqrt(u1)
        phi = 2.0 * math.pi * u2
        dirs.append((r * math.cos(phi), r * math.sin(phi), math.sqrt(max(0.0, 1.0 - u1))))

    maxd = zmax * 0.75 + 0.3
    for vi, v in enumerate(me.vertices):
        n = v.normal
        if n.length < 1e-5:
            n = Vector((0.0, 0.0, 1.0))
        n = n.normalized()
        # 构造切空间
        t = Vector((0.0, 0.0, 1.0)).cross(n)
        if t.length < 1e-4:
            t = Vector((1.0, 0.0, 0.0)).cross(n)
        t.normalize()
        b = n.cross(t)
        origin = v.co + n * 0.012
        hits = 0
        for dx, dy, dz in dirs:
            d = (t * dx + b * dy + n * dz).normalized()
            loc, nor, idx, dist = bvh.ray_cast(origin, d, maxd)
            if loc is not None:
                hits += 1
        ao = 1.0 - hits / len(dirs)
        ao = 0.46 + 0.54 * (ao ** 1.15)

        # 越靠近熔岩面越热：底部一层暖色偏移，让石头"泡在岩浆里"
        g = max(0.0, 1.0 - v.co.z / glow_h)
        g = g * g
        r = min(1.0, ao * (1.0 + 0.62 * g))
        gg = min(1.0, ao * (1.0 + 0.20 * g))
        bb = max(0.0, min(1.0, ao * (1.0 - 0.16 * g)))
        attr.data[vi].color = (r, gg, bb, 1.0)
    me.update()


def final_material(name, alb_img, emi_img, rough):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    out.location = (420, 0)
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (120, 0)
    nt.links.new(bsdf.outputs[0], out.inputs["Surface"])

    ta = nt.nodes.new("ShaderNodeTexImage")
    ta.image = alb_img
    ta.location = (-260, 220)
    ta.interpolation = "Linear"
    ta.extension = "REPEAT"
    nt.links.new(ta.outputs["Color"], bsdf.inputs["Base Color"])

    te = nt.nodes.new("ShaderNodeTexImage")
    te.image = emi_img
    te.location = (-260, -160)
    te.interpolation = "Linear"
    te.extension = "REPEAT"
    nt.links.new(te.outputs["Color"], bsdf.inputs["Emission Color"])

    bsdf.inputs["Emission Strength"].default_value = 1.0
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = 0.0
    mat.diffuse_color = (1.0, 1.0, 1.0, 1.0)
    return mat


def pillar(r=2.1, h=8.0, sides=7, rings=4, seed=11):
    rng = random.Random(seed)
    verts, faces = [], []
    for k in range(rings + 1):
        t = k / rings
        z = h * t
        rr = r * (1.0 - 0.52 * t)
        for i in range(sides):
            a = 2 * math.pi * i / sides + 0.18 * t
            j = 0.84 + rng.random() * 0.32
            verts.append(
                (
                    math.cos(a) * rr * j,
                    math.sin(a) * rr * j,
                    z + (rng.random() - 0.5) * 0.22,
                )
            )
    for k in range(rings):
        for i in range(sides):
            a = k * sides + i
            b = k * sides + (i + 1) % sides
            c = (k + 1) * sides + (i + 1) % sides
            d = (k + 1) * sides + i
            faces.append((a, b, c, d))
    tip = len(verts)
    verts.append((0.0, 0.0, h + 1.35))
    for i in range(sides):
        faces.append((rings * sides + i, rings * sides + (i + 1) % sides, tip))
    faces.append(tuple(reversed(range(sides))))
    return verts, faces


def add_cone(verts, faces, cx, cy, z0, r, h, sides, seed, lean=0.0):
    rng = random.Random(seed)
    start = len(verts)
    for i in range(sides):
        a = 2 * math.pi * i / sides
        j = 0.78 + rng.random() * 0.42
        verts.append((cx + math.cos(a) * r * j, cy + math.sin(a) * r * j, z0))
    tip = len(verts)
    verts.append((cx + lean, cy + lean * 0.4, z0 + h))
    for i in range(sides):
        faces.append((start + i, start + (i + 1) % sides, tip))
    faces.append(tuple(reversed(range(start, start + sides))))


def spikes(seed=23):
    verts, faces = [], []
    add_cone(verts, faces, 0, 0, 0, 2.7, 1.1, 7, seed)
    spec = [
        (-1.45, -0.65, 4.4, 0.95, 0.35),
        (1.35, -0.95, 3.7, 0.85, -0.3),
        (0.15, 1.35, 5.3, 1.05, 0.2),
        (-0.95, 1.25, 3.2, 0.78, 0.15),
        (1.55, 0.85, 2.8, 0.72, -0.2),
    ]
    for i, (cx, cy, h, r, lean) in enumerate(spec):
        add_cone(verts, faces, cx, cy, 0.35, r, h, 5, seed + 7 + i, lean)
    return verts, faces


def add_blade(verts, faces, cx, cy, w, d, h, rot, seed):
    rng = random.Random(seed)
    co, si = math.cos(rot), math.sin(rot)

    def put(x, y, z):
        verts.append((cx + x * co - y * si, cy + x * si + y * co, z))

    idx = len(verts)
    put(-w / 2, -d / 2, 0)
    put(w / 2, -d / 2, 0)
    put(w / 2, d / 2, 0)
    put(-w / 2, d / 2, 0)
    put(-w * 0.46, -d * 0.62, h * 0.44)
    put(w * 0.46, -d * 0.62, h * 0.44)
    put(w * 0.46, d * 0.62, h * 0.44)
    put(-w * 0.46, d * 0.62, h * 0.44)
    tip = len(verts)
    put((rng.random() - 0.5) * 0.4, 0, h)
    b = idx
    faces.append((b + 3, b + 2, b + 1, b))
    for k in range(4):
        faces.append((b + k, b + (k + 1) % 4, b + 4 + (k + 1) % 4, b + 4 + k))
    for k in range(4):
        faces.append((b + 4 + k, b + 4 + (k + 1) % 4, tip))


def shards(seed=37):
    verts, faces = [], []
    add_blade(verts, faces, 0.0, 0.0, 3.0, 1.35, 6.6, 0.25, seed)
    add_blade(verts, faces, -1.25, 0.75, 1.9, 1.0, 4.2, -0.55, seed + 1)
    add_blade(verts, faces, 1.35, -0.6, 2.0, 1.05, 5.0, 0.85, seed + 2)
    return verts, faces


# name, builder, seed, palette, 起伏量, 近地余热高度占比
PROTOTYPES = [
    ("volcanic_pillar", pillar, 101, "basalt", 0.34, 0.46),
    ("lava_spikes", spikes, 203, "basalt", 0.20, 0.56),
    ("obsidian_shard", shards, 307, "obsidian", 0.16, 0.50),
]


def export_one(obj, filepath):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.context.view_layer.update()
    props = {p.identifier for p in bpy.ops.export_scene.gltf.get_rna_type().properties}
    kwargs = {
        "filepath": filepath,
        "export_format": "GLB",
        "use_selection": True,
        "export_apply": True,
        "export_yup": True,
    }
    for key, val in (
        ("export_vertex_color", "ACTIVE"),
        ("export_materials", "EXPORT"),
        ("export_normals", True),
        ("export_texcoords", True),
        ("export_image_format", "AUTO"),
        ("export_cameras", False),
        ("export_lights", False),
    ):
        if key in props:
            kwargs[key] = val
    bpy.ops.export_scene.gltf(**kwargs)


def main():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.context.view_layer.update()

    # 先把两套贴图烘出来（3 个原型共用）
    tex = {}
    for variant, pal in PALETTES.items():
        alb, emi = make_textures(pal, 900 + len(variant) * 17)
        alb_path = os.path.join(TEX_DIR, variant + "_albedo.jpg")
        emi_path = os.path.join(TEX_DIR, variant + "_emissive.png")
        tex[variant] = {
            "albedo": write_image(variant + "_albedo", alb, alb_path, "JPEG"),
            "emissive": write_image(variant + "_emissive", emi, emi_path, "PNG"),
            "albedo_path": alb_path,
            "emissive_path": emi_path,
        }

    report = []
    for name, builder, seed, variant, bump, glow in PROTOTYPES:
        verts, faces = builder()
        obj = make_mesh(name, verts, faces)
        roughen(obj, seed, bump, scale=1.0, cuts=2)
        box_uv(obj)
        bake_vertex_color(obj, seed + 5, glow)
        pal = PALETTES[variant]
        obj.data.materials.clear()
        obj.data.materials.append(
            final_material(
                name + "_mat",
                tex[variant]["albedo"],
                tex[variant]["emissive"],
                pal["rough"],
            )
        )
        bpy.context.view_layer.update()

        me = obj.data
        xs = [v.co.x for v in me.vertices]
        ys = [v.co.y for v in me.vertices]
        zs = [v.co.z for v in me.vertices]
        filepath = os.path.join(OUT_DIR, name + ".glb")
        export_one(obj, filepath)
        report.append(
            {
                "name": name,
                "file": os.path.relpath(filepath, ROOT).replace("\\", "/"),
                "bytes": os.path.getsize(filepath),
                "variant": variant,
                "verts": len(me.vertices),
                "tris": sum(max(0, len(p.vertices) - 2) for p in me.polygons),
                "uv": bool(me.uv_layers),
                "vcol": any(a.name == "COLOR_0" for a in me.color_attributes),
                "box_min": [round(min(xs), 2), round(min(ys), 2), round(min(zs), 2)],
                "box_max": [round(max(xs), 2), round(max(ys), 2), round(max(zs), 2)],
            }
        )

    tex_report = [
        {
            "name": v,
            "albedo_bytes": os.path.getsize(t["albedo_path"]),
            "emissive_bytes": os.path.getsize(t["emissive_path"]),
        }
        for v, t in tex.items()
    ]
    print(
        "@@JSON@@"
        + json.dumps(
            {"ok": True, "prototypes": report, "textures": tex_report},
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()

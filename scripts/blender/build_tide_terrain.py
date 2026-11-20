# -*- coding: utf-8 -*-
"""冰汐海峡（tide）地形资产：峡谷岩壁段 + 大/小冰山。

全部程序化生成：3D 噪声位移 + 顶点色（导出 COLOR_0），无贴图、无外部依赖。
输出到 public/models/props/：
    cliff_segment.glb   60m × 26m × 18m 岩壁段
    iceberg_large.glb   直径 ~34m 冰山
    iceberg_small.glb   直径 ~14m 碎冰山

用法（二选一）：
    blender -b --python scripts/blender/build_tide_terrain.py
    Blender 内：exec(open(r"<项目>/scripts/blender/build_tide_terrain.py").read())

坐标约定：原点在底面中心，+Z 沿岩壁长度方向，+Y 向上，+X 是岩壁正面朝外的方向。
冰原点在水线中心（y=0 即水面），下沉量由场景摆放时决定。
"""

import math
import os

import bpy
import bmesh
from mathutils import Vector, noise

# --------------------------------------------------------------------------
# 路径
# --------------------------------------------------------------------------
try:
    _HERE = os.path.dirname(os.path.abspath(__file__))
    PROJECT = os.path.normpath(os.path.join(_HERE, '..', '..'))
except NameError:  # Blender 的 exec 环境没有 __file__
    PROJECT = r'D:/3Dgame - 副本'
OUT_DIR = os.path.join(PROJECT, 'public', 'models', 'props')
os.makedirs(OUT_DIR, exist_ok=True)


# --------------------------------------------------------------------------
# 小工具
# --------------------------------------------------------------------------
def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def rgb(hex_int):
    """sRGB 十六进制 → 线性 (r,g,b)，顶点色按 glTF 规范存线性值。"""
    r = ((hex_int >> 16) & 255) / 255.0
    g = ((hex_int >> 8) & 255) / 255.0
    b = (hex_int & 255) / 255.0
    return (srgb_to_linear(r), srgb_to_linear(g), srgb_to_linear(b))


def mix(a, b, t):
    t = max(0.0, min(1.0, t))
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t)


def clamp01(x):
    return 0.0 if x < 0.0 else (1.0 if x > 1.0 else x)


def smoothstep(x):
    x = clamp01(x)
    return x * x * (3.0 - 2.0 * x)


def scale_rgb(c, k):
    return (c[0] * k, c[1] * k, c[2] * k)


def nf(p, freq=1.0, off=(0.0, 0.0, 0.0)):
    """Perlin 噪声，归一化到约 -1..1。"""
    return noise.noise(Vector((p[0] * freq + off[0], p[1] * freq + off[1], p[2] * freq + off[2])))


def wipe_scene():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    for block in (bpy.data.meshes, bpy.data.materials, bpy.data.objects):
        for item in list(block):
            if item.users == 0:
                block.remove(item)


def new_mesh_object(name, verts, faces, colors):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([tuple(v) for v in verts], [], faces)
    mesh.validate(verbose=False)
    mesh.update()

    attr = mesh.color_attributes.new(name='Col', type='FLOAT_COLOR', domain='POINT')
    for i, c in enumerate(colors):
        attr.data[i].color = (c[0], c[1], c[2], 1.0)
    mesh.color_attributes.active_color = attr
    try:
        mesh.attributes.active_color_index = mesh.attributes.find('Col')
    except Exception:
        pass

    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    return obj


def add_planar_uv(obj, tile_u, tile_v):
    """平面 UV：沿长度按 tile_u 米一格平铺，竖直方向按 tile_v 米一格。
    岩壁只需要"表面有颗粒"，不需要真展开，所以用世界坐标直接投。"""
    mesh = obj.data
    uv = mesh.uv_layers.new(name='UVMap')
    for li, loop in enumerate(mesh.loops):
        co = mesh.vertices[loop.vertex_index].co
        uv.data[li].uv = (co.x / tile_u, (co.z + 0.6 * co.y) / tile_v)


def make_vertex_color_material(obj, name, roughness, specular=0.5, ior_level=None):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    inputs = bsdf.inputs
    inputs['Base Color'].default_value = (1.0, 1.0, 1.0, 1.0)
    inputs['Roughness'].default_value = roughness
    inputs['Metallic'].default_value = 0.0
    for key in ('Specular IOR Level', 'Specular'):
        if key in inputs:
            inputs[key].default_value = specular
            break
    if ior_level is not None and 'IOR' in inputs:
        inputs['IOR'].default_value = ior_level
    vcol = nt.nodes.new('ShaderNodeVertexColor')
    vcol.layer_name = 'Col'
    vcol.location = (-320, 120)
    nt.links.new(vcol.outputs['Color'], inputs['Base Color'])
    obj.data.materials.append(mat)
    return mat


def export_glb(obj, filename):
    path = os.path.join(OUT_DIR, filename)
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    kwargs = dict(
        filepath=path,
        export_format='GLB',
        use_selection=True,
        export_yup=True,
        export_apply=True,
        export_vertex_color='MATERIAL',
        export_active_vertex_color_when_no_material=False,
        export_cameras=False,
        export_lights=False,
        export_animations=False,
    )
    try:
        bpy.ops.export_scene.gltf(**kwargs)
    except TypeError:
        for key in ('export_active_vertex_color_when_no_material', 'export_animations'):
            kwargs.pop(key, None)
        bpy.ops.export_scene.gltf(**kwargs)
    size = os.path.getsize(path)
    tris = sum(len(p.vertices) - 2 for p in obj.data.polygons)
    print('exported %-22s %7.1f KB  verts=%-6d tris=%d' % (
        filename, size / 1024.0, len(obj.data.vertices), tris))
    return path


# --------------------------------------------------------------------------
# 1. 峡谷岩壁段
# --------------------------------------------------------------------------
def build_cliff_segment():
    """60(长) × 26(高) × ~18(厚) 的峡谷岩壁段。

    Blender 是 Z 轴朝上、导出 yup 后几何轴会转成 glTF 的 X 长 / Y 高 / Z 厚，
    所以这里按 Blender 约定建模：X = 长度，Y = 厚度，Z = 高度。

    形制不是"噪声立方体"——那样远看就是一个灰盒子。这里用**放样山脊**：
    沿 X 每 1.3m 取一个横断面，每个断面是一条闭合折线（近垂直岩面 → 锯齿山脊 →
    平缓顶面 → 背面 → 水线），断面之间放样成壳体。

    着色策略：平滑着色 + 顶点色承担"岩层"。突起处提亮、凹陷处压暗（relief），
    再叠横向层理色带和竖向水痕 —— 这些是近距离也能看懂的岩石语言，
    硬边的小面反而会让岩壁变成折纸。
    """
    half_len = 30.0      # X: -30..30 → 60m
    half_thick = 9.0     # Y: -9..9   → 厚 18m（含噪声后 ~20m）
    z_low = -4.0         # 水线以下留 4m，避免冰面/浪头露出断口
    nx = 48              # 沿长度的横断面数
    nface = 14           # 岩面竖直分段
    ntop = 7             # 顶面分段
    nback = 5            # 背面分段

    rock_wet = rgb(0x2a2621)
    rock_low = rgb(0x5b5245)
    rock_mid = rgb(0x7b7060)
    rock_high = rgb(0x9a9080)
    grass = rgb(0x415c2c)
    grass_dark = rgb(0x2b4122)

    def end_fade(u):
        # 两端收窄：让岩壁段可以首尾相接；留 0.3 残差 = 自然岩缝
        return 0.3 + 0.7 * smoothstep((half_len - abs(u)) / 10.0)

    def crest_height(u):
        f = end_fade(u)
        h = 21.0
        h += 5.5 * nf((u * 0.055, 3.1, 0.0), 1.0, (0.0, 0.0, 0.0)) * f
        h += 2.6 * nf((u * 0.16, 7.7, 2.0), 1.0, (0.0, 0.0, 0.0)) * f
        return max(12.0, h)

    def face_point(u, t, f):
        """岩面在某高度比例 t 处的 (y, relief)。后倾 + 竖沟 + 横檐 + 碎裂。"""
        base = -half_thick - 0.6 + 4.2 * (t ** 1.5)   # 上部后倾 4.2m
        groove = 3.4 * nf((u * 0.17, t * 0.5, 0.0), 1.0, (11.0, 0.0, 5.0))   # 竖沟（沿高度慢）
        ledge = 2.9 * nf((u * 0.045, t * 4.2, 4.0), 1.0, (0.0, 3.0, 0.0))    # 横檐
        micro = 1.2 * nf((u * 0.55, t * 2.1, 8.0), 1.0, (2.0, 0.0, 1.0))      # 碎裂
        d = (groove + ledge + micro) * f * (0.45 + 0.55 * t)
        return base + d, d

    # ---------- 逐断面生成横截面折线 ----------
    sections = []   # [(x, y, z, kind, t, relief), ...]
    for i in range(nx + 1):
        u = -half_len + (2.0 * half_len) * i / nx
        f = end_fade(u)
        H = crest_height(u)
        sec = []
        for k in range(nface + 1):
            t = k / nface
            z = z_low + (H - z_low) * t
            y, d = face_point(u, t, f)
            sec.append((u, y, z, 'face', t, d))
        crest_y = sec[-1][1]
        for k in range(1, ntop + 1):
            t = k / ntop
            y = crest_y + (half_thick * 0.88 - crest_y) * t
            bump = 1.6 * nf((u * 0.085, t * 2.6, 9.0), 1.0, (0.0, 0.0, 0.0)) * f
            z = H - 2.8 * (t ** 1.3) + bump
            sec.append((u, y, z, 'top', t, bump))
        back_top_z = sec[-1][2]
        for k in range(1, nback + 1):
            t = k / nback
            y = half_thick * 0.88 + 0.5 * t + 0.9 * nf((u * 0.1, t * 2.0, 2.0), 1.0, (5.0, 0.0, 0.0)) * f
            z = back_top_z - (back_top_z - z_low) * t
            sec.append((u, y, z, 'back', t, 0.0))
        sections.append(sec)

    m = len(sections[0])
    verts = []
    colors = []
    for sec in sections:
        for (x, y, z, kind, t, relief) in sec:
            verts.append(Vector((x, y, z)))
            # ---- 顶点色：下部湿岩、中部灰褐岩层、顶部草绿 ----
            tt = clamp01((z - 0.5) / 15.0)
            c = mix(rock_low, rock_mid, smoothstep(tt))
            if z > 12.0:
                c = mix(c, rock_high, smoothstep(clamp01((z - 12.0) / 9.0)))
            if z < 2.4:
                c = mix(rock_wet, c, clamp01((z + 4.0) / 6.4))
            if kind == 'top' and z > 13.0:
                g = smoothstep(clamp01((z - 13.0) / 6.0)) * smoothstep(clamp01(t * 1.7))
                c = mix(c, mix(grass, grass_dark, smoothstep(clamp01((t - 0.45) / 0.55))), g)
            # 层理：横向色带（岩层）
            band = nf((x * 0.42, z * 1.35, 0.0), 1.0, (3.0, 0.0, 9.0))
            c = scale_rgb(c, 0.86 + 0.26 * band)
            # 体积感：突起提亮、凹处压暗（岩缝的暗影）
            c = scale_rgb(c, 1.0 + 0.13 * clamp01(relief / 3.0) - 0.30 * clamp01(-relief / 3.0))
            # 竖向水痕：随机几道从山脊流下来的深色渍
            stain = nf((x * 1.6, 0.0, 0.0), 1.0, (17.0, 0.0, 0.0))
            if stain > 0.42:
                c = scale_rgb(c, 1.0 - 0.22 * clamp01((stain - 0.42) / 0.5) * clamp01((21.0 - z) / 18.0))
            colors.append(c)

    faces = []
    for i in range(nx):
        a = i * m
        b = (i + 1) * m
        for k in range(m):
            k2 = (k + 1) % m
            faces.append([a + k, a + k2, b + k2, b + k])
    # 两端封口（三角扇）
    vf = len(verts)
    verts.append(Vector((sections[0][0][0], 0.0, 12.0)))
    colors.append(rock_low)
    vl = len(verts)
    verts.append(Vector((sections[-1][0][0], 0.0, 12.0)))
    colors.append(rock_low)
    for k in range(m):
        k2 = (k + 1) % m
        faces.append([vf, k2, k])
        faces.append([vl, (nx * m) + k, (nx * m) + k2])

    obj = new_mesh_object('cliff_segment', verts, faces, colors)
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()
    add_planar_uv(obj, 12.0, 9.0)
    for poly in obj.data.polygons:
        poly.use_smooth = True
    make_vertex_color_material(obj, 'cliff_rock', roughness=0.94, specular=0.22)
    return obj


# --------------------------------------------------------------------------
# 2. 冰山
# --------------------------------------------------------------------------
def build_iceberg(name, radius, subdivisions, seed_off, freq=0.09, sink=4.0):
    """噪声位移的冰山。

    颜色不是"整个球从蓝到白"，而是**按水面高度**分工：
    水线以下压成深蓝（只在下沉部分露出一点冷色），水线附近一圈深青蓝，
    往上快速过渡到冰白 —— 这样露出水面的一整段都有明度差，
    暴风雪里也不会糊成一坨白（方案 5.3 验收要点）。
    """
    bm = bmesh.new()
    try:
        bmesh.ops.create_icosphere(bm, subdivisions=subdivisions, radius=1.0)
    except TypeError:
        bmesh.ops.create_icosphere(bm, subdivisions=subdivisions, diameter=1.0)
    bm.verts.ensure_lookup_table()
    bm.verts.index_update()
    bm.normal_update()

    deep = rgb(0x0f3550)
    midwater = rgb(0x37718f)
    mid = rgb(0x7fb3c9)
    pale = rgb(0xbddcec)
    top = rgb(0xe4f2fb)

    verts = []
    colors = []
    hh = 1.35 * radius             # 拉伸后的半高
    y_water = -sink                # 水线（模型坐标）
    span = max(0.001, hh - y_water)
    for v in bm.verts:
        d = v.co.normalized()
        # 主频按米计（方案给 0.09）+ 两层细节；总幅度钳到 ±25% 半径
        n = nf(d * radius, freq, seed_off)
        n2 = nf(d * radius, freq * 2.9, (seed_off[0] + 41.0, seed_off[1] + 17.0, seed_off[2] + 5.0))
        n3 = nf(d * radius, freq * 7.3, (seed_off[0] + 7.0, seed_off[1] + 63.0, seed_off[2] + 29.0))
        k = 1.0 + 0.25 * (0.74 * n + 0.38 * n2 + 0.16 * n3)
        p = d * (radius * k)
        p.z *= 1.35   # 纵向拉伸（Blender Z = 上）：冰山陡峭
        verts.append(p)

        # 水线归一 → 深蓝 → 青蓝 → 冰白
        t = clamp01((p.z - y_water) / span)
        c = mix(deep, midwater, smoothstep(t / 0.18))
        c = mix(c, mid, smoothstep((t - 0.12) / 0.34))
        c = mix(c, pale, smoothstep((t - 0.44) / 0.30))
        c = mix(c, top, smoothstep((t - 0.76) / 0.24))
        if p.z < y_water:
            c = mix(deep, c, clamp01((p.z + hh) / max(0.001, hh + y_water)))
        # 冰层横纹：让整块冰像"压出来的"，不是一只白球
        c = scale_rgb(c, 1.0 + 0.055 * nf((0.0, 0.0, p.z), 1.1, (2.0, 2.0, 2.0)))
        # 凹处（位移为负）压暗 = 冰裂缝的阴影，暴风雪里靠它保轮廓
        c = scale_rgb(c, 0.58 + 0.54 * clamp01(0.5 + 1.7 * (k - 1.0)))
        colors.append(c)

    faces = [[l.vert.index for l in f.loops] for f in bm.faces]
    bm.free()

    obj = new_mesh_object(name, verts, faces, colors)
    # flat shading：冰是晶体，硬边的小面正好是"冰棱"，平滑着色会变成一团白馒头
    for poly in obj.data.polygons:
        poly.use_smooth = False
    make_vertex_color_material(obj, name + '_ice', roughness=0.26, specular=0.55, ior_level=1.31)
    return obj


# --------------------------------------------------------------------------
def main():
    wipe_scene()
    export_glb(build_cliff_segment(), 'cliff_segment.glb')
    wipe_scene()
    export_glb(build_iceberg('iceberg_large', 17.0, 5, (3.7, 9.1, 21.5), sink=4.5), 'iceberg_large.glb')
    wipe_scene()
    export_glb(build_iceberg('iceberg_small', 7.0, 4, (55.0, 12.4, 8.8), freq=0.21, sink=2.2), 'iceberg_small.glb')
    print('done ->', OUT_DIR)


if __name__ == '__main__':
    main()
else:
    main()

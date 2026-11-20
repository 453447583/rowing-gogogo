# -*- coding: utf-8 -*-
"""
磐石号（titan）参数化低模 —— Blender 5.2 无头运行
  blender -b --factory-startup --python scripts/blender/boats/build_panshi.py

规格：docs/8艘赛艇-建模方案与决策记录.md
  - 水线 y=0，船底 -0.30，船头朝 +Z
  - 所有坐标以 **md 单位**书写，最后统一乘 S（md 3.2m → 目标 4.4m）
  - 4 材质桶：A 漆面 / B 深色件 / C 金属 / D 自发光(+E 玻璃)
产物：
  assets_src/boats/panshi.glb
  shots/boats/panshi_hero.png / _side.png / _rear.png
"""

import bpy
import bmesh
import math
import os
from mathutils import Vector, Matrix

ROOT = "D:/3Dgame - 副本"
OUT_IMG = os.path.join(ROOT, "shots/boats")
OUT_GLB = os.path.join(ROOT, "assets_src/boats/panshi.glb")
os.makedirs(OUT_IMG, exist_ok=True)
os.makedirs(os.path.dirname(OUT_GLB), exist_ok=True)

S = 1.38          # md 3.2m → 4.42m（+ 尾部推进器 ≈ 4.68m，对应 hull.length 4.6）
LMD = 3.10        # md 船长
HALFMD = LMD / 2.0


# ---------------------------------------------------------------- 基础工具
def s2l(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hexlin(h):
    h = h.lstrip("#")
    return (s2l(int(h[0:2], 16) / 255.0),
            s2l(int(h[2:4], 16) / 255.0),
            s2l(int(h[4:6], 16) / 255.0))


def make_mat(name, hexcol, metallic, rough, emit_hex=None, emit_str=0.0, alpha=1.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*hexlin(hexcol), 1.0)
    b.inputs["Metallic"].default_value = metallic
    b.inputs["Roughness"].default_value = rough
    if emit_hex:
        b.inputs["Emission Color"].default_value = (*hexlin(emit_hex), 1.0)
        b.inputs["Emission Strength"].default_value = emit_str
    if alpha < 1.0:
        b.inputs["Alpha"].default_value = alpha
        for attr, val in (("blend_method", "BLEND"), ("surface_render_method", "BLENDED")):
            try:
                setattr(m, attr, val)
            except Exception:
                pass
    return m


def link(ob):
    bpy.context.scene.collection.objects.link(ob)
    return ob


def finish(bm, name, material, loc=(0, 0, 0), rot=(0, 0, 0)):
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.update()
    ob = bpy.data.objects.new(name, me)
    link(ob)
    if material is not None:
        ob.data.materials.append(material)
    ob.location = loc
    ob.rotation_euler = rot
    return ob


def box(name, size, loc, rot=(0, 0, 0), material=None, bevel=0.0, segs=2):
    """size / loc 都是 md 单位，内部统一乘 S。"""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=Vector([v * S for v in size]), verts=bm.verts)
    if bevel > 0:
        bmesh.ops.bevel(bm, geom=list(bm.verts) + list(bm.edges) + list(bm.faces),
                        offset=bevel * S, segments=segs, profile=0.5,
                        affect="EDGES", clamp_overlap=True)
    return finish(bm, name, material, tuple(v * S for v in loc), rot)


def cyl(name, r, depth, loc, rot=(0, 0, 0), material=None, seg=16, r2=None):
    bm = bmesh.new()
    try:
        bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=seg,
                              radius1=r * S, radius2=(r if r2 is None else r2) * S,
                              depth=depth * S)
    except TypeError:
        bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=seg,
                              diameter1=r * 2 * S, diameter2=(r if r2 is None else r2) * 2 * S,
                              depth=depth * S)
    return finish(bm, name, material, tuple(v * S for v in loc), rot)


def strip(name, x1, z1, x2, z2, y, h, t, material):
    """沿 XZ 平面从 (x1,z1) 拉到 (x2,z2) 的薄板（md 单位），用来贴灯带 / 舷条。"""
    dx, dz = x2 - x1, z2 - z1
    ln = math.hypot(dx, dz)
    ang = math.atan2(dx, dz)
    return box(name, (t, h, ln), ((x1 + x2) / 2, y, (z1 + z2) / 2), (0, ang, 0), material)


def edge_band(name, z0, z1, dy, h, t, material, x_mul=1.0, inset=0.008, steps=6):
    """沿船体轮廓逐段生成左右对称的贴条。
    手填坐标在船首收窄段一定会飘到船体外面，所以一律按 hull_profile 采样。"""
    zs = [z0 + (z1 - z0) * i / steps for i in range(steps + 1)]
    for i in range(steps):
        za, zb = zs[i], zs[i + 1]
        pa, pb = hull_profile(za), hull_profile(zb)
        xa = pa[0] * x_mul - inset
        xb = pb[0] * x_mul - inset
        ya = pa[3] + dy
        yb = pb[3] + dy
        for sx in (-1, 1):
            dx, dz = sx * xb - sx * xa, zb - za
            ln = math.hypot(dx, dz)
            ang = math.atan2(dx, dz)
            box("%s_%d_%d" % (name, sx, i), (t, h, ln),
                (sx * (xa + xb) / 2, (ya + yb) / 2, (za + zb) / 2),
                (0, ang, 0), material)


# ---------------------------------------------------------------- 船体放样
def hull_profile(zmd):
    """返回 (半甲板宽, 半折角宽, 半龙骨宽, 甲板高, 折角高, 龙骨高)，单位 md。"""
    t = (zmd + HALFMD) / LMD
    # 首部收窄提前到 t=0.52，尾部也收一点，避免看成一块平板
    wf = 1.0 - 0.66 * max(0.0, (t - 0.52) / 0.48) ** 1.55 - 0.18 * max(0.0, (0.30 - t) / 0.30) ** 1.5
    wf = max(0.05, wf)
    hd = 0.90 * wf
    # 舷弧别抬太狠（抬狠了甲板会被埋进船体，整艘读成一块石头）
    y_top = 0.372 + 0.075 * t ** 1.9 + 0.115 * max(0.0, (t - 0.86) / 0.14) ** 1.25
    y_keel = -0.150 + 0.130 * max(0.0, (t - 0.58) / 0.42) ** 1.5
    return (hd, hd * 0.965, hd * 0.55, y_top, 0.030, y_keel)


def build_hull(mat_paint, mat_dark):
    zs = [-HALFMD + LMD * f for f in (0.0, 0.10, 0.20, 0.32, 0.46, 0.60, 0.72, 0.84, 0.93, 1.0)]
    rings = []
    for z in zs:
        hd, hc, hk, yt, yc, yk = hull_profile(z)
        rings.append([
            (-hd * S, yt * S, z * S),
            (-hc * S, yc * S, z * S),
            (-hk * S, yc * S, z * S),
            (0.0, yk * S, z * S),
            (hk * S, yc * S, z * S),
            (hc * S, yc * S, z * S),
            (hd * S, yt * S, z * S),
            (0.0, (yt + 0.004) * S, z * S),
        ])

    n = len(rings[0])
    verts = [v for r in rings for v in r]
    faces = []
    for i in range(len(rings) - 1):
        a, b = i * n, (i + 1) * n
        for j in range(n):
            j2 = (j + 1) % n
            faces.append((a + j, a + j2, b + j2, b + j))
    faces.append(tuple(range(n)))
    faces.append(tuple((len(rings) - 1) * n + j for j in range(n)))

    me = bpy.data.meshes.new("hull")
    me.from_pydata(verts, [], faces)
    me.update()
    ob = bpy.data.objects.new("hull", me)
    link(ob)
    ob.data.materials.append(mat_paint)
    ob.data.materials.append(mat_dark)

    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()

    for p in me.polygons:
        y = sum(me.vertices[v].co.y for v in p.vertices) / len(p.vertices)
        # 朝上的面 = 甲板，压深色；水线以下也深色；其余是灰舷侧
        up = p.normal.y > 0.72
        p.material_index = 1 if (y < 0.10 * S or up) else 0
    return ob


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene

    # ---------- 材质 ----------
    M_PAINT = make_mat("A_Paint", "737D89", 0.42, 0.33)      # 装甲漆面
    M_PAINT2 = make_mat("A_Paint2", "4B545F", 0.42, 0.36)    # 次级漆面（甲板/舱体）
    M_DARK = make_mat("B_Dark", "171B21", 0.38, 0.60)        # 深色件 / 船底
    M_METAL = make_mat("C_Metal", "8A959F", 0.90, 0.22)      # 金属件
    M_ORANGE = make_mat("D_Orange", "1A0F06", 0.10, 0.50, "FF9E1A", 3.0)
    M_CYAN = make_mat("D_Cyan", "04100F", 0.10, 0.50, "00E5FF", 3.4)
    M_WHITE = make_mat("A_White", "EDF1F5", 0.25, 0.35)
    M_RED = make_mat("A_Red", "FF5A2E", 0.30, 0.42)
    M_GLASS = make_mat("E_Glass", "0A1418", 0.15, 0.05, alpha=0.30)

    # ---------- 船体 ----------
    build_hull(M_PAINT, M_DARK)
    box("keel_pad", (0.70, 0.09, 1.90), (0, -0.150, -0.04), material=M_DARK)

    # 侧舷装甲鼓包（概念图那两条明显的侧面凸台）
    for sx in (-1, 1):
        strip("sponson_%d" % sx, sx * 0.80, -0.95, sx * 0.84, 0.55,
              0.155, 0.20, 0.10, M_PAINT)
        strip("sponson2_%d" % sx, sx * 0.84, 0.55, sx * 0.62, 1.02,
              0.185, 0.17, 0.09, M_PAINT)

    # 船首撞角护甲
    box("ram_low", (1.02, 0.24, 0.50), (0, 0.050, 1.16), material=M_DARK, bevel=0.025)
    box("ram_top", (0.76, 0.20, 0.46), (0, 0.255, 1.20), material=M_PAINT, bevel=0.03)
    box("ram_tip", (0.20, 0.09, 0.09), (0, 0.175, 1.47), material=M_RED, bevel=0.012)

    # ---------- 甲板 / 上层 ----------
    box("deck", (1.22, 0.085, 1.94), (0, 0.402, -0.16), material=M_DARK, bevel=0.018)
    box("deck_upper", (0.96, 0.13, 1.10), (0, 0.470, -0.42), material=M_PAINT2, bevel=0.028)

    # 舷缘深色压条：给船体一条清晰的顶边，不然整艘糊成一坨（这条很关键）
    edge_band("gunnel", -1.16, 1.26, 0.004, 0.058, 0.070, M_DARK)
    # 舷墙
    edge_band("bulwark", -1.10, 1.02, 0.062, 0.132, 0.048, M_PAINT2)
    # 尾部机舱甲板（把大平甲板断开，不然整艘像驳船）
    box("engine_deck", (0.90, 0.16, 0.62), (0, 0.445, -1.10), material=M_PAINT2, bevel=0.03)
    # 船首龙骨柱（撞角上方的竖向加强板，让船头"立"起来）
    box("stem", (0.16, 0.34, 0.30), (0, 0.300, 1.30), (0, 0, 0), M_PAINT, bevel=0.025)

    # ---------- 驾驶舱 ----------
    # 只做两段：座舱体 + 玻璃罩。原来座舱/玻璃/顶盖三层叠起来会变成"台阶金字塔"。
    box("cockpit_base", (0.86, 0.24, 0.86), (0, 0.545, -0.20), material=M_PAINT2, bevel=0.035)
    box("canopy", (0.76, 0.20, 0.74), (0, 0.750, -0.22), material=M_GLASS, bevel=0.055, segs=3)
    box("canopy_spine", (0.075, 0.045, 0.66), (0, 0.812, -0.24), material=M_PAINT2, bevel=0.010)

    # ---------- 防滚架 ----------
    for sx in (-1, 1):
        cyl("cage_post_%d" % sx, 0.026, 0.24, (sx * 0.430, 0.870, -0.02), (0, 0, 0), M_METAL, seg=8)
        cyl("cage_leg_%d" % sx, 0.024, 0.26, (sx * 0.442, 0.830, -0.44),
            (math.radians(15), 0, 0), M_METAL, seg=8)
        cyl("cage_diag_%d" % sx, 0.020, 0.30, (sx * 0.320, 0.900, -0.22),
            (0, math.radians(90), 0), M_METAL, seg=6)
    cyl("cage_bar", 0.026, 0.88, (0, 0.985, -0.02), (0, math.radians(90), 0), M_METAL, seg=8)

    # ---------- 舷侧橙色发光窗 ----------
    for sx in (-1, 1):
        for i, zz in enumerate((0.66, 0.32, -0.02)):
            box("port_%d_%d" % (sx, i), (0.032, 0.090, 0.125),
                (sx * (0.852 - i * 0.006), 0.222, zz), material=M_ORANGE, bevel=0.010)

    # ---------- 青色灯带（贴着折角线走，不再手填坐标）----------
    edge_band("cyan", -1.12, 1.18, -0.284, 0.042, 0.040, M_CYAN, x_mul=1.004, inset=0.0)

    # 白色饰条（船首斜带）
    edge_band("white", 0.72, 1.04, -0.105, 0.072, 0.032, M_WHITE, x_mul=1.006, inset=0.0, steps=3)

    # ---------- 尾部推进器 ×4 ----------
    thr = [(-0.31, 0.235, 0.245), (0.31, 0.235, 0.245), (-0.615, 0.105, 0.155), (0.615, 0.105, 0.155)]
    for i, (tx, ty, tr) in enumerate(thr):
        zc = -HALFMD - 0.075
        cyl("thr_housing_%d" % i, tr, 0.28, (tx, ty, zc), (math.radians(90), 0, 0), M_METAL, seg=20)
        cyl("thr_ring_%d" % i, tr * 0.80, 0.045, (tx, ty, zc - 0.145),
            (math.radians(90), 0, 0), M_CYAN, seg=20)
        cyl("thr_core_%d" % i, tr * 0.46, 0.075, (tx, ty, zc - 0.170),
            (math.radians(90), 0, 0), M_DARK, seg=14)

    # 尾部导流鳍 / 艉板
    for sx in (-1, 1):
        box("fin_%d" % sx, (0.06, 0.20, 0.36), (sx * 0.700, 0.030, -1.16),
            (math.radians(-9), 0, math.radians(sx * 7)), M_DARK, bevel=0.012)
    box("stern_plate", (0.84, 0.20, 0.06), (0, 0.400, -1.545), material=M_PAINT2, bevel=0.015)

    # ---------- 栏杆 ----------
    for sx in (-1, 1):
        for zz in (-1.02, -0.62, -0.22, 0.16, 0.52):
            hd, _, _, yt, _, _ = hull_profile(zz)
            cyl("railpost_%d_%d" % (sx, int(zz * 100)), 0.014, 0.12,
                (sx * (hd - 0.012), yt + 0.060, zz), (0, 0, 0), M_METAL, seg=6)


    edge_band("railtop", -1.02, 0.52, 0.134, 0.020, 0.020, M_METAL, inset=0.022, steps=4)

    # ---------- 雷达 ----------
    cyl("radar_pole", 0.018, 0.14, (0, 0.700, -0.86), (0, 0, 0), M_METAL, seg=6)
    box("radar_pad", (0.183, 0.020, 0.070), (0, 0.772, -0.86), material=M_METAL, bevel=0.006)
    box("radar_lamp", (0.040, 0.032, 0.040), (0, 0.800, -0.86), material=M_RED, bevel=0.006)

    # ---------- 座椅 ----------
    box("seat", (0.30, 0.11, 0.26), (0, 0.560, -0.38), material=M_DARK, bevel=0.02)
    box("seat_back", (0.30, 0.24, 0.085), (0, 0.660, -0.50), material=M_DARK, bevel=0.02)

    # ---------- 统一转成 Blender 的 Z-up ----------
    # 我是按「X 宽 / Y 高 / Z 长(船头+Z)」建的，而 Blender 世界是 Z 向上。
    # 不转的话模型在场景里是"立"着的，截图会变成俯视一坨，导出的 glTF 也会把船长当成高度。
    # 挂一个旋转 90° 的空物体做父级：局部 (x,y,z) → 世界 (x,-z,y)，船头转到 -Y、高度转到 +Z。
    # 这样 export_yup 换算后正好是 glTF 的「+Z 船头 / +Y 向上」。
    root = bpy.data.objects.new("panshi_root", None)
    link(root)
    root.rotation_euler = (math.radians(90), 0, 0)
    meshes = [o for o in scene.collection.objects if o.type == "MESH"]
    for ob in meshes:
        ob.parent = root
        ob.matrix_parent_inverse = Matrix.Identity(4)
    bpy.context.view_layer.update()

    # ---------- 统计 ----------
    total_tris = 0
    for ob in meshes:
        ob.data.calc_loop_triangles()
        total_tris += len(ob.data.loop_triangles)
    print("@@STAT@@ meshes=%d tris=%d" % (len(meshes), total_tris))

    # ---------- 导出 GLB ----------
    root.select_set(True)
    for ob in meshes:
        ob.select_set(True)
    bpy.ops.export_scene.gltf(filepath=OUT_GLB, export_format="GLB",
                              use_selection=True, export_apply=True, export_yup=True)
    print("@@GLB@@", OUT_GLB, os.path.getsize(OUT_GLB))

    # ---------- 布景（世界坐标：Z 向上，船头 -Y）----------
    world = bpy.data.worlds.new("W")
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs[0].default_value = (*hexlin("16212C"), 1)
    bg.inputs[1].default_value = 0.55

    wme = bpy.data.meshes.new("water")
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=26.0)
    bm.to_mesh(wme)
    bm.free()
    water = bpy.data.objects.new("water", wme)
    link(water)
    water.location = (0, 0, -0.025)
    water.data.materials.append(make_mat("W_Water", "040C11", 0.05, 0.72))

    bpy.context.view_layer.update()
    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    for ob in meshes:
        for c in ob.bound_box:
            w = ob.matrix_world @ Vector(c)
            for i in range(3):
                lo[i] = min(lo[i], w[i])
                hi[i] = max(hi[i], w[i])
    center = (lo + hi) / 2
    radius = (hi - lo).length / 2
    print("@@BBOX@@ lo=%s hi=%s size=%s r=%.2f" % (
        [round(v, 2) for v in lo], [round(v, 2) for v in hi],
        [round(v, 2) for v in (hi - lo)], radius))

    def area(name, loc, energy, size, color):
        ld = bpy.data.lights.new(name, "AREA")
        ld.energy = energy
        ld.size = size
        ld.color = hexlin(color)
        ob = bpy.data.objects.new(name, ld)
        link(ob)
        ob.location = loc
        ob.rotation_euler = (Vector((0, 0, 0.35)) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
        return ob

    area("key", (-6.5, -9.0, 6.5), 6200, 9.0, "FFF2DE")
    area("rim", (5.2, 5.4, 3.2), 2200, 5.0, "A6DCFF")
    area("fill", (-9.0, -6.0, 2.2), 2200, 8.0, "D6E8FF")
    area("under", (0.0, -1.0, -1.2), 200, 6.0, "3FA8C8")

    cam_d = bpy.data.cameras.new("cam")
    cam = bpy.data.objects.new("cam", cam_d)
    link(cam)
    scene.camera = cam

    scene.render.engine = "BLENDER_EEVEE"
    try:
        scene.eevee.taa_render_samples = 64
        scene.eevee.use_raytracing = True
    except Exception as e:
        print("@@EEVEE_OPT@@", e)
    scene.render.resolution_x = 880
    scene.render.resolution_y = 495
    scene.view_settings.look = "AgX - Medium High Contrast"
    scene.view_settings.exposure = 0.15

    def aim(pos_dir, lens, fill=1.12):
        cam_d.lens = lens
        # 16:9 下竖向 FOV 比横向小得多，取小的那个算距离，否则船尾会被裁掉
        res_x, res_y = scene.render.resolution_x, scene.render.resolution_y
        sensor = 36.0
        h_half = math.atan((sensor / 2) / lens)
        v_half = math.atan((sensor * res_y / res_x / 2) / lens)
        half = min(h_half, v_half)
        dist = radius / math.tan(half) * fill
        cam.location = center + Vector(pos_dir).normalized() * dist
        cam.rotation_euler = (center - cam.location).to_track_quat("-Z", "Y").to_euler()
        bpy.context.view_layer.update()
        return dist

    # 船头在 -Y；相机方向按 (X, Y, Z)
    shots = [
        ("panshi_hero", (-0.60, -0.78, 0.105), 85, 0.94),
        ("panshi_side", (-1.0, -0.02, 0.07), 95, 0.93),
        ("panshi_rear", (0.58, 0.78, 0.11), 85, 0.96),
    ]
    for name, dirv, lens, fill in shots:
        d = aim(dirv, lens, fill)
        scene.render.filepath = os.path.join(OUT_IMG, name + ".png")
        bpy.ops.render.render(write_still=True)
        print("@@SHOT@@", name, "dist=%.2f" % d)


main()

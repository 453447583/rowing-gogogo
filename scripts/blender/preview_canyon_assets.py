"""峡谷险道 · 六个资产预览 v3
- 程序化贴图（物体坐标噪声 + 凹凸）与层理
- 崖壁改成 26m 高的垂直岩壁（不是石堆）
- 远景山体宽顶不尖
- 每个模型单独显隐，互不入镜
用法：D:/blender/blender.exe -b --python scripts/blender/preview_canyon_assets.py
"""
import bpy, math, os, random
from mathutils import Vector

OUTDIR = r"D:\3Dgame - 副本\shots\verify"
BLEND = r"D:\3Dgame - 副本\public\models\canyon_assets_preview.blend"
os.makedirs(OUTDIR, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
coll = bpy.data.collections.new("canyon")
scene.collection.children.link(coll)

MEMBERS = {i: [] for i in range(1, 7)}
CUR = [1]


def noisy(name, c1, c2, scale=2.4, bump=0.7, rough=0.9, detail=9.0, pos=(0.34, 0.7)):
    m = bpy.data.materials.new(name)
    nt = m.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    coord = nt.nodes.new("ShaderNodeTexCoord")
    tex = nt.nodes.new("ShaderNodeTexNoise")
    tex.inputs["Scale"].default_value = scale
    tex.inputs["Detail"].default_value = detail
    tex.inputs["Roughness"].default_value = 0.62
    nt.links.new(coord.outputs["Object"], tex.inputs["Vector"])
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = pos[0]
    ramp.color_ramp.elements[0].color = (*c1, 1)
    ramp.color_ramp.elements[1].position = pos[1]
    ramp.color_ramp.elements[1].color = (*c2, 1)
    mid = ramp.color_ramp.elements.new(0.52)
    mid.color = (*(tuple((a + b) / 2 for a, b in zip(c1, c2))), 1)
    nt.links.new(tex.outputs["Fac"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = rough
    if bump > 0:
        bp = nt.nodes.new("ShaderNodeBump")
        bp.inputs["Strength"].default_value = bump
        bp.inputs["Distance"].default_value = 0.4
        nt.links.new(tex.outputs["Fac"], bp.inputs["Height"])
        nt.links.new(bp.outputs["Normal"], bsdf.inputs["Normal"])
    m.diffuse_color = (*c1, 1)
    return m


def strata(name, c1, c2, bands=0.42, bump=0.35):
    """水平层理：Wave 按 Z 切层，叠噪声抖动"""
    m = bpy.data.materials.new(name)
    nt = m.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    coord = nt.nodes.new("ShaderNodeTexCoord")
    mp = nt.nodes.new("ShaderNodeMapping")
    mp.inputs["Scale"].default_value = (1.0, 1.0, 1.0)
    nt.links.new(coord.outputs["Object"], mp.inputs["Vector"])
    try:
        wave = nt.nodes.new("ShaderNodeTexWave")
        wave.wave_type = 'BANDS'
        try:
            wave.bands_direction = 'Z'
        except Exception:
            pass
        wave.inputs["Scale"].default_value = bands
        wave.inputs["Distortion"].default_value = 2.5
        wave.inputs["Detail"].default_value = 2.0
        nt.links.new(mp.outputs["Vector"], wave.inputs["Vector"])
        src = wave.outputs["Fac"]
    except Exception:
        noise = nt.nodes.new("ShaderNodeTexNoise")
        noise.inputs["Scale"].default_value = 1.4
        nt.links.new(coord.outputs["Object"], noise.inputs["Vector"])
        src = noise.outputs["Fac"]
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.30
    ramp.color_ramp.elements[0].color = (*c1, 1)
    ramp.color_ramp.elements[1].position = 0.66
    ramp.color_ramp.elements[1].color = (*c2, 1)
    nt.links.new(src, ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.93
    bp = nt.nodes.new("ShaderNodeBump")
    bp.inputs["Strength"].default_value = bump
    bp.inputs["Distance"].default_value = 1.6
    nt.links.new(src, bp.inputs["Height"])
    nt.links.new(bp.outputs["Normal"], bsdf.inputs["Normal"])
    m.diffuse_color = (*c1, 1)
    return m


ROCK_D = noisy("rock_dark", (0.012, 0.014, 0.015), (0.098, 0.104, 0.100), 2.6, 0.75, 0.95, 9.0)
ROCK_M = noisy("rock_mid", (0.030, 0.034, 0.034), (0.165, 0.172, 0.162), 2.1, 0.7, 0.92, 9.0)
ROCK_L = noisy("rock_light", (0.070, 0.074, 0.070), (0.255, 0.258, 0.242), 3.0, 0.6, 0.9, 8.0)
STRATA = strata("rock_strata", (0.028, 0.032, 0.034), (0.185, 0.185, 0.172), 0.42, 0.45)
MOSS = noisy("moss", (0.028, 0.095, 0.035), (0.215, 0.370, 0.130), 3.4, 0.75, 0.85, 8.0)
WOOD = noisy("wood", (0.150, 0.080, 0.035), (0.430, 0.275, 0.135), 11.0, 0.5, 0.7, 10.0)
SAND = noisy("sand", (0.290, 0.250, 0.150), (0.560, 0.505, 0.340), 2.6, 0.45, 0.9, 8.0)
ORANGE = noisy("buoy", (0.500, 0.150, 0.025), (0.880, 0.400, 0.090), 3.5, 0.2, 0.6, 9.0)
CREAM = noisy("cream", (0.660, 0.620, 0.520), (0.930, 0.895, 0.810), 3.5, 0.15, 0.6, 8.0)
METAL = noisy("metal", (0.120, 0.140, 0.160), (0.360, 0.390, 0.410), 3.0, 0.15, 0.38, 7.0)
DARK = noisy("tunnel_in", (0.006, 0.008, 0.010), (0.030, 0.036, 0.042), 1.2, 0.15, 0.95, 6.0)
LEAF = noisy("leaf", (0.035, 0.130, 0.050), (0.205, 0.385, 0.135), 2.6, 0.5, 0.9, 8.0)
GRASS = noisy("grass", (0.070, 0.160, 0.055), (0.265, 0.405, 0.160), 2.2, 0.45, 0.92, 8.0)
LAMP = noisy("lamp", (0.850, 0.560, 0.150), (1.000, 0.870, 0.520), 5.0, 0.05, 0.3, 6.0)
WATER = noisy("water", (0.015, 0.062, 0.085), (0.070, 0.215, 0.255), 4.5, 0.22, 0.18, 6.0)


def link(obj):
    for c in obj.users_collection:
        c.objects.unlink(obj)
    coll.objects.link(obj)
    MEMBERS[CUR[0]].append(obj)
    return obj


def box(loc, size, m, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    o = bpy.context.object
    o.scale = size
    o.data.materials.append(m)
    return link(o)


def cone(loc, r1, r2, h, m, verts=11, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=r1, radius2=r2, depth=h, location=loc, rotation=rot)
    o = bpy.context.object
    o.data.materials.append(m)
    return link(o)


def cyl(loc, r, h, m, verts=14, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=h, location=loc, rotation=rot)
    o = bpy.context.object
    o.data.materials.append(m)
    return link(o)


def boulder(loc, size, m, seed=1, amp=0.18, smooth=True):
    """岩块：高细分球 + 顶点扰动 + Displace(Clouds) 位移 + 平滑着色 → 接近真实岩面"""
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=3, radius=1.0, location=loc)
    o = bpy.context.object
    rnd = random.Random(seed)
    me = o.data
    for v in me.vertices:
        v.co = v.co.normalized() * (1.0 + rnd.uniform(-amp, amp) * 0.45)
    tex = bpy.data.textures.new("rocktex%d" % seed, type='CLOUDS')
    tex.noise_scale = 0.32
    tex.noise_depth = 3
    md = o.modifiers.new("disp", 'DISPLACE')
    md.texture = tex
    md.strength = amp * 2.4
    md.mid_level = 0.5
    o.scale = size
    me.materials.append(m)
    for q in me.polygons:
        q.use_smooth = True
    return link(o)


CENTERS = {}
TARGETS = {}


def marker(key, x, cam, target_z):
    CENTERS[key] = Vector((x, 0, target_z))
    TARGETS[key] = cam


# ---------------- 1 峡谷崖壁：26m 高垂直岩壁 ----------------
CUR[0] = 1
CX = -80
marker(1, CX, (0, -92, 46), 13.0)
tier_h = 4.4
for t in range(5):
    z = 4.0 + t * tier_h
    lean = t * 0.7
    for i in range(7):
        rnd = random.Random(t * 31 + i * 7)
        x = CX - 18 + i * 6.0 + rnd.uniform(-1.1, 1.1)
        sc = rnd.uniform(0.82, 1.22)
        boulder((x, -1.0 - lean + rnd.uniform(-0.6, 0.6), z + rnd.uniform(-0.7, 0.7)),
                (4.0 * sc, 3.0 * sc, 3.1 * sc),
                ROCK_D if (i + t) % 3 == 0 else (ROCK_M if (t + i) % 2 else ROCK_L),
                seed=10 + t * 10 + i, amp=0.26)
    # 竖向岩柱（打破堆叠感）
    if t < 3:
        for i in (0, 3, 6):
            x = CX - 18 + i * 6.0
            boulder((x, -1.6 - lean, z + 1.4), (2.4, 2.6, 3.6), ROCK_L, seed=300 + t * 10 + i, amp=0.16)
for i in range(6):
    x = CX - 15 + i * 6.0
    boulder((x, -2.0, 24.4), (3.4, 3.4, 0.8), MOSS, seed=90 + i, amp=0.12)
for i in range(8):
    boulder((CX - 21 + i * 6.0, -3.4, 1.4), (3.4, 3.0, 2.2), ROCK_M, seed=150 + i, amp=0.24)

# ---------------- 2 隧道壳体 ----------------
CUR[0] = 2
TX = -40
marker(2, TX, (64, -78, 42), 7.0)
R_IN, R_OUT, LEN, SEG = 7.4, 9.0, 30.0, 18
verts, faces, fmat = [], [], []
for s, r in enumerate((R_OUT, R_IN)):
    for j in range(SEG + 1):
        a = math.pi * j / SEG
        y, z = math.cos(a) * r, math.sin(a) * r
        for e, x in enumerate((-LEN / 2, LEN / 2)):
            verts.append((TX + x, y, z))
V = lambda s, j, e: s * (SEG + 1) * 2 + j * 2 + e
for j in range(SEG):
    faces.append((V(0, j, 0), V(0, j + 1, 0), V(0, j + 1, 1), V(0, j, 1))); fmat.append(0)
    faces.append((V(1, j, 0), V(1, j, 1), V(1, j + 1, 1), V(1, j + 1, 0))); fmat.append(1)
    faces.append((V(0, j, 0), V(1, j, 0), V(1, j + 1, 0), V(0, j + 1, 0))); fmat.append(1)
    faces.append((V(0, j, 1), V(0, j + 1, 1), V(1, j + 1, 1), V(1, j, 1))); fmat.append(1)
me = bpy.data.meshes.new("tunnel")
me.from_pydata(verts, [], faces)
me.update()
shell = bpy.data.objects.new("tunnel_shell", me)
coll.objects.link(shell)
MEMBERS[2].append(shell)
shell.data.materials.append(ROCK_M)
shell.data.materials.append(DARK)
for i, p in enumerate(me.polygons):
    p.material_index = fmat[i]
for s in (-1, 1):
    bpy.ops.mesh.primitive_torus_add(location=(TX + s * LEN / 2, 0, 0), rotation=(0, math.radians(90), 0),
                                     major_radius=(R_IN + R_OUT) / 2, minor_radius=0.74,
                                     major_segments=30, minor_segments=9)
    o = bpy.context.object
    o.data.materials.append(METAL)
    link(o)
for i in range(9):
    x = TX - LEN / 2 + 1.6 + i * 3.5
    boulder((x, 0.8, 12.2), (3.6, 5.4, 3.4), ROCK_D if i % 2 else ROCK_M, seed=200 + i, amp=0.22)
for i in range(6):
    x = TX - 13 + i * 5.6
    boulder((x, 3.2, 15.0), (3.0, 3.2, 1.2), MOSS, seed=230 + i, amp=0.14)
for x in (-10, 0, 10):
    box((TX + x, 0, 6.1), (1.2, 1.2, 0.3), LAMP)

# ---------------- 3 波浪坡道 ----------------
CUR[0] = 3
RX = 0
marker(3, RX, (0, -74, 34), 3.0)
hs = [0.4, 2.8, 0.4, 2.8, 0.4]
SL = 7.2
for k in range(4):
    h0, h1 = hs[k], hs[k + 1]
    ang = math.atan2(h1 - h0, SL)
    cx = RX - 2 * SL + (k + 0.5) * SL
    box((cx, 0, (h0 + h1) / 2), (SL * 1.1, 8.6, 0.4), WOOD, rot=(0, -ang, 0))
    for s in (-1, 1):
        box((cx, s * 4.35, (h0 + h1) / 2 + 0.6), (SL * 1.1, 0.34, 1.2), WOOD, rot=(0, -ang, 0))
    for s in (-1, 1):
        cyl((cx, s * 3.6, max(0.5, (h0 + h1) / 2 - 0.9)), 0.26, 1.7, METAL, verts=8)
for k in range(5):
    boulder((RX - 2 * SL + k * SL, 0, -0.3), (2.4, 4.8, 1.2), ROCK_D, seed=300 + k, amp=0.16)

# ---------------- 4 近道拱门 ----------------
CUR[0] = 4
AX = 40
marker(4, AX, (13, -56, 22), 4.5)
for s in (-1, 1):
    cyl((AX, s * 7.0, 3.7), 0.70, 7.4, WOOD, verts=12)
    for k in range(3):
        cyl((AX, s * 7.0, 1.35 + k * 2.15), 0.79, 0.64, CREAM if k % 2 == 0 else ORANGE, verts=12)
    bpy.ops.mesh.primitive_uv_sphere_add(segments=18, ring_count=10, radius=1.05, location=(AX, s * 7.0, 0.1))
    o = bpy.context.object
    o.data.materials.append(ORANGE)
    link(o)
box((AX, 0, 7.8), (1.1, 15.2, 1.1), WOOD)
box((AX, 0, 6.5), (0.30, 8.6, 2.0), ORANGE)
for s in (-1, 1):
    box((AX, s * 5.4, 8.2), (0.45, 2.6, 1.5), CREAM, rot=(0, 0, math.radians(s * 14)))

# ---------------- 5 环形岛 ----------------
CUR[0] = 5
IX = 80
marker(5, IX, (0, -80, 40), 4.0)
cyl((IX, 0, 1.0), 15.0, 2.0, GRASS, verts=30)
cyl((IX, 0, -0.2), 16.4, 1.4, SAND, verts=30)
box((IX - 16.6, 0, 0.45), (5.2, 2.0, 0.45), WOOD)
for i in range(8):
    a = i / 8 * math.pi * 2 + 0.3
    r = 6.8 + (i % 3) * 2.6
    x, y = IX + math.cos(a) * r, math.sin(a) * r
    cyl((x, y, 2.8), 0.38, 2.6, WOOD, verts=7)
    cone((x, y, 5.8), 2.2, 0.10, 4.8, LEAF, verts=8)
for i in range(6):
    a = i / 6 * math.pi * 2 + 0.9
    boulder((IX + math.cos(a) * 12.4, math.sin(a) * 12.4, 1.6), (2.0, 2.0, 1.4), ROCK_M, seed=400 + i, amp=0.22)

# ---------------- 6 远景山体（宽顶） ----------------
CUR[0] = 6
MX = 120
marker(6, MX, (0, -132, 54), 10.0)
boulder((MX, 0, -0.8), (48, 26, 3.2), ROCK_D, seed=600, amp=0.08)
PEAKS = [(-26, 11.5, 17), (-13, 14.0, 25), (2, 17.0, 32), (17, 13.0, 23), (30, 10.0, 15)]
for i, (dx, r, h) in enumerate(PEAKS):
    m = STRATA if i % 2 == 0 else ROCK_M
    cone((MX + dx, 0, h / 2 - 2.0), r, r * 0.34, h, m, verts=13)
    cone((MX + dx, 0, h - 1.8), r * 0.34, r * 0.24, 2.8, ROCK_L, verts=13)
# 山脊梁：把五座连成一条山脉
for i in range(len(PEAKS) - 1):
    x0, _, h0 = PEAKS[i]
    x1, _, h1 = PEAKS[i + 1]
    hm = min(h0, h1) * 0.55
    boulder((MX + (x0 + x1) / 2, 0, hm), (abs(x1 - x0) * 0.75, 9.0, hm * 0.85), ROCK_M, seed=610 + i, amp=0.14)
for i in range(10):
    boulder((MX - 32 + i * 7.2, 11.0, 1.0), (4.4, 3.2, 2.0), ROCK_D, seed=500 + i, amp=0.26)

# ---------------- 水面 / 灯光 / 世界 ----------------
bpy.ops.mesh.primitive_plane_add(size=700, location=(-20, 0, -1.9))
water = bpy.context.object
water.data.materials.append(WATER)
for c in water.users_collection:
    c.objects.unlink(water)
coll.objects.link(water)

bpy.ops.object.light_add(type='SUN', location=(-40, -70, 95))
sun = bpy.context.object
sun.data.energy = 2.5
sun.data.angle = math.radians(4)
sun.rotation_euler = (math.radians(48), 0, math.radians(-32))
for c in sun.users_collection:
    c.objects.unlink(sun)
coll.objects.link(sun)

bpy.ops.object.light_add(type='AREA', location=(20, -95, 55))
fill = bpy.context.object
fill.data.energy = 2000
fill.data.size = 150
for c in fill.users_collection:
    c.objects.unlink(fill)
coll.objects.link(fill)

bpy.ops.object.camera_add(location=(0, -90, 40))
cam = bpy.context.object
cam.data.lens = 55
scene.camera = cam
for c in cam.users_collection:
    c.objects.unlink(cam)
coll.objects.link(cam)

world = bpy.data.worlds.new("W")
world.node_tree.nodes["Background"].inputs[0].default_value = (0.028, 0.048, 0.062, 1)
scene.world = world

scene.render.engine = 'CYCLES'
scene.cycles.samples = 40
scene.cycles.use_denoising = True
scene.cycles.device = 'CPU'
scene.render.resolution_x = 1000
scene.render.resolution_y = 620
scene.view_settings.view_transform = 'Standard'
scene.view_settings.look = 'None'

for key in sorted(CENTERS):
    for k, objs in MEMBERS.items():
        for o in objs:
            o.hide_render = (k != key)
    c = CENTERS[key]
    off = TARGETS[key]
    cam.location = c + Vector(off)
    cam.rotation_euler = (c - cam.location).to_track_quat('-Z', 'Y').to_euler()
    scene.render.filepath = os.path.join(OUTDIR, f"canyon-asset-{key}.png")
    bpy.ops.render.render(write_still=True)
    print("SHOT", key)

bpy.ops.wm.save_as_mainfile(filepath=BLEND)
print("ALL_DONE")

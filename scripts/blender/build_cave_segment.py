"""峡谷山洞段：Blender 程序化生成 → GLB + 中心线 JSON + 预览渲染

用法：
    D:/blender/blender.exe -b --python scripts/blender/build_cave_segment.py

产物（全部在项目内，不碰 C 盘）：
    public/models/cave/cave_shell.glb       视觉主体（洞壁+钟乳石+暗河水条）
    public/models/cave/cave_collision.glb   碰撞代理（低模管道，看不见）
    public/data/cave_centerline.json        中心线采样（Three.js 逻辑数据源）
    shots/verify/cave-segment.png           Cycles 预览渲染

设计约定（与游戏对齐）：
  - Blender 是 Z 轴朝上；glTF 导出自动转成 Y-up（游戏坐标）。
    game.x = blender.x, game.y = blender.z(高度), game.z = -blender.y
  - 中心线沿 Blender +X 铺设，水面在 z=0，洞顶最高约 +10m
  - 水面单独一个命名对象 `cave_water`，Three.js 拿去做流动动画
  - 顶点色 COLOR_0 携带岩石/苔藓配色（程序化材质 glTF 导不出来，这是本项目定过的规矩）

Three.js 侧约定（后续 `style: 'baked'` 用）：
  - centerline.json 每 3m 一个采样点：{x, y, z, yaw, width, kind}
  - 洞壁碰撞用 cave_collision.glb + 中心线径向约束（现有 #constrainTunnel 机制）
"""
import bpy
import bmesh
import json
import math
import os
import random

from mathutils import Vector, noise

ROOT = r"D:\3Dgame - 副本"
OUT_MODEL = os.path.join(ROOT, "public", "models", "cave")
OUT_DATA = os.path.join(ROOT, "public", "data")
OUT_SHOT = os.path.join(ROOT, "shots", "verify")
for d in (OUT_MODEL, OUT_DATA, OUT_SHOT):
    os.makedirs(d, exist_ok=True)

# ---------------- 可调参数 ----------------
STEP = 3.0            # 中心线采样步长（米）
RING_SEGS = 22        # 洞壁横截面分段数（视觉）
COLL_SEGS = 12        # 碰撞代理分段数
RX = 10.0             # 洞的横向半宽
RY = 7.5              # 洞的竖向半径
CAVE_CY = 2.5         # 洞截面中心离水面的高度（水在 0，洞底到 -5，洞顶 +10）
WATER_HALF = 7.5      # 河面半宽（航道全宽 15m）
NOISE_AMP = 0.09      # 岩壁凹凸比例

# 走向控制点（Blender 坐标：x 前进，y 横向，z 高度）——两个 S 弯
PATH_CTRL = [
    (0, 0), (40, -2), (78, 14), (104, 40), (128, 58),
    (158, 58), (182, 40), (206, 14), (238, -2), (280, 0),
]

random.seed(20261031)


# ---------------- 路径 ----------------
def catmull(p0, p1, p2, p3, t):
    """Catmull-Rom 插值，控制点连线平滑过弯"""
    t2 = t * t
    t3 = t2 * t
    return (
        0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2
               + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
    )


def build_path():
    """控制点 → 每 STEP 一个采样点 [(x, y)]，以及每点的方向"""
    pts = []
    n = len(PATH_CTRL)
    for i in range(n - 1):
        p0 = PATH_CTRL[max(0, i - 1)]
        p1 = PATH_CTRL[i]
        p2 = PATH_CTRL[i + 1]
        p3 = PATH_CTRL[min(n - 1, i + 2)]
        seg = math.dist(p1, p2)
        steps = max(2, int(seg / STEP))
        for s in range(steps):
            t = s / steps
            pts.append((catmull(p0[0], p1[0], p2[0], p3[0], t),
                        catmull(p0[1], p1[1], p2[1], p3[1], t)))
    pts.append(PATH_CTRL[-1])
    # 方向（相邻采样点差分）
    dirs = []
    for i, (x, y) in enumerate(pts):
        a = pts[max(0, i - 1)]
        b = pts[min(len(pts) - 1, i + 1)]
        dx, dy = b[0] - a[0], b[1] - a[1]
        L = math.hypot(dx, dy) or 1.0
        dirs.append((dx / L, dy / L))
    return pts, dirs


PATH, DIRS = build_path()
N = len(PATH)
print(f"[cave] 中心线 {N} 个采样点，总长约 {N * STEP:.0f} m")


def ring_frame(i):
    """第 i 个采样点：中心点、水平法线（截面横向）、前进方向"""
    x, y = PATH[i]
    dx, dy = DIRS[i]
    return (x, y, 0.0), (-dy, dx), (dx, dy)


def ring_point(center, n, a, rx, rz):
    """截面圆上的一点：a=0 是洞顶，a=π 是洞底"""
    return (center[0] + n[0] * math.sin(a) * rx,
            center[1] + n[1] * math.sin(a) * rx,
            CAVE_CY + math.cos(a) * rz)


def rock_color(x, y, z):
    """岩石顶点色：水线附近长苔藓，水下压暗，整体灰棕"""
    n = noise.noise(Vector((x * 0.2, y * 0.2, z * 0.2)))
    base = 0.15 + 0.11 * (0.5 + 0.5 * n)
    r, g, b = base * 1.06, base * 0.96, base * 0.86
    if 0.2 < z < 1.9:  # 水线苔藓带
        moss = max(0.0, 1.0 - abs(z - 0.9) / 1.0)
        g += (0.30 - g) * moss * 0.85
        r *= 1 - moss * 0.55
        b *= 1 - moss * 0.60
    if z < 0.0:  # 水下部分压暗偏青
        r *= 0.50
        g *= 0.60
        b *= 0.64
    return (r, g, b, 1.0)


def make_material(name, base=(1, 1, 1), rough=0.92):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    bsdf.inputs['Base Color'].default_value = (*base, 1.0)
    bsdf.inputs['Roughness'].default_value = rough
    return mat


def new_mesh_object(name, verts, faces, colors, mat, coll):
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.validate()
    # 法线朝外/朝上统一（手搓 winding 容易翻）
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    me.update()
    attr = me.color_attributes.new(name='Col', type='BYTE_COLOR', domain='POINT')
    for i, c in enumerate(colors):
        attr.data[i].color = c
    try:
        me.color_attributes.active_color = attr
    except Exception:
        pass
    me.materials.append(mat)
    obj = bpy.data.objects.new(name, me)
    coll.objects.link(obj)
    return obj


def build_cave_shell(coll):
    """洞壁（含钟乳石，合成一个 mesh → 游戏里 1 次绘制）+ 暗河水条"""
    verts, faces, colors = [], [], []
    rings = []
    rng = random.Random(7)

    for i in range(N):
        center, n, _ = ring_frame(i)
        ring_jitter = 1.0 + rng.uniform(-0.05, 0.05)
        idx = []
        for k in range(RING_SEGS):
            a = math.pi * 2 * k / RING_SEGS
            x, y, z = ring_point(center, n, a, RX * ring_jitter, RY * ring_jitter)
            # 岩壁凹凸：按世界坐标采样噪声，沿洞连续不断裂
            disp = 1.0 + noise.noise(Vector((x * 0.12, y * 0.12, z * 0.12))) * NOISE_AMP
            x += n[0] * math.sin(a) * (RX * disp - RX * ring_jitter)
            y += n[1] * math.sin(a) * (RX * disp - RX * ring_jitter)
            z += math.cos(a) * (RY * disp - RY * ring_jitter)
            idx.append(len(verts))
            verts.append((x, y, z))
            colors.append(rock_color(x, y, z))
        rings.append(idx)

    for i in range(N - 1):
        for k in range(RING_SEGS):
            k2 = (k + 1) % RING_SEGS
            faces.append((rings[i][k], rings[i][k2], rings[i + 1][k2], rings[i + 1][k]))

    # 钟乳石：沿洞顶每 ~9m 一根，挂在洞顶往下垂
    for i in range(2, N - 2, 3):
        if rng.random() > 0.62:
            continue
        center, n, _ = ring_frame(i)
        top = ring_point(center, n, 0.0, RX * 0.92, RY * 0.95)
        L = rng.uniform(2.0, 5.2)
        r = rng.uniform(0.45, 1.25)
        seg = 9
        base_idx = len(verts)
        for k in range(seg):
            a = math.pi * 2 * k / seg
            vx = top[0] + math.cos(a) * r + rng.uniform(-0.15, 0.15)
            vy = top[1] + math.sin(a) * r + rng.uniform(-0.15, 0.15)
            vz = top[2] - rng.uniform(0, 0.35)
            base_idx_k = len(verts)
            verts.append((vx, vy, vz))
            colors.append(rock_color(vx, vy, vz))
            assert base_idx_k == base_idx + k
        tip = len(verts)
        verts.append((top[0] + rng.uniform(-0.3, 0.3), top[1] + rng.uniform(-0.3, 0.3), top[2] - L))
        colors.append(rock_color(verts[tip][0], verts[tip][1], verts[tip][2]))
        for k in range(seg):
            faces.append((base_idx + k, base_idx + (k + 1) % seg, tip))

    shell_mat = make_material('cave_rock')
    return new_mesh_object('cave_shell', verts, faces, colors, shell_mat, coll)


def build_water(coll):
    """暗河水条：贴着水面的一条带（Three.js 里替换成动态水材质/做流动）"""
    verts, faces, colors = [], [], []
    for i in range(N):
        center, n, _ = ring_frame(i)
        for side in (-1, 1):
            x = center[0] + n[0] * side * WATER_HALF
            y = center[1] + n[1] * side * WATER_HALF
            z = 0.0 + noise.noise(Vector((x * 0.3, y * 0.3, 0.0))) * 0.06
            verts.append((x, y, z))
            colors.append((0.05, 0.30, 0.38, 1.0))
    for i in range(N - 1):
        l0, r0 = i * 2, i * 2 + 1
        l1, r1 = (i + 1) * 2, (i + 1) * 2 + 1
        faces.append((l0, r0, r1, l1))
    water_mat = make_material('cave_water', base=(0.10, 0.42, 0.50), rough=0.25)
    return new_mesh_object('cave_water', verts, faces, colors, water_mat, coll)


def build_collision(coll):
    """碰撞代理：低模管道（游戏里配合中心线做径向约束）"""
    verts, faces, colors = [], []
    rings = []
    for i in range(0, N, 2):  # 碰撞用 6m 步长就够
        center, n, _ = ring_frame(i)
        idx = []
        for k in range(COLL_SEGS):
            a = math.pi * 2 * k / COLL_SEGS
            x, y, z = ring_point(center, n, a, RX * 0.97, RY * 0.97)
            idx.append(len(verts))
            verts.append((x, y, z))
            colors.append((1, 1, 1, 1))
        rings.append(idx)
    for i in range(len(rings) - 1):
        for k in range(COLL_SEGS):
            k2 = (k + 1) % COLL_SEGS
            faces.append((rings[i][k], rings[i][k2], rings[i + 1][k2], rings[i + 1][k]))
    col_mat = make_material('cave_collision')
    return new_mesh_object('cave_collision', verts, faces, colors, col_mat, coll)


def write_centerline():
    """中心线 → 游戏坐标 JSON（game.x=blender.x, game.y=blender.z, game.z=-blender.y）"""
    points = []
    for i in range(N):
        (x, y, _z), _n, (dx, dy) = ring_frame(i)
        yaw = math.atan2(dx, -dy)  # game 前进方向 = (dx, -dy)
        points.append({
            "x": round(x, 2),
            "y": 0.0,
            "z": round(-y, 2),
            "yaw": round(yaw, 3),
            "width": round(WATER_HALF * 2, 1),
            "kind": "cave",
        })
    data = {
        "name": "cave-segment",
        "version": 1,
        "sampleStep": STEP,
        "sections": [{"kind": "cave", "from": 0, "to": len(points) - 1}],
        "points": points,
    }
    path = os.path.join(OUT_DATA, "cave_centerline.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    print(f"[cave] 中心线 JSON → {path}（{len(points)} 点）")


def setup_scene():
    try:
        bpy.ops.wm.read_factory_settings(use_empty=True)
    except Exception:
        pass
    coll = bpy.data.collections.new('CAVE')
    bpy.context.scene.collection.children.link(coll)
    return coll


def add_lights_and_camera(coll):
    """洞内暖光 + 相机（放洞口内看向深处，预览用；游戏里光照由 three.js 做）"""
    for i in range(3, N - 3, max(3, N // 8)):
        center, n, _ = ring_frame(i)
        light_data = bpy.data.lights.new(name=f'caveLight{i}', type='POINT')
        light_data.energy = 1500
        light_data.color = (1.0, 0.82, 0.62)
        light_data.shadow_soft_size = 3.0
        obj = bpy.data.objects.new(f'caveLight{i}', light_data)
        obj.location = (center[0], center[1], CAVE_CY + RY * 0.55)
        coll.objects.link(obj)

    cam_data = bpy.data.cameras.new('caveCam')
    cam_data.lens = 24
    cam = bpy.data.objects.new('caveCam', cam_data)
    start, _n, d = ring_frame(4)
    look, _n2, _d2 = ring_frame(26)
    cam.location = (start[0] + d[0] * 2, start[1] + d[1] * 2, 4.2)
    direction = Vector((look[0] - cam.location.x, look[1] - cam.location.y, 2.0 - cam.location.z))
    cam.rotation_mode = 'QUATERNION'
    cam.rotation_quaternion = direction.to_track_quat('-Z', 'Y')
    coll.objects.link(cam)
    bpy.context.scene.camera = cam


def render_preview():
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = 24
    scene.render.resolution_x = 900
    scene.render.resolution_y = 460
    scene.render.filepath = os.path.join(OUT_SHOT, "cave-segment.png")
    bpy.ops.render.render(write_still=True)
    print(f"[cave] 预览渲染 → {scene.render.filepath}")


def export_glb(path):
    try:
        bpy.ops.export_scene.gltf(filepath=path, export_apply=True, export_vertex_color='ACTIVE')
    except TypeError:
        bpy.ops.export_scene.gltf(filepath=path, export_apply=True)
    print(f"[cave] GLB → {path}（{os.path.getsize(path) // 1024} KB）")


def main():
    coll = setup_scene()
    shell = build_cave_shell(coll)
    water = build_water(coll)
    add_lights_and_camera(coll)
    render_preview()

    # 视觉三件套一起导（cave_water 是命名对象，three.js 按 name 找它做动画）
    export_glb(os.path.join(OUT_MODEL, "cave_shell.glb"))

    # 删视觉对象 → 导碰撞代理（本项目定过的规矩：删完必须 view_layer.update()）
    for o in (shell, water):
        bpy.data.objects.remove(o, do_unlink=True)
    for light in [o for o in bpy.data.objects if o.type == 'LIGHT']:
        bpy.data.objects.remove(light, do_unlink=True)
    bpy.context.view_layer.update()
    build_collision(coll)
    export_glb(os.path.join(OUT_MODEL, "cave_collision.glb"))

    write_centerline()
    print("ALL_DONE")


main()

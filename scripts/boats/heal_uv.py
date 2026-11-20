# UV 自愈 v2：UV 落在图集灰色缝隙里的面，投影到空间上最近的好三角面，重心插值取 UV
# 用法: blender -b --factory-startup --python-exit-code 1 --python heal_uv.py -- <in.glb> <out.glb> <tag> [render]
import bpy, sys, json, math, os
import numpy as np
from mathutils import Vector, kdtree

args = sys.argv[sys.argv.index('--') + 1:]
GLB_IN, GLB_OUT, TAG = args[0], args[1], args[2]
DO_RENDER = len(args) > 3 and args[3] == 'render'
ALBEDO = len(args) > 3 and args[3] == 'albedo'
DO_RENDER = DO_RENDER or ALBEDO
PHASE_SUFFIX = '_alb' if ALBEDO else ''
SHOT_DIR = 'D:/3Dgame - 副本/shots/verify/boats/fix'

SAT_MAX = 0.055
VAL_MIN = 0.28
VAL_MAX = 0.82

VIEWS = [
    ('top34', (0.72, -0.94, 0.62), 1.04),
    ('front', (0.02, -1.0, 0.14), 1.04),
    ('low',   (0.62, -0.92, -0.40), 1.04),
]

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=GLB_IN)

IMPORTED = list(bpy.data.objects)
MESHES = [o for o in IMPORTED if o.type == 'MESH']
stat = {'tag': TAG, 'meshes': [], 'healedFaces': 0}


def setup_scene():
    sc = bpy.context.scene
    if ALBEDO:
        sc.render.engine = 'BLENDER_WORKBENCH'
        sh = sc.display.shading
        sh.light = 'FLAT'
        sh.color_type = 'TEXTURE'
        sh.show_shadows = False
        sh.show_cavity = False
        sh.background_type = 'VIEWPORT'
        sh.background_color = (0.32, 0.32, 0.33)
    else:
        sc.render.engine = 'BLENDER_EEVEE'
    sc.render.resolution_x = 900
    sc.render.resolution_y = 600
    sc.render.resolution_percentage = 100
    w = bpy.data.worlds.new('W')
    sc.world = w
    w.use_nodes = True
    bg = w.node_tree.nodes.get('Background')
    if bg:
        bg.inputs[0].default_value = (0.62, 0.62, 0.63, 1)
        bg.inputs[1].default_value = 1.0
    for i, (loc, energy, size) in enumerate([
        ((3.2, -3.4, 4.2), 800, 6.0),
        ((-3.6, -1.6, 2.2), 340, 6.0),
        ((0.4, 4.2, 3.0), 240, 8.0),
        ((0.0, -1.0, -3.0), 160, 7.0),
    ]):
        ld = bpy.data.lights.new(f'L{i}', 'AREA')
        ld.energy = energy
        ld.size = size
        lo = bpy.data.objects.new(f'L{i}', ld)
        sc.collection.objects.link(lo)
        lo.location = loc
        lo.rotation_euler = (Vector((0, 0, 0.6)) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
    return sc


def bounds(objs):
    mn = Vector((1e9, 1e9, 1e9)); mx = Vector((-1e9, -1e9, -1e9))
    for o in objs:
        for c in o.bound_box:
            p = o.matrix_world @ Vector(c)
            for i in range(3):
                mn[i] = min(mn[i], p[i]); mx[i] = max(mx[i], p[i])
    return mn, mx


def place_camera(sc, center, corners, eye_dir, fill):
    cam = sc.camera
    if cam is None:
        cd = bpy.data.cameras.new('ShotCam')
        cd.lens = 62
        cam = bpy.data.objects.new('ShotCam', cd)
        sc.collection.objects.link(cam)
        sc.camera = cam
    sensor = cam.data.sensor_width
    h_half = math.atan((sensor / 2) / cam.data.lens)
    v_half = math.atan((sensor * sc.render.resolution_y / sc.render.resolution_x / 2) / cam.data.lens)
    fwd = -Vector(eye_dir).normalized()          # 相机 → 目标
    right = fwd.cross(Vector((0, 0, 1)))
    if right.length < 1e-6:
        right = fwd.cross(Vector((0, 1, 0)))
    right.normalize()
    up = right.cross(fwd).normalized()
    # 逐角求"装得下"的最近距离，取两轴最大值
    d = 0.0
    for p in corners:
        rel = p - center
        a = abs(rel.dot(right)); b = abs(rel.dot(up)); c = rel.dot(fwd)
        d = max(d, a / math.tan(h_half) - c, b / math.tan(v_half) - c)
    d = max(d, 0.05) * fill
    cam.location = center - fwd * d
    cam.rotation_euler = (center - cam.location).to_track_quat('-Z', 'Y').to_euler()


def shoot_all(sc, objs, tag, phase):
    mn, mx = bounds(objs)
    center = (mn + mx) / 2
    corners = [Vector((x, y, z)) for x in (mn.x, mx.x) for y in (mn.y, mx.y) for z in (mn.z, mx.z)]
    for name, d, fill in VIEWS:
        place_camera(sc, center, corners, d, fill)
        p = os.path.join(SHOT_DIR, f'{tag}_{phase}{PHASE_SUFFIX}_{name}.jpg')
        sc.render.filepath = p
        sc.render.image_settings.file_format = 'JPEG'
        sc.render.image_settings.quality = 88
        bpy.ops.render.render(write_still=True)


sc = setup_scene() if DO_RENDER else None
if DO_RENDER:
    shoot_all(sc, MESHES, TAG, 'before')

for ob in MESHES:
    me = ob.data
    if not me.uv_layers.active:
        continue
    img = None
    for mat in me.materials:
        if not mat or not mat.use_nodes:
            continue
        for n in mat.node_tree.nodes:
            if n.type == 'TEX_IMAGE' and n.image:
                img = n.image
                break
        if img:
            break
    if img is None:
        continue

    W, H = img.size
    px = np.empty(W * H * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    px = px.reshape(H, W, 4)

    nl = len(me.loops)
    uvs = np.empty(nl * 2, dtype=np.float32)
    me.uv_layers.active.data.foreach_get('uv', uvs)
    uvs = uvs.reshape(nl, 2)
    lv = np.empty(nl, dtype=np.int32)
    me.loops.foreach_get('vertex_index', lv)
    nv = len(me.vertices)
    co = np.empty(nv * 3, dtype=np.float32)
    me.vertices.foreach_get('co', co)
    co = co.reshape(nv, 3)
    mw = np.array(ob.matrix_world)
    world = co @ mw[:3, :3].T + mw[:3, 3]

    ui = np.clip((uvs[:, 0] % 1.0) * (W - 1), 0, W - 1).astype(np.int32)
    vi = np.clip((uvs[:, 1] % 1.0) * (H - 1), 0, H - 1).astype(np.int32)
    col = px[vi, ui, :3]
    mx = col.max(axis=1); mn = col.min(axis=1)
    is_gutter = ((mx - mn) < SAT_MAX) & (mx > VAL_MIN) & (mx < VAL_MAX)

    ntri = len(me.polygons)
    lstart = np.empty(ntri, dtype=np.int32)
    ltot = np.empty(ntri, dtype=np.int32)
    me.polygons.foreach_get('loop_start', lstart)
    me.polygons.foreach_get('loop_total', ltot)
    csum = np.concatenate([[0], np.cumsum(is_gutter.astype(np.int32))])
    gcount = csum[lstart + ltot] - csum[lstart]
    bad_face = gcount > 0
    tri = ltot == 3

    # ---- 好三角面：世界坐标三顶点 / UV / 质心 / 法线 ----
    good_face = (~bad_face) & tri
    gfi = np.nonzero(good_face)[0]
    v0 = lv[lstart[gfi]]
    v1 = lv[lstart[gfi] + 1]
    v2 = lv[lstart[gfi] + 2]
    p0 = world[v0]; p1 = world[v1]; p2 = world[v2]
    uv0 = uvs[lstart[gfi]]; uv1 = uvs[lstart[gfi] + 1]; uv2 = uvs[lstart[gfi] + 2]
    cen = (p0 + p1 + p2) / 3.0
    nrm = np.cross(p1 - p0, p2 - p0)
    ln = np.linalg.norm(nrm, axis=1)
    ln[ln < 1e-9] = 1e-9
    nrm = nrm / ln[:, None]

    kd = kdtree.KDTree(len(gfi))
    for i in range(len(gfi)):
        kd.insert(Vector(cen[i]), i)
    kd.balance()

    bad_idx = np.nonzero(bad_face & tri)[0]
    uv_new = uvs.copy()
    n_ok = 0
    n_flat = 0
    for fi in bad_idx:
        s = lstart[fi]
        bv = lv[s:s + 3].astype(np.int64)
        bp = world[bv]
        bn = np.cross(bp[1] - bp[0], bp[2] - bp[0])
        bl = np.linalg.norm(bn)
        bn = bn / bl if bl > 1e-9 else np.array([0.0, 0.0, 1.0])
        bc = bp.mean(axis=0)

        cand = kd.find_n(Vector(bc), 14)
        best = -1
        bestd = 1e18
        fb = -1
        fbd = 1e18
        for _, gi, dist in cand:
            if dist < fbd:
                fbd = dist; fb = gi
            if float(np.dot(nrm[gi], bn)) > 0.30 and dist < bestd:
                bestd = dist; best = gi
        if best < 0:
            best = fb
        if best < 0:
            continue

        a, b, c = p0[best].astype(np.float64), p1[best].astype(np.float64), p2[best].astype(np.float64)
        e0 = b - a; e1 = c - a
        d00 = float(e0 @ e0); d01 = float(e0 @ e1); d11 = float(e1 @ e1)
        den = d00 * d11 - d01 * d01
        uva, uvb, uvc = uv0[best], uv1[best], uv2[best]
        # 大面积坏面投影到小三角会严重拉伸（腹部会变成抹开的条纹）。
        # 所以直接取源面 UV 质心当作整面的单一 UV：继承邻居颜色，绝无拉伸。
        if d00 * d11 <= 0.0 or den <= 1e-10 * d00 * d11:
            uv_new[s:s + 3] = uva
            n_flat += 1
            continue
        # 面面积与源面面积接近才用重心插值（保留细节）；否则整面取源面 UV 质心
        bad_area = 0.5 * bl
        src_area = 0.5 * math.sqrt(max(den, 1e-20))
        ratio = bad_area / src_area if src_area > 1e-20 else 1e9
        if 0.30 <= ratio <= 3.0:
            for k in range(3):
                v2_ = bp[k] - a
                d20 = float(v2_ @ e0); d21 = float(v2_ @ e1)
                wv = (d11 * d20 - d01 * d21) / den
                ww = (d00 * d21 - d01 * d20) / den
                wu = 1.0 - wv - ww
                wu = max(0.0, wu); wv = max(0.0, wv); ww = max(0.0, ww)
                sm = wu + wv + ww
                if sm < 1e-9:
                    wu, wv, ww = 1.0, 0.0, 0.0
                else:
                    wu /= sm; wv /= sm; ww /= sm
                uv_new[s + k] = uva * wu + uvb * wv + uvc * ww
            n_ok += 1
        else:
            uv_new[s:s + 3] = (uva + uvb + uvc) / 3.0
            n_flat += 1

    me.uv_layers.active.data.foreach_set('uv', uv_new.ravel())
    me.update()

    stat['meshes'].append({
        'tris': int(ntri),
        'texSize': [W, H],
        'gutterLoopPct': round(float(is_gutter.mean() * 100), 1),
        'badFaces': int(bad_face.sum()),
        'projected': n_ok,
        'flatFallback': n_flat,
    })
    stat['healedFaces'] += n_ok

try:
    bpy.ops.file.pack_all()
except Exception as e:
    stat['packWarn'] = str(e)[:100]

if DO_RENDER:
    shoot_all(sc, MESHES, TAG, 'after')

for o in bpy.data.objects:
    o.select_set(False)
for o in IMPORTED:
    if o.name in bpy.data.objects:
        o.select_set(True)

bpy.ops.export_scene.gltf(
    filepath=GLB_OUT, export_format='GLB', use_selection=True,
    export_yup=True, export_apply=True, export_animations=False,
    export_image_format='AUTO', export_materials='EXPORT',
)
stat['out'] = os.path.basename(GLB_OUT)
stat['outMB'] = round(os.path.getsize(GLB_OUT) / 1048576, 2)
print('@@JSON@@' + json.dumps(stat))

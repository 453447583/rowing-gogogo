# UV 自愈 v3（调和延拓）：
#   1) 精确识别图集灰底（中性灰、明度 0.40~0.62）
#   2) 以"好面"的贴图颜色为边界条件，在坏面构成的邻接图上做 Jacobi 调和延拓
#   3) 把延拓出的颜色映射回图集里颜色最接近的真实纹素 UV —— 无拉伸、无花斑
# 用法: blender -b --factory-startup --python-exit-code 1 --python heal_uv2.py -- <in.glb> <out.glb> <tag> [render|albedo]
import bpy, sys, json, math, os
import numpy as np
from mathutils import Vector, kdtree

args = sys.argv[sys.argv.index('--') + 1:]
GLB_IN, GLB_OUT, TAG = args[0], args[1], args[2]
MODE = args[3] if len(args) > 3 else ''
DO_EEVEE = MODE == 'render'
DO_ALB = MODE == 'albedo'
DO_RENDER = DO_EEVEE or DO_ALB
SHOT_DIR = 'D:/3Dgame - 副本/shots/verify/boats/fix'

GUT_TOL = 0.045
SMOOTH_ITERS = 14
LUT_N = 32

VIEWS = [
    ('top34', (0.72, -0.94, 0.62), 1.04),
    ('front', (0.02, -1.0, 0.14), 1.04),
    ('low',   (0.62, -0.92, -0.40), 1.04),
]

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=GLB_IN)
IMPORTED = list(bpy.data.objects)
MESHES = [o for o in IMPORTED if o.type == 'MESH']
stat = {'tag': TAG, 'meshes': []}


def setup_scene():
    sc = bpy.context.scene
    sc.render.resolution_x = 900
    sc.render.resolution_y = 600
    sc.render.resolution_percentage = 100
    if DO_ALB:
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
    fwd = -Vector(eye_dir).normalized()
    right = fwd.cross(Vector((0, 0, 1)))
    if right.length < 1e-6:
        right = fwd.cross(Vector((0, 1, 0)))
    right.normalize()
    up = right.cross(fwd).normalized()
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
    suf = '_alb' if DO_ALB else ''
    for name, d, fill in VIEWS:
        place_camera(sc, center, corners, d, fill)
        sc.render.filepath = os.path.join(SHOT_DIR, f'{tag}_{phase}{suf}_{name}.jpg')
        sc.render.image_settings.file_format = 'JPEG'
        sc.render.image_settings.quality = 88
        bpy.ops.render.render(write_still=True)


sc = setup_scene() if DO_RENDER else None
if DO_RENDER:
    shoot_all(sc, MESHES, TAG, 'v3before')

for ob in MESHES:
    me = ob.data
    if not me.uv_layers.active:
        continue
    img = None
    for mat in me.materials:
        if mat and mat.use_nodes:
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
    rgb = px[:, :, :3]

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
    lcol = px[vi, ui, :3]

    # ---- 精确识别图集背景灰：取全图出现最多的"中性灰"色 ----
    samp = rgb[::4, ::4, :].reshape(-1, 3)
    q = np.clip((samp * 63.0).astype(np.int32), 0, 63)
    bin_id = q[:, 0] * 4096 + q[:, 1] * 64 + q[:, 2]
    counts = np.bincount(bin_id, minlength=64 ** 3)
    order = np.argsort(counts)[::-1]
    ref = None
    for b in order[:400]:
        if counts[b] < 500:
            break
        c = np.array([(b // 4096) % 64, (b // 64) % 64, b % 64], dtype=np.float32) / 63.0
        sat = float(c.max() - c.min())
        val = float(c.max())
        if sat < 0.05 and 0.30 < val < 0.75:
            sel = bin_id == b
            ref = samp[sel].mean(axis=0)
            break
    if ref is None:
        ref = np.array([0.5, 0.5, 0.5], dtype=np.float32)
    dev = np.abs(lcol - ref).max(axis=1)

    # 连通性判据：背景灰是整张图里最大的一块连通区域；
    # 真实漆面（浅灰蓝甲板等）只是被别的颜色围住的小岛，颜色再接近也不会被误判。
    DS = 16
    ds = rgb[::DS, ::DS, :]
    NY = ds.shape[0]; NX = ds.shape[1]
    cmask = (np.abs(ds - ref).max(axis=2) < 0.065).ravel()
    lab = np.zeros(cmask.size, dtype=np.int32)
    sizes = [0]
    cur = 0
    for start in range(cmask.size):
        if not cmask[start] or lab[start]:
            continue
        cur += 1
        stack = [start]
        lab[start] = cur
        cnt = 0
        while stack:
            p = stack.pop()
            cnt += 1
            y, x = divmod(p, NX)
            if y > 0:
                q = p - NX
                if cmask[q] and not lab[q]:
                    lab[q] = cur; stack.append(q)
            if y + 1 < NY:
                q = p + NX
                if cmask[q] and not lab[q]:
                    lab[q] = cur; stack.append(q)
            if x > 0:
                q = p - 1
                if cmask[q] and not lab[q]:
                    lab[q] = cur; stack.append(q)
            if x + 1 < NX:
                q = p + 1
                if cmask[q] and not lab[q]:
                    lab[q] = cur; stack.append(q)
        sizes.append(cnt)
    big = [i for i in range(1, len(sizes)) if sizes[i] >= 200]
    bg = np.isin(lab, big).reshape(NY, NX)

    fu = np.clip(ui // DS, 0, NX - 1)
    fv = np.clip(vi // DS, 0, NY - 1)
    loop_gutter = bg[fv, fu]
    stat.setdefault('bgComponents', len(big))
    stat.setdefault('bgCoveragePct', round(100.0 * float(bg.mean()), 1))
    stat.setdefault('gutterRef', [round(float(v), 3) for v in ref])

    ntri = len(me.polygons)
    lstart = np.empty(ntri, dtype=np.int32)
    ltot = np.empty(ntri, dtype=np.int32)
    me.polygons.foreach_get('loop_start', lstart)
    me.polygons.foreach_get('loop_total', ltot)
    csum = np.concatenate([[0], np.cumsum(loop_gutter.astype(np.int32))])
    gcount = csum[lstart + ltot] - csum[lstart]
    bad = (gcount > 0) & (ltot == 3)
    good = (~bad) & (ltot == 3)

    # 面颜色（好面用它做边界条件）
    fcol = np.zeros((ntri, 3), dtype=np.float32)
    for c in range(3):
        fcol[:, c] = (lcol[lstart, c] + lcol[lstart + 1, c] + lcol[lstart + 2, c]) / 3.0

    # ---- 面邻接（只保留坏面之间）----
    fv = lv[lstart][:, None] + 0  # 第一顶点
    va = lv[lstart]; vb = lv[lstart + 1]; vc = lv[lstart + 2]
    NV = nv + 1
    keys = []
    owner = []
    for a, b in ((va, vb), (vb, vc), (vc, va)):
        lo = np.minimum(a, b).astype(np.int64); hi = np.maximum(a, b).astype(np.int64)
        keys.append(lo * NV + hi)
        owner.append(np.arange(ntri, dtype=np.int32))
    key = np.concatenate(keys)
    own = np.concatenate(owner)
    order = np.argsort(key, kind='stable')
    key = key[order]; own = own[order]
    same = key[1:] == key[:-1]
    f1 = own[:-1][same]; f2 = own[1:][same]
    nb = np.concatenate([np.stack([f1, f2], 1), np.stack([f2, f1], 1)])

    # 只保留"至少一端是坏面"的邻居关系
    bad_mask = bad
    keep = bad_mask[nb[:, 0]]
    nb = nb[keep]
    nb_src = nb[:, 1]

    # ---- 初始化：最近好面颜色（K 近邻中位数，抗离群）----
    gfi = np.nonzero(good)[0]
    gc = (world[va[gfi]] + world[vb[gfi]] + world[vc[gfi]]) / 3.0
    kd = kdtree.KDTree(len(gfi))
    for i in range(len(gfi)):
        kd.insert(Vector(gc[i]), i)
    kd.balance()

    bad_idx = np.nonzero(bad)[0]
    target = np.zeros((ntri, 3), dtype=np.float32)
    bad_centroid = (world[va[bad_idx]] + world[vb[bad_idx]] + world[vc[bad_idx]]) / 3.0
    for j, fi in enumerate(bad_idx):
        cand = kd.find_n(Vector(bad_centroid[j]), 7)
        cols = np.array([fcol[gfi[i]] for _, i, _ in cand], dtype=np.float32)
        target[fi] = np.median(cols, axis=0)

    # ---- Jacobi 调和延拓：好面固定，坏面向邻居平均 ----
    # 坏面邻居中，好面贡献固定颜色
    src_col = np.where(bad[..., None], target, fcol)
    src_col = src_col.astype(np.float32)
    is_bad_nb = bad[nb_src]
    for _ in range(SMOOTH_ITERS):
        acc = np.zeros((ntri, 3), dtype=np.float32)
        cnt = np.zeros(ntri, dtype=np.float32)
        np.add.at(acc, nb[:, 0], np.where(is_bad_nb[..., None], target[nb_src], fcol[nb_src]))
        np.add.at(cnt, nb[:, 0], 1.0)
        # 自身也参与平均（抑制振荡）
        acc[bad_idx] += target[bad_idx]
        cnt[bad_idx] += 1.0
        upd = cnt[bad_idx] > 0
        target[bad_idx[upd]] = acc[bad_idx[upd]] / cnt[bad_idx[upd]][:, None]

    # ---- 离群剔除：与邻居均值偏离过大的孤立色斑直接拉回均值 ----
    for _ in range(3):
        acc2 = np.zeros((ntri, 3), dtype=np.float32)
        cnt2 = np.zeros(ntri, dtype=np.float32)
        nbc = np.where(is_bad_nb[..., None], target[nb_src], fcol[nb_src])
        np.add.at(acc2, nb[:, 0], nbc)
        np.add.at(cnt2, nb[:, 0], 1.0)
        has = cnt2 > 0
        mean_n = np.zeros_like(target)
        mean_n[has] = acc2[has] / cnt2[has][:, None]
        dev = np.linalg.norm(target - mean_n, axis=1)
        out = has & bad & (dev > 0.16)
        target[out] = mean_n[out]

    # ---- 连通块：小零件整块统一取中位色（小件不该有渐变，否则会花斑）----
    both_bad = bad[nb[:, 0]] & bad[nb[:, 1]]
    ee = nb[both_bad]
    parent = np.arange(ntri, dtype=np.int32)

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for a, b in ee:
        ra, rb = find(int(a)), find(int(b))
        if ra != rb:
            parent[rb] = ra
    roots = np.array([find(int(f)) for f in bad_idx], dtype=np.int32)
    small_comp = 0
    for r in np.unique(roots):
        sel = roots == r
        # 整块统一取中位色：渐变色映射回图集会因为量化落到不同纹素上形成大理石斑，
        # 统一成单一颜色反而最干净（看起来就是一块同色的漆面）
        med = np.median(target[bad_idx[sel]], axis=0)
        target[bad_idx[sel]] = med
        small_comp += 1
    stat.setdefault('smallComponents', small_comp)

    # ---- 颜色 → 图集真实纹素 UV 的 LUT ----
    step = max(1, min(W, H) // 512)
    samp = rgb[::step, ::step, :]
    su = np.linspace(0.0, 1.0, samp.shape[1], dtype=np.float32)
    sv = np.linspace(0.0, 1.0, samp.shape[0], dtype=np.float32)
    q = np.clip((samp * (LUT_N - 1)).round().astype(np.int32), 0, LUT_N - 1)
    flat_id = q[:, :, 0] * LUT_N * LUT_N + q[:, :, 1] * LUT_N + q[:, :, 2]
    lut_uv = np.full((LUT_N ** 3, 2), -1.0, dtype=np.float32)
    uu = np.tile(su, (samp.shape[0], 1))
    vv = np.tile(sv[:, None], (1, samp.shape[1]))
    flat_lut = lut_uv.reshape(-1, 2)
    uniq, first = np.unique(flat_id.ravel(), return_index=True)
    flat_lut[uniq, 0] = uu.ravel()[first]
    flat_lut[uniq, 1] = vv.ravel()[first]

    lut = flat_lut.reshape(LUT_N, LUT_N, LUT_N, 2)
    filled = lut[:, :, :, 0] >= 0
    for _ in range(10):
        if filled.all():
            break
        acc = np.zeros((LUT_N, LUT_N, LUT_N, 2), dtype=np.float32)
        cnt = np.zeros((LUT_N, LUT_N, LUT_N), dtype=np.float32)
        for axis in (0, 1, 2):
            for sh in (1, -1):
                fsh = np.roll(filled, sh, axis=axis)
                lsh = np.roll(lut, sh, axis=axis)
                acc += np.where(fsh[..., None], lsh, 0.0)
                cnt += fsh.astype(np.float32)
        newf = (~filled) & (cnt > 0)
        with np.errstate(invalid='ignore', divide='ignore'):
            avg = acc / np.maximum(cnt, 1.0)[..., None]
        lut = np.where(newf[..., None], avg, lut)
        filled = filled | newf

    # ---- 写入 UV ----
    tq = np.clip((target[bad_idx] * (LUT_N - 1)).round().astype(np.int32), 0, LUT_N - 1)
    new_uv = lut[tq[:, 0], tq[:, 1], tq[:, 2]]
    keep2 = new_uv[:, 0] >= 0
    uv_new = uvs.copy()
    for j, fi in enumerate(bad_idx):
        if not keep2[j]:
            continue
        s = lstart[fi]
        uv_new[s:s + 3] = new_uv[j]
    me.uv_layers.active.data.foreach_set('uv', uv_new.ravel())
    me.update()

    stat['meshes'].append({
        'tris': int(ntri),
        'texSize': [W, H],
        'gutterLoopPct': round(float(loop_gutter.mean() * 100), 1),
        'badFaces': int(bad.sum()),
        'uvAssigned': int(keep2.sum()),
        'avg_sat_before': round(float((lcol[loop_gutter].max(axis=1) - lcol[loop_gutter].min(axis=1)).mean()) if loop_gutter.any() else 0, 4),
    })

try:
    bpy.ops.file.pack_all()
except Exception:
    pass

if DO_RENDER:
    shoot_all(sc, MESHES, TAG, 'v3after')

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
stat['outMB'] = round(os.path.getsize(GLB_OUT) / 1048576, 2)
print('@@JSON@@' + json.dumps(stat))

# 分析 GLB：按 UV 采样贴图，找出落在"灰色空白缝隙"里的面，并按连通块汇总
# 用法: blender -b --factory-startup --python-exit-code 1 --python analyze_gutter.py -- <glb> [tag]
import bpy, sys, json, math
import numpy as np
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1:]
GLB = argv[0]
TAG = argv[1] if len(argv) > 1 else 'model'

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=GLB)

meshes = [o for o in bpy.data.objects if o.type == 'MESH']
report = {'tag': TAG, 'objects': []}

for ob in meshes:
    me = ob.data
    if not me.uv_layers.active:
        report['objects'].append({'name': ob.name, 'error': 'no uv'})
        continue

    # ---- 贴图 ----
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
        report['objects'].append({'name': ob.name, 'error': 'no image'})
        continue

    W, H = img.size
    px = np.empty(W * H * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    px = px.reshape(H, W, 4)

    # ---- UV / 顶点 ----
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

    # ---- 采样 ----
    ui = np.clip((uvs[:, 0] % 1.0) * (W - 1), 0, W - 1).astype(np.int32)
    vi = np.clip((uvs[:, 1] % 1.0) * (H - 1), 0, H - 1).astype(np.int32)
    col = px[vi, ui, :3]

    # 灰底判据：三通道接近 + 中明度
    mx = col.max(axis=1)
    mn = col.min(axis=1)
    sat = mx - mn
    val = mx
    is_gutter = (sat < 0.055) & (val > 0.28) & (val < 0.80)

    # ---- 按面汇总 ----
    ntri = len(me.polygons)
    lstart = np.empty(ntri, dtype=np.int32)
    ltot = np.empty(ntri, dtype=np.int32)
    me.polygons.foreach_get('loop_start', lstart)
    me.polygons.foreach_get('loop_total', ltot)

    gutter_loop_frac = np.zeros(ntri, dtype=np.float32)
    for i in range(ntri):
        s = lstart[i]; e = s + ltot[i]
        gutter_loop_frac[i] = is_gutter[s:e].mean() if e > s else 0.0

    full_gutter = gutter_loop_frac >= 0.99
    part_gutter = (gutter_loop_frac > 0.02) & ~full_gutter

    # ---- 连通块（按边共享） ----
    parent = np.arange(nv, dtype=np.int32)

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    edges = np.empty(len(me.edges) * 2, dtype=np.int32)
    me.edges.foreach_get('vertices', edges)
    edges = edges.reshape(-1, 2)
    for a, b in edges:
        ra, rb = find(int(a)), find(int(b))
        if ra != rb:
            parent[rb] = ra
    comp = np.array([find(i) for i in range(nv)], dtype=np.int32)

    # 每个面的代表顶点
    poly_v = lv[lstart]
    poly_comp = comp[poly_v]

    comps = []
    for c in np.unique(comp):
        sel = poly_comp == c
        if not sel.any():
            continue
        idx = np.nonzero(sel)[0]
        vs = co[lv[lstart[idx]]]
        comps.append({
            'id': int(c),
            'faces': int(idx.size),
            'gutterFull': int(full_gutter[idx].sum()),
            'gutterPart': int(part_gutter[idx].sum()),
            'vmin': [round(float(v), 2) for v in vs.min(axis=0)],
            'vmax': [round(float(v), 2) for v in vs.max(axis=0)],
        })
    comps.sort(key=lambda d: -d['faces'])

    # 灰底颜色分布
    g = col[is_gutter]
    hist = {}
    if len(g):
        q = np.round(g.mean(axis=1) * 10).astype(np.int32)
        for k, cnt in zip(*np.unique(q, return_counts=True)):
            hist[int(k)] = int(cnt)

    report['objects'].append({
        'name': ob.name,
        'tris': int(ntri),
        'verts': int(nv),
        'loops': int(nl),
        'texSize': [W, H],
        'gutterLoops': int(is_gutter.sum()),
        'gutterLoopPct': round(float(is_gutter.mean() * 100), 1),
        'facesFullGutter': int(full_gutter.sum()),
        'facesPartGutter': int(part_gutter.sum()),
        'components': len(comps),
        'comps': comps[:12],
        'gutterValueHist': dict(sorted(hist.items())),
    })

print('@@JSON@@' + json.dumps(report))

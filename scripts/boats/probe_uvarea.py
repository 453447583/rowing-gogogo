# 探针：统计每个面的 UV 三角形面积，看"灰块面"是否就是 UV 塌缩的面
import bpy, sys, json
import numpy as np

argv = sys.argv[sys.argv.index('--') + 1:]
GLB = argv[0]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=GLB)

ob = [o for o in bpy.data.objects if o.type == 'MESH'][0]
me = ob.data
nl = len(me.loops)
uvs = np.empty(nl * 2, dtype=np.float32)
me.uv_layers.active.data.foreach_get('uv', uvs)
uvs = uvs.reshape(nl, 2)
ntri = len(me.polygons)
lstart = np.empty(ntri, dtype=np.int32)
ltot = np.empty(ntri, dtype=np.int32)
me.polygons.foreach_get('loop_start', lstart)
me.polygons.foreach_get('loop_total', ltot)

a = uvs[lstart]
b = uvs[lstart + 1]
c = uvs[lstart + 2]
area = np.abs((b[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1]) - (c[:, 0] - a[:, 0]) * (b[:, 1] - a[:, 1])) * 0.5

# 贴图采样
img = None
for mat in me.materials:
    if mat and mat.use_nodes:
        for n in mat.node_tree.nodes:
            if n.type == 'TEX_IMAGE' and n.image:
                img = n.image
                break
    if img:
        break
W, H = img.size
px = np.empty(W * H * 4, dtype=np.float32)
img.pixels.foreach_get(px)
px = px.reshape(H, W, 4)
cen_u = (a[:, 0] + b[:, 0] + c[:, 0]) / 3.0
cen_v = (a[:, 1] + b[:, 1] + c[:, 1]) / 3.0
ui = np.clip((cen_u % 1.0) * (W - 1), 0, W - 1).astype(np.int32)
vi = np.clip((cen_v % 1.0) * (H - 1), 0, H - 1).astype(np.int32)
col = px[vi, ui, :3]
mx = col.max(axis=1); mn = col.min(axis=1)
loose_gray = ((mx - mn) < 0.05) & (mx > 0.38) & (mx < 0.66)

pcts = [50, 75, 90, 95, 99]
print('@@JSON@@' + json.dumps({
    'tris': int(ntri),
    'uvArea': {f'p{p}': float(np.percentile(area, p)) for p in pcts},
    'zeroArea': int((area < 1e-9).sum()),
    'tinyArea': int((area < 1e-7).sum()),
    'grayFaces': int(loose_gray.sum()),
    'grayAndZero': int((loose_gray & (area < 1e-9)).sum()),
    'grayAndTiny': int((loose_gray & (area < 1e-7)).sum()),
    'grayAreaMedian': float(np.median(area[loose_gray])) if loose_gray.any() else 0.0,
    'nongrayAreaMedian': float(np.median(area[~loose_gray])) if (~loose_gray).any() else 0.0,
}))

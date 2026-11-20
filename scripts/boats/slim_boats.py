# -*- coding: utf-8 -*-
"""
6 艘新赛艇轻量化：去旋转 → 船头对齐 glTF +Z → 减面 → 贴图 2048² → 导出 GLB
  blender -b --factory-startup --python-exit-code 1 --python scripts/boats/slim_boats.py -- [tag ...|all] [targetTris]

为什么要在 Blender 里"去旋转"：
  tripo 出的模型在自身 mesh 空间里是斜的（car6 主轴与 +X 差 ~52°），
  直接进游戏船头会歪着跑。这里用顶点协方差求水平面内的主惯性轴，把长轴转到
  glTF +Z（Blender 里是 -Y）、船头朝 +Z、船底压到 y=0，写回 GLB 后
  boats.js 只需 modelRotationY: 0 / modelLiftY: 0。

坐标系提醒（踩过的坑）：
  Blender 水平面是 XY、Z 向上；glTF 是 Y 向上。(x,y,z)_gltf → (x,-z,y)_blender。
  所以 glTF +Z = Blender -Y，绕"偏航"必须转 Blender Z 轴，不是 Y 轴。
"""

import bpy
import sys
import os
import math
import json
import numpy as np

ROOT = "D:/3Dgame - 副本"
SRC = os.path.join(ROOT, "assets_src/boats/fixed")
DST = os.path.join(ROOT, "public/models")
TMP = os.path.join(ROOT, ".tmp_build/tex")
os.makedirs(DST, exist_ok=True)
os.makedirs(TMP, exist_ok=True)

ALL = ["car6", "flycar", "jetboat", "redcar", "ship", "speedboat"]

# 双体船（redcar）的两片细长艏柱是横向分开的，末端 max|x| 反而更大，
# "窄端 = 船头"的判据会判反。俯视图人工确认后在这里显式补一次 180°。
EXTRA_FLIP = {"redcar"}

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
tags = ALL if (not argv or argv[0] == "all") else [argv[0]]
TARGET = int(argv[1]) if len(argv) > 1 else 130000
TEX_MAX = 2048


def sel_only(ob):
    bpy.ops.object.select_all(action='DESELECT')
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob


def mesh_objects():
    return [o for o in bpy.context.scene.objects if o.type == 'MESH']


def points(objs):
    out = []
    for ob in objs:
        n = len(ob.data.vertices)
        co = np.empty(n * 3, dtype=np.float64)
        ob.data.vertices.foreach_get('co', co)
        co = co.reshape(n, 3)
        mw = np.array(ob.matrix_world, dtype=np.float64)
        out.append(co @ mw[:3, :3].T + mw[:3, 3])
    return np.vstack(out)


def yaw_about_up(objs):
    """水平面 (Blender XY) 内主惯性轴相对 +X 的方位角"""
    p = points(objs)
    d = p - p.mean(axis=0)
    cxx = float((d[:, 0] * d[:, 0]).mean())
    cyy = float((d[:, 1] * d[:, 1]).mean())
    cxy = float((d[:, 0] * d[:, 1]).mean())
    return 0.5 * math.atan2(2.0 * cxy, cxx - cyy)


def widths_along_y(objs, bins=24):
    """沿 Blender Y 切片的最大横向半宽（|x|）。bin 0 = 最小 Y = glTF +Z 那一端"""
    p = points(objs)
    y0, y1 = p[:, 1].min(), p[:, 1].max()
    w = np.zeros(bins)
    for t in range(bins):
        lo = y0 + (y1 - y0) * t / bins
        hi = y0 + (y1 - y0) * (t + 1) / bins
        sl = p[(p[:, 1] >= lo) & (p[:, 1] <= hi)]
        if len(sl):
            w[t] = np.abs(sl[:, 0]).max()
    return w


def rotate_z(objs, theta):
    for ob in objs:
        ob.rotation_mode = 'XYZ'
        ob.rotation_euler.z += theta
    bpy.context.view_layer.update()
    for ob in objs:
        sel_only(ob)
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)


def normalize(objs):
    """水平居中、船底 z=0、船长（Blender Y 方向）归一到 1.0"""
    p = points(objs)
    lo, hi = p.min(axis=0), p.max(axis=0)
    length = max(hi[1] - lo[1], hi[0] - lo[0])
    s = 1.0 / length if length > 0 else 1.0
    cx = (lo[0] + hi[0]) / 2.0
    cy = (lo[1] + hi[1]) / 2.0
    for ob in objs:
        for v in ob.data.vertices:
            v.co.x = (v.co.x - cx) * s
            v.co.y = (v.co.y - cy) * s
            v.co.z = (v.co.z - lo[2]) * s
        ob.data.update()


report = []
for tag in tags:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    src = os.path.join(SRC, f"{tag}_fixed.glb")
    bpy.ops.import_scene.gltf(filepath=src)
    bpy.context.view_layer.update()
    objs = mesh_objects()
    assert len(objs) == 1, f"{tag}: 期望 1 个 mesh，实际 {len(objs)}"
    objs[0].data.calc_loop_triangles()
    tri_before = len(objs[0].data.loop_triangles)

    # ① 去旋转：水平主惯性轴 → Blender -Y（= glTF +Z）
    phi = yaw_about_up(objs)
    theta = -math.pi / 2.0 - phi
    rotate_z(objs, theta)
    yaw_deg = math.degrees(theta)

    # ② 船头判定：两端 1/6 的平均半宽，窄的一端是船头 → 必须落在 glTF +Z（最小 Y）
    w = widths_along_y(objs)
    k = max(2, len(w) // 6)
    w_plus_z = float(w[:k].mean())     # 最小 Y 端 = glTF +Z 端
    w_minus_z = float(w[-k:].mean())
    flipped = w_plus_z > w_minus_z     # +Z 端更宽 → 那是船尾，翻 180°
    if flipped:
        rotate_z(objs, math.pi)
    if tag in EXTRA_FLIP:
        rotate_z(objs, math.pi)
        flipped = not flipped

    # ③ 归一化（居中 / 船底 0 / 长 1.0）
    normalize(objs)

    # ④ 减面
    tri_now = len(objs[0].data.loop_triangles)
    ratio = min(1.0, TARGET / max(1, tri_now))
    ob = objs[0]
    sel_only(ob)
    mod = ob.modifiers.new('slim', 'DECIMATE')
    mod.decimate_type = 'COLLAPSE'
    mod.ratio = ratio
    mod.use_collapse_triangulate = True
    bpy.ops.object.modifier_apply(modifier=mod.name)
    ob.data.calc_loop_triangles()
    tri_after = len(ob.data.loop_triangles)

    # ⑤ 贴图 2048² + 重编 JPEG
    # 坑：只 scale 原 image 再导出，导出器会认"源字节未改"，直接拷贝原始 4096 贴图。
    # 必须落盘一张新的 2048 JPEG，再让材质节点指向新 image datablock。
    tex_info = []
    for img in list(bpy.data.images):
        if img.type != 'IMAGE' or img.size[0] == 0:
            continue
        was = tuple(img.size)
        if max(was) > TEX_MAX:
            img.scale(TEX_MAX, TEX_MAX)
        tmp = os.path.join(TMP, f"{tag}_{len(tex_info)}.jpg")
        try:
            img.filepath_raw = tmp
            img.file_format = 'JPEG'
            img.save()
            if not os.path.exists(tmp):
                raise RuntimeError('JPEG 未落盘')
            fresh = bpy.data.images.load(tmp, check_existing=False)
            fresh.colorspace_settings.name = 'sRGB'
            for mat in bpy.data.materials:
                if not mat.use_nodes:
                    continue
                for node in mat.node_tree.nodes:
                    if node.type == 'TEX_IMAGE' and node.image is img:
                        node.image = fresh
            bpy.data.images.remove(img)
            tex_info.append({'from': was, 'to': tuple(fresh.size), 'kb': round(os.path.getsize(tmp) / 1024)})
        except Exception as e:                     # noqa: BLE001
            tex_info.append({'error': f'{type(e).__name__}: {e}', 'from': was})

    # ⑥ 导出
    sel_only(ob)
    out = os.path.join(DST, f"boat_{tag}.glb")
    want = dict(
        filepath=out, export_format='GLB', use_selection=True, export_apply=True,
        export_yup=True, export_image_format='JPEG', export_image_quality=90,
        export_normals=True, export_texcoords=True, export_tangents=False,
        export_materials='EXPORT', export_animations=False, export_skins=False,
        export_cameras=False, export_lights=False, export_extras=False,
    )
    valid = set(bpy.ops.export_scene.gltf.get_rna_type().properties.keys())
    bpy.ops.export_scene.gltf(**{k: v for k, v in want.items() if k in valid})

    report.append({
        'tag': tag, 'triBefore': tri_before, 'triAfter': tri_after,
        'yawDeg': round(yaw_deg, 1), 'flipped': bool(flipped),
        'wPlusZ': round(w_plus_z, 3), 'wMinusZ': round(w_minus_z, 3),
        'texture': tex_info, 'mb': round(os.path.getsize(out) / 1048576, 2),
    })
    print("@@SLIM@@", json.dumps(report[-1], ensure_ascii=False))

print("@@REPORT@@", json.dumps(report, ensure_ascii=False))

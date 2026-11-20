# -*- coding: utf-8 -*-
"""把 Poly Haven 的写实松树 / 岩石做成游戏可用的低模 GLB。

用法（必须 --factory-startup）：
    D:/blender/blender.exe -b --factory-startup --python-exit-code 1 \
        --python scripts/blender/build_pine_assets.py -- <输入目录> <输出目录> <目标面数>

输入目录里放 gltf + bin + textures/（Poly Haven 的 1k 包结构）。
输出：<输出目录>/pine_trees.glb 、 rock_boulder.glb

为什么要减面：Poly Haven 的树是摄影测量模型（pine_sapling_small 约 39.8 万三角面/棵），
一棵就要吃掉整条赛道的预算。这里把针叶簇塌到 ~1300 面、树干 ~200 面，
远看仍然是真实的松树轮廓，但 150 棵也只要 ~22 万面。
"""
import json
import os
import sys

import bpy
from mathutils import Matrix

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
SRC = argv[0]
OUT = argv[1]
FOLIAGE_TRIS = int(argv[2]) if len(argv) > 2 else 1300
BARK_TRIS = int(argv[3]) if len(argv) > 3 else 220
TEX_SIZE = int(argv[4]) if len(argv) > 4 else 512


def log(**kw):
    print('@@JSON@@' + json.dumps(kw, ensure_ascii=False))


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def tri_count(obj):
    me = obj.data
    me.calc_loop_triangles()
    return len(me.loop_triangles)


def decimate_to(obj, target):
    """把三角面数压到 target 附近（DECIMATE collapse 是按比例算的，所以要迭代）"""
    cur = tri_count(obj)
    if cur <= target:
        return cur
    for _ in range(6):
        ratio = max(0.005, min(1.0, target / max(1, cur)))
        mod = obj.modifiers.new(name='dec', type='DECIMATE')
        mod.decimate_type = 'COLLAPSE'
        mod.ratio = ratio
        mod.use_collapse_triangulate = True
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.modifier_apply(modifier=mod.name)
        cur = tri_count(obj)
        if abs(cur - target) <= target * 0.2:
            break
    return cur


def bake_world(obj):
    """把 matrix_world 烘进顶点，再把物体归零，后续 join 不会错位"""
    me = obj.data
    mw = obj.matrix_world.copy()
    for v in me.vertices:
        v.co = mw @ v.co
    obj.matrix_world = Matrix.Identity(4)


def ground_and_center(obj):
    """原点放到「落地中心」：XZ 居中、Y 最低点归零（Blender 是 Z 朝上，
    这里换成 glTF 的 Y-up 由导出器负责，所以只处理 Z）"""
    me = obj.data
    xs = [v.co.x for v in me.vertices]
    ys = [v.co.y for v in me.vertices]
    zs = [v.co.z for v in me.vertices]
    cx = (min(xs) + max(xs)) * 0.5
    cy = (min(ys) + max(ys)) * 0.5
    mz = min(zs)
    for v in me.vertices:
        v.co.x -= cx
        v.co.y -= cy
        v.co.z -= mz


def shrink_images(size):
    """贴图统一缩到 size，并 pack 进 GLB：1k 的原包一棵树就要 4MB，没必要"""
    done = []
    for img in list(bpy.data.images):
        if img.source != 'FILE' or not img.size[0]:
            continue
        w, h = img.size
        if max(w, h) > size:
            img.scale(size, size)
        try:
            img.pack()
        except Exception as e:  # noqa: BLE001
            print('pack failed', img.name, e)
        done.append(img.name)
    return done


def export(path, names):
    bpy.ops.object.select_all(action='DESELECT')
    for n in names:
        ob = bpy.data.objects.get(n)
        if ob:
            ob.select_set(True)
    bpy.context.view_layer.objects.active = bpy.data.objects.get(names[0])
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format='GLB',
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_image_format='JPEG',
        export_jpeg_quality=82,
        export_texcoords=True,
        export_normals=True,
        export_materials='EXPORT',
        export_cameras=False,
        export_lights=False,
    )
    return os.path.getsize(path)


def build_trees():
    gltf = os.path.join(SRC, 'pine_sapling_small.gltf')
    reset()
    bpy.ops.import_scene.gltf(filepath=gltf)
    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    log(step='imported-trees', meshes=[(o.name, tri_count(o)) for o in meshes])

    # 每棵树在 glTF 里是「一个 mesh + 两个 primitive（树干 / 针叶）」，
    # Blender 导入后合成一个对象带两个材质槽。必须在减面之前按材质拆开：
    # 混在一起塌面数时，486 面的树干会被针叶的十几万面淹掉，直接塌成 1 个面。
    for o in list(meshes):
        bpy.ops.object.select_all(action='DESELECT')
        o.select_set(True)
        bpy.context.view_layer.objects.active = o
        bpy.ops.mesh.separate(type='MATERIAL')
    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    log(step='split-by-material', meshes=[(o.name, o.data.materials[0].name if o.data.materials else '?', tri_count(o)) for o in meshes])

    # 3 棵变体：模型是 "_a/_b/_c" 三棵树并排放在 x=0/1/2
    groups = {}
    for o in meshes:
        for k in ('_a', '_b', '_c'):
            if k in o.name:
                groups.setdefault(k, []).append(o)
                break
    if not groups:
        for o in meshes:
            x = o.matrix_world.translation.x
            groups.setdefault('_abc'[min(2, max(0, round(x)))], []).append(o)

    out_names = []
    for key, objs in sorted(groups.items()):
        for o in objs:
            mat = o.data.materials[0].name if o.data.materials else ''
            target = BARK_TRIS if 'bark' in mat else FOLIAGE_TRIS
            bake_world(o)
            before_o = tri_count(o)
            after_o = decimate_to(o, target)
            log(step='part', name=o.name, mat=mat, before=before_o, after=after_o)

        bpy.ops.object.select_all(action='DESELECT')
        for o in objs:
            o.select_set(True)
        bpy.context.view_layer.objects.active = objs[0]
        if len(objs) > 1:
            bpy.ops.object.join()
        tree = bpy.context.view_layer.objects.active
        ground_and_center(tree)
        name = 'pine_' + key.strip('_')
        tree.name = name
        tree.data.name = name + '_mesh'
        out_names.append(name)
        log(step='tree', name=name, tris_after=tri_count(tree))

    imgs = shrink_images(TEX_SIZE)
    size = export(os.path.join(OUT, 'pine_trees.glb'), out_names)
    log(step='export-trees', bytes=size, images=imgs, names=out_names)


def build_rock():
    gltf = os.path.join(SRC, '..', '.tmp_rock', 'rock_07.gltf')
    gltf = os.path.abspath(gltf)
    reset()
    bpy.ops.import_scene.gltf(filepath=gltf)
    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    bpy.ops.object.select_all(action='DESELECT')
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    rock = bpy.context.view_layer.objects.active
    bake_world(rock)
    before = tri_count(rock)
    decimate_to(rock, 1500)
    ground_and_center(rock)
    rock.name = 'rock_boulder'
    rock.data.name = 'rock_boulder_mesh'
    imgs = shrink_images(TEX_SIZE)
    size = export(os.path.join(OUT, 'rock_boulder.glb'), ['rock_boulder'])
    log(step='export-rock', bytes=size, tris_before=before, tris_after=tri_count(rock), images=imgs)


os.makedirs(OUT, exist_ok=True)
# 岩石的源目录是同级 .tmp_rock，所以 SRC 传项目根下的 .tmp_tree
build_trees()
build_rock()
log(step='done')

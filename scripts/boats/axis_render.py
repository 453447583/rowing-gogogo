# -*- coding: utf-8 -*-
"""
船头朝向判定 v2：正交俯视图 + 端点标记
  blender -b --factory-startup --python scripts/boats/axis_render.py

俯视正交（相机在 Blender +Z 上方，屏幕上方 = Blender +Y，屏幕右方 = Blender +X）
  红块 = 长轴正端（Blender +轴）  蓝块 = 长轴负端
  绿块 = 横轴正端（帮助区分左右）
注意：glTF → Blender 的换算为 (x, y, z) → (x, -z, y)，
      所以 Blender +Y = glTF -Z，Blender +X = glTF +X。
"""

import bpy
import os
from mathutils import Vector

ROOT = "D:/3Dgame - 副本"
SRC = os.path.join(ROOT, "assets_src/boats/fixed")
OUT = os.path.join(ROOT, "shots/verify/boats/axis")
TAGS = ["car6", "flycar", "jetboat", "redcar", "ship", "speedboat"]
os.makedirs(OUT, exist_ok=True)


def clear():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def world_bbox(objs):
    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    for o in objs:
        if o.type != 'MESH':
            continue
        for c in o.bound_box:
            p = o.matrix_world @ Vector(c)
            for i in range(3):
                lo[i] = min(lo[i], p[i])
                hi[i] = max(hi[i], p[i])
    return lo, hi


def mat(name, rgb):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*rgb, 1)
    if "Emission Color" in bsdf.inputs:
        bsdf.inputs["Emission Color"].default_value = (*rgb, 1)
        bsdf.inputs["Emission Strength"].default_value = 2.5
    return m


RED = None
BLUE = None
GREEN = None


def cube(loc, size, m):
    bpy.ops.mesh.primitive_cube_add(size=size, location=loc)
    ob = bpy.context.object
    ob.data.materials.append(m)
    return ob


for tag in TAGS:
    clear()
    bpy.ops.import_scene.gltf(filepath=os.path.join(SRC, f"{tag}_fixed.glb"))
    bpy.context.view_layer.update()
    objs = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    lo, hi = world_bbox(objs)
    dim = hi - lo
    ax = max(range(3), key=lambda i: dim[i])
    cross = [i for i in range(3) if i != ax and i != 1]
    cross_ax = cross[0]
    span = max(dim) * 0.055
    mid = (lo + hi) / 2

    RED = mat('mR', (1.0, 0.02, 0.02))
    BLUE = mat('mB', (0.05, 0.15, 1.0))
    GREEN = mat('mG', (0.05, 0.9, 0.15))

    def end(sign):
        p = Vector((mid.x, mid.y, hi.z + span * 0.45))
        p[ax] = (hi[ax] + span * 1.1) if sign > 0 else (lo[ax] - span * 1.1)
        return p

    cube(end(+1), span, RED)
    cube(end(-1), span, BLUE)
    p = Vector((mid.x, mid.y, hi.z + span * 0.45))
    p[cross_ax] = hi[cross_ax] + span * 1.1
    cube(p, span * 0.8, GREEN)

    # 正交俯视相机：屏幕上方 = Blender +Y，屏幕右方 = Blender +X
    cam_data = bpy.data.cameras.new('Top')
    cam_data.type = 'ORTHO'
    cam_data.ortho_scale = max(dim.x, dim.y) * 1.35 + span * 3
    cam = bpy.data.objects.new('Top', cam_data)
    cam.location = (mid.x, mid.y, hi.z + max(dim) * 3)
    bpy.context.scene.collection.objects.link(cam)
    bpy.context.scene.camera = cam

    world = bpy.data.worlds.new("W")
    bpy.context.scene.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (0.93, 0.94, 0.96, 1)
    world.node_tree.nodes["Background"].inputs[1].default_value = 1.6

    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_EEVEE'
    sc.render.resolution_x = 640
    sc.render.resolution_y = 640
    sc.render.filepath = os.path.join(OUT, f"{tag}_top.png")
    bpy.ops.render.render(write_still=True)
    print("@@DONE@@", tag, "长轴", "XYZ"[ax], "dim", [round(v, 2) for v in dim])

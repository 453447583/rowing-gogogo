# -*- coding: utf-8 -*-
"""
轻量版模型自检渲染：正交俯视 + 追尾 3/4 视
  blender -b --factory-startup --python scripts/boats/preview_slim.py -- [tag ...|all]

俯视图约定：屏幕上方 = glTF -Z，屏幕下方 = glTF +Z（也就是游戏里的"前方"）。
所以船头必须出现在画面下方 —— 出现反了说明 slim 脚本的朝向判定错了。
"""

import bpy
import os
import sys
import math
from mathutils import Vector

ROOT = "D:/3Dgame - 副本"
SRC = os.path.join(ROOT, "public/models")
OUT = os.path.join(ROOT, "shots/verify/boats/new")
ALL = ["car6", "flycar", "jetboat", "redcar", "ship", "speedboat"]
os.makedirs(OUT, exist_ok=True)

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
tags = ALL if (not argv or argv[0] == "all") else [argv[0]]


def bbox(objs):
    lo = Vector((1e9,) * 3)
    hi = Vector((-1e9,) * 3)
    for o in objs:
        for c in o.bound_box:
            p = o.matrix_world @ Vector(c)
            for i in range(3):
                lo[i] = min(lo[i], p[i])
                hi[i] = max(hi[i], p[i])
    return lo, hi


def lights(cam_loc, center):
    world = bpy.data.worlds.new("W")
    bpy.context.scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs[0].default_value = (0.86, 0.88, 0.92, 1)
    bg.inputs[1].default_value = 1.1
    bpy.ops.object.light_add(type='AREA', location=cam_loc + Vector((1.4, -1.6, 2.4)))
    key = bpy.context.object
    key.data.energy = 700
    key.data.size = 5
    key.rotation_euler = (center - key.location).to_track_quat('-Z', 'Y').to_euler()
    bpy.ops.object.light_add(type='AREA', location=center + Vector((-2.4, 1.2, 1.4)))
    fill = bpy.context.object
    fill.data.energy = 260
    fill.data.size = 6
    fill.rotation_euler = (center - fill.location).to_track_quat('-Z', 'Y').to_euler()


for tag in tags:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=os.path.join(SRC, f"boat_{tag}.glb"))
    bpy.context.view_layer.update()
    objs = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    lo, hi = bbox(objs)
    dim = hi - lo
    mid = (lo + hi) / 2
    center = Vector((mid.x, mid.y, (lo.z + hi.z) / 2))

    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_EEVEE'
    sc.render.resolution_x = 620
    sc.render.resolution_y = 460

    # --- 俯视正交 ---
    cam_data = bpy.data.cameras.new('Top')
    cam_data.type = 'ORTHO'
    cam_data.ortho_scale = max(dim.x, dim.y) * 1.25
    cam = bpy.data.objects.new('Top', cam_data)
    cam.location = (mid.x, mid.y, hi.z + max(dim) * 3)
    sc.collection.objects.link(cam)
    sc.camera = cam
    lights(cam.location, center)
    sc.render.resolution_x = 520
    sc.render.resolution_y = 520
    sc.render.filepath = os.path.join(OUT, f"{tag}_top.png")
    bpy.ops.render.render(write_still=True)

    # --- 追尾 3/4（从 -Z 后上方看，游戏追尾机位近似） ---
    for o in list(bpy.context.scene.objects):
        if o.type in {'CAMERA', 'LIGHT'}:
            bpy.data.objects.remove(o, do_unlink=True)
    cam_data2 = bpy.data.cameras.new('Chase')
    cam_data2.lens = 55
    cam2 = bpy.data.objects.new('Chase', cam_data2)
    dist = max(dim) * 2.3
    cam2.location = center + Vector((0.55, 0.78, 0.62)).normalized() * dist
    cam2.rotation_euler = (center - cam2.location).to_track_quat('-Z', 'Y').to_euler()
    sc.collection.objects.link(cam2)
    sc.camera = cam2
    sc.render.resolution_x = 620
    sc.render.resolution_y = 420
    lights(cam2.location, center)
    sc.render.filepath = os.path.join(OUT, f"{tag}_chase.png")
    bpy.ops.render.render(write_still=True)
    print("@@PREVIEW@@", tag, "dim", [round(v, 3) for v in dim], "tris",
          sum(len(o.data.loop_triangles) for o in objs))

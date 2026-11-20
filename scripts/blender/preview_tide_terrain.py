# -*- coding: utf-8 -*-
"""冰汐海峡地形资产预览：把三个 GLB 摆在一起，Cycles 出一个 800x420 的图。

    D:/blender/blender.exe -b --python scripts/blender/preview_tide_terrain.py

只为快速看形，不参与游戏构建。
"""
import math
import os

import bpy
from mathutils import Vector

try:
    _HERE = os.path.dirname(os.path.abspath(__file__))
    PROJECT = os.path.normpath(os.path.join(_HERE, '..', '..'))
except NameError:
    PROJECT = r'D:/3Dgame - 副本'
PROPS = os.path.join(PROJECT, 'public', 'models', 'props')
OUT = os.path.join(PROJECT, 'shots', 'verify', 'tide-assets-preview.png')


def setup():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    for name, loc in (('cliff_segment', (-30, 0, 0)),
                      ('iceberg_large', (35, 26, -4.5)),
                      ('iceberg_small', (62, 6, -2.2))):
        path = os.path.join(PROPS, name + '.glb')
        if not os.path.exists(path):
            continue
        bpy.ops.import_scene.gltf(filepath=path)
        ob = bpy.context.selected_objects[0]
        ob.name = name
        ob.location = loc

    bpy.ops.mesh.primitive_plane_add(size=400, location=(0, 0, -0.02))
    plane = bpy.context.object
    mat = bpy.data.materials.new('sea')
    mat.use_nodes = True
    bsdf = next(n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    bsdf.inputs['Base Color'].default_value = (0.03, 0.16, 0.22, 1)
    bsdf.inputs['Roughness'].default_value = 0.16
    plane.data.materials.append(mat)

    bpy.ops.object.light_add(type='SUN', location=(60, -80, 90))
    sun = bpy.context.object
    sun.data.energy = 4.0
    sun.rotation_euler = (math.radians(52), 0, math.radians(30))

    world = bpy.context.scene.world or bpy.data.worlds.new('W')
    bpy.context.scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes['Background']
    bg.inputs[0].default_value = (0.55, 0.70, 0.85, 1)
    bg.inputs[1].default_value = 1.2


def render(cam_loc, target, out):
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.samples = 28
    sc.cycles.device = 'CPU'
    sc.render.resolution_x = 900
    sc.render.resolution_y = 460
    sc.render.filepath = out
    cam = bpy.data.objects.get('PreviewCam')
    if not cam:
        cam = bpy.data.objects.new('PreviewCam', bpy.data.cameras.new('PreviewCam'))
        bpy.context.collection.objects.link(cam)
    cam.location = Vector(cam_loc)
    cam.rotation_euler = (Vector(target) - cam.location).to_track_quat('-Z', 'Y').to_euler()
    sc.camera = cam
    bpy.ops.render.render(write_still=True)
    print('rendered ->', out)


if __name__ == '__main__':
    setup()
    render((-46, -64, 26), (0, 14, 7), OUT)

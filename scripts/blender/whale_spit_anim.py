# 给巨鲸鲨（whale_shark）新做一段「吐泡泡」骨骼动作，导出成独立 GLB。
#
# 为什么是独立 GLB：项目里的小怪动作是「一个文件一集」，运行时按 clip 名前缀合并
# （BossMode.#loadMinionRig 把 clipModels 里的 animations 拼起来）。
# 所以这里只负责产出一个叫 whale_shark_spit 的 action，网格/骨骼沿用原 idle 文件。
#
# 姿态设计（24fps，46 帧 ≈ 1.9s）：
#   1 帧 静止 → 9 帧 抬头吸气（颌闭合、胸鳍后展）
#   → 15 帧 张颌 → 19 帧 鼓腮吐出（第一串泡）→ 26 帧 再张一次（第二串）
#   → 34 帧 合颌 → 46 帧 回到静止
# 旋转用「骨架空间绕 X 轴」施加，方向（张口是 +X 还是 -X）由下颌顶点位移自动判号，
# 不靠肉眼看轴向 —— 这批 GLB 的骨骼 roll 是手工绑的，猜轴向很容易把嘴掰反。
#
# 用法：
#   blender -b --factory-startup --python scripts/blender/whale_spit_anim.py -- \
#     public/monsters/whale_shark_idle.glb public/monsters/whale_shark_spit.glb
import json
import math
import os
import sys

import bpy
from mathutils import Matrix, Vector

ARGV = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
SRC = ARGV[0] if ARGV else 'public/monsters/whale_shark_idle.glb'
DST = ARGV[1] if len(ARGV) > 1 else 'public/monsters/whale_shark_spit.glb'
CLIP = 'whale_shark_spit'
FPS = 24


def log(**kw):
    print('@@JSON@@' + json.dumps(kw, ensure_ascii=False))


def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_glb(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.abspath(path))
    return [o for o in bpy.data.objects if o not in before]


def find_armature(objs):
    for o in objs:
        if o.type == 'ARMATURE':
            return o
    raise RuntimeError('no armature in ' + SRC)


def jaw_vertices(arm, mesh_obj):
    """取以下颌骨为主要权重的顶点：用它算「张口方向」，不用猜轴向。"""
    idx = mesh_obj.vertex_groups.find('jaw')
    if idx < 0:
        return []
    out = []
    for v in mesh_obj.data.vertices:
        best = None
        for g in v.groups:
            if best is None or g.weight > best[1]:
                best = (g.group, g.weight)
        if best and best[0] == idx and best[1] > 0.3:
            out.append(v.index)
    return out


def eval_centroid(mesh_obj, idxs):
    dg = bpy.context.evaluated_depsgraph_get()
    ev = mesh_obj.evaluated_get(dg)
    me = ev.to_mesh()
    try:
        if not idxs:
            idxs = list(range(0, len(me.vertices)))
        acc = Vector((0, 0, 0))
        n = 0
        for i in idxs:
            if i < len(me.vertices):
                acc += me.vertices[i].co
                n += 1
        return acc / max(1, n)
    finally:
        ev.to_mesh_clear()


def bone_rot(pb, axis, angle):
    """在骨架空间里绕 axis 轴旋转（绕骨头原点），不受 bone roll 影响。"""
    rot = Matrix.Rotation(angle, 4, axis)
    pb.matrix = rot @ pb.matrix


def key(pb, frame):
    pb.keyframe_insert('rotation_quaternion', frame=frame)
    pb.keyframe_insert('location', frame=frame)
    pb.keyframe_insert('scale', frame=frame)


def main():
    clear_scene()
    objs = import_glb(SRC)
    arm = find_armature(objs)
    # 这个 GLB 里有两个网格（主体 WhaleShark 3037 点 + 眼睛 Icosphere 42 点），
    # 判号要用**带 jaw 顶点组的主体**，否则取到眼球就永远算不出位移
    meshes = [o for o in objs if o.type == 'MESH']
    mesh_obj = max(meshes, key=lambda o: len(o.data.vertices))

    bpy.context.view_layer.update()
    bpy.context.scene.render.fps = FPS

    # 清掉导入的旧动作，只留我们这一段
    arm.animation_data_create()
    for a in list(bpy.data.actions):
        bpy.data.actions.remove(a)
    act = bpy.data.actions.new(CLIP)
    act.use_fake_user = True
    arm.animation_data.action = act

    for pb in arm.pose.bones:
        pb.rotation_mode = 'QUATERNION'

    rest_q = {pb.name: pb.rotation_quaternion.copy() for pb in arm.pose.bones}

    # --- 判号：先试着绕 +X 转 0.35rad，看下颌是往下还是往上 ---
    idxs = jaw_vertices(arm, mesh_obj)
    rest_c = eval_centroid(mesh_obj, idxs)
    jaw_bone = 'jaw' if 'jaw' in arm.pose.bones else None
    sign = 1.0
    if jaw_bone:
        pb = arm.pose.bones[jaw_bone]
        bone_rot(pb, Vector((1, 0, 0)), 0.35)
        bpy.context.view_layer.update()
        moved = eval_centroid(mesh_obj, idxs)
        # 下颌要往下（世界 -Z）
        if (moved - rest_c).z > 0:
            sign = -1.0
        pb.rotation_quaternion = rest_q[jaw_bone]
        bpy.context.view_layer.update()
        jaw_delta = (moved - rest_c)
    else:
        jaw_delta = Vector((0, 0, 0))

    HEAD_UP = 0.20      # 抬头
    JAW_OPEN = 0.36     # 张口（约 21°）。再大下颌会拉出一大片平板口腔，侧看像破面
    FIN_SWEEP = 0.14    # 胸鳍后展
    # 同一根骨架空间轴上，抬头的正负号和开口相反（实测：sign 让下颌往下，抬头要用 -sign）
    HEAD_SIGN = -sign if jaw_bone else sign

    def pose_at(frame, *, head, jaw, fin, spine, puff=1.0):
        for name, pb in ((n, arm.pose.bones.get(n)) for n in rest_q):
            if pb is None:
                continue
            pb.rotation_quaternion = rest_q[name].copy()
            pb.scale = (1, 1, 1)
        if head:
            for n in ('head', 'neck'):
                pb = arm.pose.bones.get(n)
                if pb:
                    bone_rot(pb, Vector((1, 0, 0)), head * HEAD_SIGN * (1.0 if n == 'head' else 0.4))
        if jaw:
            pb = arm.pose.bones.get('jaw')
            if pb:
                bone_rot(pb, Vector((1, 0, 0)), jaw * sign)
        if fin:
            for n, s in (('pectoral_L', 1), ('pectoral_R', -1)):
                pb = arm.pose.bones.get(n)
                if pb:
                    bone_rot(pb, Vector((0, 0, 1)), fin * s)
        if spine:
            # 身体轻微后仰 + 尾巴反摆，让「吸气」有躯干参与
            for n, s in (('spine_1', 1.0), ('spine_2', 0.6), ('spine_3', 0.35)):
                pb = arm.pose.bones.get(n)
                if pb:
                    bone_rot(pb, Vector((1, 0, 0)), spine * s * HEAD_SIGN)
            for n, s in (('tail_1', -1.0), ('tail_2', -0.8)):
                pb = arm.pose.bones.get(n)
                if pb:
                    bone_rot(pb, Vector((1, 0, 0)), spine * s * 0.6 * HEAD_SIGN)
        if puff != 1.0:
            pb = arm.pose.bones.get('spine_1')
            if pb:
                pb.scale = (puff, 1.0, puff)
        for pb in arm.pose.bones:
            key(pb, frame)

    # frame, head, jaw, fin, spine, puff
    poses = [
        (1,  0.00, 0.00, 0.00, 0.00, 1.00),   # 静止
        (7,  0.16, 0.00, -0.06, -0.05, 1.00),  # 抬头吸气
        (11, 0.22, 0.00, -FIN_SWEEP, -0.08, 1.04),  # 吸满（腮鼓起）
        (15, 0.20, JAW_OPEN, -FIN_SWEEP, -0.06, 1.02),  # 张颌
        (19, 0.14, JAW_OPEN * 0.86, -FIN_SWEEP * 0.6, 0.0, 0.98),  # 吐出（第一串）
        (24, 0.18, JAW_OPEN * 0.32, -FIN_SWEEP * 0.4, -0.03, 1.02),  # 收颌吸气
        (28, 0.20, JAW_OPEN, -FIN_SWEEP, -0.06, 1.02),  # 再张
        (32, 0.12, JAW_OPEN * 0.8, -FIN_SWEEP * 0.5, 0.0, 0.98),  # 吐出（第二串）
        (38, 0.06, JAW_OPEN * 0.18, -0.04, 0.0, 1.0),  # 合颌
        (46, 0.00, 0.00, 0.00, 0.00, 1.00),   # 回到静止
    ]
    for (f, head, jaw, fin, spine, puff) in poses:
        pose_at(f, head=head, jaw=jaw, fin=fin, spine=spine, puff=puff)

    # Blender 5.x 的 Action 是分层/分槽结构，`action.fcurves` 已被移除；
    # 这里只做统计（插值默认就是 BEZIER，不用逐条改）
    def action_curve_count(act):
        n = 0
        for layer in getattr(act, 'layers', []):
            for strip in layer.strips:
                for bag in getattr(strip, 'channelbags', []):
                    n += len(bag.fcurves)
        if not n and hasattr(act, 'fcurves'):
            n = len(act.fcurves)
        return n

    curves = action_curve_count(act)

    bpy.context.scene.frame_start = 1
    bpy.context.scene.frame_end = 46

    # 复位到静止帧，避免导出时 GLB 带着 posed 状态
    bpy.context.scene.frame_set(1)

    # 导出：只选骨架 + 网格，动作按 action 名导出
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        if o.type in ('ARMATURE', 'MESH'):
            o.select_set(True)
    bpy.context.view_layer.objects.active = arm

    os.makedirs(os.path.dirname(os.path.abspath(DST)), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=os.path.abspath(DST),
        export_format='GLB',
        use_selection=True,
        export_apply=False,
        export_animations=True,
        export_animation_mode='ACTIONS',
        export_nla_strips=False,
        export_bake_animation=True,
        export_optimize_animation_size=False,
        export_force_sampling=True,
        export_frame_range=True,
        export_yup=True,
    )

    log(ok=True, out=DST, clip=CLIP, frames=[1, 46],
        jaw_sign=sign, jaw_verts=len(idxs),
        jaw_move_hint=[round(jaw_delta.x, 3), round(jaw_delta.y, 3), round(jaw_delta.z, 3)],
        action_curves=curves, bones=len(arm.pose.bones))


main()

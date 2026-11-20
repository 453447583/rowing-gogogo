"""第三关龙骑士「跳劈震地」动画生成器（Blender 无头模式运行）。

在 85 根骨架的龙骑士上做一段 dk_jump_slam：
蹲身蓄力 → 蹬地跃起 → 空中举斧过顶 → 下砸 → 落地重砸（蹲姿保持）。
导出的 public/monsters/dk_slam.glb 只有骨架 + 这一段 action（无网格），
由 Boss.js 的 def.clipModels 合并进 BOSS 的同一个 mixer。

用法：
    "D:\\blender\\blender.exe" --background --factory-startup --python scripts/build-dk-slam.py

注意：
1. 导入 glTF **之前**把 scene.render.fps 设成 30，否则时间轴会被当前帧率换算。
2. 剑骨（Bone_Sword_R_1）不在手骨层级下，必须每帧用「手骨世界矩阵 × 握持偏移」
   重算，否则举斧时剑悬空。
3. 片段最后 1 帧就是落地砸击姿势，Boss.js 会按「片段时长 / 剩余预警时长」
   设动画倍速，保证落地帧与技能结算帧重合。
"""
import bpy
import math
import os
from mathutils import Quaternion, Vector

FPS = 30
ROOT = r'd:\3Dgame - 副本'
SRC = ROOT + r'\public\monsters\dk_idle.glb'
OUT = ROOT + r'\public\monsters\dk_slam.glb'
PREVIEW = ROOT + r'\.tmp_slam_preview'

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.fps = FPS
scene.frame_start = 1

bpy.ops.import_scene.gltf(filepath=SRC)
arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
pose = arm.pose


def use_action(act):
    if arm.animation_data is None:
        arm.animation_data_create()
    arm.animation_data.action = act
    slots = getattr(act, 'slots', None)
    if slots:
        arm.animation_data.action_slot = slots[0]


def grip_offset():
    use_action(bpy.data.actions['Armature_Stand_full'])
    scene.frame_set(20)
    return pose.bones[H_R].matrix.inverted() @ pose.bones[SWORD].matrix.copy()


def bone(name):
    return pose.bones[name]


def q_world(pb, axis, deg):
    """世界轴（Blender Z-up：X=右, Y=后, Z=上）换算到该骨骼局部轴后旋转"""
    m = pb.bone.matrix_local.to_3x3()
    v = m.inverted() @ Vector(axis)
    return Quaternion(v.normalized(), math.radians(deg))


def key(pb, frame, rots):
    q = Quaternion((1, 0, 0, 0))
    for axis, deg in rots:
        q = q @ q_world(pb, axis, deg)
    pb.rotation_mode = 'QUATERNION'
    pb.rotation_quaternion = q
    pb.keyframe_insert('rotation_quaternion', frame=frame)


def key_loc(pb, frame, world_vec):
    m = pb.bone.matrix_local.to_3x3()
    pb.location = m.inverted() @ Vector(world_vec)
    pb.keyframe_insert('location', frame=frame)


X = (1, 0, 0)
Y = (0, 1, 0)
Z = (0, 0, 1)

SPINE = 'Bone_Spine01_51'
CHEST = 'Bone_Chest_50'
NECK = 'Bone_Neck_49'
HEAD = 'Bone_Head_48'
JAW = 'Bone_HeadJaw_46'
HIP = 'Bone_Hip_69'
S_R = 'Bone_Shoulder_R_21'
A_R = 'Bone_Arm_R_18'
F_R = 'Bone_ArmFore_R_17'
H_R = 'Bone_ArmHand_R_16'
SWORD = 'Bone_Sword_R_1'
S_L = 'Bone_Shoulder_L_31'
A_L = 'Bone_Arm_L_28'
F_L = 'Bone_ArmFore_L_27'
H_L = 'Bone_ArmHand_L_26'
TAIL = ['Bone_Tail_00_68', 'Bone_Tail_02_67', 'Bone_Tail_04_66', 'Bone_Tail_06_64']
THIGH_R = 'Bone_LegThigh_R_58'
THIGH_L = 'Bone_LegThigh_L_63'
CALF_R = 'Bone_LegCalf_R_57'
CALF_L = 'Bone_LegCalf_L_62'

ALL_ANIM_BONES = [SPINE, CHEST, NECK, HEAD, JAW, HIP, S_R, A_R, F_R, H_R, SWORD,
                  S_L, A_L, F_L, H_L, THIGH_R, THIGH_L, CALF_R, CALF_L] + TAIL

GRIP = grip_offset()


def rest_all(frame):
    for name in ALL_ANIM_BONES:
        key(bone(name), frame, [])
    key_loc(bone(HIP), frame, (0, 0, 0))


def attach_sword(end):
    hand = pose.bones[H_R]
    sword = pose.bones[SWORD]
    sword.rotation_mode = 'QUATERNION'
    for f in range(1, end + 1):
        scene.frame_set(f)
        sword.matrix = hand.matrix @ GRIP
        sword.keyframe_insert('location', frame=f)
        sword.keyframe_insert('rotation_quaternion', frame=f)


# ---------- dk_jump_slam：蹲 → 跃 → 空中举斧 → 落地砸（末帧 = 砸地） ----------
# 27 帧 @30fps ≈ 0.87 秒，正好覆盖 Boss.js 里预警后半程的起跳窗口；
# 最后 1 帧是落地重砸的姿势，clampWhenFinished 之后会一直保持到 animHold 结束。
new_action = bpy.data.actions.new('dk_jump_slam')
new_action.use_fake_user = True
if arm.animation_data is None:
    arm.animation_data_create()
arm.animation_data.action = new_action

rest_all(1)

# f4 蹲身蓄力：膝盖弯、髋部下沉、上身压前、双臂后摆
key(bone(HIP), 4, [(X, 10)])
key_loc(bone(HIP), 4, (0, 0, -0.34))
key(bone(THIGH_R), 4, [(X, -30)])
key(bone(THIGH_L), 4, [(X, -30)])
key(bone(CALF_R), 4, [(X, 48)])
key(bone(CALF_L), 4, [(X, 48)])
key(bone(SPINE), 4, [(X, 16)])
key(bone(CHEST), 4, [(X, 10)])
key(bone(NECK), 4, [(X, 8)])
key(bone(HEAD), 4, [(X, 6)])
key(bone(S_R), 4, [(X, -12)])
key(bone(A_R), 4, [(X, -40), (Z, -10)])
key(bone(F_R), 4, [(X, -14)])
key(bone(A_L), 4, [(X, -34), (Z, 10)])
key(bone(F_L), 4, [(X, -12)])

# f8 蹬地起跳：双腿蹬直、双臂开始上举、身体舒展
key(bone(HIP), 8, [(X, -4)])
key_loc(bone(HIP), 8, (0, 0, 0.12))
key(bone(THIGH_R), 8, [(X, 8)])
key(bone(THIGH_L), 8, [(X, 8)])
key(bone(CALF_R), 8, [(X, 4)])
key(bone(CALF_L), 8, [(X, 4)])
key(bone(SPINE), 8, [(X, -8)])
key(bone(CHEST), 8, [(X, -6)])
key(bone(S_R), 8, [(X, 20)])
key(bone(A_R), 8, [(X, 100), (Z, -14)])
key(bone(F_R), 8, [(X, -24)])
key(bone(S_L), 8, [(X, 16)])
key(bone(A_L), 8, [(X, 94), (Z, 12)])
key(bone(F_L), 8, [(X, -22)])
key(bone(JAW), 8, [(X, -14)])
for i, t in enumerate(TAIL):
    key(bone(t), 8, [(X, -8 - i * 4)])

# f14 空中最高点：收膝、斧头举过头顶、腰背后仰蓄势
key(bone(HIP), 14, [(X, -10)])
key_loc(bone(HIP), 14, (0, 0, 0.05))
key(bone(THIGH_R), 14, [(X, -34)])
key(bone(THIGH_L), 14, [(X, -30)])
key(bone(CALF_R), 14, [(X, 62)])
key(bone(CALF_L), 14, [(X, 58)])
key(bone(SPINE), 14, [(X, -16)])
key(bone(CHEST), 14, [(X, -12)])
key(bone(NECK), 14, [(X, -14)])
key(bone(HEAD), 14, [(X, -12)])
key(bone(S_R), 14, [(X, 26)])
key(bone(A_R), 14, [(X, 150), (Y, -14), (Z, -16)])
key(bone(F_R), 14, [(X, -20)])
key(bone(H_R), 14, [(X, -10)])
key(bone(S_L), 14, [(X, 20)])
key(bone(A_L), 14, [(X, 132), (Z, 14)])
key(bone(F_L), 14, [(X, -18)])
key(bone(JAW), 14, [(X, -20)])
for i, t in enumerate(TAIL):
    key(bone(t), 14, [(X, -14 - i * 6)])

# f20 下砸前半：身体前倾、斧头开始向前下压
key(bone(HIP), 20, [(X, 16)])
key_loc(bone(HIP), 20, (0, 0, -0.05))
key(bone(THIGH_R), 20, [(X, -16)])
key(bone(THIGH_L), 20, [(X, -14)])
key(bone(CALF_R), 20, [(X, 40)])
key(bone(CALF_L), 20, [(X, 36)])
key(bone(SPINE), 20, [(X, 22)])
key(bone(CHEST), 20, [(X, 14)])
key(bone(NECK), 20, [(X, 16)])
key(bone(HEAD), 20, [(X, 12)])
key(bone(S_R), 20, [(X, -4)])
key(bone(A_R), 20, [(X, 30), (Z, 8)])
key(bone(F_R), 20, [(X, -6)])
key(bone(A_L), 20, [(X, 26), (Z, -6)])
key(bone(F_L), 20, [(X, -4)])
key(bone(JAW), 20, [(X, 6)])

# f27 落地重砸（末帧）：深蹲、斧头砸到身前水面、尾巴甩起
key(bone(HIP), 27, [(X, 22)])
key_loc(bone(HIP), 27, (0, 0, -0.62))
key(bone(THIGH_R), 27, [(X, -40)])
key(bone(THIGH_L), 27, [(X, -40)])
key(bone(CALF_R), 27, [(X, 66)])
key(bone(CALF_L), 27, [(X, 66)])
key(bone(SPINE), 27, [(X, 34)])
key(bone(CHEST), 27, [(X, 20)])
key(bone(NECK), 27, [(X, 22)])
key(bone(HEAD), 27, [(X, 16)])
key(bone(S_R), 27, [(X, -12)])
key(bone(A_R), 27, [(X, -72), (Z, 10)])
key(bone(F_R), 27, [(X, 14)])
key(bone(H_R), 27, [(X, 16)])
key(bone(S_L), 27, [(X, -8)])
key(bone(A_L), 27, [(X, -64), (Z, -8)])
key(bone(F_L), 27, [(X, 12)])
key(bone(JAW), 27, [(X, 12)])
for i, t in enumerate(TAIL):
    key(bone(t), 27, [(X, 18 + i * 10)])

# 必须先把剑骨的握持通道写好，再把关键帧烘焙进去
scene.frame_end = 27
attach_sword(27)

# 导出前删掉其它 action（dk_idle.glb 自带的待机段），
# 这样 dk_slam.glb 体积最小，也不会覆盖主包里同名动画
for a in list(bpy.data.actions):
    if a.name != 'dk_jump_slam':
        bpy.data.actions.remove(a)

for o in bpy.data.objects:
    o.select_set(False)
arm.select_set(True)
bpy.context.view_layer.objects.active = arm
bpy.ops.export_scene.gltf(
    filepath=OUT,
    export_format='GLB',
    use_selection=True,
    export_animations=True,
    export_animation_mode='ACTIONS',
    export_force_sampling=True,
)
print('EXPORTED', OUT)

# ---------- 预览渲染（检查姿势用，验完可删） ----------
os.makedirs(PREVIEW, exist_ok=True)
cam_data = bpy.data.cameras.new('preview_cam')
cam = bpy.data.objects.new('preview_cam', cam_data)
scene.collection.objects.link(cam)
cam.location = (9.5, -10.5, 5.2)
cam.rotation_euler = (Vector((0, 0, 2.0)) - cam.location).to_track_quat('-Z', 'Y').to_euler()
scene.camera = cam
scene.render.engine = 'BLENDER_WORKBENCH'
scene.render.resolution_x = 520
scene.render.resolution_y = 520
scene.display.shading.light = 'STUDIO'
scene.display.shading.show_shadows = False
if scene.world is None:
    scene.world = bpy.data.worlds.new('w')
scene.world.color = (0.12, 0.14, 0.18)

use_action(bpy.data.actions['dk_jump_slam'])
for f in (4, 8, 14, 20, 27):
    scene.frame_set(f)
    scene.render.filepath = os.path.join(PREVIEW, f'jump_slam_{f:03d}.png')
    bpy.ops.render.render(write_still=True)
    print('SHOT', f)

print('DONE')

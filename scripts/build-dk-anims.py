"""第三关龙骑士动画包生成器（Blender 无头模式运行）。

把上传的 5 段动画（dk_idle/walk/attack/roar/run）+ 本脚本新做的 5 段
（dk_smash 重劈 / dk_tail 回旋 / dk_cast 引雷 / dk_death 倒地 /
dk_walk_loop 踱步）合并导出成 public/monsters/dk_anims.glb（无网格，只含动画，约 0.8MB）。

用法：
    "D:\\blender\\blender.exe" --background --factory-startup --python scripts/build-dk-anims.py

注意：
1. 必须在导入 glTF **之前**把 scene.render.fps 设成 30，否则 Blender 会按当前
   帧率换算时间轴，导出后时长整体变长/变短。
2. 剑骨（Bone_Sword_R_1）挂在 Root 下、与手骨平级。上传的 5 段动画自带正确的
   握持通道（斧头离掌心约 0.28m），但新做的 4 段没有，必须靠 attach_sword()
   把「手骨世界矩阵 × 握持偏移 GRIP」每帧套给剑骨，否则挥臂时斧头悬空飞出去。
3. 姿势角度用世界轴（X=右, Y=后, Z=上）描述，q_world() 负责换算到骨骼局部轴；
   四元数列表 [(X,a),(Y,b)] 表示 qX @ qY，即先绕 Y 再绕 X。
"""
import bpy
import math
from mathutils import Quaternion, Vector, Matrix

FPS = 30
ROOT = r'd:\3Dgame - 副本'
SRC = ROOT + r'\public\monsters\dk_idle.glb'
OUT = ROOT + r'\public\monsters\dk_anims.glb'
PREVIEW = ROOT + r'\.tmp_anim_preview'

bpy.ops.wm.read_factory_settings(use_empty=True)
# 先定帧率再导入：glTF 的时间轴会按当前场景帧率换算，统一 30fps 才不会把原片拉长
scene = bpy.context.scene
scene.render.fps = FPS
scene.frame_start = 1

bpy.ops.import_scene.gltf(filepath=SRC)
arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')

# 把其它几个动画包里的 action 也收进来（同一副 85 根骨架，action 可以共用），
# 导入完就删掉它们自带的骨架/网格，只留主骨架 + 全部 action
EXTRA_SRC = [
    ROOT + r'\public\monsters\dk_attack.glb',
    ROOT + r'\public\monsters\dk_roar.glb',
    ROOT + r'\public\monsters\dk_walk.glb',
    ROOT + r'\public\monsters\dk_run.glb',
]
for path in EXTRA_SRC:
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    for o in [o for o in bpy.data.objects if o not in before]:
        bpy.data.objects.remove(o, do_unlink=True)
for a in bpy.data.actions:
    a.use_fake_user = True

pose = arm.pose


def use_action(act):
    """Blender 5.1 的 slotted action：只赋 action 不绑 slot，姿态不会更新。"""
    if arm.animation_data is None:
        arm.animation_data_create()
    arm.animation_data.action = act
    slots = getattr(act, 'slots', None)
    if slots:
        arm.animation_data.action_slot = slots[0]


def grip_offset():
    """从上传的待机段取「剑骨相对右手骨」的固定变换。

    实测该偏移下斧头离掌心只有 0.28m（真正握在手里）；新做的动作若用
    静止姿态的偏移会偏出 0.8~1.0m，看起来就是“悬空挥砍”。
    """
    use_action(bpy.data.actions['Armature_Stand_full'])
    scene.frame_set(20)
    return pose.bones[H_R].matrix.inverted() @ pose.bones[SWORD].matrix.copy()


GRIP = None


def bone(name):
    return pose.bones[name]


def q_world(pb, axis, deg):
    """把世界轴（Blender Z-up：X=右, Y=后, Z=上）换算到该骨骼的局部轴再旋转"""
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


def new_action(name):
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    if arm.animation_data is None:
        arm.animation_data_create()
    arm.animation_data.action = act
    return act


X = (1, 0, 0)   # 左右轴：绕它转 = 前后仰俯 / 挥臂
Y = (0, 1, 0)   # 前后轴：绕它转 = 侧倾
Z = (0, 0, 1)   # 上下轴：绕它转 = 扭腰 / 横扫

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

# 握持偏移要在骨骼名常量定义之后再算（内部引用 H_R / SWORD）
GRIP = grip_offset()


def rest_all(frame):
    for name in ALL_ANIM_BONES:
        key(bone(name), frame, [])
    key_loc(bone(HIP), frame, (0, 0, 0))


def finish_range(end):
    scene.frame_end = end


def attach_sword(end):
    """武器骨每帧 = 右手世界矩阵 × 握持偏移 GRIP。

    上传动画各段的偏移几乎恒定（平移 0.35m、旋转 137°），直接复用它，
    斧头就会像待机/挥砍那样稳稳握在右手里；只改 location/rotation，
    剑骨的朝向不再是手工 key 出来的，而是跟着手腕走。
    """
    hand = pose.bones[H_R]
    sword = pose.bones[SWORD]
    sword.rotation_mode = 'QUATERNION'
    for f in range(1, end + 1):
        scene.frame_set(f)
        sword.matrix = hand.matrix @ GRIP
        sword.keyframe_insert('location', frame=f)
        sword.keyframe_insert('rotation_quaternion', frame=f)


def capture_pose(act_name, frame, names):
    """采样上传动画某帧的骨骼姿态，作为新动作的基准站姿（避免从 T-pose 起手）。"""
    use_action(bpy.data.actions[act_name])
    scene.frame_set(frame)
    out = {}
    for n in names:
        pb = pose.bones[n]
        out[n] = (pb.rotation_quaternion.copy(), pb.location.copy())
    return out


def key_rel(pb, frame, base, rots):
    """在基准四元数上叠加世界轴旋转，用于「在待机站姿上做走路的摆动」。"""
    q = base.copy()
    for axis, deg in rots:
        q = q @ q_world(pb, axis, deg)
    pb.rotation_mode = 'QUATERNION'
    pb.rotation_quaternion = q
    pb.keyframe_insert('rotation_quaternion', frame=frame)


# ---------- 1. dk_smash：双手举剑过头，蓄力后重劈 ----------
new_action('dk_smash')
rest_all(1)
# 蓄力：后仰、双臂上举、头抬起
key(bone(SPINE), 12, [(X, -16)])
key(bone(CHEST), 12, [(X, -12)])
key(bone(NECK), 12, [(X, -14)])
key(bone(HEAD), 12, [(X, -10)])
key(bone(S_R), 12, [(X, 24)])
key(bone(A_R), 12, [(X, 128), (Z, -18)])
key(bone(F_R), 12, [(X, -32)])
key(bone(H_R), 12, [(X, -18)])
key(bone(SWORD), 12, [(X, -20), (Y, 95)])
key(bone(S_L), 12, [(X, 18)])
key(bone(A_L), 12, [(X, 118), (Z, 16)])
key(bone(F_L), 12, [(X, -28)])
key(bone(JAW), 12, [(X, -12)])
# 顶点停顿
key(bone(SPINE), 20, [(X, -18)])
key(bone(CHEST), 20, [(X, -13)])
key(bone(A_R), 20, [(X, 134), (Z, -20)])
key(bone(A_L), 20, [(X, 124), (Z, 18)])
key(bone(SWORD), 20, [(X, -25), (Y, 100)])
# 重劈落点
key(bone(SPINE), 28, [(X, 26)])
key(bone(CHEST), 28, [(X, 16)])
key(bone(NECK), 28, [(X, 20)])
key(bone(HEAD), 28, [(X, 14)])
key(bone(S_R), 28, [(X, -8)])
key(bone(A_R), 28, [(X, -72), (Z, 8)])
key(bone(F_R), 28, [(X, 12)])
key(bone(H_R), 28, [(X, 16)])
# X 越大剑尖越往前下方压：115 时剑身基本指向前下，劈砍才有“剁下去”的感觉
key(bone(SWORD), 28, [(X, 115), (Y, 90)])
key(bone(S_L), 28, [(X, -6)])
key(bone(A_L), 28, [(X, -62), (Z, -6)])
key(bone(F_L), 28, [(X, 10)])
key(bone(HIP), 28, [(X, 8)])
key_loc(bone(HIP), 28, (0, 0, -0.22))
key(bone(JAW), 28, [(X, 8)])
# 收势
key(bone(SPINE), 38, [(X, 10)])
key(bone(A_R), 38, [(X, -18)])
key(bone(A_L), 38, [(X, -14)])
key(bone(SWORD), 38, [(X, 60), (Y, 40)])
key_loc(bone(HIP), 38, (0, 0, -0.05))
rest_all(56)
finish_range(56)
attach_sword(56)

# ---------- 2. dk_tail：扭腰横扫（剑尾一起甩） ----------
new_action('dk_tail')
rest_all(1)
key(bone(SPINE), 10, [(Z, 34), (X, -6)])
key(bone(CHEST), 10, [(Z, 20)])
key(bone(A_R), 10, [(Z, -42), (X, 10)])
key(bone(F_R), 10, [(Z, -20)])
key(bone(SWORD), 10, [(Z, -35), (X, -8)])
key(bone(A_L), 10, [(Z, 24)])
for i, t in enumerate(TAIL):
    key(bone(t), 10, [(Z, 26 + i * 8)])
# 横扫到另一侧
key(bone(SPINE), 22, [(Z, -46), (X, 6)])
key(bone(CHEST), 22, [(Z, -26)])
key(bone(A_R), 22, [(Z, 78), (X, -14)])
key(bone(F_R), 22, [(Z, 26)])
key(bone(H_R), 22, [(Z, 14)])
key(bone(SWORD), 22, [(Z, 65), (X, -10)])
key(bone(A_L), 22, [(Z, -34), (X, -10)])
for i, t in enumerate(TAIL):
    key(bone(t), 22, [(Z, -34 - i * 10)])
key(bone(HEAD), 22, [(Z, -22)])
# 余势
key(bone(SPINE), 32, [(Z, -52)])
key(bone(A_R), 32, [(Z, 88), (X, -16)])
key(bone(SWORD), 32, [(Z, 80), (X, -12)])
for i, t in enumerate(TAIL):
    key(bone(t), 32, [(Z, -40 - i * 10)])
rest_all(49)
finish_range(49)
attach_sword(49)

# ---------- 3. dk_cast：举剑引雷 ----------
new_action('dk_cast')
rest_all(1)
key(bone(SPINE), 12, [(X, -12), (Z, -10)])
key(bone(CHEST), 12, [(X, -8), (Z, -12)])
key(bone(S_R), 12, [(X, 32), (Z, -8)])
key(bone(A_R), 12, [(X, 150), (Y, -16)])
key(bone(F_R), 12, [(X, -16)])
key(bone(H_R), 12, [(X, -8)])
key(bone(SWORD), 12, [(X, -10), (Y, 95)])
key(bone(A_L), 12, [(X, 28), (Z, 18)])
key(bone(F_L), 12, [(X, -20)])
key(bone(NECK), 12, [(X, -22)])
key(bone(HEAD), 12, [(X, -26)])
key(bone(JAW), 12, [(X, -18)])
# 引雷定格 + 顶一下
key(bone(SPINE), 24, [(X, -14), (Z, -12)])
key(bone(A_R), 24, [(X, 156), (Y, -18)])
key(bone(SWORD), 24, [(X, -12), (Y, 100)])
key(bone(HEAD), 24, [(X, -30)])
key(bone(JAW), 24, [(X, -22)])
# 落雷瞬间下压
key(bone(SPINE), 32, [(X, 8)])
key(bone(A_R), 32, [(X, 70)])
key(bone(SWORD), 32, [(X, 15), (Y, 70)])
key(bone(NECK), 32, [(X, 12)])
key(bone(HEAD), 32, [(X, 10)])
key(bone(JAW), 32, [(X, 4)])
rest_all(46)
finish_range(46)
attach_sword(46)

# ---------- 4. dk_death：踉跄跪倒 ----------
new_action('dk_death')
rest_all(1)
key(bone(SPINE), 10, [(X, -26)])
key(bone(CHEST), 10, [(X, -16)])
key(bone(NECK), 10, [(X, -12)])
key(bone(HEAD), 10, [(X, -18)])
key(bone(A_R), 10, [(X, -28), (Z, -16)])
key(bone(A_L), 10, [(X, -24), (Z, 14)])
key(bone(SWORD), 10, [(X, -15), (Y, 35)])
key_loc(bone(HIP), 10, (0, 0, -0.15))
# 跪倒
key(bone(HIP), 24, [(X, 18)])
key_loc(bone(HIP), 24, (0, 0, -0.75))
key(bone(SPINE), 24, [(X, 34)])
key(bone(CHEST), 24, [(X, 22)])
key(bone(NECK), 24, [(X, 18)])
key(bone(HEAD), 24, [(X, 22)])
key(bone(THIGH_R), 24, [(X, -34)])
key(bone(THIGH_L), 24, [(X, -34)])
key(bone(CALF_R), 24, [(X, 52)])
key(bone(CALF_L), 24, [(X, 52)])
key(bone(A_R), 24, [(X, -46)])
key(bone(A_L), 24, [(X, -40)])
key(bone(SWORD), 24, [(X, 20), (Y, 10)])
# 扑倒
key(bone(HIP), 42, [(X, 42)])
key_loc(bone(HIP), 42, (0, 0, -1.35))
key(bone(SPINE), 42, [(X, 48)])
key(bone(CHEST), 42, [(X, 26)])
key(bone(NECK), 42, [(X, 20)])
key(bone(HEAD), 42, [(X, 26)])
key(bone(JAW), 42, [(X, 14)])
key(bone(THIGH_R), 42, [(X, -48)])
key(bone(THIGH_L), 42, [(X, -48)])
key(bone(CALF_R), 42, [(X, 68)])
key(bone(CALF_L), 42, [(X, 68)])
key(bone(A_R), 42, [(X, -30), (Z, -10)])
key(bone(A_L), 42, [(X, -28), (Z, 8)])
key(bone(SWORD), 42, [(X, 30), (Y, -70)])
# 最终姿势保持（clampWhenFinished）
rest_same = False
key(bone(HIP), 72, [(X, 44)])
key_loc(bone(HIP), 72, (0, 0, -1.4))
key(bone(SPINE), 72, [(X, 48)])
key(bone(HEAD), 72, [(X, 28)])
key(bone(A_R), 72, [(X, -30), (Z, -10)])
key(bone(A_L), 72, [(X, -28), (Z, 8)])
key(bone(SWORD), 72, [(X, 30), (Y, -70)])
finish_range(72)
attach_sword(72)

# ---------- 5. dk_walk_loop：踱步（48 帧无缝循环，30fps ≈ 1.6 秒） ----------
# 上传的 Armature_Stand Work_full 与 dk_run 是同一段数据（跑起来就没有走路感），
# 所以按同一副骨架另做一段慢速踱步：双腿交替、髋部起伏、手臂/尾巴轻摆。
# 基准姿态直接采自待机段，避免从 T-pose 起手导致手臂向两侧张开。
BASE = capture_pose('Armature_Stand_full', 20, [
    HIP, SPINE, CHEST, NECK, HEAD,
    S_R, A_R, F_R, H_R, S_L, A_L, F_L, H_L,
    THIGH_R, THIGH_L, CALF_R, CALF_L,
] + TAIL)

new_action('dk_walk_loop')


def walk_key(frame, thigh_l, calf_l, thigh_r, calf_r, hip_z, hip_roll, hip_twist,
             arm_l, arm_r, tail_sway):
    pb = bone
    key_rel(pb(THIGH_L), frame, BASE[THIGH_L][0], [(X, thigh_l)])
    key_rel(pb(CALF_L), frame, BASE[CALF_L][0], [(X, calf_l)])
    key_rel(pb(THIGH_R), frame, BASE[THIGH_R][0], [(X, thigh_r)])
    key_rel(pb(CALF_R), frame, BASE[CALF_R][0], [(X, calf_r)])
    key_rel(pb(HIP), frame, BASE[HIP][0], [(Y, hip_roll), (Z, hip_twist)])
    key_loc(pb(HIP), frame, (0, 0, hip_z))
    # 上半身反向扭一点，头再反扭回来，走路才有“迈步带肩”的感觉
    key_rel(pb(SPINE), frame, BASE[SPINE][0], [(X, -7), (Z, -hip_twist * 0.8)])
    key_rel(pb(CHEST), frame, BASE[CHEST][0], [(Z, -hip_twist * 0.45)])
    key_rel(pb(HEAD), frame, BASE[HEAD][0], [(Z, hip_twist * 0.35)])
    key_rel(pb(A_L), frame, BASE[A_L][0], [(X, arm_l)])
    key_rel(pb(F_L), frame, BASE[F_L][0], [(X, 10)])
    key_rel(pb(A_R), frame, BASE[A_R][0], [(X, arm_r)])
    for i, t in enumerate(TAIL):
        key_rel(pb(t), frame, BASE[t][0], [(Z, tail_sway * (0.6 + i * 0.35))])


# f1 / f49 左脚在前着地；f25 右脚在前着地；f13、f37 是过渡（支撑腿顶起髋部）
walk_key(1, -22, 6, 18, 26, -0.06, 4, 7, 12, -7, -12)
walk_key(13, -4, 8, -14, 42, 0.03, 1, 0, 2, 0, 0)
walk_key(25, 18, 26, -22, 6, -0.06, -4, -7, -12, 7, 12)
walk_key(37, -14, 42, -4, 8, 0.03, -1, 0, 2, 0, 0)
walk_key(49, -22, 6, 18, 26, -0.06, 4, 7, 12, -7, -12)
finish_range(49)
attach_sword(49)

# ---------- 导出 ----------
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

# ---------- 预览渲染 ----------
import os
os.makedirs(PREVIEW, exist_ok=True)
cam_data = bpy.data.cameras.new('preview_cam')
cam = bpy.data.objects.new('preview_cam', cam_data)
scene.collection.objects.link(cam)
cam.location = (8.5, -10.5, 5.2)
direction = Vector((0, 0, 2.1)) - cam.location
cam.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
scene.camera = cam
scene.render.engine = 'BLENDER_WORKBENCH'
scene.render.resolution_x = 560
scene.render.resolution_y = 560
scene.display.shading.light = 'STUDIO'
scene.display.shading.show_shadows = False
world = bpy.data.worlds.new('w') if not scene.world else scene.world
scene.world = world
world.color = (0.12, 0.14, 0.18)

shots = [
    ('dk_smash', [12, 28, 38]),
    ('dk_tail', [10, 22, 32]),
    ('dk_cast', [12, 24, 32]),
    ('dk_death', [10, 24, 42]),
    ('dk_walk_loop', [1, 13, 25, 37]),
    ('Armature_Attack_full', [18, 36]),
]
angles = {
    'side': (-10.5, -4.0, 4.4),
    'front': (0.0, -12.0, 4.0),
}
for tag, loc in angles.items():
    cam.location = loc
    cam.rotation_euler = (Vector((0, 0, 2.1)) - cam.location).to_track_quat('-Z', 'Y').to_euler()
    for act_name, frames in shots:
        use_action(bpy.data.actions[act_name])
        for f in frames:
            scene.frame_set(f)
            scene.render.filepath = os.path.join(PREVIEW, f'v2_{tag}_{act_name}_{f:03d}.png')
            bpy.ops.render.render(write_still=True)
            print('SHOT', tag, act_name, f)

print('DONE')

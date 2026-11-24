"""深渊传令官（abyss_herald）全套骨骼动画包生成器（Blender 无头模式）。

产出：public/monsters/ab_anims.glb
只含骨架 Object_9（157 骨）与 AnimationClip，无网格；Boss.js 会按 clip 名
合并进本体模型的 mixer，所以骨骼名必须与 abyss_herald.glb 完全一致。

用法：
    "D:\\blender\\blender.exe" --background --factory-startup --python scripts/build-herald-anims.py

关键约束（上一次交付错绑的教训）：
1. 每根骨骼名都从原始 GLB 的 Object_9 里取，脚本里写死全名，不靠“猜后缀”；
2. 每个 action 导出前校验 fcurve 的 data_path 都能在 arm.pose.bones 里找到；
3. 左右肢体显式镜像（世界轴 Y/Z 取反），不靠负缩放；
4. 每个 clip 的首尾都 key 一遍全部动画骨骼，避免三个 clip 之间串姿势；
5. 只按旋转 + 少量根位移，不写 scale 轨道，避免镜像骨被导出成单翼。

世界轴约定（Blender Z-up，模型正面朝 -Y）：
    X = 俯仰（正 = 身体前倾 / 抬臂向前）
    Y = 侧倾（右臂外展 +，左臂外展 -）
    Z = 扭转（正 = 正面转向 +X / 角色左侧）
"""
import bpy
import math
import os
from mathutils import Quaternion, Vector

FPS = 30
ROOT = r'd:\3Dgame - 副本'
MON = ROOT + r'\public\monsters'
SRC = MON + r'\abyss_herald.glb'
OUT = MON + r'\ab_anims.glb'

X = (1, 0, 0)
Y = (0, 1, 0)
Z = (0, 0, 1)

# 骨架内部单位与米不是 1:1：整副骨架只有约 12 单位高（游戏里归一化到 8.2m）。
# key_loc 的入参按“6.9m 生物的厘米数”写，这里统一换算成骨架单位，避免
# 冲锋/倒地直接把模型甩出半个场地。
LOC_SCALE = 0.015

# ---------------- 骨骼名（来自 Object_9 的 157 骨，全名写死） ----------------
ROOT_B = 'Root_M_011'
BACK_A = 'BackA_M_012'
BACK_B = 'BackB_M_013'
CHEST = 'Chest_M_014'
NECK = 'Neck_M_0724'
HEAD = 'Head_M_0725'
HAIR = 'Hair_M_0726'
JAW = 'Jaw_M_0727'

SCAP_R = 'Scapula_R_015'
SH_R = 'Shoulder_R_0697'
EL_R = 'Elbow_R_0698'
WR_R = 'Wrist_R_0702'
SCAP_L = 'Scapula_L_0765'
SH_L = 'Shoulder_L_0766'
EL_L = 'Elbow_L_0767'
WR_L = 'Wrist_L_0768'

HIP_R = 'Hip_R_0815'
KNEE_R = 'Knee_R_0816'
ANK_R = 'Ankle_R_0797'
TOE_R = 'MiddleToe1_R_0798'
HIP_L = 'Hip_L_0833'
KNEE_L = 'Knee_L_0834'
ANK_L = 'Ankle_L_0835'
TOE_L = 'MiddleToe1_L_0836'

# 左右对称的四组翼骨（joint41~50 只有右侧一根长链，可能是披风/尾饰，保持静止）
WING_MAIN_R = ['joint16_R_0730', 'joint17_R_0731', 'joint18_R_0732', 'joint19_R_0733']
WING_MAIN_L = ['joint16_L_0790', 'joint17_L_0791', 'joint18_L_0792', 'joint19_L_0793']
WING_FAN1_R = ['joint40_R_0734', 'joint35_R_0735', 'joint36_R_0736',
               'joint37_R_0717', 'joint38_R_0718', 'joint39_R_0719']
WING_FAN1_L = ['joint40_L_0794', 'joint35_L_0795', 'joint36_L_0796',
               'joint37_L_0777', 'joint38_L_0778', 'joint39_L_0779']
WING_FAN2_R = ['joint29_R_0740', 'joint30_R_0741', 'joint31_R_0742',
               'joint32_R_0743', 'joint33_R_0744', 'joint34_R_0745']
WING_FAN2_L = ['joint29_L_0800', 'joint30_L_0801', 'joint31_L_0802',
               'joint32_L_0803', 'joint33_L_0804', 'joint34_L_0805']
WING_FAN3_R = ['joint23_R_0746', 'joint24_R_0747', 'joint25_R_0748',
               'joint26_R_0749', 'joint27_R_0750', 'joint28_R_0751']
WING_FAN3_L = ['joint23_L_0806', 'joint24_L_0807', 'joint25_L_0808',
               'joint26_L_0809', 'joint27_L_0810', 'joint28_L_0811']
WING_TIP_R = ['joint22_R_0752', 'joint21_R_0753', 'joint20_R_0754']
WING_TIP_L = ['joint22_L_0812', 'joint21_L_0813', 'joint20_L_0814']

WING_R = WING_MAIN_R + WING_FAN1_R + WING_FAN2_R + WING_FAN3_R + WING_TIP_R
WING_L = WING_MAIN_L + WING_FAN1_L + WING_FAN2_L + WING_FAN3_L + WING_TIP_L

# 每个 clip 都必须在首尾 key 到的骨骼集合（否则 clip 之间会串姿势）
ALL_BONES = [
    ROOT_B, BACK_A, BACK_B, CHEST, NECK, HEAD, HAIR, JAW,
    SCAP_R, SH_R, EL_R, WR_R, SCAP_L, SH_L, EL_L, WR_L,
    HIP_R, KNEE_R, ANK_R, TOE_R, HIP_L, KNEE_L, ANK_L, TOE_L,
] + WING_R + WING_L


# ---------------- 通用工具 ----------------
def q_world(pb, axis, deg):
    """世界轴换算到该骨骼的局部轴再旋转"""
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
    pb.location = m.inverted() @ (Vector(world_vec) * LOC_SCALE)
    pb.keyframe_insert('location', frame=frame)


def fresh(src):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.fps = FPS
    scene.frame_start = 1
    bpy.ops.import_scene.gltf(filepath=src)
    # 这个 GLB 里有 Object_3(2 骨) 和 Object_9(157 骨)，必须取骨骼最多的那副
    arm = max((o for o in bpy.data.objects if o.type == 'ARMATURE'),
              key=lambda o: len(o.data.bones))
    print('USE ARMATURE', arm.name, len(arm.data.bones))
    return scene, arm


def drop_imported_actions():
    for a in list(bpy.data.actions):
        bpy.data.actions.remove(a)


def use_action(arm, act):
    if arm.animation_data is None:
        arm.animation_data_create()
    arm.animation_data.action = act
    slots = getattr(act, 'slots', None)
    if slots:
        arm.animation_data.action_slot = slots[0]


def new_action(arm, name):
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    use_action(arm, act)
    return act


def export_glb(arm, out):
    for o in bpy.data.objects:
        o.select_set(False)
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.export_scene.gltf(
        filepath=out,
        export_format='GLB',
        use_selection=True,
        export_animations=True,
        export_animation_mode='ACTIONS',
        # 不强制采样：只导出真正 key 过的 74 根骨骼，避免把 157 骨的
        # translation/scale 全烘一遍（那会把 3.5MB 撑到十几 MB，
        # 也容易把镜像骨的负缩放覆盖掉）。
        export_force_sampling=False,
        export_optimize_animation_size=False,
    )
    print('EXPORTED', out)


def action_fcurves(act):
    """Blender 5.x 的 Action 是分层结构，fcurve 在 channelbag 里；旧版直接有 .fcurves"""
    if hasattr(act, 'fcurves'):
        return list(act.fcurves)
    out = []
    for layer in getattr(act, 'layers', []):
        for strip in layer.strips:
            for bag in getattr(strip, 'channelbags', []):
                out.extend(bag.fcurves)
    return out


def validate(arm):
    """逐条 fcurve 核对骨骼通道，任何一根绑错都直接报错中止。"""
    bad = []
    for act in bpy.data.actions:
        names = set()
        for fc in action_fcurves(act):
            path = fc.data_path
            if not path.startswith('pose.bones["'):
                bad.append((act.name, path))
                continue
            name = path.split('"')[1]
            if name not in arm.pose.bones:
                bad.append((act.name, path))
                continue
            names.add(name)
        print('ACTION', act.name, 'frames', tuple(round(v, 1) for v in act.frame_range),
              'bones', len(names), 'fcurves', len(action_fcurves(act)))
        missing = [n for n in ALL_BONES if n not in names]
        if missing:
            bad.append((act.name, 'MISSING_BONES', missing))
    if bad:
        raise RuntimeError('BONE BIND CHECK FAILED: %s' % (bad[:12],))
    print('BIND CHECK OK: every fcurve maps to a real pose bone')


# ---------------- 姿势函数 ----------------
def rest(frame):
    for n in ALL_BONES:
        key(bone(n), frame, [])
    key_loc(bone(ROOT_B), frame, (0, 0, 0))


def spine(frame, pitch=0.0, yaw=0.0, roll=0.0, w=(0.30, 0.26, 0.28, 0.16)):
    """把俯仰/扭转分配到 BackA/BackB/Chest/Neck，最后一条给 Head 的底座"""
    key(bone(BACK_A), frame, [(X, pitch * w[0]), (Z, yaw * w[0]), (Y, roll * w[0])])
    key(bone(BACK_B), frame, [(X, pitch * w[1]), (Z, yaw * w[1]), (Y, roll * w[1])])
    key(bone(CHEST), frame, [(X, pitch * w[2]), (Z, yaw * w[2]), (Y, roll * w[2])])
    key(bone(NECK), frame, [(X, pitch * w[3]), (Z, yaw * w[3]), (Y, roll * w[3])])


def look(frame, pitch=0.0, yaw=0.0, roll=0.0):
    key(bone(HEAD), frame, [(X, pitch), (Z, yaw), (Y, roll)])
    key(bone(HAIR), frame, [(X, pitch * 0.35), (Z, yaw * 0.4)])


def jaw(frame, deg):
    # 下颌向前下方张开 = 世界 +X
    key(bone(JAW), frame, [(X, deg)])


def arms(frame, up_r=0.0, out_r=0.0, yaw_r=0.0, elbow_r=0.0, wrist_r=0.0,
         up_l=0.0, out_l=0.0, yaw_l=0.0, elbow_l=0.0, wrist_l=0.0):
    """手臂：up=向前上抬，out=向体侧展开（右 +Y / 左 -Y），yaw=横扫（右 +Z / 左 -Z）"""
    key(bone(SCAP_R), frame, [(Y, out_r * 0.18), (Z, yaw_r * 0.12)])
    key(bone(SH_R), frame, [(X, -up_r), (Y, out_r), (Z, yaw_r)])
    key(bone(EL_R), frame, [(X, -elbow_r)])
    key(bone(WR_R), frame, [(X, -wrist_r)])
    key(bone(SCAP_L), frame, [(Y, -out_l * 0.18), (Z, -yaw_l * 0.12)])
    key(bone(SH_L), frame, [(X, -up_l), (Y, -out_l), (Z, -yaw_l)])
    key(bone(EL_L), frame, [(X, -elbow_l)])
    key(bone(WR_L), frame, [(X, -wrist_l)])


def legs(frame, step_r=0.0, step_l=0.0, knee_r=0.0, knee_l=0.0,
         out_r=0.0, out_l=0.0, ankle_r=0.0, ankle_l=0.0):
    """腿：step>0 向前迈；knee>0 小腿后弯；out>0 向外撇（右 +Y / 左 -Y）"""
    key(bone(HIP_R), frame, [(X, -step_r), (Y, out_r)])
    key(bone(KNEE_R), frame, [(X, knee_r)])
    key(bone(ANK_R), frame, [(X, -ankle_r)])
    key(bone(HIP_L), frame, [(X, -step_l), (Y, -out_l)])
    key(bone(KNEE_L), frame, [(X, knee_l)])
    key(bone(ANK_L), frame, [(X, -ankle_l)])


def wings(frame, spread=0.0, lift=0.0, sway=0.0):
    """翼：spread>0 向外张开，lift>0 向上抬，sway>0 向 +Y 后摆。
    每条骨按递减权重分担角度（沿骨链累加），避免末端甩成麻花。"""
    wmain = (0.38, 0.30, 0.24, 0.18)
    wfan = (0.22, 0.19, 0.16, 0.13, 0.11, 0.09)
    wtip = (0.4, 0.3, 0.3)
    for i, n in enumerate(WING_MAIN_R):
        key(bone(n), frame, [(Z, spread * wmain[i]), (Y, lift * wmain[i]), (X, sway * wmain[i])])
    for i, n in enumerate(WING_MAIN_L):
        key(bone(n), frame, [(Z, -spread * wmain[i]), (Y, -lift * wmain[i]), (X, sway * wmain[i])])
    for chain_r, chain_l in ((WING_FAN1_R, WING_FAN1_L), (WING_FAN2_R, WING_FAN2_L),
                             (WING_FAN3_R, WING_FAN3_L)):
        for i, n in enumerate(chain_r):
            key(bone(n), frame, [(Z, spread * wfan[i] * 0.9), (Y, lift * wfan[i]), (X, sway * wfan[i])])
        for i, n in enumerate(chain_l):
            key(bone(n), frame, [(Z, -spread * wfan[i] * 0.9), (Y, -lift * wfan[i]), (X, sway * wfan[i])])
    for i, n in enumerate(WING_TIP_R):
        key(bone(n), frame, [(Z, spread * wtip[i] * 0.7), (Y, lift * wtip[i])])
    for i, n in enumerate(WING_TIP_L):
        key(bone(n), frame, [(Z, -spread * wtip[i] * 0.7), (Y, -lift * wtip[i])])


# ---------------- 各 clip ----------------
def build(arm):
    global bone
    bones = arm.pose.bones
    bone = bones.__getitem__
    scene = bpy.context.scene

    # ============ ab_idle：3 秒呼吸循环 ============
    new_action(arm, 'ab_idle')
    rest(1)
    spine(1); look(1); jaw(1, 0); arms(1); legs(1); wings(1)
    key_loc(bone(ROOT_B), 1, (0, 0, 0))
    for f, ph in ((12, 1), (23, 0), (34, -1), (46, 0), (58, 1), (69, 0), (80, -1), (91, 0)):
        spine(f, pitch=1.4 * ph, yaw=1.2 * ph, roll=0.8 * ph)
        look(f, pitch=-1.0 * ph, yaw=-2.2 * ph)
        wings(f, spread=2.5 + 1.5 * ph, lift=3.0 + 2.0 * ph)
        key_loc(bone(ROOT_B), f, (0, 0, 2.5 + 5.0 * ph))
        arms(f, up_r=1.5 * ph, out_r=1.5 + ph, up_l=1.5 * ph, out_l=1.5 + ph)
        jaw(f, 0)
    rest(91)

    # ============ ab_move：1.33 秒两步循环 ============
    new_action(arm, 'ab_move')
    rest(1)
    # f1 右脚在前
    legs(1, step_r=24, step_l=-18, knee_r=10, knee_l=30, ankle_r=-6, ankle_l=10)
    spine(1, pitch=5, yaw=-4)
    look(1, yaw=4)
    arms(1, up_r=-8, out_r=4, up_l=10, out_l=6)
    wings(1, spread=3, lift=6, sway=-4)
    key_loc(bone(ROOT_B), 1, (0, 0, 0))
    # f11 换步中间
    legs(11, step_r=2, step_l=2, knee_r=22, knee_l=22)
    spine(11, pitch=6, yaw=0)
    arms(11, up_r=0, out_r=4, up_l=0, out_l=4)
    wings(11, spread=3, lift=9, sway=0)
    key_loc(bone(ROOT_B), 11, (0, 0, 22))
    # f21 左脚在前
    legs(21, step_r=-18, step_l=24, knee_r=30, knee_l=10, ankle_r=-10, ankle_l=6)
    spine(21, pitch=5, yaw=4)
    look(21, yaw=-4)
    arms(21, up_r=10, out_r=6, up_l=-8, out_l=4)
    wings(21, spread=3, lift=6, sway=4)
    key_loc(bone(ROOT_B), 21, (0, 0, 0))
    legs(31, step_r=2, step_l=2, knee_r=22, knee_l=22)
    spine(31, pitch=6, yaw=0)
    arms(31, up_r=0, out_r=4, up_l=0, out_l=4)
    wings(31, spread=3, lift=9, sway=0)
    key_loc(bone(ROOT_B), 31, (0, 0, 22))
    legs(41, step_r=24, step_l=-18, knee_r=10, knee_l=30, ankle_r=-6, ankle_l=10)
    spine(41, pitch=5, yaw=-4)
    look(41, yaw=4)
    arms(41, up_r=-8, out_r=4, up_l=10, out_l=6)
    wings(41, spread=3, lift=6, sway=-4)
    key_loc(bone(ROOT_B), 41, (0, 0, 0))

    # ============ ab_run：0.8 秒冲刺循环 ============
    new_action(arm, 'ab_run')
    rest(1)
    legs(1, step_r=36, step_l=-30, knee_r=16, knee_l=52, ankle_r=-10, ankle_l=16)
    spine(1, pitch=14, yaw=-6)
    look(1, pitch=-6)
    arms(1, up_r=-20, out_r=8, elbow_r=6, up_l=26, out_l=10, elbow_l=18)
    wings(1, spread=-4, lift=14, sway=-10)
    key_loc(bone(ROOT_B), 1, (0, 0, -14))
    legs(7, step_r=4, step_l=4, knee_r=34, knee_l=34)
    spine(7, pitch=16, yaw=0)
    arms(7, up_r=0, out_r=8, up_l=0, out_l=8)
    wings(7, spread=-2, lift=20, sway=0)
    key_loc(bone(ROOT_B), 7, (0, 0, 40))
    legs(13, step_r=-30, step_l=36, knee_r=52, knee_l=16, ankle_r=-16, ankle_l=10)
    spine(13, pitch=14, yaw=6)
    look(13, pitch=-6)
    arms(13, up_r=26, out_r=10, elbow_r=18, up_l=-20, out_l=8, elbow_l=6)
    wings(13, spread=-4, lift=14, sway=10)
    key_loc(bone(ROOT_B), 13, (0, 0, -14))
    legs(19, step_r=4, step_l=4, knee_r=34, knee_l=34)
    spine(19, pitch=16, yaw=0)
    arms(19, up_r=0, out_r=8, up_l=0, out_l=8)
    wings(19, spread=-2, lift=20, sway=0)
    key_loc(bone(ROOT_B), 19, (0, 0, 40))
    legs(25, step_r=36, step_l=-30, knee_r=16, knee_l=52, ankle_r=-10, ankle_l=16)
    spine(25, pitch=14, yaw=-6)
    look(25, pitch=-6)
    arms(25, up_r=-20, out_r=8, elbow_r=6, up_l=26, out_l=10, elbow_l=18)
    wings(25, spread=-4, lift=14, sway=-10)
    key_loc(bone(ROOT_B), 25, (0, 0, -14))

    # ============ ab_attack：右爪横扫（1.2 秒） ============
    new_action(arm, 'ab_attack')
    rest(1)
    arms(1); legs(1); wings(1); spine(1); look(1); jaw(1, 0)
    # 蓄力：右臂抬到侧上方、身体右转
    spine(8, pitch=-4, yaw=-20)
    look(8, yaw=-16)
    arms(8, up_r=72, out_r=34, yaw_r=-26, elbow_r=24, up_l=14, out_l=18)
    wings(8, spread=10, lift=16)
    jaw(8, 6)
    key_loc(bone(ROOT_B), 8, (0, 0, 6))
    spine(13, pitch=-6, yaw=-24)
    arms(13, up_r=80, out_r=38, yaw_r=-30, elbow_r=28, up_l=16, out_l=18)
    wings(13, spread=12, lift=20)
    key_loc(bone(ROOT_B), 13, (0, 0, 8))
    # 挥出：从右上扫到左下
    spine(20, pitch=12, yaw=24)
    look(20, yaw=18, pitch=4)
    arms(20, up_r=34, out_r=-4, yaw_r=44, elbow_r=-8, wrist_r=-10,
         up_l=-10, out_l=10, yaw_l=-14)
    wings(20, spread=-6, lift=4, sway=8)
    jaw(20, 16)
    key_loc(bone(ROOT_B), 20, (0, 0, -10))
    # 收势
    spine(27, pitch=6, yaw=8)
    look(27, yaw=6)
    arms(27, up_r=10, out_r=6, yaw_r=10, elbow_r=6, up_l=2, out_l=6)
    wings(27, spread=2, lift=6)
    jaw(27, 6)
    key_loc(bone(ROOT_B), 27, (0, 0, 0))
    rest(37)

    # ============ ab_lunge：冲锋突进（46 帧） ============
    new_action(arm, 'ab_lunge')
    rest(1)
    # 下蹲蓄力
    spine(10, pitch=20)
    look(10, pitch=-10)
    legs(10, step_r=18, step_l=8, knee_r=46, knee_l=38, out_r=6, out_l=6)
    arms(10, up_r=-26, out_r=10, elbow_r=20, up_l=-26, out_l=10, elbow_l=20)
    wings(10, spread=-12, lift=-10)
    key_loc(bone(ROOT_B), 10, (0, 24, -52))
    spine(16, pitch=22)
    key_loc(bone(ROOT_B), 16, (0, 30, -58))
    # 前扑：根节点整体前移 1.1m，双爪前伸
    spine(24, pitch=26)
    look(24, pitch=8)
    legs(24, step_r=30, step_l=-26, knee_r=18, knee_l=44)
    arms(24, up_r=54, out_r=26, yaw_r=8, elbow_r=-14,
         up_l=48, out_l=24, yaw_l=-8, elbow_l=-12)
    wings(24, spread=16, lift=10, sway=14)
    jaw(24, 20)
    key_loc(bone(ROOT_B), 24, (0, -108, 6))
    # 落地缓冲
    spine(33, pitch=12)
    legs(33, step_r=12, step_l=-8, knee_r=30, knee_l=34)
    arms(33, up_r=20, out_r=16, elbow_r=10, up_l=18, out_l=14, elbow_l=10)
    wings(33, spread=6, lift=6)
    key_loc(bone(ROOT_B), 33, (0, -46, -18))
    rest(46)

    # ============ ab_sweep：拧身横扫（44 帧） ============
    new_action(arm, 'ab_sweep')
    rest(1)
    spine(10, pitch=-2, yaw=-34)
    look(10, yaw=-24)
    arms(10, up_r=64, out_r=54, yaw_r=-20, elbow_r=6, up_l=20, out_l=26)
    wings(10, spread=18, lift=18, sway=-8)
    key_loc(bone(ROOT_B), 10, (0, 0, 4))
    # 定格到结算
    spine(18, pitch=-2, yaw=-38)
    arms(18, up_r=68, out_r=58, yaw_r=-24, elbow_r=6, up_l=22, out_l=28)
    wings(18, spread=22, lift=22, sway=-10)
    # 扫到另一侧
    spine(28, pitch=8, yaw=38)
    look(28, yaw=26)
    arms(28, up_r=58, out_r=46, yaw_r=46, elbow_r=-6, wrist_r=-8,
         up_l=10, out_l=14, yaw_l=-16)
    wings(28, spread=-4, lift=8, sway=12)
    jaw(28, 14)
    key_loc(bone(ROOT_B), 28, (0, 0, -6))
    spine(36, pitch=4, yaw=14)
    arms(36, up_r=20, out_r=22, yaw_r=12, elbow_r=6, up_l=6, out_l=10)
    wings(36, spread=4, lift=8)
    rest(44)

    # ============ ab_slam：双拳砸海（50 帧） ============
    new_action(arm, 'ab_slam')
    rest(1)
    # 举臂过头
    spine(14, pitch=-16)
    look(14, pitch=-16)
    arms(14, up_r=152, out_r=16, elbow_r=-10, up_l=150, out_l=16, elbow_l=-10)
    wings(14, spread=26, lift=34)
    legs(14, step_r=-6, step_l=-6, knee_r=12, knee_l=12)
    key_loc(bone(ROOT_B), 14, (0, 0, 26))
    spine(21, pitch=-18)
    arms(21, up_r=158, out_r=18, elbow_r=-12, up_l=156, out_l=18, elbow_l=-12)
    wings(21, spread=30, lift=40)
    key_loc(bone(ROOT_B), 21, (0, 0, 30))
    # 砸下
    spine(30, pitch=34)
    look(30, pitch=16)
    arms(30, up_r=26, out_r=8, elbow_r=-6, wrist_r=8,
         up_l=24, out_l=8, elbow_l=-6, wrist_l=8)
    wings(30, spread=-14, lift=-6, sway=16)
    legs(30, step_r=16, step_l=16, knee_r=52, knee_l=52, out_r=6, out_l=6)
    jaw(30, 24)
    key_loc(bone(ROOT_B), 30, (0, 0, -90))
    # 收势
    spine(38, pitch=16)
    arms(38, up_r=10, out_r=6, elbow_r=6, up_l=10, out_l=6, elbow_l=6)
    wings(38, spread=-4, lift=2)
    legs(38, step_r=6, step_l=6, knee_r=24, knee_l=24)
    jaw(38, 8)
    key_loc(bone(ROOT_B), 38, (0, 0, -26))
    rest(50)

    # ============ ab_roar：仰天咆哮（50 帧） ============
    new_action(arm, 'ab_roar')
    rest(1)
    # 先压身蓄气
    spine(9, pitch=14)
    look(9, pitch=10)
    arms(9, up_r=-10, out_r=6, elbow_r=14, up_l=-10, out_l=6, elbow_l=14)
    wings(9, spread=-14, lift=-12)
    legs(9, knee_r=24, knee_l=24)
    key_loc(bone(ROOT_B), 9, (0, 0, -26))
    # 爆发：后仰、张口、六翼展开
    spine(18, pitch=-20)
    look(18, pitch=-28)
    jaw(18, 38)
    arms(18, up_r=24, out_r=64, yaw_r=-10, elbow_r=16,
         up_l=24, out_l=64, yaw_l=-10, elbow_l=16)
    wings(18, spread=48, lift=42)
    legs(18, step_r=6, step_l=6, knee_r=10, knee_l=10, out_r=4, out_l=4)
    key_loc(bone(ROOT_B), 18, (0, 0, 22))
    spine(24, pitch=-24, roll=3)
    look(24, pitch=-32, yaw=6)
    jaw(24, 42)
    wings(24, spread=54, lift=48)
    key_loc(bone(ROOT_B), 24, (0, 0, 26))
    spine(29, pitch=-21, roll=-3)
    look(29, pitch=-30, yaw=-6)
    jaw(29, 36)
    wings(29, spread=50, lift=44)
    key_loc(bone(ROOT_B), 29, (0, 0, 22))
    # 收
    spine(38, pitch=-6)
    look(38, pitch=-8)
    jaw(38, 12)
    arms(38, up_r=12, out_r=24, up_l=12, out_l=24)
    wings(38, spread=18, lift=18)
    legs(38, knee_r=8, knee_l=8)
    key_loc(bone(ROOT_B), 38, (0, 0, 6))
    rest(50)

    # ============ ab_cast：单手掌心前推（44 帧） ============
    new_action(arm, 'ab_cast')
    rest(1)
    spine(10, pitch=4, yaw=-10)
    look(10, yaw=-6)
    arms(10, up_r=28, out_r=16, elbow_r=46, up_l=6, out_l=10)
    wings(10, spread=6, lift=10)
    key_loc(bone(ROOT_B), 10, (0, 0, 2))
    # 推出
    spine(20, pitch=10, yaw=-18)
    look(20, yaw=-10, pitch=2)
    arms(20, up_r=84, out_r=8, yaw_r=-6, elbow_r=-10, wrist_r=-14,
         up_l=-8, out_l=22, yaw_l=10)
    wings(20, spread=12, lift=16, sway=6)
    jaw(20, 10)
    key_loc(bone(ROOT_B), 20, (0, -18, 4))
    # 保持到结算
    spine(30, pitch=10, yaw=-18)
    arms(30, up_r=86, out_r=8, yaw_r=-6, elbow_r=-12, wrist_r=-16,
         up_l=-8, out_l=22, yaw_l=10)
    wings(30, spread=14, lift=18, sway=6)
    spine(38, pitch=4, yaw=-6)
    arms(38, up_r=26, out_r=8, elbow_r=10, up_l=0, out_l=8)
    wings(38, spread=4, lift=8)
    rest(44)

    # ============ ab_sword_cast：双手举剑下劈（56 帧） ============
    new_action(arm, 'ab_sword_cast')
    rest(1)
    # 举剑过头、后仰
    spine(14, pitch=-18)
    look(14, pitch=-20)
    arms(14, up_r=148, out_r=22, elbow_r=-8, up_l=146, out_l=22, elbow_l=-8)
    wings(14, spread=20, lift=30)
    legs(14, step_r=-4, step_l=-4, knee_r=10, knee_l=10)
    key_loc(bone(ROOT_B), 14, (0, 0, 22))
    spine(24, pitch=-22)
    look(24, pitch=-24)
    jaw(24, 14)
    arms(24, up_r=154, out_r=24, elbow_r=-10, up_l=152, out_l=24, elbow_l=-10)
    wings(24, spread=24, lift=34)
    key_loc(bone(ROOT_B), 24, (0, 0, 26))
    # 下劈
    spine(36, pitch=30)
    look(36, pitch=14)
    arms(36, up_r=38, out_r=6, elbow_r=-4, wrist_r=6,
         up_l=36, out_l=6, elbow_l=-4, wrist_l=6)
    wings(36, spread=-10, lift=-4, sway=14)
    legs(36, step_r=12, step_l=12, knee_r=40, knee_l=40)
    jaw(36, 20)
    key_loc(bone(ROOT_B), 36, (0, -12, -52))
    # 收
    spine(46, pitch=12)
    arms(46, up_r=14, out_r=8, elbow_r=6, up_l=14, out_l=8, elbow_l=6)
    wings(46, spread=-2, lift=4)
    legs(46, step_r=4, step_l=4, knee_r=18, knee_l=18)
    jaw(46, 6)
    key_loc(bone(ROOT_B), 46, (0, 0, -10))
    rest(56)

    # ============ ab_summon：张臂开门（54 帧） ============
    new_action(arm, 'ab_summon')
    rest(1)
    spine(12, pitch=-8)
    arms(12, up_r=16, out_r=54, elbow_r=18, up_l=16, out_l=54, elbow_l=18)
    wings(12, spread=30, lift=30)
    look(12, pitch=-12)
    key_loc(bone(ROOT_B), 12, (0, 0, 14))
    # 全开
    spine(24, pitch=-14)
    look(24, pitch=-22)
    jaw(24, 22)
    arms(24, up_r=34, out_r=74, yaw_r=-8, elbow_r=8,
         up_l=34, out_l=74, yaw_l=-8, elbow_l=8)
    wings(24, spread=56, lift=46)
    legs(24, step_r=6, step_l=6, out_r=8, out_l=8)
    key_loc(bone(ROOT_B), 24, (0, 0, 28))
    # 向前推门
    spine(34, pitch=10)
    look(34, pitch=6)
    jaw(34, 12)
    arms(34, up_r=60, out_r=40, elbow_r=-6, up_l=60, out_l=40, elbow_l=-6)
    wings(34, spread=26, lift=22, sway=12)
    key_loc(bone(ROOT_B), 34, (0, -22, 8))
    spine(42, pitch=4)
    arms(42, up_r=28, out_r=24, elbow_r=6, up_l=28, out_l=24, elbow_l=6)
    wings(42, spread=10, lift=10)
    rest(54)

    # ============ ab_enrage：二阶段爆翼（46 帧） ============
    new_action(arm, 'ab_enrage')
    rest(1)
    # 蹲身收翼
    spine(8, pitch=18)
    look(8, pitch=12)
    arms(8, up_r=-16, out_r=8, elbow_r=26, up_l=-16, out_l=8, elbow_l=26)
    wings(8, spread=-24, lift=-18)
    legs(8, knee_r=38, knee_l=38)
    key_loc(bone(ROOT_B), 8, (0, 0, -44))
    # 爆开
    spine(17, pitch=-22)
    look(17, pitch=-30)
    jaw(17, 40)
    arms(17, up_r=30, out_r=70, yaw_r=-14, elbow_r=14,
         up_l=30, out_l=70, yaw_l=-14, elbow_l=14)
    wings(17, spread=58, lift=50)
    legs(17, step_r=8, step_l=8, out_r=6, out_l=6)
    key_loc(bone(ROOT_B), 17, (0, 0, 30))
    # 震颤
    spine(22, pitch=-24, roll=3)
    look(22, pitch=-32, yaw=7)
    wings(22, spread=62, lift=54)
    key_loc(bone(ROOT_B), 22, (0, 0, 34))
    spine(27, pitch=-20, roll=-3)
    look(27, pitch=-28, yaw=-7)
    wings(27, spread=56, lift=48)
    key_loc(bone(ROOT_B), 27, (0, 0, 28))
    # 稳住
    spine(36, pitch=-4)
    look(36, pitch=-6)
    jaw(36, 10)
    arms(36, up_r=12, out_r=30, up_l=12, out_l=30)
    wings(36, spread=24, lift=22)
    key_loc(bone(ROOT_B), 36, (0, 0, 8))
    rest(46)

    # ============ ab_hurt：受击后仰（20 帧） ============
    new_action(arm, 'ab_hurt')
    rest(1)
    spine(5, pitch=-14, yaw=4)
    look(5, pitch=-16, yaw=6)
    arms(5, up_r=18, out_r=26, elbow_r=16, up_l=12, out_l=20)
    wings(5, spread=10, lift=12)
    key_loc(bone(ROOT_B), 5, (0, 14, 4))
    spine(10, pitch=-18)
    look(10, pitch=-20)
    arms(10, up_r=24, out_r=30, elbow_r=20, up_l=18, out_l=24)
    wings(10, spread=14, lift=16)
    key_loc(bone(ROOT_B), 10, (0, 18, 2))
    spine(16, pitch=-6)
    look(16, pitch=-6)
    arms(16, up_r=8, out_r=12, elbow_r=8, up_l=6, out_l=10)
    wings(16, spread=4, lift=6)
    key_loc(bone(ROOT_B), 16, (0, 4, 0))
    rest(20)

    # ============ ab_death：跪倒 → 前扑趴地（60 帧，结束时保持趴地） ============
    new_action(arm, 'ab_death')
    rest(1)
    spine(10, pitch=18)
    look(10, pitch=14)
    legs(10, knee_r=26, knee_l=26)
    key_loc(bone(ROOT_B), 10, (0, 0, -40))
    # 跪倒：重心下沉、双膝折起
    spine(22, pitch=40)
    look(22, pitch=26)
    arms(22, up_r=6, out_r=22, elbow_r=18, up_l=6, out_l=22, elbow_l=18)
    legs(22, step_r=-10, step_l=-8, knee_r=96, knee_l=88, out_r=8, out_l=8)
    wings(22, spread=-16, lift=-22)
    jaw(22, 16)
    key_loc(bone(ROOT_B), 22, (0, 10, -170))
    # 前扑倒地：上身压低、双臂前伸撑地
    spine(38, pitch=70)
    look(38, pitch=30)
    arms(38, up_r=58, out_r=26, elbow_r=-22, wrist_r=8,
         up_l=58, out_l=26, elbow_l=-22, wrist_l=8)
    legs(38, step_r=-20, step_l=-16, knee_r=92, knee_l=86, out_r=10, out_l=10)
    wings(38, spread=-30, lift=-40, sway=10)
    jaw(38, 22)
    key_loc(bone(ROOT_B), 38, (0, -58, -280))
    # 趴伏（保持到结束，与死亡停帧衔接）
    spine(48, pitch=84)
    look(48, pitch=16)
    arms(48, up_r=52, out_r=34, elbow_r=-28, wrist_r=6,
         up_l=52, out_l=34, elbow_l=-28, wrist_l=6)
    legs(48, step_r=-26, step_l=-20, knee_r=96, knee_l=90, out_r=10, out_l=10)
    wings(48, spread=-34, lift=-46, sway=8)
    jaw(48, 12)
    key_loc(bone(ROOT_B), 48, (0, -66, -330))
    spine(60, pitch=84)
    look(60, pitch=16)
    arms(60, up_r=52, out_r=34, elbow_r=-28, wrist_r=6,
         up_l=52, out_l=34, elbow_l=-28, wrist_l=6)
    legs(60, step_r=-26, step_l=-20, knee_r=96, knee_l=90, out_r=10, out_l=10)
    wings(60, spread=-34, lift=-46, sway=8)
    jaw(60, 10)
    key_loc(bone(ROOT_B), 60, (0, -66, -330))

    # ============ ab_stagger：单膝跪地（40 帧） ============
    new_action(arm, 'ab_stagger')
    rest(1)
    spine(8, pitch=16)
    look(8, pitch=12)
    legs(8, knee_r=40, knee_l=26)
    key_loc(bone(ROOT_B), 8, (0, 0, -60))
    # 右膝着地、左腿半跪（左脚掌仍踩地，所以左膝要更深地折起）
    spine(16, pitch=38, yaw=-8)
    look(16, pitch=24, yaw=-6)
    arms(16, up_r=-14, out_r=14, elbow_r=24, up_l=-10, out_l=12, elbow_l=18)
    legs(16, step_r=-16, step_l=44, knee_r=100, knee_l=95, out_r=8, out_l=6)
    wings(16, spread=-20, lift=-24)
    jaw(16, 10)
    key_loc(bone(ROOT_B), 16, (0, 6, -200))
    # 定格 1 秒（对应 bosses.js 的 staggerHold: 1.05）
    spine(28, pitch=39, yaw=-8)
    look(28, pitch=25, yaw=-6)
    arms(28, up_r=-14, out_r=14, elbow_r=24, up_l=-10, out_l=12, elbow_l=18)
    legs(28, step_r=-16, step_l=44, knee_r=100, knee_l=95, out_r=8, out_l=6)
    wings(28, spread=-20, lift=-24)
    jaw(28, 10)
    key_loc(bone(ROOT_B), 28, (0, 6, -200))
    # 站起
    spine(36, pitch=8)
    look(36, pitch=4)
    legs(36, knee_r=18, knee_l=12)
    arms(36, up_r=4, out_r=6, elbow_r=6, up_l=4, out_l=6, elbow_l=6)
    wings(36, spread=-2, lift=-2)
    key_loc(bone(ROOT_B), 36, (0, 0, -26))
    rest(40)

    # ============ ab_blink_cast：瞬移前摇（30 帧，结束时保持蹲姿） ============
    new_action(arm, 'ab_blink_cast')
    rest(1)
    spine(8, pitch=16, yaw=-12)
    look(8, pitch=8, yaw=-10)
    arms(8, up_r=24, out_r=12, elbow_r=42, up_l=18, out_l=10, elbow_l=34)
    wings(8, spread=-22, lift=-20)
    legs(8, step_r=-8, step_l=-8, knee_r=30, knee_l=30)
    key_loc(bone(ROOT_B), 8, (0, 0, -60))
    spine(18, pitch=24, yaw=-18)
    look(18, pitch=12, yaw=-14)
    arms(18, up_r=34, out_r=16, elbow_r=54, up_l=26, out_l=14, elbow_l=46)
    wings(18, spread=-30, lift=-28)
    legs(18, step_r=-12, step_l=-12, knee_r=40, knee_l=40)
    key_loc(bone(ROOT_B), 18, (0, 6, -110))
    spine(30, pitch=24, yaw=-18)
    look(30, pitch=12, yaw=-14)
    arms(30, up_r=34, out_r=16, elbow_r=54, up_l=26, out_l=14, elbow_l=46)
    wings(30, spread=-30, lift=-28)
    legs(30, step_r=-12, step_l=-12, knee_r=40, knee_l=40)
    key_loc(bone(ROOT_B), 30, (0, 6, -110))

    # ============ ab_blink_slash：瞬移落点横斩（36 帧） ============
    new_action(arm, 'ab_blink_slash')
    rest(1)
    spine(1, pitch=20, yaw=-14)
    look(1, pitch=10, yaw=-10)
    arms(1, up_r=30, out_r=14, elbow_r=48, up_l=24, out_l=12, elbow_l=40)
    wings(1, spread=-24, lift=-24)
    legs(1, step_r=-10, step_l=-10, knee_r=36, knee_l=36)
    key_loc(bone(ROOT_B), 1, (0, 4, -46))
    # 爆起挥斩
    spine(9, pitch=6, yaw=30)
    look(9, yaw=22)
    arms(9, up_r=74, out_r=30, yaw_r=54, elbow_r=2, wrist_r=-8,
         up_l=-14, out_l=18, yaw_l=-18)
    wings(9, spread=34, lift=26, sway=10)
    jaw(9, 14)
    legs(9, step_r=18, step_l=-14, knee_r=16, knee_l=34)
    key_loc(bone(ROOT_B), 9, (0, -62, 8))
    # 收势
    spine(18, pitch=10, yaw=16)
    look(18, yaw=12)
    arms(18, up_r=34, out_r=18, yaw_r=24, elbow_r=8, up_l=-6, out_l=10)
    wings(18, spread=12, lift=12)
    legs(18, step_r=6, step_l=-4, knee_r=14, knee_l=18)
    key_loc(bone(ROOT_B), 18, (0, -20, -6))
    spine(26, pitch=4, yaw=4)
    arms(26, up_r=12, out_r=8, yaw_r=6, up_l=0, out_l=6)
    wings(26, spread=4, lift=6)
    key_loc(bone(ROOT_B), 26, (0, -4, 0))
    rest(36)

    scene.frame_end = 91


def render_previews(arm, outdir):
    """离线渲染几张关键姿势，用来目检骨骼绑定/左右镜像是否正确（开发调试用）"""
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = 10
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 400
    scene.render.resolution_y = 400
    scene.render.resolution_percentage = 100
    scene.view_settings.view_transform = 'Standard'
    scene.render.film_transparent = False
    world = bpy.data.worlds.new('PreviewWorld')
    scene.world = world
    world.use_nodes = True
    world.node_tree.nodes['Background'].inputs[0].default_value = (0.11, 0.13, 0.16, 1)
    world.node_tree.nodes['Background'].inputs[1].default_value = 1.0

    cam_data = bpy.data.cameras.new('PreviewCam')
    cam_data.lens = 62
    cam = bpy.data.objects.new('PreviewCam', cam_data)
    scene.collection.objects.link(cam)
    cam.location = (7.6, -13.2, 5.6)
    look_dir = Vector((0, 0, 3.5)) - cam.location
    cam.rotation_euler = look_dir.to_track_quat('-Z', 'Y').to_euler()
    scene.camera = cam

    sun_data = bpy.data.lights.new('PreviewSun', 'SUN')
    sun_data.energy = 4.0
    sun = bpy.data.objects.new('PreviewSun', sun_data)
    scene.collection.objects.link(sun)
    sun.rotation_euler = (math.radians(55), 0, math.radians(-35))

    # 场景里两个未绑定的 Icosphere（2m）会挡住镜头，预览时隐藏
    for o in bpy.data.objects:
        if o.type == 'MESH' and o.name != 'Object_12':
            o.hide_render = True

    shots = [
        ('ab_idle', 12), ('ab_roar', 24), ('ab_slam', 21), ('ab_sweep', 18),
        ('ab_lunge', 24), ('ab_attack', 20), ('ab_enrage', 22),
        ('ab_blink_slash', 9), ('ab_death', 48), ('ab_stagger', 20),
    ]
    os.makedirs(outdir, exist_ok=True)
    for name, frame in shots:
        act = bpy.data.actions.get(name)
        if not act:
            continue
        use_action(arm, act)
        scene.frame_set(frame)
        scene.render.filepath = os.path.join(outdir, name + '.png')
        bpy.ops.render.render(write_still=True)
        print('PREVIEW', scene.render.filepath)


def pose_report(arm):
    """打印关键帧的世界坐标，数值核对左右镜像/抬臂方向/倒地深度（开发调试用）

    z 值单位是骨架原始单位：站立时 头≈690.7、髋≈685.3、踝≈680.3、趾≈679.2。
    地面 = 趾 679 左右；倒地时头应降到 682 以内，踝不应低于 676。
    """
    scene = bpy.context.scene
    bones = ['Head_M_0725', 'Jaw_M_0727', 'Wrist_R_0702', 'Wrist_L_0768',
             'joint19_R_0733', 'joint19_L_0793', 'Hip_R_0815',
             'Knee_R_0816', 'Knee_L_0834',
             'Ankle_R_0797', 'Ankle_L_0835', 'MiddleToe1_R_0798']
    shots = [
        ('ab_idle', 12), ('ab_attack', 20), ('ab_lunge', 24),
        ('ab_sweep', 28), ('ab_slam', 21), ('ab_slam', 30), ('ab_roar', 24),
        ('ab_enrage', 22), ('ab_blink_cast', 30), ('ab_blink_slash', 9),
        ('ab_death', 22), ('ab_death', 38), ('ab_death', 48), ('ab_death', 60),
        ('ab_stagger', 16), ('ab_stagger', 28), ('ab_sword_cast', 36),
    ]
    for name, frame in shots:
        act = bpy.data.actions.get(name)
        if not act:
            continue
        use_action(arm, act)
        scene.frame_set(frame)
        bpy.context.view_layer.update()
        row = []
        for n in bones:
            pb = arm.pose.bones[n]
            row.append('%s(%.2f,%.2f,%.2f)' % (n.split('_')[0], pb.head.x, pb.head.y, pb.head.z))
        print('POSE', name, frame, ' '.join(row))


def main():
    scene, arm = fresh(SRC)
    drop_imported_actions()
    build(arm)
    validate(arm)
    if os.environ.get('HERALD_POSE_REPORT'):
        pose_report(arm)
    if os.environ.get('HERALD_PREVIEW_DIR'):
        render_previews(arm, os.environ['HERALD_PREVIEW_DIR'])
    export_glb(arm, OUT)
    print('DONE herald anims')


main()

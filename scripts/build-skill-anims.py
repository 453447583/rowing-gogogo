"""四关新技能 + 通用 enrage 的骨骼动画包生成器（Blender 无头模式）。

产出（只含骨架、无网格，供 Boss.js 的 clipModels 覆盖同名 clip）：
  public/monsters/fd_skills.glb  fd_rift_slam / fd_gate_call / fd_enrage
  public/monsters/dk_skills.glb  dk_grid_thunder / dk_enrage
  public/monsters/bd_skills.glb  bd_laser_sweep / bd_enrage

用法：
    "D:\\blender\\blender.exe" --background --factory-startup --python scripts/build-skill-anims.py

约定与 build-dk-anims.py 一致：
1. 导入 glTF **之前**把 scene.render.fps 设为 30；
2. 姿势角度用世界轴（Blender Z-up）描述：X=俯仰/挥臂，Y=侧倾/展翼，Z=扭腰/横扫；
3. 龙骑士的武器骨 Bone_Sword_R_1 每帧 = 右手世界矩阵 × 握持偏移，否则斧头会飞出去。
"""
import bpy
import math
from mathutils import Quaternion, Vector

FPS = 30
ROOT = r'd:\3Dgame - 副本'
MON = ROOT + r'\public\monsters'

X = (1, 0, 0)
Y = (0, 1, 0)
Z = (0, 0, 1)


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
    pb.location = m.inverted() @ Vector(world_vec)
    pb.keyframe_insert('location', frame=frame)


def fresh(src):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.fps = FPS
    scene.frame_start = 1
    bpy.ops.import_scene.gltf(filepath=src)
    arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
    return scene, arm


def drop_imported_actions():
    """导入的模型自带 idle/attack 等 clip，留着会被一起导出、白白撑大文件。"""
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
        export_force_sampling=True,
    )
    print('EXPORTED', out)




# ============================================================
# 1. 深渊/炎狱火龙：fd_rift_slam / fd_gate_call / fd_enrage
# ============================================================
FD_PELVIS = 'Bone009_01'
FD_B1 = 'Bone010_02'
FD_B2 = 'Bone011_03'
FD_CHEST = 'Bone012_04'
FD_N0 = 'Bone013_05'
FD_N1 = 'Bone014_06'
FD_N2 = 'Bone015_07'
FD_HEAD = 'Bone017_08'
FD_SKULL = 'Bone016_013'
FD_JAW = ['mouse1_09', 'mouse2_010', 'mouse3_011', 'mouse4_012']
FD_TAIL = ['Bone001_067', 'Bone002_068', 'Bone003_069', 'Bone004_070',
           'Bone005_071', 'Bone006_072', 'Bone007_073', 'Bone008_074']
FD_WL = 'Bone027_043'
FD_WR = 'Bone072_020'
FD_BODY = [FD_PELVIS, FD_B1, FD_B2, FD_CHEST, FD_N0, FD_N1, FD_N2, FD_HEAD, FD_SKULL]


def build_fd():
    scene, arm = fresh(MON + r'\fire_dragon_boss.glb')
    pose = arm.pose
    drop_imported_actions()

    def bone(n):
        return pose.bones[n]

    def rest(frame):
        for n in FD_BODY:
            key(bone(n), frame, [])
        for n in FD_JAW:
            key(bone(n), frame, [])
        for n in FD_TAIL:
            key(bone(n), frame, [])
        key(bone(FD_WL), frame, [])
        key(bone(FD_WR), frame, [])
        key_loc(bone(FD_PELVIS), frame, (0, 0, 0))

    def rear(frame, k, jaw):
        """k>0 = 抬身前压前立起（负值 = 前压），jaw = 张口角度"""
        key(bone(FD_PELVIS), frame, [(X, -9 * k)])
        key(bone(FD_B1), frame, [(X, -8 * k)])
        key(bone(FD_B2), frame, [(X, -7 * k)])
        key(bone(FD_CHEST), frame, [(X, -6 * k)])
        key(bone(FD_N0), frame, [(X, -8 * k)])
        key(bone(FD_N1), frame, [(X, -9 * k)])
        key(bone(FD_N2), frame, [(X, -8 * k)])
        key(bone(FD_HEAD), frame, [(X, -10 * k)])
        key(bone(FD_SKULL), frame, [(X, -6 * k)])
        for j in FD_JAW:
            key(bone(j), frame, [(X, jaw)])
        key_loc(bone(FD_PELVIS), frame, (0, 0, 0.10 * max(0, k)))

    def wings(frame, ya, yb):
        """一对翼根：ya/yb 是左右两翼绕世界 Y 的展开角（符号相反）"""
        key(bone(FD_WR), frame, [(Y, ya)])
        key(bone(FD_WL), frame, [(Y, yb)])

    def tail(frame, side, lift):
        for i, n in enumerate(FD_TAIL):
            key(bone(n), frame, [(Z, side * (0.5 + i * 0.16)), (X, lift * (0.4 + i * 0.1))])

    # ---- fd_rift_slam：抬身前压 → 双翼下砸 → 咆哮（60 帧 = 2.0s）----
    new_action(arm, 'fd_rift_slam')
    rest(1)
    rear(16, 1.0, 14)
    wings(16, -20, 20)
    tail(16, 4, 10)
    rear(30, 1.35, 26)
    wings(30, -30, 30)
    tail(30, 8, 18)
    # 砸：整条上身向前下方压，尾巴反向甩起（对齐 1.6s = 技能结算瞬间）
    key(bone(FD_PELVIS), 48, [(X, 10)])
    key(bone(FD_B1), 48, [(X, 9)])
    key(bone(FD_B2), 48, [(X, 8)])
    key(bone(FD_CHEST), 48, [(X, 7)])
    key(bone(FD_N0), 48, [(X, 10)])
    key(bone(FD_N1), 48, [(X, 12)])
    key(bone(FD_N2), 48, [(X, 12)])
    key(bone(FD_HEAD), 48, [(X, 14)])
    key(bone(FD_SKULL), 48, [(X, 8)])
    for j in FD_JAW:
        key(bone(j), 48, [(X, 4)])
    key_loc(bone(FD_PELVIS), 48, (0, 0, -0.30))
    wings(48, 16, -16)
    tail(48, -6, -14)
    rear(54, 0.5, 18)
    wings(54, -6, 6)
    tail(54, 3, 4)
    rest(60)

    # ---- fd_gate_call：立身展翼咆哮 → 低头前推（开门，75 帧 = 2.5s）----
    new_action(arm, 'fd_gate_call')
    rest(1)
    rear(20, 1.15, 20)
    wings(20, -34, 34)
    tail(20, 10, 14)
    rear(38, 1.45, 30)
    wings(38, -44, 44)
    key(bone(FD_HEAD), 38, [(X, -16), (Z, 8)])
    tail(38, 14, 20)
    # 头往下压、翼向前收：把“门”推到海面上（对齐 2.2s = 技能结算瞬间）
    rear(58, -0.25, 6)
    wings(58, 26, -26)
    tail(58, -10, -8)
    key(bone(FD_HEAD), 58, [(X, 16)])
    rear(64, -0.1, 10)
    wings(64, 12, -12)
    tail(64, -4, -2)
    rest(75)

    # ---- fd_enrage：快速立身展翼 + 甩头咆哮（36 帧 = 1.2s）----
    new_action(arm, 'fd_enrage')
    rest(1)
    rear(8, 1.2, 22)
    wings(8, -30, 30)
    tail(8, 10, 12)
    rear(16, 1.4, 30)
    wings(16, -40, 40)
    key(bone(FD_HEAD), 16, [(X, -14), (Z, 12)])
    key(bone(FD_N2), 16, [(X, -10), (Z, 8)])
    tail(16, 18, 18)
    rear(24, 1.35, 28)
    wings(24, -36, 36)
    key(bone(FD_HEAD), 24, [(X, -12), (Z, -12)])
    key(bone(FD_N2), 24, [(X, -9), (Z, -8)])
    tail(24, -16, 16)
    rear(30, 0.6, 18)
    rest(36)

    scene.frame_end = 75
    export_glb(arm, MON + r'\fd_skills.glb')
    print('DONE fd')


# ============================================================
# 2. 雷霆龙骑士：dk_grid_thunder / dk_enrage
# ============================================================
DK_SPINE = 'Bone_Spine01_51'
DK_CHEST = 'Bone_Chest_50'
DK_NECK = 'Bone_Neck_49'
DK_HEAD = 'Bone_Head_48'
DK_JAW = 'Bone_HeadJaw_46'
DK_HIP = 'Bone_Hip_69'
DK_S_R = 'Bone_Shoulder_R_21'
DK_A_R = 'Bone_Arm_R_18'
DK_F_R = 'Bone_ArmFore_R_17'
DK_H_R = 'Bone_ArmHand_R_16'
DK_SWORD = 'Bone_Sword_R_1'
DK_S_L = 'Bone_Shoulder_L_31'
DK_A_L = 'Bone_Arm_L_28'
DK_F_L = 'Bone_ArmFore_L_27'
DK_H_L = 'Bone_ArmHand_L_26'
DK_TAIL = ['Bone_Tail_00_68', 'Bone_Tail_02_67', 'Bone_Tail_04_66', 'Bone_Tail_06_64']
DK_WING_L = 'Bone_Wing_L_11'
DK_WING_R = 'Bone_Wing_R_41'
DK_THIGH_R = 'Bone_LegThigh_R_58'
DK_THIGH_L = 'Bone_LegThigh_L_63'
DK_CALF_R = 'Bone_LegCalf_R_57'
DK_CALF_L = 'Bone_LegCalf_L_62'
DK_ALL = [DK_SPINE, DK_CHEST, DK_NECK, DK_HEAD, DK_JAW, DK_HIP,
          DK_S_R, DK_A_R, DK_F_R, DK_H_R, DK_S_L, DK_A_L, DK_F_L, DK_H_L,
          DK_THIGH_R, DK_THIGH_L, DK_CALF_R, DK_CALF_L,
          DK_WING_L, DK_WING_R] + DK_TAIL


def build_dk():
    scene, arm = fresh(MON + r'\dk_idle.glb')
    pose = arm.pose

    def bone(n):
        return pose.bones[n]

    def rest(frame):
        for n in DK_ALL:
            key(bone(n), frame, [])
        key_loc(bone(DK_HIP), frame, (0, 0, 0))

    # 握持偏移必须在删 action 之前从待机段取到（斧头才会握在手里而不是飞出去）
    use_action(arm, bpy.data.actions['Armature_Stand_full'])
    scene.frame_set(20)
    grip = bone(DK_H_R).matrix.inverted() @ bone(DK_SWORD).matrix.copy()
    drop_imported_actions()

    def attach_sword(end):
        hand = pose.bones[DK_H_R]
        sword = pose.bones[DK_SWORD]
        sword.rotation_mode = 'QUATERNION'
        for f in range(1, end + 1):
            scene.frame_set(f)
            sword.matrix = hand.matrix @ grip
            sword.keyframe_insert('location', frame=f)
            sword.keyframe_insert('rotation_quaternion', frame=f)

    def raise_pose(frame):
        """举斧向天引雷（与 dk_cast 同一套姿势，方便和第三关已有动作连贯）"""
        key(bone(DK_SPINE), frame, [(X, -12), (Z, -10)])
        key(bone(DK_CHEST), frame, [(X, -8), (Z, -12)])
        key(bone(DK_S_R), frame, [(X, 32), (Z, -8)])
        key(bone(DK_A_R), frame, [(X, 150), (Y, -16)])
        key(bone(DK_F_R), frame, [(X, -16)])
        key(bone(DK_H_R), frame, [(X, -8)])
        key(bone(DK_A_L), frame, [(X, 28), (Z, 18)])
        key(bone(DK_F_L), frame, [(X, -20)])
        key(bone(DK_NECK), frame, [(X, -22)])
        key(bone(DK_HEAD), frame, [(X, -26)])
        key(bone(DK_JAW), frame, [(X, -18)])
        key(bone(DK_WING_L), frame, [(Y, -14)])
        key(bone(DK_WING_R), frame, [(Y, 14)])
        key_loc(bone(DK_HIP), frame, (0, 0, 0.02))
        for i, t in enumerate(DK_TAIL):
            key(bone(t), frame, [(X, -6 - i * 2)])

    # ---- dk_grid_thunder：举斧引雷 7.5s（225 帧），最后落在第四波格子上 ----
    new_action(arm, 'dk_grid_thunder')
    rest(1)
    raise_pose(20)
    raise_pose(30)
    # 引雷期间的颤抖：只抖脊柱/颈/头/持斧手，躯干基准不变
    for i, f in enumerate(range(42, 192, 10)):
        s = 1 if i % 2 == 0 else -1
        key(bone(DK_SPINE), f, [(X, -12 + s * 1.6), (Z, -10 + s * 1.2)])
        key(bone(DK_NECK), f, [(X, -22 + s * 2.0)])
        key(bone(DK_HEAD), f, [(X, -26 - s * 2.4), (Z, s * 1.8)])
        key(bone(DK_A_R), f, [(X, 150 + s * 2.2), (Y, -16 + s * 1.4)])
        key(bone(DK_WING_L), f, [(Y, -14 - s * 2.5)])
        key(bone(DK_WING_R), f, [(Y, 14 + s * 2.5)])
    raise_pose(197)
    # 落雷：整把斧砸向海面
    key(bone(DK_SPINE), 210, [(X, 26)])
    key(bone(DK_CHEST), 210, [(X, 16)])
    key(bone(DK_NECK), 210, [(X, 20)])
    key(bone(DK_HEAD), 210, [(X, 14)])
    key(bone(DK_S_R), 210, [(X, -8)])
    key(bone(DK_A_R), 210, [(X, -72), (Z, 8)])
    key(bone(DK_F_R), 210, [(X, 12)])
    key(bone(DK_H_R), 210, [(X, 16)])
    key(bone(DK_A_L), 210, [(X, -62), (Z, -6)])
    key(bone(DK_F_L), 210, [(X, 10)])
    key(bone(DK_HIP), 210, [(X, 8)])
    key_loc(bone(DK_HIP), 210, (0, 0, -0.22))
    key(bone(DK_JAW), 210, [(X, 8)])
    key(bone(DK_WING_L), 210, [(Y, 10)])
    key(bone(DK_WING_R), 210, [(Y, -10)])
    for i, t in enumerate(DK_TAIL):
        key(bone(t), 210, [(X, -10 - i * 3)])
    key(bone(DK_SPINE), 217, [(X, 10)])
    key(bone(DK_A_R), 217, [(X, -18)])
    key(bone(DK_A_L), 217, [(X, -14)])
    key_loc(bone(DK_HIP), 217, (0, 0, -0.05))
    rest(225)
    # 武器骨必须在本 action 还处于激活状态时逐帧 bake
    attach_sword(225)

    # ---- dk_enrage：举斧咆哮 + 展翼（36 帧 = 1.2s）----
    new_action(arm, 'dk_enrage')
    rest(1)
    key(bone(DK_SPINE), 8, [(X, -16)])
    key(bone(DK_CHEST), 8, [(X, -10)])
    key(bone(DK_NECK), 8, [(X, -18)])
    key(bone(DK_HEAD), 8, [(X, -20)])
    key(bone(DK_JAW), 8, [(X, -20)])
    key(bone(DK_S_R), 8, [(X, 30)])
    key(bone(DK_A_R), 8, [(X, 132), (Z, -14)])
    key(bone(DK_F_R), 8, [(X, -20)])
    key(bone(DK_A_L), 8, [(X, 40), (Z, 22)])
    key(bone(DK_F_L), 8, [(X, -24)])
    key(bone(DK_WING_L), 8, [(Y, -30)])
    key(bone(DK_WING_R), 8, [(Y, 30)])
    for i, t in enumerate(DK_TAIL):
        key(bone(t), 8, [(Z, 10 + i * 5), (X, -6 - i * 2)])
    key(bone(DK_SPINE), 18, [(X, -18)])
    key(bone(DK_HEAD), 18, [(X, -24), (Z, 8)])
    key(bone(DK_A_R), 18, [(X, 138), (Z, -16)])
    key(bone(DK_JAW), 18, [(X, -24)])
    key(bone(DK_WING_L), 18, [(Y, -38)])
    key(bone(DK_WING_R), 18, [(Y, 38)])
    for i, t in enumerate(DK_TAIL):
        key(bone(t), 18, [(Z, -8 - i * 5), (X, -4 - i * 2)])
    key(bone(DK_SPINE), 26, [(X, -10)])
    key(bone(DK_HEAD), 26, [(X, -14)])
    key(bone(DK_A_R), 26, [(X, 90)])
    key(bone(DK_JAW), 26, [(X, -12)])
    key(bone(DK_WING_L), 26, [(Y, -18)])
    key(bone(DK_WING_R), 26, [(Y, 18)])
    rest(36)
    attach_sword(36)

    scene.frame_end = 225
    export_glb(arm, MON + r'\dk_skills.glb')
    print('DONE dk')


# ============================================================
# 3. 暗夜血魔：bd_laser_sweep / bd_enrage
# ============================================================
BD_PELVIS = 'Bip001 Pelvis_02'
BD_SPINE = 'Bip001 Spine_03'
BD_SPINE1 = 'Bip001 Spine1_016'
BD_NECK = 'Bip001 Neck_017'
BD_HEAD = 'Bip001 Head_018'
BD_L_UPPER = 'Bip001 L UpperArm_022'
BD_L_FORE = 'Bip001 L Forearm_023'
BD_L_HAND = 'Bip001 L Hand_024'
BD_R_UPPER = 'Bip001 R UpperArm_036'
BD_R_FORE = 'Bip001 R Forearm_037'
BD_R_HAND = 'Bip001 R Hand_038'
BD_TAIL = ['Bip001 Tail_069', 'Bip001 Tail1_070']
BD_WING_L = ['Bone004(mirrored)_054', 'Bone005(mirrored)_055', 'Bone006(mirrored)_056']
BD_WING_R = ['Bone004_049', 'Bone005_050', 'Bone006_051']
BD_BODY = [BD_PELVIS, BD_SPINE, BD_SPINE1, BD_NECK, BD_HEAD,
           BD_L_UPPER, BD_L_FORE, BD_L_HAND, BD_R_UPPER, BD_R_FORE, BD_R_HAND] \
    + BD_TAIL + BD_WING_L + BD_WING_R


def build_bd():
    scene, arm = fresh(MON + r'\blood_demon_prince.glb')
    pose = arm.pose
    drop_imported_actions()

    def bone(n):
        return pose.bones[n]

    def rest(frame):
        for n in BD_BODY:
            key(bone(n), frame, [])
        key_loc(bone(BD_PELVIS), frame, (0, 0, 0))

    def arms_out(frame, up, fore=12):
        """双臂向两侧展开：up=0 平举，>0 上抬，<0 下压"""
        key(bone(BD_L_UPPER), frame, [(Y, -78 - up)])
        key(bone(BD_L_FORE), frame, [(Y, -fore)])
        key(bone(BD_R_UPPER), frame, [(Y, 78 + up)])
        key(bone(BD_R_FORE), frame, [(Y, fore)])

    def wings(frame, spread):
        for i, n in enumerate(BD_WING_L):
            key(bone(n), frame, [(Y, -spread * (0.6 + i * 0.22))])
        for i, n in enumerate(BD_WING_R):
            key(bone(n), frame, [(Y, spread * (0.6 + i * 0.22))])

    def tail(frame, lift, side):
        for i, n in enumerate(BD_TAIL):
            key(bone(n), frame, [(X, lift * (0.6 + i * 0.3)), (Z, side * (0.5 + i * 0.4))])

    # ---- bd_laser_sweep：双臂平举、拧身慢扫（130 帧 = 4.3s，跟着光束转）----
    new_action(arm, 'bd_laser_sweep')
    rest(1)
    key(bone(BD_SPINE), 14, [(X, -6), (Z, -44)])
    key(bone(BD_SPINE1), 14, [(Z, -28)])
    key(bone(BD_NECK), 14, [(Z, 16)])
    key(bone(BD_HEAD), 14, [(X, -8), (Z, 20)])
    arms_out(14, 4, 14)
    wings(14, 12)
    tail(14, 8, 14)
    # 抬手定格到技能结算（1.7s），之后跟着光束把上身拧到另一侧
    key(bone(BD_SPINE), 46, [(X, -6), (Z, -46)])
    key(bone(BD_SPINE1), 46, [(Z, -29)])
    arms_out(46, 4, 14)
    key(bone(BD_SPINE), 100, [(X, -6), (Z, 44)])
    key(bone(BD_SPINE1), 100, [(Z, 28)])
    key(bone(BD_NECK), 100, [(Z, -16)])
    key(bone(BD_HEAD), 100, [(X, -8), (Z, -20)])
    arms_out(100, 4, 14)
    wings(100, 12)
    tail(100, 8, -14)
    key(bone(BD_SPINE), 116, [(X, -4), (Z, 26)])
    arms_out(116, -6, 10)
    key(bone(BD_HEAD), 116, [(X, -4), (Z, -8)])
    rest(130)

    # ---- bd_enrage：展翼仰头咆哮（36 帧 = 1.2s）----
    new_action(arm, 'bd_enrage')
    rest(1)
    key(bone(BD_SPINE), 8, [(X, -12)])
    key(bone(BD_SPINE1), 8, [(X, -8)])
    key(bone(BD_NECK), 8, [(X, -16)])
    key(bone(BD_HEAD), 8, [(X, -22)])
    arms_out(8, 26, 18)
    wings(8, 34)
    tail(8, 16, 10)
    key(bone(BD_SPINE), 18, [(X, -15)])
    key(bone(BD_SPINE1), 18, [(X, -10)])
    key(bone(BD_NECK), 18, [(X, -20)])
    key(bone(BD_HEAD), 18, [(X, -28)])
    arms_out(18, 40, 22)
    wings(18, 44)
    tail(18, 22, -8)
    key(bone(BD_HEAD), 26, [(X, -22), (Z, 8)])
    arms_out(26, 30, 18)
    wings(26, 36)
    rest(36)

    scene.frame_end = 130
    export_glb(arm, MON + r'\bd_skills.glb')
    print('DONE bd')


build_fd()
build_dk()
build_bd()
print('DONE')

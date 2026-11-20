# 回程石堤（"城墙"）的三件装饰资产：垛口 / 浮雕壁板 / 旗杆旗帜。
#
#   blender -b --factory-startup --python-exit-code 1 --python scripts/wall/gen_wall_props.py
#
# 产出（都落在 public/models/decor/）：
#   wall_crenel.glb  6m 一组的垛口模块（压在女儿墙压顶上，间隔 6m 实例摆放）
#   wall_relief.glb  2.4×1.6m 浮雕壁板（贴在堤身内侧收分面上）
#   wall_banner.glb  旗杆 + 悬挂旗帜（立在走道靠女儿墙一侧）
#
# 关键约定（和 Track.js 的断面严格对齐，改尺寸前先回看那段）：
#   · 女儿墙压顶：lat 10.1 → 10.8（0.7m 宽），顶面从水面 +4.35 抬到 +4.60（外倾 0.25）
#     → 垛口的底座做成 0.7m 宽、0.5m 高，底面包住整段斜坡，不会浮空也不会穿通；
#   · 堤身内侧收分面：lat 7.1 → 7.9，从 -1.2m 抬到 +3.4m（≈20°）→ 浮雕板背面平贴；
#   · 壁柱每 16m 一根、立在同一个 lat 上，所以垛口的避让在 JS 里做（见 #buildReturnBank）。
#
# 导出规则（项目通用）：几何用顶点色 COLOR_0 表达颜色，Base Color 打平成白，
# 颜色值是**线性**的（sRGB hex 必须先 s2l），材质关掉背面剔除 → glTF doubleSided。
import bpy
import math
import json
import os

OUT_DIR = os.path.join('public', 'models', 'decor')
FRAME = 0


def s2l(c):
    """sRGB 0..1 → 线性（color_attributes 吃线性值，不转换会整体偏亮）。"""
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hex2lin(h):
    r = ((h >> 16) & 255) / 255.0
    g = ((h >> 8) & 255) / 255.0
    b = (h & 255) / 255.0
    return (s2l(r), s2l(g), s2l(b), 1.0)


class Builder:
    """攒顶点/面/每面颜色，最后一次性建 mesh。单位：米。"""

    def __init__(self):
        self.v = []
        self.f = []
        self.c = []

    def _push(self, pts, faces, col):
        base = len(self.v)
        self.v.extend(pts)
        for fc in faces:
            self.f.append(tuple(base + i for i in fc))
            self.c.append(col)

    def box(self, x0, x1, y0, y1, z0, z1, col, shrink_top=0.0, rot_y=0.0):
        """轴对齐立方体；shrink_top 让顶面四周内收（做倒角/收分），rot_y 绕自身中心在 XY 平面旋转。"""
        cx = (x0 + x1) * 0.5
        cy = (y0 + y1) * 0.5
        hx = (x1 - x0) * 0.5
        hy = (y1 - y0) * 0.5
        ca, sa = math.cos(rot_y), math.sin(rot_y)

        def P(sx, sy, z, sh):
            x = cx + sx * max(0.0, hx - sh)
            y = cy + sy * max(0.0, hy - sh)
            if rot_y:
                dx, dy = x - cx, y - cy
                x = cx + dx * ca - dy * sa
                y = cy + dx * sa + dy * ca
            return (x, y, z)

        pts = [
            P(-1, -1, z0, 0), P(1, -1, z0, 0), P(1, 1, z0, 0), P(-1, 1, z0, 0),
            P(-1, -1, z1, shrink_top), P(1, -1, z1, shrink_top),
            P(1, 1, z1, shrink_top), P(-1, 1, z1, shrink_top),
        ]
        faces = [
            (0, 3, 2, 1), (4, 5, 6, 7),
            (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7),
        ]
        self._push(pts, faces, col)

    def prism(self, sides, r0, r1, z0, z1, col, cx=0.0, cy=0.0, rot=0.0):
        """n 边棱柱（旗杆用），r0 底半径 / r1 顶半径。"""
        pts = []
        for i in range(sides):
            a = rot + i * math.tau / sides
            pts.append((cx + math.cos(a) * r0, cy + math.sin(a) * r0, z0))
        for i in range(sides):
            a = rot + i * math.tau / sides
            pts.append((cx + math.cos(a) * r1, cy + math.sin(a) * r1, z1))
        faces = []
        for i in range(sides):
            j = (i + 1) % sides
            faces.append((i, j, sides + j, sides + i))
        faces.append(tuple(range(sides - 1, -1, -1)))            # 底面
        faces.append(tuple(range(sides, sides * 2)))              # 顶面
        self._push(pts, faces, col)

    def sheet(self, cols, rows, fn, col_fn):
        """参数曲面片（旗面）：fn(u,v) → (x,y,z)，col_fn(u,v) → 颜色。"""
        base = len(self.v)
        for r in range(rows + 1):
            for c in range(cols + 1):
                self.v.append(fn(c / cols, r / rows))
        for r in range(rows):
            for c in range(cols):
                a = base + r * (cols + 1) + c
                b = a + 1
                d = a + (cols + 1)
                e = d + 1
                quad = (a, b, e, d)
                # 每个格子按中心点取色
                col = col_fn((c + 0.5) / cols, (r + 0.5) / rows)
                self.f.append(quad)
                self.c.append(col)

    def build(self, name, mat_name):
        me = bpy.data.meshes.new(name)
        me.from_pydata(self.v, [], self.f)
        me.update()
        attr = me.color_attributes.new(name='Col', type='FLOAT_COLOR', domain='CORNER')
        for i, poly in enumerate(me.polygons):
            col = self.c[i]
            for li in poly.loop_indices:
                attr.data[li].color = col
        me.color_attributes.active_color = attr
        me.color_attributes.render_color_index = 0
        mat = bpy.data.materials.new(mat_name)
        mat.use_nodes = True
        bsdf = mat.node_tree.nodes['Principled BSDF']
        bsdf.inputs['Base Color'].default_value = (1, 1, 1, 1)
        bsdf.inputs['Roughness'].default_value = 0.92
        bsdf.inputs['Metallic'].default_value = 0.0
        mat.use_backface_culling = False
        me.materials.append(mat)
        ob = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(ob)
        return ob


def export(ob, path):
    for o in bpy.data.objects:
        o.select_set(o is ob)
    bpy.context.view_layer.objects.active = ob
    props = set(bpy.ops.export_scene.gltf.get_rna_type().properties.keys())
    kw = dict(filepath=path, export_format='GLB', use_selection=True,
              export_apply=True, export_yup=True,
              export_animations=False, export_skins=False,
              export_materials='EXPORT')
    for key, val in (('export_vertex_color', 'ACTIVE'), ('export_all_vertex_colors', False),
                     ('export_attributes', False), ('export_normals', True)):
        if key in props:
            kw[key] = val
    bpy.ops.export_scene.gltf(**kw)


bpy.ops.wm.read_factory_settings(use_empty=True)

C_RAIL = hex2lin(0xc6ba9c)     # 垛口底座（暖灰石）
C_MERLON = hex2lin(0xe4dbc2)   # 垛墙（浅色，远看有锯齿天际线）
C_MERLON_TOP = hex2lin(0xf0e8d2)
C_SLAB = hex2lin(0xa8987c)
C_FRAME = hex2lin(0xd8cdb2)
C_MOTIF = hex2lin(0xbfae8e)
C_MOTIF_HI = hex2lin(0xe8dfc6)
C_POLE = hex2lin(0x5d5147)
C_GOLD = hex2lin(0xc9a44e)
C_CLOTH = hex2lin(0x9d2f28)
C_CLOTH_EDGE = hex2lin(0xd8b45c)

results = []

# ---------------------------------------------------------------- 垛口模块（6m）
b = Builder()
# 底座压条：0.7m 宽 × 0.5m 高。底面故意低于压顶内沿，好把 0.25m 的外倾斜面吃进去。
b.box(-3.0, 3.0, -0.35, 0.35, -0.02, 0.50, C_RAIL)
# 三块垛墙：宽 1.1m、高 0.75m，顶部四周内收 0.05 做倒角
for cx in (-2.20, 0.0, 2.20):
    b.box(cx - 0.55, cx + 0.55, -0.30, 0.30, 0.50, 1.16, C_MERLON, shrink_top=0.05)
    b.box(cx - 0.50, cx + 0.50, -0.25, 0.25, 1.16, 1.30, C_MERLON_TOP, shrink_top=0.06)
ob = b.build('wall_crenel', 'wall_crenel_mat')
export(ob, os.path.join(OUT_DIR, 'wall_crenel.glb'))
results.append({'name': 'wall_crenel', 'tris': sum(len(p.vertices) - 2 for p in ob.data.polygons)})
bpy.data.objects.remove(ob, do_unlink=True)

# ---------------------------------------------------------------- 浮雕壁板（2.4×1.6）
b = Builder()
b.box(-1.20, 1.20, 0.00, 0.07, -0.80, 0.80, C_SLAB)              # 底版
for (x0, x1, z0, z1) in ((-1.20, 1.20, 0.64, 0.80), (-1.20, 1.20, -0.80, -0.64),
                         (-1.20, -1.04, -0.64, 0.64), (1.04, 1.20, -0.64, 0.64)):
    b.box(x0, x1, 0.07, 0.17, z0, z1, C_FRAME)                    # 外框四条
# 主题：三层波浪 + 中间一枚菱形，全部凸出 8~14cm
for i, (zc, h) in enumerate(((0.30, 0.11), (-0.02, 0.11), (-0.34, 0.11))):
    b.box(-0.86, 0.86, 0.07, 0.15 + i * 0.0, zc - h, zc + h, C_MOTIF)
b.box(-0.30, 0.30, 0.07, 0.21, -0.16, 0.16, C_MOTIF_HI, rot_y=math.radians(45))
for sx in (-1, 1):
    b.box(sx * 0.62 - 0.05, sx * 0.62 + 0.05, 0.07, 0.19, -0.60, 0.60, C_MOTIF_HI)
ob = b.build('wall_relief', 'wall_relief_mat')
export(ob, os.path.join(OUT_DIR, 'wall_relief.glb'))
results.append({'name': 'wall_relief', 'tris': sum(len(p.vertices) - 2 for p in ob.data.polygons)})
bpy.data.objects.remove(ob, do_unlink=True)

# ---------------------------------------------------------------- 旗杆 + 旗帜
b = Builder()
b.box(-0.24, 0.24, -0.24, 0.24, 0.00, 0.34, C_POLE, shrink_top=0.04)   # 基座
b.prism(6, 0.105, 0.075, 0.34, 5.90, C_POLE)                            # 杆身
b.box(-0.13, 0.13, -0.13, 0.13, 5.90, 6.14, C_GOLD, shrink_top=0.05)    # 顶饰
b.prism(4, 0.10, 0.0, 6.14, 6.42, C_GOLD, rot=math.radians(45))         # 尖顶
b.box(-0.68, 0.68, -0.035, 0.035, 5.60, 5.68, C_GOLD)                   # 横担
# 旗面：从横担下垂，带两道正弦褶皱；四周一圈金边（用顶点色区分）
BX, BZ0, BZ1 = 0.56, 3.05, 5.58
def cloth(u, v):
    x = -BX + 2 * BX * u
    z = BZ1 - (BZ1 - BZ0) * v
    # 越靠下摆动越大，靠杆一侧几乎不动
    wave = math.sin(u * math.pi * 2.2 + v * 1.4) * 0.055 * (0.25 + 0.75 * u) * (0.35 + 0.65 * v)
    return (x, wave, z)
def cloth_col(u, v):
    edge = min(u, 1 - u, v, 1 - v)
    return C_CLOTH_EDGE if edge < 0.085 else C_CLOTH
b.sheet(7, 8, cloth, cloth_col)
ob = b.build('wall_banner', 'wall_banner_mat')
export(ob, os.path.join(OUT_DIR, 'wall_banner.glb'))
results.append({'name': 'wall_banner', 'tris': sum(len(p.vertices) - 2 for p in ob.data.polygons)})

print('@@JSON@@' + json.dumps({'ok': True, 'assets': results}))

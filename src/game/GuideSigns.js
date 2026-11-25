/**
 * 全地图通用「弯道导向牌」（黑底白双 chevron + 橙色下沿 + 立柱/底座）。
 *
 * 以前只有湖泊环线在 LakeStadium.js 里有一套立牌，而且贴图方向是写死的：
 * 不管赛道往哪拐，箭头永远指向同一侧。湖泊是右弯环线，箭头却指左，
 * 所以看起来是「反的」。这里把它做成全地图共用的独立层：
 *
 *   - 箭头方向按**该处弯道转向**决定，永远指向弯内（玩家该转的方向）
 *   - 牌子立在弯道**外侧**，牌面法线朝来车方向，玩家从后追上来才看得见
 *   - 只在真正有曲率的地方成排布点，直道不摆，急弯三连排
 *   - 近道走廊一律跳过（近道口不放牌，免得挡住分叉 / 误导玩家）
 *
 * 净空（避免和赛道外物体穿模，全部只读、不写 colliders）：
 *   近道折线 / 岛屿 / 暗礁 / 领奖台 / 其它赛段中心线 / Environment 的
 *   静态碰撞体（树、石头、岩壁）/ 湖泊看台占地。任一项不过就整组丢弃。
 *
 * 其它约定：确定性地按弧长采样，不用 Math.random；牌面/立柱/底座各 1 个
 * InstancedMesh（左右箭头各一批），整层 4 个 draw call；牌面做正反两面，
 * 从背面看箭头也不会左右镜像。URL：?guideSigns=0 关闭、?guideSigns=flip
 * 一键整体翻转箭头（实机觉得方向不对时用来对照，不用改代码）。
 *
 * planGuideSigns() 是纯数学、不碰 DOM / three 的规划函数，单独导出给
 * tests/guide_signs_audit.mjs 对全部地图做净空与方向审计。
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createGLTFLoader } from './gltfLoader.js';
import {
  sampleCenterline, sampleAt, lakeStadiumLayout,
  lakeStadiumDisabledByUrl, inStadiumFootprint,
} from './LakeStadiumLayout.js';

const SIGN_STEP = 18;      // 候选点沿弧长的间距（米）
const GROUP_GAP = 22;      // 两组牌之间的最小弧长（米），连排不能叠在一起
const EDGE_EXTRA = 7.5;    // 牌离走廊边界再外挪的距离（米）
// 回到「只在真正有弯的地方摆」的稀疏版：用户明确说加密版太多、看着密集恐惧。
// 只比最初的 0.19 放宽一点点（0.155），让缓弯多出零星几组，不做全覆盖。
const CURVE_MIN = 0.155;   // ±9m 切线夹角阈值：低于它当作直道跳过
const CURVE_HARD = 0.33;   // 急弯：三连排
const CURVE_MID = 0.26;    // 中弯：两连排
const ROW_GAP = 5.5;       // 连排内相邻牌的弧长间距（米）
const COVER_R = 14;        // 覆盖率只作为可观测指标打印，不作为布点目标

// 带贴图的木柱 + 青铜牌框（Blender 出，见 public/models/props/guide_sign_post.glb）。
// 加载失败时保留原来的细杆/底座，牌层照常工作。
const SIGN_POST_URL = '/models/props/guide_sign_post.glb';
let signPostPromise = null;
function loadSignPostKit() {
  if (!signPostPromise) {
    signPostPromise = new Promise((resolve, reject) => {
      createGLTFLoader().load(SIGN_POST_URL, resolve, undefined, reject);
    }).catch((err) => {
      console.warn('[guide-signs] 立柱模型加载失败，保留程序化立柱', err);
      return null;
    });
  }
  return signPostPromise;
}

function urlFlag() {
  try {
    if (typeof location === 'undefined') return '';
    return new URLSearchParams(location.search).get('guideSigns') || '';
  } catch { return ''; }
}

/** 牌层总开关：默认所有竞速地图都开，?guideSigns=0 关掉做 A/B 对比 */
export function guideSignsEnabled() {
  return urlFlag() !== '0';
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/**
 * 画一张黑底白双 chevron。基准图案尖端朝左（«），dir='right' 时整体水平镜像成 »。
 * 镜像只包住 chevron 本体，底部的橙色条保持贴着牌底，不会跟着跑到上沿。
 */
function makeChevronTexture(dir) {
  const c = makeCanvas(256, 128);
  const x = c.getContext('2d');
  x.fillStyle = '#111a22';
  x.fillRect(0, 0, 256, 128);
  x.save();
  if (dir === 'right') {
    x.translate(256, 0);
    x.scale(-1, 1);
  }
  x.strokeStyle = '#ffffff';
  x.lineWidth = 19;
  x.lineJoin = 'round';
  x.lineCap = 'butt';
  for (let i = 0; i < 2; i++) {
    const ox = 46 + i * 82;
    x.beginPath();
    x.moveTo(ox + 50, 22);
    x.lineTo(ox + 4, 64);
    x.lineTo(ox + 50, 106);
    x.stroke();
  }
  x.restore();
  x.fillStyle = '#f0a121';
  x.fillRect(0, 118, 256, 10);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** 正反两片背靠背：从任意一侧看，箭头都不会左右镜像 */
function makePlateGeometry() {
  const front = new THREE.PlaneGeometry(2.3, 1.25);
  const back = new THREE.PlaneGeometry(2.3, 1.25);
  back.rotateY(Math.PI);
  back.translate(0, 0, -0.02);
  const merged = mergeGeometries([front, back], false);
  front.dispose();
  back.dispose();
  merged.computeBoundingSphere();
  return merged;
}

function distToPolyline(pts, x, z) {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[i + 1];
    const vx = bx - ax;
    const vz = bz - az;
    const L2 = vx * vx + vz * vz || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / L2));
    const d = Math.hypot(x - (ax + vx * t), z - (az + vz * t));
    if (d < best) best = d;
  }
  return best;
}

export { distToPolyline as guideDistToPolyline };

/**
 * 纯数学布点：不碰 DOM / three，可在 Node 里直接对全部地图做审计。
 * @param {object} mapDef MAPS 里的一项
 * @param {object} opts { colliders, heightAt, flip }
 *        heightAt(x,z) 返回该处赛道面高度（抬高段用），不传则一律 0
 * @returns {{ signs: Array, stats: object, layout: object }}
 *          sign = { x, z, baseY, tx, tz, rx, rz, dir, s }
 *          dir = 'left' | 'right'，指箭头在玩家屏幕上指向哪一侧
 */
export function planGuideSigns(mapDef, opts = {}) {
  const { colliders = [], heightAt = () => 0, flip = false } = opts;
  const layout = sampleCenterline(mapDef, 2);
  const { samples, total } = layout;
  const stadium = mapDef.id === 'lake' && !lakeStadiumDisabledByUrl()
    ? lakeStadiumLayout(mapDef)
    : null;
  const shortcuts = mapDef.shortcuts || [];
  const gateW = mapDef.gateWidth || 10;
  const off = gateW / 2 + EDGE_EXTRA;
  const signs = [];
  if (!samples.length || !total) {
    return { signs, stats: { total: 0, groups: 0, signs: 0, left: 0, right: 0, coverage: 0, coveredMeters: 0, flipped: flip }, layout };
  }

  /** 弧长 → 中心线点 + 单位切线 + 屏幕右向量（相机沿 +t 看时，右 = (-tz, tx)） */
  const frameAt = (s) => {
    const p = sampleAt(layout, s);
    const a = sampleAt(layout, s - 6);
    const b = sampleAt(layout, s + 6);
    let tx = b.x - a.x;
    let tz = b.z - a.z;
    const L = Math.hypot(tx, tz) || 1;
    tx /= L;
    tz /= L;
    return { x: p.x, z: p.z, tx, tz, rx: -tz, rz: tx };
  };

  /** 局部转向：cross > 0 = 往屏幕右拐，< 0 = 往屏幕左拐 */
  const turnAt = (s) => {
    const a = frameAt(s - 9);
    const b = frameAt(s + 9);
    return { cross: a.tx * b.tz - a.tz * b.tx, dot: a.tx * b.tx + a.tz * b.tz };
  };

  /** 到「当前位置以外」的中心线最短距离：防止牌子插进折返回来的另一段赛道 */
  const otherTrackMin = (x, z, s) => {
    let best = Infinity;
    for (const smp of samples) {
      const d = Math.abs(smp.s - s);
      if (Math.min(d, total - d) < 24) continue;
      const dd = Math.hypot(x - smp.x, z - smp.z);
      if (dd < best) best = dd;
    }
    return best;
  };

  const clearOf = (x, z, s) => {
    // 近道：整条走廊 + 余量全跳过，近道入口不放牌（用户要求「近道可以不用放」）
    for (const sc of shortcuts) {
      if (distToPolyline(sc.points || [], x, z) < sc.width + 10) return false;
    }
    for (const is of mapDef.islands || []) {
      if (Math.hypot(x - is.x, z - is.z) < is.r + 7) return false;
    }
    for (const r of mapDef.rocks || []) {
      if (Math.hypot(x - r.x, z - r.z) < r.r + 6) return false;
    }
    if (mapDef.podium && Math.hypot(x - mapDef.podium.x, z - mapDef.podium.z) < 28) return false;
    if (stadium && inStadiumFootprint(stadium, x, z, 2)) return false;
    // 相邻/折返赛段：牌离任一其它段中心线不能比本段还近
    if (otherTrackMin(x, z, s) < off - 2.5) return false;
    // 树 / 岸石 / 岩壁等静态碰撞体：只留一点点余量，牌杆不插进实物
    for (const c of colliders) {
      if (Math.hypot(x - c.x, z - c.z) < (c.r || 0) + 1.2) return false;
    }
    return true;
  };

  const placed = [];
  let groups = 0;

  const placeGroup = (s, cross, rows) => {
    const turn = cross >= 0 ? 1 : -1;       // 1 = 右转，-1 = 左转
    let count = 0;
    for (let r = 0; r < rows; r++) {
      const ss = s + (r - (rows - 1) / 2) * ROW_GAP;
      const q = frameAt(ss);
      // 连排跨过 S 弯拐点时，边缘那块牌所在位置的转向可能已经反过来了。
      // 这种牌宁可不摆，也不能沿用整组方向把箭头指反（用户明确要求方向别放反）。
      const localTurn = turnAt(ss).cross >= 0 ? 1 : -1;
      if (localTurn !== turn) continue;
      // 弯道外侧 = 转向的反侧；右转时外侧在屏幕左
      const outX = -turn * q.rx;
      const outZ = -turn * q.rz;
      const x = q.x + outX * off;
      const z = q.z + outZ * off;
      if (!clearOf(x, z, ss)) continue;
      // 抬高段（云端 / 瀑布 / 栈道）以中心线处的赛道面为基准，别让牌掉到水面上
      const baseY = heightAt(q.x, q.z) || 0;
      signs.push({
        x, z, baseY, cx: q.x, cz: q.z,   // cx/cz = 对应中心线点，验收脚本用来摆合法机位
        tx: q.tx, tz: q.tz, rx: q.rx, rz: q.rz,
        // 右转 → 箭头指屏幕右；左转 → 指屏幕左。flip 用于一键整体对照
        dir: (turn > 0) !== flip ? 'right' : 'left',
        s: ss,
      });
      count++;
    }
    if (count) {
      groups++;
      placed.push(s);
    }
    return count;
  };

  // 起点后一组「起步引导牌」：每张图都能第一眼看到方向参照
  placeGroup(20, turnAt(20).cross, 1);

  for (let s = 10; s < total - 6; s += SIGN_STEP) {
    if (placed.some((p) => Math.min(Math.abs(p - s), total - Math.abs(p - s)) < GROUP_GAP)) continue;
    const { cross, dot } = turnAt(s);
    const ang = Math.abs(Math.atan2(cross, dot));
    if (ang < CURVE_MIN) continue;
    const rows = ang > CURVE_HARD ? 3 : ang > CURVE_MID ? 2 : 1;
    placeGroup(s, cross, rows);
  }

  // 覆盖率：沿中心线每 2m 一格，COVER_R 内有牌就算这段有方向指引（环形首尾相接）
  const CELL = 2;
  const cells = Math.max(1, Math.ceil(total / CELL));
  const rad = Math.ceil(COVER_R / CELL);
  const coveredMask = () => {
    const mask = new Uint8Array(cells);
    for (const sg of signs) {
      const c = Math.round(sg.s / CELL);
      for (let k = -rad; k <= rad; k++) mask[((c + k) % cells + cells) % cells] = 1;
    }
    return mask;
  };
  const hitCount = (mask) => mask.reduce((a, v) => a + v, 0);

  // 覆盖率只算出来给验收脚本看，不再为了指标补牌（用户否决了高密度方案）
  const coverage = hitCount(coveredMask()) / cells;

  return {
    signs,
    stats: {
      total: Math.round(total),
      groups,
      signs: signs.length,
      left: signs.filter((s) => s.dir === 'left').length,
      right: signs.filter((s) => s.dir === 'right').length,
      coverage: Math.round(coverage * 1000) / 1000,
      coveredMeters: Math.round(coverage * total),
      flipped: flip,
    },
    layout,
  };
}

/**
 * @param {THREE.Scene} scene
 * @param {object} mapDef 当前地图定义（MAPS 里的一项）
 * @param {object} opts { track, colliders }：track 用来取抬高段的赛道面高度，
 *                      colliders 是 Environment 已生成的静态圆形碰撞体
 */
export function createGuideSigns(scene, mapDef, opts = {}) {
  const { track = null, colliders = [] } = opts;
  const group = new THREE.Group();
  group.name = 'guide-signs';
  scene.add(group);

  const flip = urlFlag() === 'flip';
  const plan = planGuideSigns(mapDef, {
    colliders,
    flip,
    heightAt: (x, z) => track?.surfaceYAt?.(x, z) ?? 0,
  });
  const empty = {
    group,
    stats: plan.stats,
    setEnabled() {},
    dispose() { scene.remove(group); },
  };
  if (!plan.signs.length) return empty;

  const left = [];
  const right = [];
  const posts = [];
  const bases = [];
  const roots = [];
  const up = new THREE.Vector3(0, 1, 0);

  for (const s of plan.signs) {
    const X = new THREE.Vector3(s.rx, 0, s.rz);      // 牌面本地 +X = 玩家屏幕右
    const Z = new THREE.Vector3(-s.tx, 0, -s.tz);    // 牌面朝来车方向
    const basis = () => new THREE.Matrix4().makeBasis(X, up, Z);
    const m = basis();
    m.setPosition(s.x, s.baseY + 2.25, s.z);
    (s.dir === 'right' ? right : left).push({ base: m });
    const pm = basis();
    pm.setPosition(s.x, s.baseY + 0.9, s.z);
    posts.push({ base: pm });
    const bm = basis();
    bm.setPosition(s.x, s.baseY + 0.08, s.z);
    bases.push({ base: bm });
    const rm = basis();
    rm.setPosition(s.x, s.baseY, s.z);
    roots.push({ base: rm });
  }

  const leftTex = makeChevronTexture('left');
  const rightTex = makeChevronTexture('right');
  const plateGeo = makePlateGeometry();
  const postGeo = new THREE.CylinderGeometry(0.09, 0.11, 1.75, 7);
  const baseGeo = new THREE.BoxGeometry(1.5, 0.26, 0.8);
  const signMats = [
    new THREE.MeshBasicMaterial({ map: leftTex, side: THREE.FrontSide, fog: true }),
    new THREE.MeshBasicMaterial({ map: rightTex, side: THREE.FrontSide, fog: true }),
  ];
  const postMat = new THREE.MeshLambertMaterial({ color: 0x3b4753 });
  const baseMat = new THREE.MeshLambertMaterial({ color: 0x2c3742 });

  const makeBatch = (geo, mat, list, name) => {
    if (!list.length) return;
    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    mesh.name = name;
    mesh.frustumCulled = false;
    list.forEach((d, i) => mesh.setMatrixAt(i, d.base));
    mesh.instanceMatrix.needsUpdate = true;
    group.add(mesh);
  };

  makeBatch(plateGeo, signMats[0], left, 'guide-signs-left');
  makeBatch(plateGeo, signMats[1], right, 'guide-signs-right');
  makeBatch(postGeo, postMat, posts, 'guide-signs-posts');
  makeBatch(baseGeo, baseMat, bases, 'guide-signs-bases');

  // 带贴图的立柱到位后接管：木柱 + 青铜底座 + 牌框，仍是 2 个 InstanceMesh。
  // 模型原点在柱脚（y=0），所以直接用 roots 的矩阵摆位。
  if (guideSignsEnabled()) {
    loadSignPostKit().then((gltf) => {
      if (!gltf || !group.parent) return;
      for (const name of ['guide-signs-posts', 'guide-signs-bases']) {
        const old = group.getObjectByName(name);
        if (!old) continue;
        group.remove(old);
        old.geometry.dispose();
      }
      gltf.scene.updateMatrixWorld(true);
      const seen = new Set();
      gltf.scene.traverse((obj) => {
        if (!obj.isMesh || !obj.geometry) return;
        const mat = Array.isArray(obj.material) ? obj.material[0] : obj.material;
        if (!mat || seen.has(mat)) return;
        seen.add(mat);
        const geo = obj.geometry.clone();
        geo.applyMatrix4(obj.matrixWorld);
        geo.computeBoundingSphere();
        const mesh = new THREE.InstancedMesh(geo, mat, roots.length);
        mesh.name = 'guide-signs-post-kit';
        mesh.frustumCulled = false;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        roots.forEach((d, i) => mesh.setMatrixAt(i, d.base));
        mesh.instanceMatrix.needsUpdate = true;
        group.add(mesh);
        signMats.push(mat);   // 统一在 dispose() 里释放
      });
    });
  }

  group.visible = guideSignsEnabled();

  return {
    group,
    signs: plan.signs,   // 只读布点结果，给验收脚本定位机位 / 审计用
    stats: plan.stats,
    setEnabled(on) { group.visible = !!on; },
    dispose() {
      scene.remove(group);
      group.traverse((o) => o.geometry?.dispose?.());
      signMats.forEach((m) => m.dispose());
      postMat.dispose();
      baseMat.dispose();
      leftTex.dispose();
      rightTex.dispose();
    },
  };
}

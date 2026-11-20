/**
 * 竞技场环形看台 —— 竞技场模式（mode==='arena'）专属视觉层。
 *
 * 背景替换：BOSS_ARENA 设了 noMountains: true，四周不再有远景山脊，
 * 改由这里用一圈看台把战场围合成「真正的竞技场」：
 *   - 看台沿正多边形边摆放（中心落在内切圆的 apothem 上、沿边方向），
 *     每个接缝故意重叠 ~3m，端墙互相咬合 → **整圈完全无缝**；
 *   - 观众是程序化人偶（两套姿势：坐观 / 举手欢呼），欢呼的随环绕人浪跳跃；
 *   - **每座看台顶上都有一块实时比分牌**（共享一张 CanvasTexture，
 *     数据由 Game 注入的 scoreProvider 提供，内容变化才重绘）。
 *
 * 设计约束（沿用湖泊看台的既有约定）：
 *   - 纯视觉，不写任何 colliders，不会造出空气墙（硬边界仍是 boundary.r）；
 *   - 确定性：只用固定步长 + 索引哈希，不用 Math.random()，联机两端一致；
 *   - 每类道具一个 InstancedMesh，整层不到 10 个 draw call。
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  buildStandGeometry, buildScreenGeometry,
  ROWS, RISE, TREAD, SEAT_TOP,
} from './LakeStadium.js';
import { STAND_LENGTH, STAND_DEPTH } from './LakeStadiumLayout.js';

/** 看台前沿距硬边界（米）：船被软夹在 boundary.r - 2.5，留出缓冲不贴脸 */
const FRONT_GAP = 4;
/**
 * 竞技场看台比湖泊看台高（6 排 → 10 排）。
 * 用户反馈"看台有点矮"，但要求"尽量把后面的天空露出来"，所以只加排数、
 * 每排高差与排距保持美术定过的 1.4 / 1.9m：座位顶 9.8m → 15.4m，
 * 顶棚 12.4m → 18.0m，抬头还能看到一圈天空。
 */
const ARENA_ROWS = 10;
const ARENA_ROOF_Y = SEAT_TOP + ARENA_ROWS * RISE + 2.6;
/**
 * 比分牌必须整块抬到顶棚之上。
 * 坑一（原地挡）：屏幕在局部 z=0、后墙在 z=+6.15，而雨棚前沿在 z=-4.5（朝场心一侧）。
 *   板体只要低于「看台最高点」（雨棚面 18.5m），从场心看就会被雨棚前沿切掉下沿。
 * 坑二（掠射挡）：只抬到 roofY+1.3 还不够 —— 水面机位（h≈2m）在 60m 外看过来，
 *   视线越过 18.5m 的雨棚前沿时会被抬到 18.0m，正好切掉板底。
 * 解：boardLift 6.2 → 板底 = roofY + 2.9 = 20.9m，
 *   h=2m 时 d≥35m 起、h=5m 时 d≥28m 起视线完全越过雨棚前沿，板底零遮挡；
 *   只剩「正上方那一座」（d≈13m，抬头仰视自己头顶的牌子）在物理上必然被切 ——
 *   真实球场同理，不考虑。
 */
const ARENA_SCREEN_LIFT = 6.2;
/** 每个接缝的重叠量（米）：正多边形边长 = STAND_LENGTH - OVERLAP，端墙互相咬合 */
const JOINT_OVERLAP = 2.4;

/** 确定性哈希：同一个 (a,b,c) 永远得到同一个 0~1 */
function hash3(a, b, c) {
  const v = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453;
  return v - Math.floor(v);
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** 比分牌底版：只画不随比分变的骨架（标题条/棋盘格/底色），比分区留给 redrawScore */
function makeArenaScreenBase() {
  const c = makeCanvas(512, 256);
  const x = c.getContext('2d');
  x.fillStyle = '#0a1420';
  x.fillRect(0, 0, 512, 256);
  x.fillStyle = '#123048';
  x.fillRect(0, 0, 512, 54);
  x.fillStyle = '#ff5c39';
  x.fillRect(0, 0, 10, 54);
  x.fillStyle = '#eaf3ff';
  x.font = 'bold 30px "Segoe UI",sans-serif';
  x.textBaseline = 'middle';
  x.fillText('激流竞技场 ARENA', 26, 29);
  for (let i = 0; i < 32; i++) {
    x.fillStyle = i % 2 ? '#e9eff5' : '#16202b';
    x.fillRect(i * 16, 54, 16, 12);
  }
  return c;
}

/** 在底版上重绘实时比分：名字 + 局分 + 血量条 + 阶段提示 */
function redrawScore(canvas, s) {
  const x = canvas.getContext('2d');
  // 只清比分区（标题条 54px + 棋盘格 12px 以下是动态区）
  x.fillStyle = '#0a1420';
  x.fillRect(0, 66, 512, 190);
  x.textBaseline = 'middle';
  x.textAlign = 'center';
  // 两侧名字（各限 9 字，超出截断）
  const trim = (t) => (String(t || '').length > 9 ? String(t).slice(0, 8) + '…' : String(t || ''));
  x.font = 'bold 26px "Segoe UI",sans-serif';
  x.fillStyle = '#7fb3e8';
  x.fillText(trim(s.myName), 120, 108);
  x.fillStyle = '#f0948a';
  x.fillText(trim(s.foeName), 392, 108);
  // 局分（大字）
  x.font = 'bold 74px "Segoe UI",sans-serif';
  x.fillStyle = '#4a9cf0';
  x.fillText(String(s.myScore ?? 0), 120, 172);
  x.fillStyle = '#f05a4a';
  x.fillText(String(s.foeScore ?? 0), 392, 172);
  x.fillStyle = '#5f7f9c';
  x.font = 'bold 44px "Segoe UI",sans-serif';
  x.fillText(':', 256, 172);
  // 血量条（HP 变化也重绘，让观众席大屏和场上血条同步）
  const bar = (cx, k, col) => {
    x.fillStyle = '#16283a';
    x.fillRect(cx - 78, 208, 156, 14);
    x.fillStyle = col;
    x.fillRect(cx - 78, 208, Math.round(156 * Math.max(0, Math.min(1, k))), 14);
  };
  bar(120, s.myHp ?? 1, '#4a9cf0');
  bar(392, s.foeHp ?? 1, '#f05a4a');
  // 阶段提示
  x.font = 'bold 22px "Segoe UI",sans-serif';
  x.fillStyle = '#ffd23f';
  const tag = s.phase === 'fight' ? `第 ${s.round ?? 1} 局 · 对决中`
    : s.phase === 'countdown' ? `第 ${s.round ?? 1} 局 · 准备中`
      : s.phase === 'matchEnd' ? '比赛结束' : '结算中';
  x.fillText(tag, 256, 108);
  x.textAlign = 'left';
}

/** 三角彩旗（白底靠 per-instance color 上色），挂在看台顶棚前沿 */
function makePennantTexture() {
  const c = makeCanvas(128, 128);
  const x = c.getContext('2d');
  x.clearRect(0, 0, 128, 128);
  x.fillStyle = '#ffffff';
  x.beginPath();
  x.moveTo(8, 16);
  x.lineTo(120, 16);
  x.lineTo(64, 116);
  x.closePath();
  x.fill();
  return new THREE.CanvasTexture(c);
}

// ---------------------------------------------------------------------------
// 观众人偶：程序化低模，两套姿势各合并成一个几何。
// 本地坐标：原点在脚底，Y 向上，+Z 朝看台外侧（背对战场，面朝场上才对——
// 看台在环外、观众面朝场心，所以实例摆放时整体绕 Y 转 180°，见下方 compose）。
// ---------------------------------------------------------------------------

function tinted(geo, hex) {
  const c = new THREE.Color(hex);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

function boxGeo(w, h, d, x, y, z, hex) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return tinted(g, hex);
}

/** 手臂：一根斜的小方柱，angle>0 表示上举（欢呼），0 表示垂在身侧 */
function armGeo(side, angle, hex) {
  const g = new THREE.BoxGeometry(0.11, 0.46, 0.13);
  g.translate(0, 0.23, 0);           // 支点挪到肩部，方便绕肩旋转
  g.rotateZ(side * angle);
  g.translate(side * 0.26, 0.86, 0); // 肩位
  return tinted(g, hex);
}

/** 坐观姿势：躯干 + 头 + 双臂垂下 */
function buildPuppetSitting() {
  const parts = [
    boxGeo(0.38, 0.72, 0.26, 0, 0.36, 0, 0xffffff),   // 腿+躯干一体柱
    boxGeo(0.24, 0.24, 0.24, 0, 0.9, 0, 0xffffff),    // 头
    armGeo(-1, 0.12, 0xffffff),
    armGeo(1, 0.12, 0xffffff),
  ];
  const merged = mergeGeometries(parts, false);
  parts.forEach((g) => g.dispose());
  merged.computeBoundingSphere();
  return merged;
}

/** 欢呼姿势：双臂高举过头（V 字），配上人浪跳跃就是「加油」 */
function buildPuppetCheering() {
  const parts = [
    boxGeo(0.38, 0.72, 0.26, 0, 0.36, 0, 0xffffff),
    boxGeo(0.24, 0.24, 0.24, 0, 0.9, 0, 0xffffff),
    armGeo(-1, 0.9, 0xffffff),
    armGeo(1, 0.9, 0xffffff),
  ];
  const merged = mergeGeometries(parts, false);
  parts.forEach((g) => g.dispose());
  merged.computeBoundingSphere();
  return merged;
}

/** 灯柱：架在看台后沿的场地照明杆（无缝环没有"入口"了，灯柱改挂后沿） */
function buildGateLightGeometry() {
  const parts = [
    boxGeo(0.24, 8.5, 0.24, 0, 4.25, 0, 0x707a84),
    boxGeo(1.5, 0.16, 0.16, 0.55, 8.3, 0, 0x707a84),
    boxGeo(0.7, 0.2, 0.3, 1.15, 8.12, 0, 0xfff4cf),
  ];
  const merged = mergeGeometries(parts, false);
  parts.forEach((g) => g.dispose());
  merged.computeBoundingSphere();
  return merged;
}

/**
 * 建整套竞技场看台层。返回 { group, stats, update, scoreInfo, dispose }。
 * @param {THREE.Scene} scene
 * @param {object} arenaDef BOSS_ARENA（只读 boundary.r）
 * @param {object} opts.scoreProvider 每次轮询返回实时比分
 *   { myName, foeName, myScore, foeScore, myHp, foeHp, round, phase }，没有就显示占位版
 */
export function createArenaStadium(scene, arenaDef, opts = {}) {
  const scoreProvider = opts.scoreProvider || null;
  const group = new THREE.Group();
  group.name = 'arena-stadium';
  scene.add(group);

  const r = arenaDef.boundary?.r ?? 92;
  // 无缝正多边形：内切圆半径（apothem）= 边长/(2·tan(π/n))。
  // n 取「apothem ≥ r + FRONT_GAP + 半进深」的最小值 → 16 座，前沿距边界 ≈6m。
  const rTarget = r + FRONT_GAP + STAND_DEPTH / 2;
  const n = Math.max(10, Math.ceil(Math.PI / Math.atan((STAND_LENGTH - JOINT_OVERLAP) / (2 * rTarget))));
  const ap = (STAND_LENGTH - JOINT_OVERLAP) / (2 * Math.tan(Math.PI / n));

  // 观众配色：主队蓝红 + 中性浅色，远看是两片助威方阵夹着路人
  const CROWD_COLORS = [
    0x2f6fbf, 0x2f6fbf, 0x4a86cf, 0xd03a2f, 0xd03a2f,
    0xe8ecf1, 0xe8ecf1, 0xd7dee6, 0xc2ccd6,
    0xf0a121, 0x3d5673,
  ];
  const PENNANT_COLORS = [0xff5c39, 0x2f6fbf, 0xf2f6fa, 0xffd23f];
  const crowdColor = new THREE.Color();
  const iPos = new THREE.Vector3();
  const iQuat = new THREE.Quaternion();
  const flip = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
  const iScale = new THREE.Vector3();

  // ---- 看台 / 观众 / 大屏 / 彩旗 / 入口灯柱 ----
  const standList = [];
  const sitting = [];   // 坐观人偶（静态）
  const cheering = [];  // 欢呼人偶（人浪动态）
  const screens = [];
  const pennants = [];
  const gateLights = [];

  for (let si = 0; si < n; si++) {
    const a = ((si + 0.5) / n) * Math.PI * 2;
    const ox = Math.cos(a);
    const oz = Math.sin(a);
    // 看台中心落在内切圆上（apothem 处），X 轴取该处切向 = 正多边形边方向，
    // 相邻看台沿边方向相距 (STAND_LENGTH - JOINT_OVERLAP)，端墙互相咬合 → 无缝
    const Z = new THREE.Vector3(ox, 0, oz);
    const X = new THREE.Vector3(oz, 0, -ox);
    const base = new THREE.Matrix4().makeBasis(X, new THREE.Vector3(0, 1, 0), Z);
    base.setPosition(ox * ap, 0, oz * ap);
    standList.push({ base });

    // 观众：每级台阶一排，确定性哈希留空座 + 分配姿势
    for (let i = 0; i < ARENA_ROWS; i++) {
      const zf = -STAND_DEPTH / 2 + 0.5 + i * TREAD;
      const y = SEAT_TOP + (i + 1) * RISE + 0.42;
      let col = 0;
      for (let u = -STAND_LENGTH / 2 + 1.4; u < STAND_LENGTH / 2 - 1.4; u += 1.15, col++) {
        const h = hash3(si + 1, i * 31 + 7, col * 13 + 3);
        if (h > 0.72) continue;                    // 约 28% 空座
        const h2 = hash3(si + 5, i * 17 + 1, col * 7 + 11);
        const m = new THREE.Matrix4();
        iPos.set(u + (h2 - 0.5) * 0.3, y, zf + 0.7 + h2 * 0.6);
        iScale.setScalar(0.9 + h2 * 0.22);
        // 人偶面朝场心：几何默认背朝场心（+Z 朝外），绕 Y 转 180°
        m.compose(iPos, iQuat.copy(flip), iScale);
        const entry = {
          base: new THREE.Matrix4().multiplyMatrices(base, m),
          color: CROWD_COLORS[Math.floor(h * 997) % CROWD_COLORS.length],
        };
        // 约四成欢呼（后排更多：站得高看得清，也符合「后排站起来」的直觉）
        if (hash3(si + 9, i * 7 + 3, col * 5 + 1) < 0.18 + i * 0.05) {
          entry.phase = a * 3 + u * 0.05 + h2 * 0.5;  // 人浪相位：绕环一圈三道浪
          entry.jy = y;
          cheering.push(entry);
        } else {
          sitting.push(entry);
        }
      }
    }

    // 顶棚前沿彩旗串
    for (let u = -STAND_LENGTH / 2 + 1.6, pi = 0; u < STAND_LENGTH / 2 - 1.6; u += 2.4, pi++) {
      const m = new THREE.Matrix4().makeTranslation(u, ARENA_ROOF_Y - 0.95, -4.72);
      pennants.push({
        base: new THREE.Matrix4().multiplyMatrices(base, m),
        color: PENNANT_COLORS[pi % PENNANT_COLORS.length],
      });
    }

    // 实时比分牌：**每座看台都挂一块**（同一张 CanvasTexture，玩家转到哪都能看到比分）
    {
      const m = new THREE.Matrix4().makeTranslation(0, 0, 1.5);
      const screenBase = new THREE.Matrix4().multiplyMatrices(base, m);
      // 屏面要和看台朝向一致（正面朝航道）：绕 Y 转 180°
      screens.push({ base: new THREE.Matrix4().multiplyMatrices(screenBase, new THREE.Matrix4().makeRotationY(Math.PI)) });
    }

    // 场地照明杆：挂看台后沿（无缝环没有豁口了），灯臂朝场心
    {
      const m = new THREE.Matrix4().makeRotationY(Math.PI - a);
      m.setPosition(ox * (ap + STAND_DEPTH / 2 + 1.2), 0, oz * (ap + STAND_DEPTH / 2 + 1.2));
      gateLights.push({ base: m });
    }
  }

  const standMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const rigMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  // 全部比分牌共享同一张 CanvasTexture：内容变化才 needsUpdate，N 块屏零额外开销
  const scoreCanvas = makeArenaScreenBase();
  const scoreTex = new THREE.CanvasTexture(scoreCanvas);
  const screenMat = new THREE.MeshBasicMaterial({ map: scoreTex, fog: true });
  const pennantMat = new THREE.MeshLambertMaterial({
    map: makePennantTexture(), transparent: true, alphaTest: 0.4, side: THREE.DoubleSide,
  });
  const sitMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const cheerMat = new THREE.MeshLambertMaterial({ vertexColors: true });

  const batches = [];
  const makeBatch = (geo, mat, list, name, opts = {}) => {
    if (!list.length) return null;
    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    mesh.name = name;
    mesh.frustumCulled = false;
    if (opts.dynamic) mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    list.forEach((d, i) => mesh.setMatrixAt(i, d.base));
    mesh.instanceMatrix.needsUpdate = true;
    if (opts.colors) {
      list.forEach((d, i) => {
        crowdColor.setHex(d.color ?? 0xffffff);
        mesh.setColorAt(i, crowdColor);
      });
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    group.add(mesh);
    batches.push({ mesh, list });
    return mesh;
  };

  makeBatch(buildStandGeometry({ rows: ARENA_ROWS }), standMat, standList, 'arena-stands');
  makeBatch(buildPuppetSitting(), sitMat, sitting, 'arena-crowd-sitting', { colors: true });
  makeBatch(buildPuppetCheering(), cheerMat, cheering, 'arena-crowd-cheering', { colors: true, dynamic: true });
  makeBatch(
    buildScreenGeometry({ roofY: ARENA_ROOF_Y, boardLift: ARENA_SCREEN_LIFT }),
    screenMat, screens, 'arena-screens',
  );
  makeBatch(buildGateLightGeometry(), rigMat, gateLights, 'arena-gate-lights');
  makeBatch(new THREE.PlaneGeometry(1.15, 0.95), pennantMat, pennants, 'arena-pennants', { colors: true });

  const tmp = new THREE.Matrix4();
  let scoreKey = '';
  let lastScore = null;
  let scoreAcc = 1;   // 首帧立即拉一次比分

  return {
    group,
    stats: {
      stands: n,
      sitting: sitting.length,
      cheering: cheering.length,
      screens: screens.length,
      pennants: pennants.length,
      gateLights: gateLights.length,
    },
    /** 当前比分牌上画着的数据（测试观测用） */
    scoreInfo() { return lastScore; },
    /** 人浪：欢呼人偶沿环绕场跳跃，相位差让波浪绕圈传播 */
    update(t, dt = 0.016) {
      if (!group.visible) return;
      // 每 0.5s 拉一次实时比分，内容有变才重绘 CanvasTexture
      scoreAcc += dt;
      if (scoreProvider && scoreAcc >= 0.5) {
        scoreAcc = 0;
        const s = scoreProvider() || null;
        const key = s ? JSON.stringify(s) : '';
        if (key !== scoreKey) {
          scoreKey = key;
          lastScore = s;
          if (s) redrawScore(scoreCanvas, s);
          scoreTex.needsUpdate = true;
        }
      }
      const batch = batches.find((b) => b.mesh.name === 'arena-crowd-cheering');
      if (!batch) return;
      for (let i = 0; i < batch.list.length; i++) {
        const d = batch.list[i];
        // 只取正半周的平方衰减：跳起-落下干脆，不像正弦那样悬在半空
        const s = Math.sin(t * 3.4 - d.phase);
        const jump = s > 0 ? s * s * 0.5 : 0;
        d.base.decompose(iPos, iQuat, iScale);
        iPos.y = d.jy + jump;
        tmp.compose(iPos, iQuat, iScale);
        batch.mesh.setMatrixAt(i, tmp);
      }
      batch.mesh.instanceMatrix.needsUpdate = true;
    },
    dispose() {
      scene.remove(group);
      group.traverse((o) => {
        o.geometry?.dispose?.();
        if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
        else o.material?.dispose?.();
      });
      scoreTex.dispose();
      pennantMat.map?.dispose();
    },
  };
}

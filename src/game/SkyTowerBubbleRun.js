import * as THREE from 'three';
import { SKY_TOWER, layerY } from '../data/skyTowerRun.js';
import { makeBubbleMaterial } from '../utils/bubbleMaterial.js';
import { cloneProp } from './propLoader.js';

/**
 * 第 2 层：泡泡送包子。
 *
 * 玩法（用户口径）
 * ----------------
 * 场地中央一个货物（包子），谁先碰到谁背着；背货的人极速 ×0.72、不能放泡泡；
 * 追的人按 K 在船头前方放一颗泡泡，**3 秒引信**，炸中持货者就掉货；
 * 谁先把货送到自己那一端的终点门，得 SCORE 分，货回中央重开。
 *
 * 视觉取素材的方式（和第一层那批"程序化几何体"的区别）
 * ----------------------------------------------------
 * - 终点门：`/models/props/flag_gate.glb`（赛道上现成的旗门），按开口尺寸缩放；
 * - 泡泡：`utils/bubbleMaterial.js` 里那套肥皂泡着色器（菲涅尔 + 薄膜干涉 + 高光），
 *   和巨鲸鲨吐的是同一份材质，只是这里尺寸更大、引信倒数时会长大；
 * - 包子：没有现成 GLB，用球面做形变（收口 + 八道褶）+ **canvas 现画的面皮贴图**
 *   （暖白底 + 面团斑 + 褶影），比纯色 MeshStandardMaterial 更像面食；
 * - 石台/光环：程序化但走 PBR + 发光环，和 GLB 放一起不违和。
 */

const D = SKY_TOWER.DELIVER;
const TWO_PI = Math.PI * 2;

/**
 * 面皮贴图：接近纯白 + 极淡的面团斑。
 * 第一版用暖白（#fffaf0）＋偏黄的暗斑，在这层夕阳天空下直接读成橘子色 ——
 * 天空是暖粉的，贴图再暖就叠加成橙色了；所以这里把底子压到冷白，
 * 褶子的明暗不靠贴图（会跟几何错位），改成烘进顶点色（见 makeBunGeometry）。
 */
function bunTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(0.55, '#fdfcfa');
  g.addColorStop(1, '#f0ece4');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);

  // 面团斑：大而淡的亮/暗块，模拟发酵的表面起伏（别偏黄，宁可用中性灰）
  for (let i = 0; i < 80; i++) {
    const x = Math.random() * 256;
    const y = Math.random() * 256;
    const r = 8 + Math.random() * 34;
    const dawn = Math.random() < 0.55;
    const rg = ctx.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0, dawn ? 'rgba(255,255,255,0.42)' : 'rgba(178,170,152,0.16)');
    rg.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = rg;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TWO_PI);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

/**
 * 包子：球面形变 —— 底部压平、顶部收口、绕一圈 8 道带螺旋的褶。
 * 关键点（第一版是个"光滑桃子的教训"）：
 * - 褶的振幅不能太小：5.5% 在 3.5m 的包子、夕阳平光下等于没有，读成一个圆球；
 * - 用 sign·|cos|^0.72 把脊线削利，纯 cos 的褶在动态光下会被磨平；
 * - 相位随高度轻微扭转（+t*2.6），像手工捏出来的螺旋褶，不是齿轮；
 * - 谷底压暗直接写进 vertexColors —— 贴图上的褶线和几何对不齐（UV 接缝在别处），
 *   只有顶点色能保证"暗的地方就是凹的地方"。
 */
function makeBunGeometry(r, seg = 56, ring = 36) {
  const geo = new THREE.SphereGeometry(1, seg, ring);
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  const colors = [];
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const t = (v.y + 1) / 2;                       // 0 底 → 1 顶
    const a = Math.atan2(v.z, v.x);
    // 收口：顶部往里收（真包子顶是被捏成小揪的），但别削成锥子
    const pinch = 1 - 0.34 * Math.max(0, (t - 0.5) / 0.5) ** 2;
    // 褶：只在上半身起褶，底部保持圆润
    const amp = 0.13 * Math.min(1, Math.max(0, (t - 0.12) / 0.5));
    const c = Math.cos(a * 8 + t * 2.6);
    const ridge = Math.sign(c) * Math.abs(c) ** 0.72;
    const pleat = 1 + ridge * amp;
    let x = v.x * pinch * pleat * r;
    let z = v.z * pinch * pleat * r;
    let y = v.y * r * 0.86;
    // 底部压平（蒸笼里坐出来的平底）
    if (y < -0.55 * r) y = -0.55 * r - (y + 0.55 * r) * 0.18;
    pos.setXYZ(i, x, y, z);
    // 谷暗脊亮：0.74 → 1.00，另外整体底部略暗一点
    const k = 0.74 + 0.26 * Math.max(0, c) * Math.min(1, Math.max(0, (t - 0.08) / 0.4));
    colors.push(k, k * 0.998, k * 0.99);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  return geo;
}

/**
 * 把 GLB 旗门整体换色（冷色那一侧用）。
 * 材质在实例之间是**共享**的（propLoader 为了省内存只 clone 物体、不 clone 材质），
 * 所以必须 clone 再改颜色，否则改一侧另一侧也跟着变色。
 * 两扇门原本长得一模一样，跑错门是常事 —— 整扇门染色比只染旗子更好认。
 */
function recolorGate(root, flagMain, flagAlt, frame = null) {
  const repaint = (m) => {
    const name = `${m?.name || ''}`;
    let col;
    if (/flag/i.test(name)) col = /yellow/i.test(name) ? flagAlt : flagMain;
    else if (frame !== null && /metal|float|frame/i.test(name)) col = frame;
    if (col === undefined || col === null) return m;
    const c = m.clone();
    c.color.set(col);
    c.needsUpdate = true;
    return c;
  };
  root.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    o.material = Array.isArray(o.material) ? o.material.map(repaint) : repaint(o.material);
  });
}

export class SkyTowerBubbleRun {  constructor(scene, opts = {}) {
    this.scene = scene;
    this.opts = opts;
    this.layer = D.LAYER;
    this.deckY = layerY(this.layer) + 0.30;
    this.fx = opts.fx || null;
    this.authority = opts.authority !== false;
    this.onScore = opts.onScore || (() => {});
    this.onEvent = opts.onEvent || (() => {});
    this.netSend = opts.netSend || (() => {});

    this.group = new THREE.Group();
    this.group.name = 'sky-tower-deliver';
    // 整组抬到第 2 层台面：之后所有子物体都用「台面 y=0」的局部坐标，
    // 别再混着写 this.deckY，否则地面线会被抬两次（第一版就是这么错的）
    this.group.position.y = this.deckY;
    scene.add(this.group);

    this.carrierId = null;
    this.cargo = { x: 0, z: 0, held: false };
    this.respawnIn = 0;
    this.bubbles = [];
    this.seq = 0;
    this.cooldown = new Map();
    this.scores = new Map();
    this.elapsed = 0;
    this.arriveFlash = 0;
    this.disposed = false;

    this.gateFx = [];
    this.bubbleMats = [];
    this.bubbleGeo = new THREE.SphereGeometry(1, 24, 16);

    this.#buildDeck();
    this.#buildGates();
    this.#buildPedestal();
    this.#buildCargo();
  }

  // ---------------------------------------------------------------- 场地

  #buildDeck() {
    const lineMat = new THREE.MeshBasicMaterial({
      color: 0xdff6ff, transparent: true, opacity: 0.35, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
    });
    const y = 0.012;
    // 石台 → 两端终点门的引导线：一眼看出"货要往哪送"。
    // 石台不在原点（原点被塔柱占着），所以这两条是斜的；长度和角度都要现算。
    for (const s of [-1, 1]) {
      const dx = s * D.GATE_X - 0;
      const dz = 0 - D.PEDESTAL_Z;
      const len = Math.hypot(dx, dz) - 6;
      const line = new THREE.Mesh(new THREE.BoxGeometry(len, 0.02, 0.26), lineMat);
      line.position.set(dx / 2, y, D.PEDESTAL_Z / 2);
      line.rotation.y = Math.atan2(dx, dz) - Math.PI / 2;
      this.group.add(line);
    }
    const ring = new THREE.Mesh(new THREE.TorusGeometry(8.5, 0.18, 6, 64), lineMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.set(0, y, D.PEDESTAL_Z);
    this.group.add(ring);
  }

  /** 两个终点门：先摆程序化的光幕 + 底座光环（GLB 到了再叠上去），保证任何情况下都能玩 */
  #buildGates() {
    this.gates = [];
    for (const s of [-1, 1]) {
      const x = s * D.GATE_X;
      const warm = s > 0;
      const tint = warm ? 0xffa25a : 0x6fd8ff;
      const holder = new THREE.Group();
      holder.position.set(x, 0, 0);
      this.group.add(holder);

      // 光幕：一张竖向渐变 + 细条纹的 canvas 贴图。
      // 第一版用加色混合 → 在这层明亮的夕阳天空前等于没画（加色只能提亮，天空已经够亮）。
      // 改成普通混合的染色玻璃，才看得出"这里是一道能量墙"。
      const curtain = new THREE.Mesh(
        new THREE.PlaneGeometry(D.GATE_SPAN, 9.5),
        new THREE.MeshBasicMaterial({
          map: this.#curtainTexture(tint),
          transparent: true, opacity: 0.52, depthWrite: false,
          blending: THREE.NormalBlending, side: THREE.DoubleSide,
        }),
      );
      curtain.rotation.y = Math.PI / 2;
      curtain.position.set(0, 4.9, 0);
      holder.add(curtain);
      // 地面判定环
      const zone = new THREE.Mesh(
        new THREE.RingGeometry(D.GATE_R - 0.5, D.GATE_R, 56),
        new THREE.MeshBasicMaterial({
          color: tint, transparent: true, opacity: 0.55,
          side: THREE.DoubleSide, depthWrite: false,
        }),
      );
      zone.rotation.x = -Math.PI / 2;
      zone.position.y = 0.03;
      holder.add(zone);
      const glowDisc = new THREE.Mesh(
        new THREE.CircleGeometry(D.GATE_R, 48),
        new THREE.MeshBasicMaterial({
          color: tint, transparent: true, opacity: 0.16,
          side: THREE.DoubleSide, depthWrite: false,
        }),
      );
      glowDisc.rotation.x = -Math.PI / 2;
      glowDisc.position.y = 0.02;
      holder.add(glowDisc);
      // 门楣上方的倒锥信标：远处也知道"货往这边送"
      const chevron = new THREE.Mesh(
        new THREE.ConeGeometry(1.7, 2.8, 4),
        new THREE.MeshBasicMaterial({ color: tint, transparent: true, opacity: 0.9 }),
      );
      chevron.rotation.x = Math.PI;      // 尖端朝下
      chevron.position.set(0, 11.2, 0);
      holder.add(chevron);
      this.gateFx.push({ curtain, zone, tint, chevron });
      this.gates.push({ side: s, x, zone, holder });

      // GLB 旗门：赛道上现成的 `/models/props/flag_gate.glb`（开口朝 ±Z，按 yaw 转 90°）
      cloneProp('/models/props/flag_gate.glb', D.GATE_SPAN, { by: 'max' })
        .then((model) => {
          if (this.disposed) return;
          model.rotation.y = Math.PI / 2;
          // 旗门底部贴地，往两侧各让一点，别挡在判定环正中
          model.position.set(0, 0, 0);
          model.traverse((o) => { if (o.isMesh) o.castShadow = true; });
          // 冷色那一侧的旗子染成蓝的：两扇门原本一模一样，跑错门是常事。
          // 门框保留原木色 —— 试过整体染蓝，metalness 0.75 的柱子会黑成两根炭
          if (!warm) recolorGate(model, 0x1b48cc, 0x8fc4ff);
          holder.add(model);
          holder.userData.glb = model;
        })
        .catch(() => { /* 没加载出来就只留光幕，玩法不受影响 */ });
    }
  }

  #curtainTexture(tint) {
    const c = document.createElement('canvas');
    c.width = 128; c.height = 256;
    const ctx = c.getContext('2d');
    const col = new THREE.Color(tint);
    const r = Math.round(col.r * 255), g = Math.round(col.g * 255), b = Math.round(col.b * 255);
    const grad = ctx.createLinearGradient(0, 256, 0, 0);
    grad.addColorStop(0, `rgba(${r},${g},${b},0.85)`);
    grad.addColorStop(0.55, `rgba(${r},${g},${b},0.22)`);
    grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 128, 256);
    // 竖向细条纹：让光幕有"扫描线"的电子感
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 10; i++) {
      const x = (i / 10) * 128 + 3;
      ctx.fillStyle = `rgba(255,255,255,0.10)`;
      ctx.fillRect(x, 0, 2, 256);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  /**
   * 取货台：货物摆在这儿，也是"货回台子"的落点。位置避开中央塔柱（见 PEDESTAL_Z 注释）。
   *
   * 造型迭代记录（都在截图上翻过车）：
   * 1) 直筒石墩 → 夕阳下像一只鼓；
   * 2) 两级台基 + 金色大环 → 像生日蛋糕，暖光把整块石头染成橙粉；
   * 3) 现在：一块**薄石台**（0.36m 高）+ 冷白刻环 + 从台面往上打的光柱。
   *    薄板读作"停机坪/取货点"，包子悬在光柱里也说得通（不需要台子把包子托住）。
   */
  #buildPedestal() {
    const pz = D.PEDESTAL_Z;
    const stone = new THREE.MeshStandardMaterial({
      // 带一点冷调：这层天空是暖粉的，石头用中性白会被染成橙色，和"夕阳下的石头"糊成一片
      color: 0xd8e4f5, roughness: 0.86, metalness: 0,
    });
    const slab = new THREE.Mesh(new THREE.CylinderGeometry(4.4, 4.9, 0.36, 36, 1), stone);
    slab.position.set(0, 0.18, pz);
    slab.castShadow = true;
    slab.receiveShadow = true;
    this.group.add(slab);

    // 光柱：货在台子上时一眼能找到，也用来"托住"悬空的包子
    this.beacon = new THREE.Mesh(
      new THREE.CylinderGeometry(2.0, 2.5, 15, 22, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xdff0ff, transparent: true, opacity: 0.09,
        side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
      }),
    );
    this.beacon.position.set(0, 7.5, pz);
    this.group.add(this.beacon);
  }

  // ---------------------------------------------------------------- 货物

  #buildCargo() {
    const holder = new THREE.Group();
    const bunMat = new THREE.MeshPhysicalMaterial({
      map: bunTexture(),
      vertexColors: true,
      color: 0xffffff,
      roughness: 0.68,
      metalness: 0,
      sheen: 0.6,
      sheenRoughness: 0.9,
      sheenColor: new THREE.Color(0xffffff),
      clearcoat: 0.10,
      clearcoatRoughness: 0.85,
      // 微弱的自发光把面皮往白里抬一点：这层是夕阳，纯靠反照率会被染成橙红
      emissive: new THREE.Color(0xffffff),
      emissiveIntensity: 0.10,
    });
    this.bunMesh = new THREE.Mesh(makeBunGeometry(1.75), bunMat);
    this.bunMesh.castShadow = true;
    holder.add(this.bunMesh);
    // 顶上的小揪：包子最容易认的特征，几何里做不出来（球面极点收不出结）。
    // 中心要抬到 1.56：包子顶极点在 1.505，放低了整个球埋在面里，只露出一条没受光的黑缝。
    // 材质必须单独一份且 vertexColors=false —— 小球几何没有 color 属性，
    // 复用带 vertexColors 的 bunMat 会渲染成黑块（第一版就是这么翻车的）。
    const knotMat = bunMat.clone();
    knotMat.vertexColors = false;
    const knot = new THREE.Mesh(new THREE.SphereGeometry(0.38, 20, 14), knotMat);
    knot.scale.set(1, 0.7, 1);
    knot.position.y = 1.56;
    knot.rotation.y = 0.6;
    knot.castShadow = true;
    holder.add(knot);
    this.bunKnot = knot;
    this.cargoGroup = holder;
    this.group.add(holder);
    this.#placeFreeCargo();
  }

  /**
   * 货回到场上。默认落点是石台（z=PEDESTAL_Z，不是原点 —— 原点是塔柱）；
   * 被泡泡炸掉时落在原地（谁先抢到算谁的），所以这里要能带坐标 ——
   * 老写法一刀切回石台，等于把"抢落点"这段玩法删了。
   */
  #placeFreeCargo(x = 0, z = D.PEDESTAL_Z) {
    this.cargo.held = false;
    this.cargo.x = x;
    this.cargo.z = z;
    this.respawnIn = 0;
    this.cargoReturn = false;
    this.cargoGroup.visible = true;
    this.beacon.visible = Math.abs(x) < 0.01 && Math.abs(z - D.PEDESTAL_Z) < 0.01;
  }

  // ---------------------------------------------------------------- 每帧

  /**
   * @param {number} dt
   * @param {Array<{id:string, boat:object, index:number}>} entries 第 2 层的船
   */
  update(dt, entries = []) {
    if (this.disposed) return;
    this.elapsed += dt;
    this._lastEntries = entries;
    for (const [k, v] of this.cooldown) this.cooldown.set(k, Math.max(0, v - dt));

    // 货的"重新可拾取"倒计时：送成/掉线 → 回中央；被炸 → 就落在原地
    if (!this.cargo.held && this.respawnIn > 0) {
      this.respawnIn -= dt;
      if (this.respawnIn <= 0) {
        this.respawnIn = 0;
        if (this.cargoReturn) this.#placeFreeCargo();
        this.cargoGroup.visible = true;
        this.fx?.play?.('ring', this.cargo.x, this.deckY + 2, this.cargo.z, 1.4);
      }
    }

    // 拾取：谁先碰到谁背（判定只在房主做，客机等 deliverGrab）
    if (this.authority && !this.cargo.held && this.respawnIn <= 0) {
      for (const e of entries) {
        const d = Math.hypot(e.boat.pos.x - this.cargo.x, e.boat.pos.z - this.cargo.z);
        if (d > D.CARGO_PICK_R) continue;
        this.#grab(e.id, e.index);
        break;
      }
    }

    // 送达判定（同样只在房主做）
    if (this.carrierId) {
      const e = entries.find((x) => x.id === this.carrierId);
      if (e && this.authority) {
        const gx = this.#gateX(e.index);
        if (Math.hypot(e.boat.pos.x - gx, e.boat.pos.z) < D.GATE_R) this.#deliver(e);
      } else if (this.authority) {
        // 持货者掉线/落海：货回中央（防"鬼握着货"）
        this.#dropCargo('lost');
      }
    }

    this.#updateBubbles(dt, entries);
    this.#updateVisuals(dt, entries);
  }

  #boatPos(id) {
    const e = this._lastEntries?.find((x) => x.id === id);
    return e ? { x: e.boat.pos.x, z: e.boat.pos.z } : null;
  }

  #gateX(index) {
    return (index % 2 === 0 ? -1 : 1) * D.GATE_X;
  }

  #grab(id, index) {
    this.carrierId = id;
    this.cargo.held = true;
    // 被背着期间 cargo.x/z 每帧跟着船更新（见 updateVisuals），这里只是先放个合理值
    this.cargo.x = 0; this.cargo.z = D.PEDESTAL_Z;
    this.beacon.visible = false;
    this.fx?.play?.('ring', 0, this.deckY + 2, D.PEDESTAL_Z, 1.6);
    this.onEvent({ type: 'grab', id, index });
    this.netSend({ t: 'deliverGrab', id });
  }

  #dropCargo(reason, at) {
    if (!this.carrierId) return;
    const who = this.carrierId;
    const pos = at || this.#boatPos(who);
    this.carrierId = null;
    this.cargo.held = false;
    // 被炸掉：落在原地，0.7 秒后谁都能捡；掉线之类的异常才回中央
    this.cargoReturn = reason === 'lost';
    this.respawnIn = reason === 'lost' ? D.CARGO_RESPAWN : 0.7;
    this.cargoGroup.visible = true;
    if (pos) { this.cargo.x = pos.x; this.cargo.z = pos.z; }
    this.fx?.play?.('ring', this.cargo.x, this.deckY + 2, this.cargo.z, 1.2);
    this.onEvent({ type: 'drop', id: who, reason });
    this.netSend({ t: 'deliverDrop', id: who, r: reason });
  }

  #deliver(e) {
    if (!this.carrierId) return;
    const id = this.carrierId;
    this.carrierId = null;
    this.cargo.held = false;
    this.cargoReturn = true;
    this.respawnIn = D.CARGO_RESPAWN;
    this.cargoGroup.visible = false;
    this.beacon.visible = false;
    this.scores.set(id, (this.scores.get(id) || 0) + 1);
    this.arriveFlash = 0.9;
    this.fx?.play?.('explosion', e.boat.pos.x, this.deckY + 2, e.boat.pos.z, 1.4);
    this.fx?.play?.('ring', e.boat.pos.x, this.deckY + 2, e.boat.pos.z, 2.2);
    this.onScore(id, D.SCORE, e.index);
    this.netSend({ t: 'deliverScore', id });
  }

  // ---------------------------------------------------------------- 泡泡

  /**
   * 放一个泡泡（K）。只有"没背货"的人能放 —— 这是这个玩法的核心不对称：
   * 背货的只能跑，追的才有火力。
   */
  fire(id, boat, index) {
    if (this.disposed || !boat) return false;
    if (this.carrierId === id) return false;
    if ((this.cooldown.get(id) || 0) > 0) return false;
    if (this.bubbles.filter((b) => b.owner === id && !b.dead).length >= D.BUBBLE_MAX) return false;
    const fx = Math.sin(boat.heading);
    const fz = Math.cos(boat.heading);
    const x = boat.pos.x + fx * D.BUBBLE_AHEAD;
    const z = boat.pos.z + fz * D.BUBBLE_AHEAD;
    const bubble = this.#addBubble({
      id: `${id}:${++this.seq}`,
      owner: id,
      x, z,
      vx: fx * D.BUBBLE_SPEED,
      vz: fz * D.BUBBLE_SPEED,
    });
    this.cooldown.set(id, D.BUBBLE_CD);
    this.fx?.play?.('ring', x, this.deckY + 2.4, z, 0.9);
    this.onEvent({ type: 'fire', id });
    this.netSend({
      t: 'bubbleSpawn', id: bubble.id, o: id,
      x: +x.toFixed(2), z: +z.toFixed(2), vx: +bubble.vx.toFixed(2), vz: +bubble.vz.toFixed(2),
    });
    return true;
  }

  #addBubble(spec) {
    const mat = makeBubbleMaterial({ tint: 0xcdf4ff, opacity: 1, rim: 1.1, phase: Math.random() * TWO_PI });
    const mesh = new THREE.Mesh(this.bubbleGeo, mat);
    const scale = 1.35;
    mesh.scale.setScalar(scale);
    mesh.position.set(spec.x, 2.6, spec.z);
    this.group.add(mesh);
    // 地面预警圈：引信最后 1 秒最亮，半径就是爆炸半径
    const warn = new THREE.Mesh(
      new THREE.RingGeometry(D.BUBBLE_R - 0.75, D.BUBBLE_R, 44),
      new THREE.MeshBasicMaterial({
        color: 0xff8a5a, transparent: true, opacity: 0,
        side: THREE.DoubleSide, depthWrite: false,
      }),
    );
    warn.rotation.x = -Math.PI / 2;
    warn.position.set(spec.x, 0.05, spec.z);
    this.group.add(warn);
    this.bubbleMats.push(mat);
    const b = {
      id: spec.id, owner: spec.owner,
      x: spec.x, z: spec.z, vx: spec.vx, vz: spec.vz,
      t: 0, dead: false, mesh, warn, mat, base: scale,
    };
    this.bubbles.push(b);
    return b;
  }

  #updateBubbles(dt, entries) {
    for (let i = this.bubbles.length - 1; i >= 0; i--) {
      const b = this.bubbles[i];
      b.mat.uniforms.uTime.value = this.elapsed;
      b.t += dt;
      const u = Math.min(1, b.t / D.BUBBLE_FUSE);

      // 飞行：阻尼衰减到停，然后原地飘
      const sp = Math.hypot(b.vx, b.vz);
      if (sp > 0.01) {
        const k = Math.max(0, sp - D.BUBBLE_DRAG * dt) / sp;
        b.vx *= k; b.vz *= k;
        b.x += b.vx * dt; b.z += b.vz * dt;
      }
      // 引信越长长得越大：远看就知道"这颗快炸了"
      const sc = b.base * (1 + u * 0.42);
      b.mesh.scale.setScalar(sc);
      b.mesh.position.set(b.x, 2.6 + Math.sin(this.elapsed * 2.4 + i) * 0.18 + u * 0.5, b.z);
      b.warn.position.set(b.x, 0.05, b.z);
      b.warn.material.opacity = u > 0.45 ? ((u - 0.45) / 0.55) * 0.85 : 0;
      if (u > 0.82) {
        const pulse = 0.5 + Math.sin(this.elapsed * 18) * 0.5;
        b.warn.material.opacity = 0.45 + pulse * 0.45;
      }

      if (b.t >= D.BUBBLE_FUSE) this.#popBubble(b, entries);
    }
  }

  #popBubble(b, entries) {
    b.dead = true;
    b.mesh.visible = false;
    b.warn.visible = false;
    this.group.remove(b.mesh);
    this.group.remove(b.warn);
    b.mesh.material.dispose();
    b.warn.geometry.dispose();
    b.warn.material.dispose();
    this.bubbleMats = this.bubbleMats.filter((m) => m !== b.mat);
    this.bubbles = this.bubbles.filter((x) => x !== b);

    this.fx?.play?.('explosion', b.x, this.deckY + 2.6, b.z, 1.1);
    this.fx?.play?.('ring', b.x, this.deckY + 1.2, b.z, 1.8);
    this.onEvent({ type: 'pop', id: b.owner, x: b.x, z: b.z });
    this.netSend({ t: 'bubblePop', b: b.id, x: +b.x.toFixed(2), z: +b.z.toFixed(2) });

    // 判定只由房主做：命中持货者 → 掉货 + 僵直
    if (!this.authority) return;
    const carrier = entries.find((e) => e.id === this.carrierId);
    if (!carrier) return;
    const d = Math.hypot(carrier.boat.pos.x - b.x, carrier.boat.pos.z - b.z);
    if (d > D.BUBBLE_R) return;
    carrier.boat.stunTimer = Math.max(carrier.boat.stunTimer || 0, D.STUN);
    carrier.boat.vel.multiplyScalar(0.5);
    this.#dropCargo('bubble', { x: b.x, z: b.z });
    this.onEvent({ type: 'hit', id: this.carrierId, by: b.owner });
  }

  // ---------------------------------------------------------------- 视觉

  #updateVisuals(dt, entries) {
    const bob = Math.sin(this.elapsed * 1.8) * 0.16;
    if (this.beacon.visible) {
      this.beacon.material.opacity = 0.055 + Math.sin(this.elapsed * 1.6) * 0.018;
    }

    if (this.carrierId) {
      const e = entries.find((x) => x.id === this.carrierId);
      if (e) {
        const boat = e.boat;
        // 背在船尾上方：跟着船走，留一点点滞后才有"背着东西"的重量感。
        // 3.0 试过，读起来是"包子悬在船上飘"，压到 2.0 才像驮着。
        const back = 1.6;
        const tx = boat.pos.x - Math.sin(boat.heading) * back;
        const tz = boat.pos.z - Math.cos(boat.heading) * back;
        const k = 1 - Math.exp(-9 * dt);
        this.cargoGroup.position.x += (tx - this.cargoGroup.position.x) * k;
        this.cargoGroup.position.z += (tz - this.cargoGroup.position.z) * k;
        this.cargoGroup.position.y = (boat.pos.y - this.deckY) + 2.0 + bob * 0.6;
        this.cargoGroup.rotation.y += dt * 1.2;
        this.cargo.x = boat.pos.x;
        this.cargo.z = boat.pos.z;
        this.beacon.visible = false;
      }
    } else {
      // 自由状态：在石台上方悬浮旋转
      const k = 1 - Math.exp(-8 * dt);
      this.cargoGroup.position.x += (this.cargo.x - this.cargoGroup.position.x) * k;
      this.cargoGroup.position.z += (this.cargo.z - this.cargoGroup.position.z) * k;
      this.cargoGroup.position.y = 3.0 + bob;
      this.cargoGroup.rotation.y += dt * 0.9;
      this.cargoGroup.visible = this.respawnIn <= 0.001;
    }

    // 终点光幕呼吸 + 送达瞬间闪一下
    this.arriveFlash = Math.max(0, this.arriveFlash - dt);
    for (let i = 0; i < this.gateFx.length; i++) {
      const g = this.gateFx[i];
      g.curtain.material.opacity = 0.46 + Math.sin(this.elapsed * 1.7) * 0.07 + this.arriveFlash * 0.3;
      g.zone.material.opacity = 0.42 + Math.sin(this.elapsed * 1.7 + 1.2) * 0.10;
      if (g.chevron) {
        g.chevron.rotation.y += dt * 1.1;
        g.chevron.position.y = 11.2 + Math.sin(this.elapsed * 1.9 + i * 2) * 0.45;
      }
    }
  }

  // ---------------------------------------------------------------- 对外

  /** 谁背着货（mode 用来写 boat.speedMul / 禁冲刺） */
  isCarrier(id) {
    return this.carrierId === id;
  }

  /**
   * AI 决策：背货 → 冲向自己那端的终点；没背 → 追持货者并放泡泡；货空着 → 去抢。
   * @returns {{x:number,z:number,fire:boolean}} 目标点 + 是否该放泡泡
   */
  aiPlan(id, index, boats) {
    if (this.carrierId === id) {
      return { x: this.#gateX(index), z: 0, fire: false };
    }
    if (this.carrierId) {
      const b = boats?.get?.(this.carrierId);
      if (b) {
        const d = Math.hypot(b.pos.x - (boats.get(id)?.pos.x ?? 0), b.pos.z - (boats.get(id)?.pos.z ?? 0));
        return { x: b.pos.x, z: b.pos.z, fire: d < 34 && d > 8 };
      }
    }
    return { x: this.cargo.x, z: this.cargo.z, fire: false };
  }

  /** 网络：接收房主广播 */
  applyNet(e) {
    if (!e) return;
    if (e.t === 'bubbleSpawn') {
      if (this.bubbles.some((b) => b.id === e.id)) return;
      this.#addBubble({ id: e.id, owner: e.o, x: e.x, z: e.z, vx: e.vx || 0, vz: e.vz || 0 });
    } else if (e.t === 'bubblePop') {
      const b = this.bubbles.find((x) => x.id === e.b);
      if (b) {
        b.dead = true;
        this.group.remove(b.mesh);
        this.group.remove(b.warn);
        this.bubbles = this.bubbles.filter((x) => x !== b);
        this.fx?.play?.('ring', e.x, this.deckY + 1.2, e.z, 1.6);
      }
    } else if (e.t === 'deliverGrab') {
      this.carrierId = e.id;
      this.cargo.held = true;
      this.beacon.visible = false;
    } else if (e.t === 'deliverDrop') {
      this.carrierId = null;
      this.cargo.held = false;
      this.respawnIn = D.CARGO_RESPAWN;
    } else if (e.t === 'deliverScore') {
      this.scores.set(e.id, (this.scores.get(e.id) || 0) + 1);
      this.carrierId = null;
      this.cargo.held = false;
      this.respawnIn = D.CARGO_RESPAWN;
      this.arriveFlash = 0.9;
    }
  }

  state() {
    return {
      carrier: this.carrierId,
      held: this.cargo.held,
      bubbles: this.bubbles.length,
      scores: Object.fromEntries(this.scores),
    };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const ms = Array.isArray(o.material) ? o.material : [o.material];
        ms.forEach((m) => m.dispose());
      }
    });
    this.scene.remove(this.group);
    this.bubbleGeo?.dispose();
  }
}

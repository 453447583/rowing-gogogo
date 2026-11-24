import * as THREE from 'three';
import { SKY_TOWER, layerY, layerRadius } from '../data/skyTowerRun.js';

/**
 * 云端天梯的"赛道"层：接口对齐 BossArena/Track，让 Game 的物理主循环原样跑。
 *
 * 关键点：
 * - Game 每帧调 boat.updateLocal(..., colliders, boundary)，浮力来自 waveHeight。
 *   我们用 boat.diveTargetY 把船钉在平台高度（Boat.#applyPose 的接管通道，
 *   见 Boat.js:3205），所以船是在"空中平台"上开，不是在水上。
 * - constrain() 做平台边界：开出当前层半径就算坠落 → 交给 mode 处理。
 * - 浮空上升（2026-11-24 去掉螺旋梯）：开进"升降光柱"后进入 liftRide，
 *   船原地垂直浮起到上一层，像被光托上去；前 60 秒通道关闭，由 mode 调
 *   setUpliftOpen() 解锁。
 */
const TWO_PI = Math.PI * 2;
const LIFT_H = SKY_TOWER.LAYER_Y[1] - SKY_TOWER.LAYER_Y[0];

export class SkyTowerArena {
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.opts = opts;
    this.gates = [0, 1];
    this.gateWidth = 0;
    this.shoreColliders = [];
    this.mechColliders = [];
    this.dives = [];
    this.openTrack = false;
    this.radius = layerRadius(0) + 6;
    this.boundary = { x: 0, z: 0, r: this.radius };
    this.group = new THREE.Group();
    this.group.name = 'sky-tower-arena';
    scene.add(this.group);
    this.disposed = false;

    // 浮空升降光柱：每层一个，位置在平台内侧。收集期内关闭（暗红色），
    // 1 分钟后由 mode 统一开启（青色），船开进去就垂直浮起。
    this.upliftOpen = false;
    this.uplinks = SKY_TOWER.LAYER_Y.slice(0, -1).map((y, i) => ({
      x: Math.cos(this.#uplinkAngle(i)) * layerRadius(i) * 0.38,
      z: Math.sin(this.#uplinkAngle(i)) * layerRadius(i) * 0.38,
      y,
      layer: i,
      r: SKY_TOWER.UPLINK_R,
    }));
    this.#buildUplinkRings();
  }

  #uplinkAngle(i) { return 0.35 + i * 1.1; }

  #buildUplinkRings() {
    this.uplinkMeshes = [];
    for (const up of this.uplinks) {
      const g = new THREE.Group();
      g.position.set(up.x, up.y + 0.4, up.z);
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(up.r, 0.22, 8, 48),
        new THREE.MeshBasicMaterial({ color: 0xff6b6b, transparent: true, opacity: 0.55 }),
      );
      ring.rotation.x = Math.PI / 2;
      g.add(ring);
      // 一根通透的升降光柱（不是螺旋梯）：关闭时暗、开启时亮
      const column = new THREE.Mesh(
        new THREE.CylinderGeometry(up.r * 0.78, up.r * 0.9, LIFT_H, 24, 1, true),
        new THREE.MeshBasicMaterial({
          color: 0x66d0ff, transparent: true, opacity: 0.08,
          side: THREE.DoubleSide, depthWrite: false,
        }),
      );
      column.position.y = LIFT_H / 2;
      g.add(column);
      // 柱内三道上升的细光环，让"浮空上升"有方向感
      const marks = [];
      for (let k = 0; k < 3; k++) {
        const m = new THREE.Mesh(
          new THREE.TorusGeometry(up.r * 0.62, 0.09, 6, 36),
          new THREE.MeshBasicMaterial({ color: 0x9ff5ff, transparent: true, opacity: 0.22 }),
        );
        m.rotation.x = Math.PI / 2;
        m.position.y = 2 + k * (LIFT_H - 4) / 3;
        g.add(m);
        marks.push(m);
      }
      g.userData = { ring, column, marks };
      this.group.add(g);
      this.uplinkMeshes.push(g);
    }
  }

  /** 收集期结束才打开上升通道（视觉与判定同步） */
  setUpliftOpen(open) {
    if (this.upliftOpen === !!open) return;
    this.upliftOpen = !!open;
    for (const g of this.uplinkMeshes) {
      const { ring, column, marks } = g.userData;
      ring.material.color.setHex(this.upliftOpen ? 0x9ff5ff : 0xff6b6b);
      ring.material.opacity = this.upliftOpen ? 0.95 : 0.5;
      column.material.opacity = this.upliftOpen ? 0.2 : 0.05;
      marks.forEach((m) => { m.material.opacity = this.upliftOpen ? 0.55 : 0.12; });
    }
  }

  /** 出生点：底层平台均匀排布，全部朝向塔心 */
  spawnTransform(index, count = 1) {
    const n = Math.max(1, count);
    const r = layerRadius(0) * 0.66;
    const a = (index / n) * TWO_PI + Math.PI * 0.25;
    return {
      x: Math.cos(a) * r,
      z: Math.sin(a) * r,
      y: layerY(0),
      heading: Math.atan2(-Math.cos(a), -Math.sin(a)),
      layer: 0,
    };
  }

  /** 让船贴在当前层的平台高度（在 Game 调用 updateLocal 之前，由 mode.driveBoat 写入） */
  deckYFor(boat) {
    if (boat.liftRide) return boat.liftRide.y;
    const layer = boat.skyLayer ?? 0;
    return layerY(layer) + 0.4;
  }

  /** 当前点是否在某层平台内 */
  static layerAt(x, z) {
    for (let i = SKY_TOWER.LAYER_Y.length - 1; i >= 0; i--) {
      if (Math.hypot(x, z) <= layerRadius(i)) return i;
    }
    return -1;
  }

  /**
   * 边界 + 浮空升降推进。Game 的 track.constrain 在船更新之后调用。
   */
  constrain(boat, dt = 1 / 60) {
    if (this.disposed) return;
    // 浮空上升中：垂直推进，不绕圈
    if (boat.liftRide) {
      this.#advanceLift(boat, dt);
      return;
    }
    // 落海动画期间由 SkyTowerMode.#updateWaterFalls 独占推进高度/位置：
    // 这里一旦把 diveTargetY 拉回平台高度，船就会被"弹"回第一层，摔不下去了
    if (boat.skyFall) return;
    const layer = boat.skyLayer ?? 0;
    const R = layerRadius(layer);
    const d = Math.hypot(boat.pos.x, boat.pos.z);
    // 船体轮廓外缘超出平台 → 坠落（留 0.8m 宽容，避免刚贴边就掉）
    if (d > R + 0.8) {
      this.opts.onFall?.(boat, layer);
      return;
    }
    // 贴平台高度；升降光柱附近不硬夹，交给上升流程
    boat.diveTargetY = layerY(layer) + 0.4;
    boat.airborne = false;
    boat.onCoaster = false;
    this.#tryUplink(boat, layer);
  }

  #tryUplink(boat, layer) {
    if (!this.upliftOpen || layer >= SKY_TOWER.LAYER_Y.length - 1) return;
    const now = performance.now();
    if ((boat.skyUplinkAt || 0) > now - 2600) return;
    // 进入光柱就浮起：不需要速度门槛，慢速开进去也能上楼
    const up = this.uplinks[layer];
    if (Math.hypot(boat.pos.x - up.x, boat.pos.z - up.z) > up.r) return;
    boat.skyUplinkAt = now;
    const toLayer = layer + 1;
    // 落点收进上层平台内侧，避免刚落地就贴边
    const landR = Math.min(Math.hypot(boat.pos.x, boat.pos.z), layerRadius(toLayer) * 0.55);
    const a = Math.atan2(boat.pos.z, boat.pos.x);
    boat.liftRide = {
      t: 0,
      dur: SKY_TOWER.LIFT_TIME,
      fromY: boat.pos.y,
      toY: layerY(toLayer) + 0.4,
      fromX: boat.pos.x, fromZ: boat.pos.z,
      toX: Math.cos(a) * landR, toZ: Math.sin(a) * landR,
      heading: boat.heading,
      layer,
      toLayer,
    };
    boat.airborne = false;
    boat.vy = 0;
    this.opts.onClimb?.(boat, toLayer);
  }

  /** 垂直浮空上升：位置从下层光柱平滑升到上层落点，朝向保持 */
  #advanceLift(boat, dt) {
    const r = boat.liftRide;
    r.t = Math.min(1, r.t + dt / r.dur);
    const e = r.t * r.t * (3 - 2 * r.t); // smoothstep
    boat.pos.set(
      THREE.MathUtils.lerp(r.fromX, r.toX, e),
      THREE.MathUtils.lerp(r.fromY, r.toY, e),
      THREE.MathUtils.lerp(r.fromZ, r.toZ, e),
    );
    boat.heading = r.heading;
    boat.vy = 0;
    boat.vel.set(0, 0, 0);
    boat.speed = 0;
    boat.diveTargetY = boat.pos.y;
    if (r.t >= 1) {
      boat.liftRide = null;
      boat.skyLayer = r.toLayer;
      this.opts.onLanded?.(boat, r.toLayer);
    }
  }

  surfaceYAt(x, z) {
    const layer = SkyTowerArena.layerAt(x, z);
    return layer >= 0 ? layerY(layer) + 0.3 : null;
  }

  applyMechs() {}
  updateMechs() {}
  updateVisual() {}
  updateCoaster() {}
  keepAfterFinishLine() {}
  setBuoyPalette() {}
  checkGate() { return false; }
  isWrongWay() { return false; }
  progressRatio() { return 0; }
  progress() { return 0; }
  aiShortcutTarget() { return null; }
  diveHeightAt() { return null; }
  faultAt() { return null; }
  lateralAt() { return 0; }
  arcAt() { return { s: 0 }; }
  gatePos() { return { x: 0, z: 0 }; }
  respawnPoint(x, z) { return { x, z, heading: 0 }; }

  /** 货物模型：水晶/星核用多面体 + 自发光；土豆用变形球 + 哑光，不做丑几何体 */
  static makeCargoMesh(type) {
    const g = new THREE.Group();
    if (type.id === 'potato') {
      const geo = new THREE.IcosahedronGeometry(0.62, 1);
      const pos = geo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const k = 0.9 + Math.sin(i * 2.7) * 0.09;
        pos.setXYZ(i, pos.getX(i) * k * 1.18, pos.getY(i) * k * 0.82, pos.getZ(i) * k);
      }
      geo.computeVertexNormals();
      g.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        color: type.color, roughness: 0.92, metalness: 0,
        emissive: 0x3a2306, emissiveIntensity: 0.35,
      })));
    } else if (type.id === 'crystal') {
      const gem = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.72, 0),
        new THREE.MeshStandardMaterial({
          color: type.color, roughness: 0.12, metalness: 0.35,
          emissive: type.color, emissiveIntensity: 0.95,
          transparent: true, opacity: 0.92, flatShading: true,
        }),
      );
      gem.scale.y = 1.35;
      g.add(gem);
    } else {
      const core = new THREE.Mesh(
        new THREE.IcosahedronGeometry(0.72, 1),
        new THREE.MeshStandardMaterial({
          color: 0xfff0b0, roughness: 0.1, metalness: 0.5,
          emissive: type.color, emissiveIntensity: 1.6,
        }),
      );
      g.add(core);
      const halo = new THREE.Mesh(
        new THREE.TorusGeometry(1.05, 0.055, 6, 36),
        new THREE.MeshBasicMaterial({ color: type.color, transparent: true, opacity: 0.85 }),
      );
      halo.rotation.x = Math.PI / 2.4;
      g.add(halo);
      g.userData.halo = halo;
    }
    g.scale.setScalar(type.scale || 1);
    return g;
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
  }
}

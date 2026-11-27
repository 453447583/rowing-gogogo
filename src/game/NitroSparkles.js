// 流光号尾焰的「紫色风尾」——纯 three.js 粒子层，叠在 Effekseer 三束雷光外面。
//
// 为什么单独一层：Effekseer 的三束蓝紫光束（N_MagicThunder）形状够帅但偏「单薄」，
// 玩家要的是「光束外面再裹一层随风向后飘散的紫色粒子」。这些粒子全部留在世界空间、
// 不跟船，船一开就自然甩在身后 → 读作「风把紫雾吹散」。
//
// 性能设计：
//   · 单个 THREE.Points + 一个 BufferGeometry（单次 draw call），240 个粒子封顶；
//   · 池化复用，零每帧 new / 零 GC；位置和颜色各一个 DynamicDrawUsage attribute；
//   · 加法混合 + 柔边圆贴图 → 被 PostFx 的 bloom 抓到，自带「发光」。
// 淡出靠「颜色乘生命二次方」：加法混合下颜色→0 就等于透明，不需要逐粒子 alpha。
import * as THREE from 'three';

let sparkleTexture = null;
function getSparkleTexture() {
  if (sparkleTexture) return sparkleTexture;
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  // 中心亮、外圈迅速柔化：小尺寸贴图也能读出「一团发光的紫雾」
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,0.95)');
  g.addColorStop(0.35, 'rgba(230,205,255,0.55)');
  g.addColorStop(0.75, 'rgba(180,140,255,0.16)');
  g.addColorStop(1, 'rgba(150,110,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  sparkleTexture = new THREE.CanvasTexture(canvas);
  sparkleTexture.colorSpace = THREE.SRGBColorSpace;
  return sparkleTexture;
}

export class NitroSparkles {
  /**
   * @param {THREE.Scene} scene
   * @param {object} opts { max, size, color, rate, minLife, maxLife, rise, drag }
   */
  constructor(scene, opts = {}) {
    this.max = opts.max ?? 240;
    this.size = opts.size ?? 0.8;
    this.baseColor = new THREE.Color(opts.color ?? 0x9b6bff);
    this.rate = opts.rate ?? 96;          // 每秒发射数（只在加速时）
    this.minLife = opts.minLife ?? 0.7;
    this.maxLife = opts.maxLife ?? 1.25;
    this.rise = opts.rise ?? 1.15;        // 上浮加速度（紫雾往上升）
    this.drag = opts.drag ?? 1.5;         // 速度衰减
    this.maxPerFrame = opts.maxPerFrame ?? 7;

    this.pos = new Float32Array(this.max * 3);
    this.col = new Float32Array(this.max * 3);
    this.vel = new Float32Array(this.max * 3);
    this.life = new Float32Array(this.max);
    this.full = new Float32Array(this.max);
    this.cursor = 0;
    this.emitAcc = 0;
    this.time = 0;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry = geo;

    this.material = new THREE.PointsMaterial({
      map: getSparkleTexture(),
      size: this.size,
      sizeAttenuation: true,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      vertexColors: true,
      opacity: 1,
      fog: false,
    });

    this.points = new THREE.Points(geo, this.material);
    // 粒子会甩到船后十几米，包围盒不容易算准 → 直接关掉视锥剔除，别出现「转头就没」
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
    scene.add(this.points);

    // 取喷口世界坐标用的临时向量（3 个喷口轮流用，避免每帧 new）
    this._tmpV = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  }

  /**
   * 商城喷射皮肤切换时只改参数，不重建粒子池（池按最大的 240 预分配好了）。
   * 仍然只在加速时发射，绝不改船速 / 氮气时长。
   */
  configure(opts = {}) {
    const n = Math.round(Number(opts.max) || 0);
    if (n > 0) this.max = Math.min(this.life.length, n);
    const s = Number(opts.size);
    if (s > 0) { this.size = s; this.material.size = s; }
    if (opts.color != null) this.baseColor.set(opts.color);
    for (const k of ['rate', 'minLife', 'maxLife', 'rise', 'drag']) {
      const v = Number(opts[k]);
      if (Number.isFinite(v) && v > 0) this[k] = v;
    }
    if (this.minLife > this.maxLife) this.minLife = this.maxLife;
    this.emitAcc = 0;
    return this;
  }

  /** 发射一颗：出生在喷口，初速 = 一部分船速 + 船尾方向喷射 + 随机侧向，之后交给 update 飘散 */
  spawn(x, y, z, heading, speed = 0) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.max;
    const i3 = i * 3;
    const fwdX = Math.sin(heading), fwdZ = Math.cos(heading);     // 船前进方向
    const backX = -fwdX, backZ = -fwdZ;                           // 船尾方向
    const sideX = Math.cos(heading), sideZ = -Math.sin(heading);  // 侧向
    const side = (Math.random() - 0.5) * 2;
    // ⚠ 关键：粒子必须「带走一部分船速」（0.65），否则 30m/s 的船会瞬间把它甩出
    //   光束长度之外，紫色就只剩喷口一小团、飘不到光束后段。带 65% 后相对船每 0.5s
    //   只后退 ~5m，正好铺满三束光束的长度；剩下 35% 的差速就是「随风向后飘」。
    const carry = speed * 0.65;
    const spd = 2.2 + Math.random() * 3.4;
    this.pos[i3] = x + (Math.random() - 0.5) * 0.36;
    this.pos[i3 + 1] = y + (Math.random() - 0.5) * 0.3;
    this.pos[i3 + 2] = z + (Math.random() - 0.5) * 0.36;
    this.vel[i3] = fwdX * carry + backX * spd + sideX * side * 2.6;
    this.vel[i3 + 1] = 0.6 + Math.random() * 1.5;
    this.vel[i3 + 2] = fwdZ * carry + backZ * spd + sideZ * side * 2.6;
    this.life[i] = this.full[i] = this.minLife + Math.random() * (this.maxLife - this.minLife);
    const c = this.baseColor;
    this.col[i3] = c.r;
    this.col[i3 + 1] = c.g;
    this.col[i3 + 2] = c.b;
  }

  /**
   * @param {number} dt
   * @param {{active:boolean, anchors:THREE.Object3D[], heading:number}|null} emit
   */
  update(dt, emit) {
    this.time += dt;
    const { pos, col, vel, life, full } = this;
    const c = this.baseColor;
    const k = Math.max(0, 1 - this.drag * dt);
    const t = this.time;

    for (let i = 0; i < this.max; i++) {
      if (life[i] <= 0) continue;
      const i3 = i * 3;
      life[i] -= dt;
      if (life[i] <= 0) { col[i3] = col[i3 + 1] = col[i3 + 2] = 0; continue; }
      // 阻力 + 上浮 + 一点横向湍流（用索引当固定相位，避免每帧 random）
      vel[i3] *= k;
      vel[i3 + 2] *= k;
      vel[i3 + 1] = vel[i3 + 1] * k + this.rise * dt;
      const ph = i * 1.7;
      vel[i3] += Math.sin(t * 2.3 + ph) * 1.7 * dt;
      vel[i3 + 2] += Math.cos(t * 2.1 + ph) * 1.7 * dt;
      pos[i3] += vel[i3] * dt;
      pos[i3 + 1] += vel[i3 + 1] * dt;
      pos[i3 + 2] += vel[i3 + 2] * dt;
      // 淡出：颜色按生命 1.35 次方衰减（比二次方更「耐看」一点，紫雾能拖到光束后段；
      // 加法混合下颜色→0 就等于透明，不需要逐粒子 alpha）
      const a = life[i] / full[i];
      const f = Math.pow(a, 1.35);
      col[i3] = c.r * f;
      col[i3 + 1] = c.g * f;
      col[i3 + 2] = c.b * f;
    }

    if (emit && emit.active && emit.anchors && emit.anchors.length) {
      this.emitAcc += dt * this.rate;
      let n = Math.min(Math.floor(this.emitAcc), this.maxPerFrame);
      if (n > 0) {
        this.emitAcc -= n;
        const list = emit.anchors;
        for (let k2 = 0; k2 < n; k2++) {
          const idx = (Math.random() * list.length) | 0;
          const a = list[idx];
          if (!a) continue;
          const v = this._tmpV[idx % 3];
          a.getWorldPosition(v);
          this.spawn(v.x, v.y, v.z, emit.heading, emit.speed || 0);
        }
      } else if (this.emitAcc > 2) {
        this.emitAcc = 0; // 掉帧后别攒一大堆一次性喷出来
      }
    }

    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.color.needsUpdate = true;
  }

  dispose() {
    this.points.parent?.remove(this.points);
    this.geometry.dispose();
    this.material.dispose();
  }
}

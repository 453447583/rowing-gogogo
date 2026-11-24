import * as THREE from 'three';

/**
 * BOSS 死亡大光圈。
 *
 * 旧版是 Effekseer 的一张平面贴图在原地放大，玩家能明显看出是二维片。
 * 这里改成三层叠加：
 *   1. 地面冲击环：贴着水面向外扩到 70m，真实 3D 透视；
 *   2. 竖立冲击环：始终面向相机，从 BOSS 身上向外炸开；
 *   3. 全屏光圈 + 色闪：贴在相机前 2.2m 的广告牌，会短暂盖住整个视野。
 *
 * 颜色由 data/bossAuras.js 的 death 字段按 BOSS 主题配置。
 */
const DURATION = 2.4;
// 相机前贴片的距离：足够近，任何相机的 near 都不会裁掉
const OVERLAY_DIST = 2.2;

let ringTex = null;
function getRingTexture() {
  if (ringTex) return ringTex;
  const size = 512;
  const c = size / 2;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d');
  // 厚光环：中段最亮，内外柔和衰减
  const grad = g.createRadialGradient(c, c, 0, c, c, c);
  grad.addColorStop(0, 'rgba(255,255,255,0)');
  grad.addColorStop(0.48, 'rgba(255,255,255,0.05)');
  grad.addColorStop(0.6, 'rgba(255,255,255,0.55)');
  grad.addColorStop(0.68, 'rgba(255,255,255,0.96)');
  grad.addColorStop(0.76, 'rgba(255,255,255,0.6)');
  grad.addColorStop(0.9, 'rgba(255,255,255,0.12)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  // 放射光刺：让光圈不是一条干净的圆线，更像能量爆开
  g.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 28; i++) {
    const a = (i / 28) * Math.PI * 2 + (i % 3) * 0.04;
    g.save();
    g.translate(c, c);
    g.rotate(a);
    g.beginPath();
    g.moveTo(c * 0.5, 0);
    g.lineTo(c * 0.98, -4);
    g.lineTo(c * 0.98, 4);
    g.closePath();
    g.fillStyle = i % 2 ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.22)';
    g.fill();
    g.restore();
  }
  ringTex = new THREE.CanvasTexture(cv);
  ringTex.colorSpace = THREE.SRGBColorSpace;
  return ringTex;
}

let flashTex = null;
function getFlashTexture() {
  if (flashTex) return flashTex;
  const size = 256;
  const c = size / 2;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d');
  const grad = g.createRadialGradient(c, c, 0, c, c, c);
  grad.addColorStop(0, 'rgba(255,255,255,0.95)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0.7)');
  grad.addColorStop(0.8, 'rgba(255,255,255,0.28)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  flashTex = new THREE.CanvasTexture(cv);
  flashTex.colorSpace = THREE.SRGBColorSpace;
  return flashTex;
}

const easeOut = (k) => 1 - (1 - k) * (1 - k);
const clamp01 = (k) => Math.max(0, Math.min(1, k));

export class DeathBurst {
  /**
   * @param {THREE.Scene} scene
   * @param {Function} getCamera 返回当前相机（相机可能在开局后才注入）
   */
  constructor(scene, getCamera) {
    this.scene = scene;
    this.getCamera = getCamera;
    this.t = -1;
    this.active = false;
    this.#build();
  }

  #build() {
    // 地面 / 竖立两个环共用同一份几何体
    this.ringGeo = new THREE.RingGeometry(0.86, 1, 128);

    this.groundMat = new THREE.MeshBasicMaterial({
      map: getRingTexture(), color: 0xffffff, transparent: true, opacity: 0,
      side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    });
    this.ground = new THREE.Mesh(this.ringGeo, this.groundMat);
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.visible = false;
    this.ground.renderOrder = 20;
    this.ground.frustumCulled = false;
    this.scene.add(this.ground);

    this.uprightMat = new THREE.MeshBasicMaterial({
      map: getRingTexture(), color: 0xffffff, transparent: true, opacity: 0,
      side: THREE.DoubleSide, depthWrite: false, depthTest: false,
      blending: THREE.AdditiveBlending, fog: false,
    });
    this.upright = new THREE.Mesh(this.ringGeo, this.uprightMat);
    this.upright.visible = false;
    this.upright.renderOrder = 21;
    this.upright.frustumCulled = false;
    this.scene.add(this.upright);

    // 全屏层：放在场景里、每帧贴到相机跟前（相机本身不在场景树里，挂相机上不会被渲染）
    this.overlay = new THREE.Group();
    this.overlay.visible = false;
    this.scene.add(this.overlay);

    this.ringMat = new THREE.MeshBasicMaterial({
      map: getRingTexture(), color: 0xffffff, transparent: true, opacity: 0,
      side: THREE.DoubleSide, depthWrite: false, depthTest: false,
      blending: THREE.AdditiveBlending, fog: false,
    });
    this.screenRing = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.ringMat);
    this.screenRing.renderOrder = 999;
    this.screenRing.frustumCulled = false;
    this.overlay.add(this.screenRing);

    // 第二波环：延迟 0.22s 起跑，补上第一环飞出画面后的空窗，形成连续两波扫屏
    this.ring2Mat = this.ringMat.clone();
    this.screenRing2 = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.ring2Mat);
    this.screenRing2.renderOrder = 999;
    this.screenRing2.frustumCulled = false;
    this.overlay.add(this.screenRing2);

    this.flashMat = new THREE.MeshBasicMaterial({
      map: getFlashTexture(), color: 0xffffff, transparent: true, opacity: 0,
      side: THREE.DoubleSide, depthWrite: false, depthTest: false,
      blending: THREE.AdditiveBlending, fog: false,
    });
    this.screenFlash = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.flashMat);
    this.screenFlash.position.z = 0.02;
    this.screenFlash.renderOrder = 998;
    this.screenFlash.frustumCulled = false;
    this.overlay.add(this.screenFlash);

    this._v = new THREE.Vector3();
  }

  /**
   * @param {object} opts
   * @param {number} opts.x BOSS 位置
   * @param {number} opts.z
   * @param {number} opts.color 主光圈颜色
   * @param {number} opts.glow 外圈/地面颜色
   */
  play({ x = 0, z = 0, color = 0xffffff, glow = 0xffffff } = {}) {
    this.t = 0;
    this.active = true;
    this.color = color;
    this.glow = glow;
    this.groundMat.color.setHex(glow);
    this.uprightMat.color.setHex(glow);
    this.ringMat.color.setHex(color);
    this.ring2Mat.color.setHex(color);
    this.flashMat.color.setHex(color);

    this.ground.position.set(x, 1.1, z);
    this.ground.scale.setScalar(2);
    this.ground.visible = true;
    this.groundMat.opacity = 0.9;

    this.upright.position.set(x, 3.2, z);
    this.upright.scale.setScalar(1.5);
    this.upright.visible = true;
    this.uprightMat.opacity = 0.95;

    this.overlay.visible = true;
    this.ringMat.opacity = 0;
    this.ring2Mat.opacity = 0;
    this.flashMat.opacity = 0.95;
  }

  update(dt) {
    if (!this.active) return;
    this.t += dt;
    const t = this.t;
    if (t >= DURATION) {
      this.active = false;
      this.ground.visible = false;
      this.upright.visible = false;
      this.overlay.visible = false;
      return;
    }
    const cam = this.getCamera?.();
    if (!cam) return;

    // 1) 地面环：1.2s 内扩到 70m
    const gk = clamp01(t / 1.2);
    this.ground.scale.setScalar(2 + easeOut(gk) * 72);
    this.groundMat.opacity = 0.9 * (1 - clamp01(t / 1.9));

    // 2) 竖立环：面向相机，向外炸开
    const uk = clamp01(t / 1.0);
    this.upright.scale.setScalar(1.5 + easeOut(uk) * 40);
    this.upright.quaternion.copy(cam.quaternion);
    this.uprightMat.opacity = 0.95 * (1 - clamp01(t / 1.35));

    // 3) 全屏层：贴在相机前，尺寸按 FOV / aspect 实时算，任何分辨率都铺满
    const h = 2 * OVERLAY_DIST * Math.tan(THREE.MathUtils.degToRad((cam.fov || 60) / 2));
    const w = h * (cam.aspect || 1.78);
    cam.getWorldDirection(this._v);
    this.overlay.position.copy(cam.position).addScaledVector(this._v, OVERLAY_DIST);
    this.overlay.quaternion.copy(cam.quaternion);

    // 光圈从屏幕中心匀速扩到出画：1.6s 的扫屏，保证视线被完整扫过一遍
    // （用线性而不是 easeOut：缓出会让环在前 0.3s 就飞出画面，后半段只剩空场）
    const rk = clamp01(t / 1.6);
    const rs = 0.16 + rk * 2.1;
    this.screenRing.scale.set(w * rs, h * rs, 1);
    this.ringMat.opacity = Math.min(1, t / 0.08) * (1 - clamp01(t / 1.9));

    // 第二波环：延迟 0.35s 起跑，接在第一环后面继续扫屏
    const t2 = t - 0.35;
    const rk2 = clamp01(t2 / 1.6);
    const rs2 = 0.16 + rk2 * 2.1;
    this.screenRing2.scale.set(w * rs2, h * rs2, 1);
    this.ring2Mat.opacity = t2 <= 0 ? 0 : Math.min(1, t2 / 0.08) * (1 - clamp01(t2 / 1.9));

    // 第一下色闪负责“糊住视角”，0.9s 内退干净
    this.screenFlash.scale.set(w * 1.2, h * 1.2, 1);
    this.flashMat.opacity = 0.95 * (1 - clamp01(t / 0.9));
  }

  dispose() {
    this.scene.remove(this.ground);
    this.scene.remove(this.upright);
    this.scene.remove(this.overlay);
    this.ringGeo.dispose();
    this.screenRing.geometry.dispose();
    this.screenRing2.geometry.dispose();
    this.screenFlash.geometry.dispose();
    [this.groundMat, this.uprightMat, this.ringMat, this.ring2Mat, this.flashMat].forEach((m) => m.dispose());
    // 贴图是模块级共享的，不随单个实例释放
    this.active = false;
  }
}

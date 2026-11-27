// 选艇页的涂装预览窗：一小块 3D 视口，实时把选中的船刷成选中的漆色。
//
// 为什么不直接复用 BoatShowcase：展示台要挂 Effekseer 尾焰 + 主炮演出，
// 初始化特效库在手机上能让抽屉掉一帧白；这里只需要「模型 + 水面 + 慢转」，
// 所以单独写一个轻量的，dispose 也干净（只丢自己的 GL 资源）。
//
// 换色走的是 src/data/paintTint.js 的同一套着色器 —— 预览看到什么，比赛里就是什么。

import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { getBoat } from '../data/boats.js';
import { measureModelBox } from '../game/modelBounds.js';
import { makePaintMaterial, paintTargetRgb } from '../data/paintTint.js';
import { loadModel } from './BoatShowcase.js';

// 预览窗比展示台小得多，船长归一化到 4.2 刚好占满画框
const TARGET_LEN = 4.2;
// 角色型赛艇（牛来号）按身高定标，口径与 BoatShowcase 一致
const CHAR_HEIGHT = 0.55;

export class BoatPaintPreview {
  constructor(container, boatId = '', paint = null) {
    this.container = container;
    this.running = true;
    this.boatId = '';
    this.model = null;
    this.paintHex = '';
    this.paintKey = '';
    this.painted = [];
    this.seq = 0;
    this.lastT = 0;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(34, 1, 0.1, 60);
    this.camera.position.set(3.5, 2.0, 4.6);
    this.camera.lookAt(0, 0.6, 0);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    container.appendChild(this.renderer.domElement);

    this.holder = new THREE.Group();  // 缓慢摆头
    this.scene.add(this.holder);
    this.tilt = new THREE.Group();    // 浪涌浮动
    this.holder.add(this.tilt);

    this.#buildStage();
    this.#resize();
    this.resizeObserver = new ResizeObserver(() => this.#resize());
    this.resizeObserver.observe(container);

    this.setBoat(boatId);
    this.setPaint(paint);
    this.#animate();
  }

  #buildStage() {
    this.scene.add(new THREE.HemisphereLight(0xbde9ff, 0x04263f, 2.4));
    const key = new THREE.DirectionalLight(0xfff1cf, 2.6);
    key.position.set(-5, 9, 6);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x59d8ff, 2.4);
    rim.position.set(4, 2, -6);
    this.scene.add(rim);

    // 水面圆盘：径向渐变，边缘淡出到透明，和展示台同一套观感
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(128, 128, 18, 128, 128, 128);
    grad.addColorStop(0, 'rgba(96, 192, 226, 0.9)');
    grad.addColorStop(0.55, 'rgba(38, 128, 176, 0.78)');
    grad.addColorStop(1, 'rgba(16, 74, 116, 0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 256, 256);
    this.waterTex = new THREE.CanvasTexture(c);
    this.waterTex.colorSpace = THREE.SRGBColorSpace;
    const water = new THREE.Mesh(
      new THREE.CircleGeometry(4.6, 48),
      new THREE.MeshBasicMaterial({ map: this.waterTex, transparent: true, depthWrite: false }),
    );
    water.rotation.x = -Math.PI / 2;
    water.position.y = -0.02;
    this.scene.add(water);
  }

  /** 换船：命中同一艘时直接返回（抽屉重绘会反复调到这里） */
  setBoat(boatId) {
    if (!boatId || boatId === this.boatId) return;
    const def = getBoat(boatId);
    if (!def?.model) return;
    this.boatId = boatId;
    const seq = ++this.seq;
    loadModel(def.model).then((gltf) => {
      if (!this.running || seq !== this.seq) return;
      this.#swap(gltf, def);
      // 新模型套用当前选中的漆色（换船时涂装应当延续）
      this.#rebuildPaint();
    }).catch(() => {});
  }

  /**
   * 设置漆色。hex 为空 = 原色。
   * 已有漆只是换色时只改 uniform，不重建材质 —— 连点时不会闪烁。
   */
  setPaint(paint) {
    const hex = paint?.hex || '';
    const key = paint?.key || '';
    if (hex === this.paintHex && key === this.paintKey) return;
    const recolor = !!hex && this.painted.length > 0;
    this.paintHex = hex;
    this.paintKey = key;
    if (recolor) {
      const [r, g2, b] = paintTargetRgb(THREE, hex, key);
      for (const p of this.painted) {
        p.mat.userData.paintUniforms?.uPaint.value.set(r, g2, b);
      }
      return;
    }
    this.#rebuildPaint();
  }

  #rebuildPaint() {
    // 先把上一轮的漆还原：漆材质都是 clone 出来的，dispose 掉换回原材质
    for (const p of this.painted) {
      if (p.mesh.material === p.mat) p.mesh.material = p.base;
      p.mat.dispose();
    }
    this.painted = [];
    if (!this.model || !this.paintHex) return;
    this.model.traverse((o) => {
      if (!o.isMesh || o.visible === false) return;
      const base = o.userData.__paintBase || o.material;
      if (!base) return;
      // 蒙皮网格（牛来号）也染：只换材质，不动几何，蒙皮不受影响
      o.userData.__paintBase = base;
      const mat = makePaintMaterial(THREE, base, this.paintHex, this.boatId, {
        paintKey: this.paintKey,
      });
      o.material = mat;
      this.painted.push({ mesh: o, base, mat });
    });
  }

  #swap(gltf, def) {
    if (this.model) {
      this.tilt.remove(this.model);
      this.model.userData.mixer?.stopAllAction();
      this.model.traverse((o) => {
        if (!o.isMesh) return;
        o.geometry?.dispose();
        const m = o.material;
        if (Array.isArray(m)) m.forEach((x) => x.dispose());
        else m?.dispose();
      });
      this.model = null;
    }
    this.painted = [];

    // 带骨骼的（牛来号）必须 SkeletonUtils.clone，否则和比赛里的船共用骨架
    const hasSkin = gltf.scene.getObjectByProperty('isSkinnedMesh', true) !== undefined;
    const model = hasSkin ? cloneSkinned(gltf.scene) : gltf.scene.clone(true);

    // 朝向 / 比例：与 boatThumbs、BoatShowcase 同一套规则，船头统一朝 +Z
    const box = measureModelBox(model);
    const size = box.getSize(new THREE.Vector3());
    const fwdLen = Math.max(size.x, size.z, 0.001);
    if (Number.isFinite(def.modelRotationX) || Number.isFinite(def.modelRotationY)) {
      model.rotation.x = Number.isFinite(def.modelRotationX) ? def.modelRotationX : 0;
      model.rotation.y = Number.isFinite(def.modelRotationY) ? def.modelRotationY : 0;
    } else {
      model.rotation.y = size.x > size.z ? -Math.PI / 2 : 0;
    }
    const charScale = !Number.isFinite(def.fitHeight)
      ? 0
      : (def.fitHeight * CHAR_HEIGHT) / Math.max(size.y, 0.001);
    const s = charScale > 0 ? charScale : TARGET_LEN / fwdLen;
    model.scale.setScalar(s);
    model.updateMatrixWorld(true);

    const box2 = measureModelBox(model);
    const c2 = box2.getCenter(new THREE.Vector3());
    model.position.x -= c2.x;
    model.position.z -= c2.z;
    model.position.y -= box2.min.y * 0.35;
    const lift = !Number.isFinite(def.modelLiftY)
      ? 0
      : def.fitTo === 'height'
        ? def.modelLiftY
        : def.modelLiftY * (TARGET_LEN / ((def.hull?.length || 4) * (def.modelScale || 1)));
    model.position.y += lift;
    model.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });

    // 角色赛艇原地小跑当待机（没有 walk 动作的模型跳过）
    let mixer = null;
    const walkClip = def.anim?.walk
      ? THREE.AnimationClip.findByName(gltf.animations || [], def.anim.walk)
      : null;
    if (walkClip) {
      mixer = new THREE.AnimationMixer(model);
      const act = mixer.clipAction(walkClip);
      act.play();
      act.timeScale = 0.45;
    }
    model.userData.mixer = mixer;
    model.userData.baseY = model.position.y;

    this.model = model;
    this.tilt.add(model);
  }

  #resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  #animate = () => {
    if (!this.running) return;
    requestAnimationFrame(this.#animate);
    if (this.container.clientWidth === 0 || document.hidden) return;
    const now = performance.now();
    const t = now * 0.001;
    const dt = Math.min(0.05, Math.max(0, t - (this.lastT || t)));
    this.lastT = t;

    // 慢速摆头 + 浪涌，让静态窗里也有活气（幅度比展示台小，别晃得看不清漆）
    this.holder.rotation.y = Math.sin(t * 0.42) * 0.5 + 0.18;
    this.tilt.position.y = Math.sin(t * 1.15) * 0.06;
    this.tilt.rotation.z = Math.sin(t * 0.9) * 0.03;
    this.model?.userData.mixer?.update(dt);

    this.renderer.render(this.scene, this.camera);
  };

  /** 抽屉收起时暂停（省一个 WebGL 上下文的每帧开销），再打开接着用 */
  pause() { this.running = false; }

  resume() {
    if (this.running) return;
    this.running = true;
    this.lastT = 0;
    this.#animate();
  }

  dispose() {
    this.running = false;
    this.resizeObserver?.disconnect();
    this.waterTex?.dispose();
    this.model?.traverse((o) => {
      if (!o.isMesh) return;
      o.geometry?.dispose();
      const m = o.material;
      if (Array.isArray(m)) m.forEach((x) => x.dispose());
      else m?.dispose();
    });
    for (const p of this.painted) p.mat.dispose();
    this.painted = [];
    this.scene.traverse((obj) => {
      if (obj.isMesh || obj.isPoints) {
        obj.geometry?.dispose();
        const m = obj.material;
        if (Array.isArray(m)) m.forEach((x) => x.dispose());
        else m?.dispose();
      }
    });
    this.renderer.dispose();
    this.renderer.forceContextLoss?.();
    this.container.innerHTML = '';
  }
}

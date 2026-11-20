// 绯鲨号氮气尾焰的「直线水流」——纯 three.js 射流水柱，作为主视觉；
// 原来的 Effekseer toonWater 水花粒子降级为辅助（在末端炸开的水沫）。
//
// 做法：每个喷口一根「锥形水柱」——根部略粗、末端收细并渐隐，贴着船尾笔直向后射。
//   · 几何体在本地空间就已经是「朝 +Z、根部在原点」，运行时只要 position=喷口、
//     rotation.y = heading+π 就能对准船尾（不用再猜素材默认朝向）。
//   · 用 4 分量顶点色做「根部亮→末端透明」的纵向渐变（不依赖贴图，滚 UV 也不会把渐变带走）。
//   · 贴图只负责「水流条纹」，沿轴向循环滚动 = 水在往后冲。
//   · 加法混合 + 青色 → 被 PostFx 的 bloom 抓到，解决「地图里看着太淡」。
//
// 性能：3 个 mesh、共享一份材质与贴图，几何体 7×16 段，开销可以忽略。
import * as THREE from 'three';

let flowTexture = null;
function getFlowTexture() {
  if (flowTexture) return flowTexture;
  const w = 64, h = 256;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  // 横向细亮带（垂直于水流轴向）：滚动时读作「水里的气泡 / 波纹一段段往后冲」。
  // 数量多、单条很淡，叠起来才是「流水」；早先做成少量粗亮带会读成「螺纹管 / 弹簧」。
  for (let i = 0; i < 150; i++) {
    const y = Math.random() * h;
    const bh = 0.8 + Math.random() * 2.2;
    const a = 0.05 + Math.random() * 0.22;
    const g = ctx.createLinearGradient(0, y, w, y);
    g.addColorStop(0, `rgba(255,255,255,0)`);
    g.addColorStop(0.5, `rgba(220,248,255,${a})`);
    g.addColorStop(1, `rgba(255,255,255,0)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, y, w, bh);
  }
  // 纵向拉丝（沿流动方向）：让「往后冲」的方向感更明确
  for (let i = 0; i < 26; i++) {
    const x = Math.random() * w;
    ctx.strokeStyle = `rgba(200,240,255,${0.05 + Math.random() * 0.14})`;
    ctx.lineWidth = 0.5 + Math.random() * 1.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + (Math.random() - 0.5) * 5, h);
    ctx.stroke();
  }
  flowTexture = new THREE.CanvasTexture(canvas);
  flowTexture.colorSpace = THREE.SRGBColorSpace;
  flowTexture.wrapS = THREE.RepeatWrapping;
  flowTexture.wrapT = THREE.RepeatWrapping;
  return flowTexture;
}

export class NitroJetStream {
  /**
   * @param {THREE.Scene} scene
   * @param {object} opts { length, radius, color, flow, opacity }
   * @param {number} maxJets 最多几根（= 喷口数）
   */
  constructor(scene, opts = {}, maxJets = 3) {
    this.length = opts.length ?? 7;
    this.radius = opts.radius ?? 0.1;
    this.color = opts.color ?? 0x8fe9ff;
    this.flow = opts.flow ?? 2.6;          // UV 滚动速度（每秒）
    this.opacity = opts.opacity ?? 0.85;
    this.time = 0;

    const tex = getFlowTexture().clone();
    tex.needsUpdate = true;
    // 每根水柱重复几次条纹（长度 ~7m，重复 4 次让流动颗粒更细密）
    tex.repeat.set(1, 4);
    this.texture = tex;

    // 锥体：根部粗、末端细；本地已朝 +Z、根部在 z=0
    const L = this.length;
    const geo = new THREE.CylinderGeometry(this.radius * 0.32, this.radius, L, 7, 16, true);
    geo.rotateX(Math.PI / 2);      // 轴向 Y → Z
    geo.translate(0, 0, L / 2);    // 根部落到原点，向 +Z 延伸
    // 4 分量顶点色：根部不透明 → 末端全透明（二次渐隐）
    {
      const pos = geo.attributes.position;
      const colors = new Float32Array(pos.count * 4);
      for (let i = 0; i < pos.count; i++) {
        const t = Math.min(1, Math.max(0, pos.getZ(i) / L)); // 0 根 → 1 末端
        const a = (1 - t) * (1 - t);
        colors[i * 4 + 0] = 1;
        colors[i * 4 + 1] = 1;
        colors[i * 4 + 2] = 1;
        colors[i * 4 + 3] = a;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 4));
    }
    this.geometry = geo;

    this.material = new THREE.MeshBasicMaterial({
      map: tex,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      // 单面渲染：细圆柱从外部看外表面就够，DoubleSide 会让填充率翻倍、白掉帧
      side: THREE.FrontSide,
      color: this.color,
      opacity: this.opacity,
      fog: false,
    });

    this.jets = [];
    for (let i = 0; i < maxJets; i++) {
      const mesh = new THREE.Mesh(this.geometry, this.material);
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 2;
      scene.add(mesh);
      this.jets.push({ mesh, v: new THREE.Vector3() });
    }
  }

  /**
   * @param {number} dt
   * @param {{active:boolean, anchors:THREE.Object3D[], heading:number}|null} emit
   */
  update(dt, emit) {
    this.time += dt;
    const active = !!(emit && emit.active && emit.anchors && emit.anchors.length);
    for (let i = 0; i < this.jets.length; i++) {
      const j = this.jets[i];
      const a = active ? emit.anchors[i] : null;
      if (!a) { j.mesh.visible = false; continue; }
      a.getWorldPosition(j.v);
      j.mesh.position.copy(j.v);
      // 本地 +Z 绕 Y 转 heading+π → 船尾方向
      j.mesh.rotation.set(0, emit.heading + Math.PI, 0);
      // 关键：喷口在船尾下部，纯水平射会直接插进水面、只露一小截。
      // 给一个本地俯仰角（约 7°）让水柱向后上方喷出，整条都浮在水面之上。
      j.mesh.rotateX(-0.12);
      // 轻微「水流抖振」：整体横向小幅摆动，避免像一根硬塑料管
      j.mesh.position.x += Math.sin(this.time * 9 + i * 2.1) * 0.05;
      j.mesh.position.y += Math.sin(this.time * 7 + i * 1.3) * 0.04;
      j.mesh.visible = true;
    }
    if (active) {
      // 条纹沿轴向滚动 = 水在往后冲
      this.texture.offset.y = (this.texture.offset.y - dt * this.flow) % 1;
    }
  }

  dispose() {
    for (const j of this.jets) j.mesh.parent?.remove(j.mesh);
    this.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}

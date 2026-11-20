import * as THREE from 'three';

// 星空天气：三层星星 + 银河星带 + 星云柔光面片 + 流星对象池 + 镜头附近的星尘 + 水面星点反光。
// 全部用 Points / InstancedMesh，单帧总 draw call 约 10 次；画质档位只改数量与柔光强度。
// 星星挂在跟随相机的 group 上（半径 1800），所以开船跑出多远都不会“走出星空”，
// depthTest 仍为 true，山体/岩岛照常遮挡星星。

const QUALITY = {
  high: {
    // 点数全部走同一次 draw call，多加几百颗的代价可以忽略；
    // 真正决定观感的是“点尺寸”，见 #makeLayer 的 starSize
    bright: 80, mid: 8000, dim: 5200, band: 3600,
    nebula: 0.16, dust: 150, meteors: 4, meteorGap: [4, 8], glints: 200,
  },
  medium: {
    bright: 56, mid: 4200, dim: 2800, band: 1900,
    nebula: 0.12, dust: 100, meteors: 3, meteorGap: [6, 10], glints: 140,
  },
  low: {
    // 低配笔记本：暗星 900→500、星尘 150→60、流星 4→2 且间隔拉长，
    // 银河柔光压到 0.06；水面金属反光直接关掉（只留深蓝夜色），天空粒子全保留
    bright: 28, mid: 700, dim: 500, band: 700,
    nebula: 0.06, dust: 60, meteors: 2, meteorGap: [8, 15], glints: 0,
  },
};

const SKY_RADIUS = 1800;
const _bufSize = new THREE.Vector2();

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 星星顶点着色器：每颗星自带相位，独立正弦闪烁；尺寸按物理像素给，避免高 DPI 下变小
const STAR_VERTEX = /* glsl */`
  uniform float uTime;
  uniform float uPixelRatio;
  attribute float aPhase;
  attribute float aSize;
  attribute vec3 aColor;
  varying vec3 vColor;
  varying float vTwinkle;
  void main() {
    vColor = aColor;
    vTwinkle = 0.74 + 0.26 * sin(uTime * (0.8 + aPhase * 1.7) + aPhase * 25.0);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = aSize * uPixelRatio;
  }
`;

const STAR_FRAGMENT = /* glsl */`
  varying vec3 vColor;
  varying float vTwinkle;
  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float r = length(d) * 2.0;
    if (r > 1.0) discard;
    // 中心亮核 + 外圈柔光：亮星看起来带一小团光晕
    float core = smoothstep(1.0, 0.25, r);
    float halo = pow(max(0.0, 1.0 - r), 2.5) * 0.8;
    float a = clamp(core * 0.9 + halo, 0.0, 1.0) * vTwinkle;
    gl_FragColor = vec4(vColor, a);
  }
`;

// 星云柔光贴图：程序化画在 canvas 上，不额外加载资源
function makeNebulaTexture() {
  const w = 1024;
  const h = 256;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const rand = mulberry32(20261031);
  ctx.clearRect(0, 0, w, h);
  // 横向长带、纵向柔和的冷蓝紫渐变（中心最亮，向上下两端散开）
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, 'rgba(96,118,196,0)');
  g.addColorStop(0.34, 'rgba(128,150,222,0.28)');
  g.addColorStop(0.5, 'rgba(186,190,240,0.5)');
  g.addColorStop(0.66, 'rgba(150,138,216,0.28)');
  g.addColorStop(1, 'rgba(96,88,168,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  // 云絮状亮斑：让“银河”不是一条干净的光条
  for (let i = 0; i < 190; i++) {
    const x = rand() * w;
    const y = h * 0.5 + (rand() - 0.5) * h * 0.42;
    const r = 8 + rand() * 46;
    const a = 0.03 + rand() * 0.09;
    ctx.fillStyle = `rgba(${190 + rand() * 40},${192 + rand() * 34},255,${a})`;
    ctx.beginPath();
    ctx.ellipse(x, y, r * 1.9, r * 0.7, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // 两端淡出，避免面片边缘出现硬直边
  const edge = ctx.createLinearGradient(0, 0, w, 0);
  edge.addColorStop(0, 'rgba(0,0,0,1)');
  edge.addColorStop(0.12, 'rgba(0,0,0,0)');
  edge.addColorStop(0.88, 'rgba(0,0,0,0)');
  edge.addColorStop(1, 'rgba(0,0,0,1)');
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = edge;
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = 'source-over';
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// 流星贴图：头部亮点 + 由亮到暗的锥形尾迹（横向渐变）
function makeMeteorTexture() {
  const w = 256;
  const h = 32;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, w, 0);
  g.addColorStop(0, 'rgba(190,214,255,0.98)');
  g.addColorStop(0.16, 'rgba(214,232,255,0.62)');
  g.addColorStop(0.52, 'rgba(168,196,255,0.2)');
  g.addColorStop(1, 'rgba(120,150,220,0)');
  ctx.fillStyle = g;
  // 上半/下半用 y 方向渐隐收成锥形
  for (let x = 0; x < w; x++) {
    const t = x / w;
    const half = h / 2 * (1 - t * 0.75);
    ctx.fillRect(x, h / 2 - half, 1, half * 2);
  }
  // 头部亮核
  const head = ctx.createRadialGradient(10, h / 2, 0, 10, h / 2, h * 0.6);
  head.addColorStop(0, 'rgba(255,255,255,1)');
  head.addColorStop(0.4, 'rgba(220,235,255,0.7)');
  head.addColorStop(1, 'rgba(190,214,255,0)');
  ctx.fillStyle = head;
  ctx.beginPath();
  ctx.arc(10, h / 2, h * 0.6, 0, Math.PI * 2);
  ctx.fill();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 水面星点：屏幕空间点精灵（永远正对镜头）。
// 早先用“平铺在水面上的长条面片”，相机只有 4 米高、几乎是贴水面看过去，
// 面片被压缩成 1~2 像素的横线，还会被浪峰整体挡住——等于没画。
// 点精灵按距离缩放、纵向拉长，才像星星在水面上拖出的倒影。
const GLINT_VERTEX = /* glsl */`
  uniform float uTime;
  uniform float uPixelScale;
  attribute float aPhase;
  attribute float aSize;
  varying float vTw;
  varying float vFade;
  void main() {
    vTw = 0.5 + 0.5 * sin(uTime * (0.5 + aPhase * 1.3) + aPhase * 31.0);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float depth = max(-mv.z, 1.0);
    // 只有船附近的水面才泛星光：85m 外完全淡出，
    // 否则整片远处水面会连成一条白点带，像荧光（玩家反馈）
    vFade = clamp((85.0 - depth) / 55.0, 0.0, 1.0);
    gl_PointSize = clamp(aSize * uPixelScale / depth, 1.5, 13.0);
  }
`;

const GLINT_FRAGMENT = /* glsl */`
  varying float vTw;
  varying float vFade;
  void main() {
    vec2 d = gl_PointCoord * 2.0 - 1.0;
    // 横向略微拉长：水面上被波浪压扁的一段星光倒影
    float r = length(vec2(d.x * 0.62, d.y * 1.9));
    if (r > 1.0) discard;
    float a = pow(1.0 - r, 1.9) * (0.32 + 0.68 * vTw) * 0.55 * vFade;
    gl_FragColor = vec4(0.74, 0.87, 1.0, a);
  }
`;

export class NightSky {
  constructor(scene, { quality = 'high', renderer = null } = {}) {
    this.scene = scene;
    this.renderer = renderer;
    this.quality = QUALITY[quality] ? quality : 'high';
    this.visible = false;
    this.time = 0;
    this.uniforms = {
      uTime: { value: 0 },
      uPixelRatio: { value: renderer?.getPixelRatio?.() || 1.25 },
    };
    this.group = new THREE.Group();
    this.group.name = 'night-sky';
    this.group.renderOrder = 2;
    this.group.visible = false;
    // 流星对象池的状态（要在 #build 之前初始化：构建时就会往池里塞对象）
    // 开局 1.2s 就来第一颗，玩家进场就能看到流星，不用等 4~9s
    this.meteorTimer = 1.2;
    this.meteorState = [];
    // 银河的朝向要按“开局时镜头正前方”来定：固定世界方向的话，
    // 每条赛道开局船头朝向都不同，银河很可能落在镜头背后（之前就是这样，
    // 只在屏幕顶角露出一块紫斑）。第一次 update 拿到相机后再建银河与柔光带。
    this.viewDir = null;
    this.viewRight = null;
    scene.add(this.group);
    this.#build();
  }

  setVisible(v) {
    this.visible = !!v;
    this.group.visible = this.visible;
    // 水面星点挂在场景根上（世界坐标），要单独跟着开关，
    // 否则切回白天时水面还留着星星倒影
    if (this.glintsRoot) this.glintsRoot.visible = this.visible;
  }

  setQuality(q) {
    if (!QUALITY[q] || q === this.quality) return;
    this.quality = q;
    this.#rebuild();
  }

  // ---------- 星空构建 ----------
  #build() {
    const cfg = QUALITY[this.quality];
    const rand = mulberry32(20261030);
    const colors = [
      [1.0, 1.0, 1.0], [1.0, 1.0, 1.0], [1.0, 1.0, 1.0],
      [0.76, 0.86, 1.0], // 淡蓝
      [1.0, 0.94, 0.78], // 淡黄
      [0.86, 0.78, 1.0], // 淡紫
    ];

    // 半球随机方向（cos 加权，天顶附近密度一致）
    const dir = (minY) => {
      const y = minY + (1 - minY) * rand();
      const a = rand() * Math.PI * 2;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      return [Math.cos(a) * r, y, Math.sin(a) * r];
    };

    // 三层星星：亮星（大、带光晕、少）/ 中星（最多）/ 遥远暗星（细小铺满）
    // 点尺寸单位是物理像素。早期版本给 4.6/2.2/1.3，在 1400px 宽的画面里
    // 中星只有 2px、暗星 1px，等于“满天星砂”，看上去就是一片黑——这里整体放大。
    this.bright = this.#makeLayer(() => dir(0.06), cfg.bright, 11, 0.5, colors, rand);
    this.mid = this.#makeLayer(() => dir(0.02), cfg.mid, 3.8, 0.5, colors, rand);
    this.dim = this.#makeLayer(() => dir(0.0), cfg.dim, 2.4, 0.5, colors, rand);

    // 银河：沿固定大弧线撒一条密集星带 + 星云柔光带。
    // 朝向依赖开局相机，没有相机就先不建（不占 draw call）
    this.band = null;
    this.nebula = null;
    this.bandAxis = null;
    if (this.viewDir) this.#buildBandAndNebula(cfg);

    // 星尘：镜头附近缓慢巡游的淡蓝微光
    this.#buildDust(cfg.dust, rand);

    // 流星对象池
    this.#buildMeteors(cfg.meteors, rand);

    // 水面星点反光（低画质 glints = 0，直接不建）
    this.glints = null;
    if (cfg.glints > 0) this.#buildGlints(cfg.glints, rand);
  }

  #makeLayer(dirs, count, size, sizeJitter, colors, rand) {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    const phase = new Float32Array(count);
    const sizes = new Float32Array(count);
    const col = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const [x, y, z] = dirs();
      pos[i * 3] = x * SKY_RADIUS;
      pos[i * 3 + 1] = y * SKY_RADIUS;
      pos[i * 3 + 2] = z * SKY_RADIUS;
      phase[i] = rand();
      sizes[i] = size * (1 - sizeJitter / 2 + rand() * sizeJitter);
      const c = colors[Math.floor(rand() * colors.length)];
      col[i * 3] = c[0];
      col[i * 3 + 1] = c[1];
      col[i * 3 + 2] = c[2];
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    const mat = this.#starMaterial();
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    points.renderOrder = 3;
    this.group.add(points);
    return points;
  }

  #starMaterial() {
    return new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: STAR_VERTEX,
      fragmentShader: STAR_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
  }

  // ---------- 银河（星带 + 柔光带）----------
  // 朝向按开局镜头：弧线中点压在镜头前方约 10° 仰角（正好落在可见天空里），
  // 切向沿“屏幕右上”方向，于是银河从画面左下斜贯到右上。
  #buildBandAndNebula(cfg) {
    const rand = mulberry32(20261030);
    this.#buildBand(rand, cfg.band);
    this.#buildNebula(cfg.nebula);
  }

  #buildBand(rand, count) {
    const H = new THREE.Vector3(this.viewDir.x, 0, this.viewDir.z);
    if (H.lengthSq() < 1e-5) H.set(0, 0, -1);
    H.normalize();
    const ELEV = 0.17; // ≈9.7°，镜头俯视时天空只露出地平线上方十几度
    const A = H.clone().multiplyScalar(Math.cos(ELEV))
      .add(new THREE.Vector3(0, Math.sin(ELEV), 0)).normalize();
    const R = new THREE.Vector3(this.viewRight?.x ?? 1, 0, this.viewRight?.z ?? 0);
    if (R.lengthSq() < 1e-5) R.set(1, 0, 0);
    R.normalize();
    // 走向：屏幕水平方向再抬起一点 → 左下到右上的缓斜线。
    // 不用整圆：可见天空只有地平线上方十几度，大圆会很快拱出画面或掉到山里，
    // 只在中间露出一小截。这里用“以 A 为原点、沿 D 拉长的窄带”，整条都能看见。
    const D = R.add(new THREE.Vector3(0, 0.35, 0)).normalize();
    const N = new THREE.Vector3().crossVectors(A, D).normalize();
    this.bandAxis = { A, D, N };

    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    const phase = new Float32Array(count);
    const sizes = new Float32Array(count);
    const col = new Float32Array(count * 3);
    const c = new THREE.Vector3();
    const base = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      const t = (rand() * 2 - 1) * 1.2; // 沿带子方向的位置
      base.copy(A).addScaledVector(D, t).normalize();
      const spread = (rand() + rand() + rand() - 1.5) * 0.13;
      c.copy(base).multiplyScalar(Math.cos(spread)).addScaledVector(N, Math.sin(spread)).normalize();
      pos[i * 3] = c.x * (SKY_RADIUS - 30);
      pos[i * 3 + 1] = c.y * (SKY_RADIUS - 30);
      pos[i * 3 + 2] = c.z * (SKY_RADIUS - 30);
      phase[i] = rand();
      sizes[i] = 2.2 + rand() * 2.2;
      // 银河里的星比普通星星更亮一点（它本来就是密集星团）
      const v = 0.82 + rand() * 0.18;
      col[i * 3] = v * 0.92;
      col[i * 3 + 1] = v * 0.94;
      col[i * 3 + 2] = v;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    const points = new THREE.Points(geo, this.#starMaterial());
    points.frustumCulled = false;
    points.renderOrder = 3;
    this.band = points;
    this.group.add(points);
  }

  // ---------- 星云柔光面片 ----------
  // 用一条“沿银河弧线弯曲的带状网格”而不是一块平板：平板只能在天空一个角落
  // 露出一团紫斑（之前就是把 3400×640 的板子放到了头顶侧面），弯带才能跟星带
  // 一起斜贯天空。整条带子 1 次 draw call、130 个顶点。
  #buildNebula(opacity) {
    const tex = makeNebulaTexture();
    this.nebulaTexture = tex;
    const { A, D, N } = this.bandAxis;
    const R = SKY_RADIUS - 60;
    const steps = 48;
    const halfWidth = 0.14; // 带宽（弧度），约 490 米高
    const tFrom = -1.25;
    const tTo = 1.25;
    const pos = new Float32Array((steps + 1) * 2 * 3);
    const uv = new Float32Array((steps + 1) * 2 * 2);
    const idx = [];
    const center = new THREE.Vector3();
    const edge = new THREE.Vector3();
    for (let i = 0; i <= steps; i++) {
      const t = tFrom + (tTo - tFrom) * (i / steps);
      center.copy(A).addScaledVector(D, t).normalize();
      for (let r = 0; r < 2; r++) {
        edge.copy(center).multiplyScalar(Math.cos(halfWidth))
          .addScaledVector(N, r ? Math.sin(halfWidth) : -Math.sin(halfWidth)).normalize();
        const v = (i * 2 + r) * 3;
        pos[v] = edge.x * R;
        pos[v + 1] = edge.y * R;
        pos[v + 2] = edge.z * R;
        const t = (i * 2 + r) * 2;
        uv[t] = i / steps;
        uv[t + 1] = r;
      }
      if (i < steps) {
        const a = i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      opacity,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      fog: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 2;
    mesh.frustumCulled = false;
    this.nebula = mesh;
    this.group.add(mesh);
  }

  // ---------- 星尘 ----------
  #buildDust(count, rand) {
    const geo = new THREE.BufferGeometry();
    this.dustPos = new Float32Array(count * 3);
    this.dustVel = new Float32Array(count * 3);
    const phase = new Float32Array(count);
    const sizes = new Float32Array(count);
    const col = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      this.dustPos[i * 3] = (rand() - 0.5) * 130;
      this.dustPos[i * 3 + 1] = rand() * 42 + 1.5;
      this.dustPos[i * 3 + 2] = (rand() - 0.5) * 130;
      this.dustVel[i * 3] = (rand() - 0.5) * 1.6;
      this.dustVel[i * 3 + 1] = 0.15 + rand() * 0.5;
      this.dustVel[i * 3 + 2] = (rand() - 0.5) * 1.6;
      phase[i] = rand();
      sizes[i] = 3.2 + rand() * 3.6;
      // 淡蓝微光，少量偏白
      const b = 0.78 + rand() * 0.22;
      col[i * 3] = 0.7 * b;
      col[i * 3 + 1] = 0.86 * b;
      col[i * 3 + 2] = b;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(this.dustPos, 3));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    const mat = this.#starMaterial();
    this.dust = new THREE.Points(geo, mat);
    this.dust.frustumCulled = false;
    this.dust.renderOrder = 4;
    this.group.add(this.dust);
    this.dustCount = count;
  }

  // ---------- 流星 ----------
  #buildMeteors(count, rand) {
    this.meteorGeo = new THREE.PlaneGeometry(1, 1);
    this.meteorTexture = makeMeteorTexture();
    this.meteorRand = rand;
    for (let i = 0; i < count; i++) {
      const mat = new THREE.MeshBasicMaterial({
        map: this.meteorTexture,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: false,
      });
      const mesh = new THREE.Mesh(this.meteorGeo, mat);
      mesh.visible = false;
      mesh.renderOrder = 5;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.meteorState.push({ mesh, active: false, t: 0, life: 2, from: new THREE.Vector3(), dir: new THREE.Vector3(), dist: 300 });
    }
  }

  #spawnMeteor() {
    const m = this.meteorState.find((s) => !s.active);
    if (!m) return;
    const rand = this.meteorRand;
    // 方位按“开局镜头前方”铺开 ±60°，保证流星真的落在玩家视野里
    // （原来固定朝世界 -Z，很多赛道开局船头不朝 -Z，流星全在背后）
    const base = this.viewDir ? Math.atan2(this.viewDir.x, this.viewDir.z) : Math.PI;
    const a = base + (rand() - 0.5) * 2.1;
    const y = 0.18 + rand() * 0.6;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    m.from.set(Math.sin(a) * r, y, Math.cos(a) * r).normalize().multiplyScalar(SKY_RADIUS - 40);
    // 切向方向 + 一点向下的分量
    const up = m.from.clone().normalize();
    const side = new THREE.Vector3(rand() - 0.5, -0.45, rand() - 0.5);
    m.dir.copy(side.sub(up.clone().multiplyScalar(side.dot(up)))).normalize();
    m.dist = 240 + rand() * 160;
    m.t = 0;
    m.life = 1.6 + rand() * 0.5;
    m.active = true;
    m.mesh.visible = true;
  }

  // ---------- 水面星点反光 ----------
  #buildGlints(count, rand) {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    const phase = new Float32Array(count);
    const sizes = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const a = rand() * Math.PI * 2;
      // 只撒在赛艇周围一圈近处水面上：远处整片铺开会在中景连成一条白点带，
      // 看起来像“水面荧光”，很出戏（玩家反馈）
      const r = 5 + Math.sqrt(rand()) * 85;
      pos[i * 3] = Math.cos(a) * r;
      // 抬到浪峰之上：贴着水面放会被近处的浪挡住
      pos[i * 3 + 1] = 1.2 + rand() * 0.9;
      pos[i * 3 + 2] = Math.sin(a) * r;
      phase[i] = rand();
      sizes[i] = 0.3 + rand() * 0.5; // 世界尺寸（米），屏幕上按距离缩放
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    this.glintCount = count;
    this.glintUniforms = {
      uTime: this.uniforms.uTime,
      uPixelScale: { value: 900 },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.glintUniforms,
      vertexShader: GLINT_VERTEX,
      fragmentShader: GLINT_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    points.renderOrder = 4;
    this.glints = points;
    // 水面反光必须留在世界坐标里：不能挂到跟随相机的星星组上，
    // 否则玩家一开船，水面上的星点倒影会跟着船跑（看起来像贴在镜头上）
    this.glintsRoot = new THREE.Group();
    this.glintsRoot.name = 'night-water-glints';
    this.glintsRoot.add(points);
    this.scene.add(this.glintsRoot);
  }

  // ---------- 每帧 ----------
  update(dt, camera) {
    if (!this.visible) return;
    this.time += dt;
    this.uniforms.uTime.value = this.time;
    if (this.renderer) {
      const pr = this.renderer.getPixelRatio();
      if (this.uniforms.uPixelRatio.value !== pr) this.uniforms.uPixelRatio.value = pr;
    }
    // 星空整体跟相机走（星星本身不做视差，山体靠深度缓冲遮挡）
    if (camera) {
      this.group.position.copy(camera.position);
      // 第一次拿到镜头方向：定下银河朝向，补建星带与柔光带
      if (!this.viewDir) {
        this.viewDir = camera.getWorldDirection(new THREE.Vector3());
        this.viewRight = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
        this.#buildBandAndNebula(QUALITY[this.quality]);
      }
    }

    this.#updateDust(dt);
    this.#updateMeteors(dt);
    if (this.glints && camera) {
      // 星点在世界坐标里固定（船开过去时倒影不会跟着漂），
      // 但按 200m 的方块围着镜头做“循环回卷”：走多远，船周围的水面都有几点星光。
      // 回卷发生在 100m 外，点只有几像素、还在独立闪烁，看不出跳变
      const attr = this.glints.geometry.attributes.position;
      const arr = attr.array;
      const W = 100;
      const cx = camera.position.x;
      const cz = camera.position.z;
      let dirty = false;
      for (let i = 0; i < this.glintCount; i++) {
        const ix = i * 3;
        const dx = arr[ix] - cx;
        if (dx > W) { arr[ix] -= W * 2; dirty = true; } else if (dx < -W) { arr[ix] += W * 2; dirty = true; }
        const dz = arr[ix + 2] - cz;
        if (dz > W) { arr[ix + 2] -= W * 2; dirty = true; } else if (dz < -W) { arr[ix + 2] += W * 2; dirty = true; }
      }
      if (dirty) attr.needsUpdate = true;
      // 点精灵的“每米对应多少像素”：镜头 FOV 变了也要跟着变，否则近距离会缩成小点
      const buf = this.renderer?.getDrawingBufferSize(_bufSize) ?? _bufSize.set(1400, 860);
      this.glintUniforms.uPixelScale.value = buf.y
        / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5));
    }
  }

  #updateDust(dt) {
    if (!this.dust) return;
    const pos = this.dustPos;
    const vel = this.dustVel;
    for (let i = 0; i < this.dustCount; i++) {
      const ix = i * 3;
      pos[ix] += vel[ix] * dt;
      pos[ix + 1] += vel[ix + 1] * dt;
      pos[ix + 2] += vel[ix + 2] * dt;
      // 超出镜头周围的盒子就绕回另一侧
      if (pos[ix] > 65) pos[ix] = -65; else if (pos[ix] < -65) pos[ix] = 65;
      if (pos[ix + 2] > 65) pos[ix + 2] = -65; else if (pos[ix + 2] < -65) pos[ix + 2] = 65;
      if (pos[ix + 1] > 46) pos[ix + 1] = 1.5;
    }
    this.dust.geometry.attributes.position.needsUpdate = true;
  }

  #updateMeteors(dt) {
    this.meteorTimer -= dt;
    if (this.meteorTimer <= 0) {
      this.#spawnMeteor();
      const [lo, hi] = QUALITY[this.quality].meteorGap;
      this.meteorTimer = lo + Math.random() * (hi - lo);
    }
    const x = new THREE.Vector3();
    const y = new THREE.Vector3();
    const z = new THREE.Vector3();
    const m4 = new THREE.Matrix4();
    for (const s of this.meteorState) {
      if (!s.active) continue;
      s.t += dt;
      const p = s.t / s.life;
      if (p >= 1) {
        s.active = false;
        s.mesh.visible = false;
        s.mesh.material.opacity = 0;
        continue;
      }
      // 位置沿切线推进，并保持在天球半径上
      const travel = s.dist * p;
      const pos = s.from.clone().addScaledVector(s.dir, travel);
      pos.setLength(SKY_RADIUS - 40);
      s.mesh.position.copy(pos);
      // 亮度：迅速亮起，然后随尾迹变暗（尾迹由贴图渐变表现）
      const fade = p < 0.12 ? p / 0.12 : (1 - p) / 0.88;
      s.mesh.material.opacity = 0.95 * fade;
      // 面片朝向相机：X 轴沿运动方向，Z 轴指回原点
      z.copy(pos).normalize().negate();
      x.copy(s.dir);
      x.addScaledVector(z, -x.dot(z)).normalize();
      y.copy(z).cross(x).normalize();
      x.copy(y).cross(z).normalize();
      m4.makeBasis(x, y, z);
      s.mesh.quaternion.setFromRotationMatrix(m4);
      s.mesh.scale.set(320, 15, 1);
    }
  }

  // ---------- 重建 / 销毁 ----------
  #rebuild() {
    const visible = this.visible;
    this.#clearChildren();
    this.meteorState.length = 0;
    this.meteorTimer = 2.5;
    this.time = 0;
    this.#build();
    this.setVisible(visible);
  }

  #clearChildren() {
    const disposables = [];
    for (const child of [...this.group.children]) {
      this.group.remove(child);
      child.geometry?.dispose?.();
      // 星空材质共享 uniforms，逐层 dispose 不会互相影响
      child.material?.dispose?.();
      disposables.push(child);
    }
    if (this.glintsRoot) {
      this.scene.remove(this.glintsRoot);
      const points = this.glints;
      points?.geometry?.dispose?.();
      points?.material?.dispose?.();
      this.glintsRoot = null;
    }
    this.nebulaTexture?.dispose?.();
    this.meteorTexture?.dispose?.();
    this.nebulaTexture = null;
    this.meteorTexture = null;
    this.meteorGeo = null;
    this.band = null;
    this.bright = null;
    this.mid = null;
    this.dim = null;
    this.dust = null;
    this.glints = null;
    return disposables;
  }

  dispose() {
    this.#clearChildren();
    this.scene.remove(this.group);
  }
}

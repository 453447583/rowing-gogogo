import * as THREE from 'three';
import { SKY_TOWER, layerY, layerRadius } from '../data/skyTowerRun.js';

/**
 * 云端天梯场景：一座中央水晶塔 + 10 层玻璃浮空平台 + 浮空升降光柱 + 程序化天空。
 *
 * 美术口径（用户明确要求）：
 * - 不许出现裸露的 Box/Cylinder 程序几何体 —— 全部用自定义 BufferGeometry /
 *   LatheGeometry / 发光边条 / 自发光材质包起来，读起来是"建筑"不是"色块"。
 * - 天空云要接近 3A 观感 —— 自写 raymarch-lite 体积云 shader（fbm + 太阳前向散射）。
 *
 * 2026-11-24 用户改动：
 * - 天空不再自带一套"暖金→极光青"的插值色板，改成**每层套 WEATHERS 里的一套天气**
 *   （见 setWeather）：晴天蓝天白云、黄昏橙、暴风雨乌云压顶、暴雪冷白、星空带银河。
 * - 每层地面改成玻璃：中间不封底，从上往下能一层层看穿到第一层的海面。
 * - 塔下云海删除（第一层浮在竞技场海面上，脚底下是水）。
 *
 * 场景只负责"好看 + 几何采样"，玩法状态在 SkyTowerMode.js。
 */

// ---------- 共享 GLSL 噪声 ----------
// 3D value noise + fbm，天空 / 玻璃两个 shader 复用。
const NOISE_GLSL = /* glsl */`
  float hash31(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
  }
  float noise3(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash31(i + vec3(0,0,0)), hash31(i + vec3(1,0,0)), f.x),
          mix(hash31(i + vec3(0,1,0)), hash31(i + vec3(1,1,0)), f.x), f.y),
      mix(mix(hash31(i + vec3(0,0,1)), hash31(i + vec3(1,0,1)), f.x),
          mix(hash31(i + vec3(0,1,1)), hash31(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  float fbm(vec3 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) {
      v += a * noise3(p);
      p = p * 2.02 + vec3(11.3, 7.7, 3.1);
      a *= 0.5;
    }
    return v;
  }
`;

// ---------- 天空：物理大气渐变 + 体积感云 ----------
const SKY_VERT = /* glsl */`
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const SKY_FRAG = /* glsl */`
  precision highp float;
  varying vec3 vDir;
  uniform float uTime;
  uniform vec3 uSunDir;
  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform vec3 uSunColor;
  uniform vec3 uCloudLight;
  uniform vec3 uCloudDark;
  uniform float uCloudCover;
  uniform float uSunGain;   // 天气的太阳强度（暴风雨 ≈0.3，晴天 1.2）
  uniform float uStars;     // 星空天气才 >0
  ${NOISE_GLSL}

  // 星点：两层不同密度的格点，格心随机偏置 → 不会排成整齐的点阵。
  // 用方向做输入（天空球是无限远），星空才不会被镜头移动"拖着走"。
  float starLayer(vec3 d, float scale, float thresh) {
    vec3 p = d * scale;
    vec3 i = floor(p);
    float h = hash31(i);
    if (h < thresh) return 0.0;
    vec3 f = fract(p) - 0.5;
    vec3 off = vec3(hash31(i + 7.1), hash31(i + 13.7), hash31(i + 21.3)) - 0.5;
    float r = length(f - off * 0.55);
    float core = smoothstep(0.22, 0.0, r);
    float twinkle = 0.72 + 0.28 * sin(uTime * 1.9 + h * 62.8);
    return core * twinkle * (0.40 + 0.75 * h);
  }

  void main() {
    vec3 d = normalize(vDir);
    float up = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);
    // 大气渐变：地平线暖 → 天顶冷，太阳方向叠一层大范围辉光
    vec3 col = mix(uHorizon, uZenith, pow(up, 0.7));
    float sd = max(dot(d, normalize(uSunDir)), 0.0);
    col += uSunColor * pow(sd, 48.0) * 0.9 * uSunGain;
    col += uSunColor * pow(sd, 6.0) * 0.22 * uSunGain;

    // 星空：晴朗白天/黄昏/暴雨/暴雪都不画（uStars=0），只有 starry 天气亮起来
    if (uStars > 0.001 && d.y > 0.015) {
      float s = starLayer(d, 78.0, 0.956) + starLayer(d, 190.0, 0.982) * 0.6;
      // 一条淡银河：沿倾斜平面加亮，夜里抬头才不是纯黑
      float band = exp(-pow(dot(d, normalize(vec3(0.34, 0.52, -0.78))), 2.0) * 16.0);
      s += band * 0.085;
      col += vec3(0.86, 0.93, 1.0) * s * uStars * 2.0 * smoothstep(0.005, 0.12, d.y);
    }

    // 天空云：把视线投影到高空云层平面，做 3D fbm 密度 + 太阳前向散射。
    // 两层不同高度的云叠加：低层大而厚（积云），高层细而亮（卷云），
    // 视差让"云在流动"有纵深，不再是一张平贴图。
    if (d.y > 0.006) {
      vec3 rd = d;
      // 低层积云：把云放到 ~600m 高空再投影（不是原来那个 26m 的贴脸平面）。
      // 原来 26m 的问题：站在塔上抬头时整屏只对应云平面上一小段（约 6m），
      // fbm 采出来几乎是常数 —— 画面就是一片"水彩晕"，完全没有云的形状。
      // 除数的下限 0.35（≈20° 仰角）是防走样的：再低云平面会被拉到无穷远，
      // 纹理高频段会闪成噪点；低仰角那一条带由下面的 fade 淡进地平线色。
      vec3 p = rd * (600.0 / max(rd.y, 0.35));
      p *= 0.014;
      p.xz += vec2(uTime * 0.016, uTime * 0.008);
      float n = fbm(p);
      // 细节层拉到 4.2 倍频：0.030 的云尺度下 2.7 倍太"糊"，抬头看是一片水彩晕
      float detail = fbm(p * 4.2 + vec3(13.0, 5.0, 21.0));
      // 云量：天气给 0.20（星空）~0.96（暴风雨），阈值随之上下平移
      float lo = 0.66 - uCloudCover * 0.30;
      float density = smoothstep(lo, lo + 0.18, n);
      density *= 0.68 + 0.62 * detail;
      // 云越多的天气越"连成一片"：暴雨/暴雪不该是碎云缝里露蓝天的样子，
      // 那读起来像"多云的晴天"。乘子随 uCloudCover 涨，晴天几乎不变。
      density = clamp(density * (0.82 + uCloudCover * 0.72), 0.0, 1.0);
      // 只乘系数填不满"密度本来就是 0"的缝（0 × 任何数还是 0），
      // 高云量天气再垫一层背景云：fbm 只要过了 0.18 就给 90% 密度，
      // 于是天幕是一整片厚云，只剩极少数几处略薄的地方透光。
      float overcast = smoothstep(0.70, 0.95, uCloudCover);
      density = max(density, smoothstep(0.16, 0.52, n) * overcast * 0.94);
      // 沿太阳方向采一次密度梯度 → 云的受光面/背光面，光从边缘透出来
      float n2 = fbm(p + normalize(uSunDir) * 0.85);
      float lit = clamp((n - n2) * 2.6 + 0.30 + sd * 0.50, 0.0, 1.0);
      // 受光面再单独抬一次：云顶亮、云底暗，才有体积感（否则是一片同亮度的白斑）
      lit = mix(lit, 1.0, smoothstep(0.55, 0.95, n) * 0.45);
      // 云越满，明暗差越小：暴雨/暴雪是一整片压顶的厚云（均匀深灰），
      // 保留大反差会读成"一朵朵碎云缝里漏天"，反而不像暴雨天。
      lit = mix(lit, 0.52, smoothstep(0.7, 0.98, uCloudCover) * 0.8);
      vec3 cloud = mix(uCloudDark, uCloudLight, lit);
      cloud += uSunColor * pow(sd, 8.0) * 0.55 * lit * uSunGain;
      float fade = smoothstep(0.006, 0.07, rd.y);
      col = mix(col, cloud, clamp(density, 0.0, 1.0) * fade * 0.96);
      // 高层卷云（高度 95，横向拉长）
      vec3 q = rd * (1600.0 / max(rd.y, 0.35));
      q *= vec3(0.004, 0.003, 0.006);
      q.x += uTime * 0.004;
      float cn = fbm(q);
      float cDensity = smoothstep(0.52, 0.72, cn) * 0.5 * (0.35 + uCloudCover);
      col = mix(col, uCloudLight * 1.12, cDensity * fade);
    }
    // 地平线以下：天梯把场景雾压到近 0（否则 1400m 天空球会被雾染成一块平色），
    // 结果远海和海天接缝是一条硬线。这里把天空球的下半部渐变成远海色，
    // 海→天就有一个自然的过渡带，而不是"海到这里就断了"。
    float below = smoothstep(0.02, -0.07, d.y);
    col = mix(col, mix(uHorizon * 0.42, uZenith * 0.38, 0.45), below * 0.9);
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

// ---------- 玻璃地面：整层都在"看穿"----------
// 为什么不用 MeshPhysicalMaterial 的 transmission：transmission 每帧要额外渲一张
// 背景缓冲、再按菲涅尔取样，10 层大盘叠加在集显上直接把帧率砍半。这里手写一层
// 菲涅尔 + 分格线 + 天空色的玻璃片：没有光照计算（玻璃本来也不该有漫反射），
// 一格 draw call，透过去能直接看到下面的层和海面。
const GLASS_VERT = /* glsl */`
  varying vec3 vWorld;
  varying vec3 vN;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    vN = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;
const GLASS_FRAG = /* glsl */`
  precision highp float;
  varying vec3 vWorld;
  varying vec3 vN;
  uniform vec3 uTint;
  uniform vec3 uSky;
  uniform float uOpacity;
  uniform float uGrid;
  void main() {
    vec3 V = normalize(cameraPosition - vWorld);
    vec3 N = normalize(vN);
    float ndv = abs(dot(V, N));
    // 菲涅尔：正上方看得最透、掠射角才起反射。
    // 指数取 4.5 而不是 2~3：10 层大盘在低机位会被"叠 10 次"，指数太低整片会糊成奶白。
    float fres = pow(1.0 - ndv, 4.5);
    // 分格：4m 细线 + 16m 主缝，让"这是一整块玻璃板"有尺度参照。
    // 线宽用 fwidth 跟着像素密度走，否则俯视几十米外的斜视区域会走成一片摩尔纹噪点；
    // 400m 外直接淡出（那么远也只该是玻璃的反光，不该是一张网格贴图）。
    vec2 p = vWorld.xz;
    vec2 f1 = fwidth(p / 4.0);
    vec2 f2 = fwidth(p / 16.0);
    vec2 g1 = abs(fract(p / 4.0) - 0.5);
    vec2 g2 = abs(fract(p / 16.0) - 0.5);
    float fine = 1.0 - smoothstep(0.5 - f1.x * 1.6 - 0.006, 0.5, max(g1.x, g1.y));
    float seam = 1.0 - smoothstep(0.5 - f2.x * 1.6 - 0.010, 0.5, max(g2.x, g2.y));
    float near = 1.0 - smoothstep(140.0, 420.0, length(cameraPosition - vWorld));
    float line = (fine * 0.45 + seam * 0.55) * near;
    float alpha = uOpacity + fres * 0.26 + line * 0.12 * uGrid;
    // 反射色不能直接用天空的全亮度：地平线那圈本来就接近白，
    // 再乘一次高 fres 就变成"地上铺了一张白纸"。压到 0.55 并掺回玻璃本体的冷色。
    vec3 refl = uSky * 0.55;
    vec3 col = mix(uTint * 0.58, refl, 0.30 + 0.62 * fres)
             + vec3(0.03, 0.10, 0.14) * (1.0 - ndv)
             + line * 0.07 * uGrid;
    gl_FragColor = vec4(col, clamp(alpha, 0.02, 0.66));
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

// 每层天气的云量（天空云 shader 用）：越"坏"的天气云越满。
// day/dusk 有正常积云，storm 压成一片乌云，blizzard 是厚雪幕，
// starry 只留几缕夜云（不然星星全被糊住）。
const CLOUD_COVER = { day: 0.38, dusk: 0.48, storm: 0.96, blizzard: 0.86, starry: 0.20 };

/** 天气 → 天梯天空/灯光的一整套参数（不复制色板，直接用 WEATHERS 里的字段派生） */
function paletteFromWeather(w) {
  const id = w?.id || 'day';
  const zenith = new THREE.Color(w?.skyTop ?? 0x6dabef);
  const horizon = new THREE.Color(w?.skyBottom ?? 0xd4e8ff);
  const sun = new THREE.Color(w?.sunColor ?? 0xfff8f0);
  const cloudBase = new THREE.Color(w?.cloudColor ?? 0xffffff);
  // 云的亮面比云色更亮一档，暗面往地平线色里沉 —— 暴雨的云色本来就是黑灰，
  // 再压就是纯黑块；暴雪的云色接近白，提亮后和雪幕连成一片。
  const cloudLight = cloudBase.clone().lerp(new THREE.Color(1, 1, 1), id === 'starry' ? 0.02 : 0.14);
  // 云暗面压得比云色更低：亮天空（白天/暴雪）里云只能靠"暗面"和天空拉开对比，
  // 否则一片白云贴在浅蓝天幕上等于没云。
  // 暴雨要反向处理：它的云色本身已经是 0x3a434e，再乘 0.62 就成纯黑，
  // 云缝和云体全是黑的 —— 看上去像"碎云"，而不是压顶的乌云。所以只压到 0.92。
  const darkMul = id === 'starry' ? 0.5 : id === 'storm' ? 0.92 : 0.62;
  const cloudDark = cloudBase.clone().lerp(horizon, 0.45).multiplyScalar(darkMul);
  const sunDir = new THREE.Vector3(...(w?.sunDir || [0.565, 0.242, 0.785])).normalize();
  const sunPos = new THREE.Vector3(...(w?.sunPos || [205, 88, 285])).normalize();
  return {
    id, zenith, horizon, sun, cloudLight, cloudDark, sunDir, sunPos,
    cloudCover: CLOUD_COVER[id] ?? 0.5,
    sunGain: THREE.MathUtils.clamp((w?.sunIntensity ?? 1.4) / 1.5, 0.25, 1.25),
    stars: id === 'starry' ? 1 : 0,
    hemiIntensity: w?.hemiIntensity ?? 0.9,
    hemiSky: new THREE.Color(w?.hemiSky ?? w?.skyTop ?? 0xd9e8f6),
    hemiGround: new THREE.Color(w?.hemiGround ?? 0x3a4a70),
    sunIntensity: w?.sunIntensity ?? 1.4,
  };
}

export class SkyTowerScenery {
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'sky-tower-scenery';
    scene.add(this.group);
    this.t = 0;
    // 逐层开关：只有刚结束比赛的那层会点亮（逐层赛制）
    this.upliftOpenAt = [];
    this.liftRings = [];
    this.disposed = false;
    // 当前层天气（WEATHERS 里的对象），由 setWeather 写入；探针读 scenery.weather.id
    this.weather = opts.weather || null;
    this.sunDir = new THREE.Vector3(0.45, 0.55, 0.7).normalize();
    // 自己的光照（Environment 整组隐藏后，塔和船要有光）。光不挂 group，
    // 这样 group 整体可见性切换不影响它们。
    this.hemi = new THREE.HemisphereLight(0xd8f0ff, 0x3a4a70, 1.15);
    this.key = new THREE.DirectionalLight(0xfff0d4, 1.45);
    this.key.position.set(60, 120, 90);
    this.rim = new THREE.DirectionalLight(0x7fd8ff, 0.7);
    this.rim.position.set(-80, 50, -60);
    scene.add(this.hemi, this.key, this.rim);
    this.#buildSky();
    this.#buildSpire();
    this.#buildPlatforms();
    this.#buildLifts();
    this.#buildDecor();
    // 天空/灯光/玻璃的天气参数要等两组几何都建好再套（玻璃材质 uniforms 在里面）
    this.setWeather(this.weather || { id: 'day' });
  }

  #buildSky() {
    this.skyMat = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uSunDir: { value: this.sunDir.clone() },
        uZenith: { value: new THREE.Color(0x6dabef) },
        uHorizon: { value: new THREE.Color(0xd4e8ff) },
        uSunColor: { value: new THREE.Color(0xfff8f0) },
        uCloudLight: { value: new THREE.Color(0xffffff) },
        uCloudDark: { value: new THREE.Color(0x9fb4c8) },
        uCloudCover: { value: 0.46 },
        uSunGain: { value: 1 },
        uStars: { value: 0 },
      },
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), this.skyMat);
    this.sky.scale.setScalar(1400);
    this.sky.frustumCulled = false;
    this.group.add(this.sky);
  }


  #buildSpire() {
    const g = new THREE.Group();
    g.name = 'sky-tower-spire';
    // 2026-11-24：第 1 层改成水球赛，中圈要干净 —— 塔身从**第 2 层地板**起，
    // 不然一根 190m 的水晶柱悬在球场上空、又穿过第 2 层地板正中（石台/包子会埋进柱子）。
    // 底下的层环（layerRings）不跟着抬，它们本来就挂在每层平台边缘，位置是对的。
    const BASE_Y = SKY_TOWER.SPIRE_BASE_Y;
    // 塔身：Lathe 造型（不是裸圆柱），下宽上窄、腰部内收，像一根被风打磨的水晶柱
    const pts = [];
    const H = SKY_TOWER.SPIRE_H;
    for (let i = 0; i <= 24; i++) {
      const t = i / 24;
      const y = BASE_Y + t * (H - BASE_Y);
      const r = 3.6 - t * 1.35 + Math.sin(t * Math.PI * 3) * 0.5 + Math.sin(t * 17) * 0.12;
      pts.push(new THREE.Vector2(Math.max(1.1, r), y));
    }
    const bodyGeo = new THREE.LatheGeometry(pts, 12);
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0xbfd8ff, roughness: 0.18, metalness: 0.72,
      emissive: 0x1d4a7a, emissiveIntensity: 0.55, flatShading: true,
    });
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    g.add(body);
    // 底面封口：塔身现在从半空起（BASE_Y），Lathe 是开口的，
    // 不封底从下往上看会是一个能看穿到天空的空心管子。
    const capR = pts[0].x;
    const cap = new THREE.Mesh(new THREE.CircleGeometry(capR, 16), bodyMat);
    cap.rotation.x = Math.PI / 2;
    cap.position.y = BASE_Y + 0.02;
    g.add(cap);
    const capGlow = new THREE.Mesh(
      new THREE.RingGeometry(capR * 0.9, capR * 1.16, 32),
      new THREE.MeshBasicMaterial({
        color: 0x9fe8ff, transparent: true, opacity: 0.5,
        side: THREE.DoubleSide, depthWrite: false,
      }),
    );
    capGlow.rotation.x = Math.PI / 2;
    capGlow.position.y = BASE_Y + 0.02;
    g.add(capGlow);

    // 塔身发光竖棱：12 条细光带，随高度渐亮 —— 让塔在云海里"立得住"
    const edgeMat = new THREE.MeshBasicMaterial({ color: 0x9fe8ff, transparent: true, opacity: 0.72 });
    for (let i = 0; i < 8; i++) {
      const curvePts = [];
      for (let j = 0; j <= 20; j++) {
        const t = j / 20;
        const a = (i / 8) * Math.PI * 2;
        const r = 3.62 - t * 1.35 + Math.sin(t * Math.PI * 3) * 0.5 + 0.16;
        curvePts.push(new THREE.Vector3(Math.cos(a) * r, BASE_Y + t * (H - BASE_Y), Math.sin(a) * r));
      }
      const curve = new THREE.CatmullRomCurve3(curvePts);
      const strip = new THREE.Mesh(new THREE.TubeGeometry(curve, 40, 0.09, 5, false), edgeMat);
      g.add(strip);
    }

    // 每层一道光环 + 悬浮晶簇：把"层数"做成看得见的进度刻度
    this.layerRings = [];
    for (let i = 0; i < SKY_TOWER.LAYER_Y.length; i++) {
      const y = layerY(i);
      const r = layerRadius(i) + 2.2;
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(r, 0.16, 8, 72),
        new THREE.MeshBasicMaterial({ color: SKY_TOWER.LAYER_SKY[i], transparent: true, opacity: 0.85 }),
      );
      ring.rotation.x = Math.PI / 2;
      ring.position.y = y + 0.8;
      g.add(ring);
      this.layerRings.push(ring);
    }
    // 塔顶 gigantic 水晶尖，直入云霄
    const tip = new THREE.Mesh(
      new THREE.OctahedronGeometry(4.2, 0),
      new THREE.MeshStandardMaterial({
        color: 0xdffaff, roughness: 0.08, metalness: 0.4,
        emissive: 0x74e9ff, emissiveIntensity: 1.35, flatShading: true,
      }),
    );
    tip.position.y = H + 6;
    tip.scale.set(1, 2.6, 1);
    g.add(tip);
    this.tip = tip;
    this.group.add(g);
  }

  /**
   * 一层玻璃地面（2026-11-24 用户要求："每层地面要是玻璃做的，能看到第一层的水面"）。
   *
   * 原来是 Lathe 实心盘（上表面 + 斜切边 + 下收底座），从上往下看是一块实心色块。
   * 现在拆成三件：
   *   ① 玻璃盘面（薄薄一层，顶面 +0.3，和船底 diveTargetY=+0.4 咬合）
   *   ② 玻璃侧边（半米厚的"板边"，掠射角发亮，读得出厚度）
   *   ③ 边缘发光 rim + 同心符文（不透明，保证"边界在哪"一眼能看见）
   * 中间不封底 —— 底一封就看不见下面了。
   */
  #makePlatform(y, radius, idx) {
    const g = new THREE.Group();
    g.position.y = y;
    const tint = new THREE.Color(SKY_TOWER.LAYER_SKY[idx]);
    // 玻璃材质：10 层共享同一个 shader，颜色/天空色按层和天气各自一份
    const glassMat = new THREE.ShaderMaterial({
      vertexShader: GLASS_VERT,
      fragmentShader: GLASS_FRAG,
      transparent: true,
      depthWrite: false,          // 不写深度：后面的层和下面的海面才透得出来
      side: THREE.DoubleSide,
      // 分格线用 fwidth 抗锯齿：WebGL1 下没有这个扩展会编译失败（整层看不见）
      extensions: { derivatives: true },
      uniforms: {
        // 盘的染色：偏冷白，只掺一点该层主题色，避免整层看成一整块蓝玻璃
        uTint: { value: tint.clone().lerp(new THREE.Color(0xdff2ff), 0.72) },
        uSky: { value: new THREE.Color(0xd4e8ff) },
        uOpacity: { value: 0.05 + idx * 0.003 },
        uGrid: { value: idx === 0 ? 1.0 : 0.85 },
      },
    });
    const disk = new THREE.Mesh(new THREE.CircleGeometry(radius, 96), glassMat);
    disk.rotation.x = -Math.PI / 2;
    disk.position.y = 0.30;
    disk.renderOrder = 2;
    g.add(disk);

    const edgeGeo = new THREE.CylinderGeometry(radius, radius, 0.56, 96, 1, true);
    const edge = new THREE.Mesh(edgeGeo, glassMat);
    edge.position.y = 0.02;
    edge.renderOrder = 2;
    g.add(edge);

    // 地面符文：同心发光细环，暗示"这是竞技场不是荒野"。压在玻璃上沿一点点，
    // 不写深度（跟着玻璃一起透），否则会被自己挡住
    for (let k = 0; k < 3; k++) {
      const rr = radius * (0.42 + k * 0.22);
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(rr, 0.055, 6, 80),
        new THREE.MeshBasicMaterial({
          color: 0xaee8ff, transparent: true, opacity: 0.26, depthWrite: false,
        }),
      );
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.34;
      g.add(ring);
    }
    // 边缘发光护栏（只做光带，不做实体墙：掉下去是玩法的一部分）——
    // 玻璃层最需要它：不透明的一圈亮边就是"这里到头了"的唯一明确信号
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(radius + 0.15, 0.17, 8, 96),
      new THREE.MeshBasicMaterial({ color: SKY_TOWER.LAYER_SKY[idx] }),
    );
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 0.42;
    g.add(rim);
    // 边缘下方的冷色吊边：从下往上看时玻璃边不是悬空的
    const skirt = new THREE.Mesh(
      new THREE.TorusGeometry(radius + 0.02, 0.09, 6, 96),
      new THREE.MeshBasicMaterial({
        color: 0x8fd8ff, transparent: true, opacity: 0.5, depthWrite: false,
      }),
    );
    skirt.rotation.x = Math.PI / 2;
    skirt.position.y = -0.32;
    g.add(skirt);
    g.userData.glassMat = glassMat;
    return g;
  }

  #buildPlatforms() {
    this.platforms = [];
    this.glassMats = [];
    for (let i = 0; i < SKY_TOWER.LAYER_Y.length; i++) {
      const plat = this.#makePlatform(layerY(i), layerRadius(i), i);
      this.group.add(plat);
      this.platforms.push(plat);
      this.glassMats.push(plat.userData.glassMat);
    }
  }


  /**
   * 注：原来这里补过一圈「第一层外沿 → 看台前沿」的金属地板（r 81.6~96.6）,
   * 用来盖住"塔立在赛场中央、脚下露出空洞"。2026-11-24 第一层改成浮在海面上后，
   * 这圈不透明地板会把海面挡掉一半，所以整块删掉 —— 塔与看台之间直接是海。
   */

  /**
   * 浮空升降光柱（2026-11-24 取代螺旋梯）。
   * 每层一根通透光柱 + 底座光环 + 柱内上升光环：船开进去像被光托着垂直浮起。
   * 开场待机是暗红，开球后由 setUpliftOpen() 点亮。
   */
  #buildLifts() {
    const H = SKY_TOWER.LAYER_Y[1] - SKY_TOWER.LAYER_Y[0];
    for (let i = 0; i < SKY_TOWER.LAYER_Y.length - 1; i++) {
      const a = 0.35 + i * 1.1;
      const rr = layerRadius(i) * 0.38;
      const g = new THREE.Group();
      g.position.set(Math.cos(a) * rr, layerY(i) + 0.5, Math.sin(a) * rr);
      // 2026-11-27：比赛进行中不出现天梯，本层打满 60 秒后才显形（与 arena 同步开关）。
      g.visible = false;

      // 光柱：Lathe 剖面做出下宽上收、腰部微鼓的"能量柱"，不是裸圆柱
      const r = SKY_TOWER.UPLINK_R;
      const prof = [
        new THREE.Vector2(0.1, 0), new THREE.Vector2(r * 0.94, 0.4),
        new THREE.Vector2(r * 0.72, H * 0.5), new THREE.Vector2(r * 0.86, H),
        new THREE.Vector2(0.1, H),
      ];
      const column = new THREE.Mesh(
        new THREE.LatheGeometry(prof, 28),
        new THREE.MeshBasicMaterial({
          color: 0x59c8ff, transparent: true, opacity: 0.075,
          side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
        }),
      );
      g.add(column);

      // 底座光环
      const base = new THREE.Mesh(
        new THREE.TorusGeometry(r, 0.16, 8, 48),
        new THREE.MeshBasicMaterial({ color: 0xff6b6b, transparent: true, opacity: 0.6 }),
      );
      base.rotation.x = Math.PI / 2;
      g.add(base);

      // 柱内三道向上滚动的光环，明示"这里会往上送"
      const marks = [];
      for (let k = 0; k < 3; k++) {
        const m = new THREE.Mesh(
          new THREE.TorusGeometry(r * 0.66, 0.075, 6, 36),
          new THREE.MeshBasicMaterial({
            color: 0x9ff5ff, transparent: true, opacity: 0.18, depthWrite: false,
          }),
        );
        m.rotation.x = Math.PI / 2;
        m.position.y = 2 + k * (H - 4) / 3;
        g.add(m);
        marks.push(m);
      }
      g.userData = { base, column, marks };
      this.liftRings.push(g);
      this.group.add(g);
    }
  }

  /** 与 arena 判定同步：按层点亮升降光柱（不传层 = 全部） */
  setUpliftOpen(open, layer = null) {
    if (!this.upliftOpenAt.length) {
      this.upliftOpenAt = this.liftRings.map(() => false);
    }
    const apply = (i) => {
      const val = !!open;
      if (this.upliftOpenAt[i] === val) return;
      this.upliftOpenAt[i] = val;
      const g = this.liftRings[i];
      if (!g) return;
      const { base, column, marks } = g.userData;
      g.visible = val;
      base.material.color.setHex(val ? 0x9ff5ff : 0xff6b6b);
      base.material.opacity = val ? 0.95 : 0.5;
      column.material.opacity = val ? 0.12 : 0.035;
      marks.forEach((m) => { m.material.opacity = val ? 0.55 : 0.12; });
    };
    if (layer == null) {
      for (let i = 0; i < this.liftRings.length; i++) apply(i);
    } else if (layer >= 0 && layer < this.liftRings.length) {
      apply(layer | 0);
    }
  }

  #buildDecor() {
    // 平台外的浮空岛礁：低多边形但用变形 + 冷色 emissive，读起来是"云中碎石"。
    // 2026-11-24：第一层改浮在海面上后，原来 y=-18~130 的碎石会有一半泡在海面附近、
    // 读成"海上垃圾"；整体抬到 40~200m 高空 + 推远到 170~330m，变成塔周围的浮岛。
    const rockMat = new THREE.MeshStandardMaterial({
      color: 0x7f93b5, roughness: 0.85, metalness: 0.12,
      emissive: 0x16335c, emissiveIntensity: 0.45, flatShading: true,
    });
    let seed = 20261124;
    const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < 26; i++) {
      const a = rand() * Math.PI * 2;
      const r = 170 + rand() * 160;
      const y = 40 + rand() * 165;
      const size = 2 + rand() * 4.5;
      const geo = new THREE.IcosahedronGeometry(size, 1);
      const pos = geo.attributes.position;
      for (let j = 0; j < pos.count; j++) {
        const k = 0.75 + rand() * 0.5;
        pos.setXYZ(j, pos.getX(j) * k, pos.getY(j) * k * 0.55, pos.getZ(j) * k);
      }
      geo.computeVertexNormals();
      const rock = new THREE.Mesh(geo, rockMat);
      rock.position.set(Math.cos(a) * r, y, Math.sin(a) * r);
      rock.rotation.set(rand() * 3, rand() * 3, rand() * 3);
      this.group.add(rock);
    }
  }

  /**
   * 切到某一套天气（2026-11-24 起天梯不再自带色板，直接吃 WEATHERS）。
   *
   * 一次调用同步三件事：天空 shader 的色板/云量/太阳/星星、场景灯光、玻璃反光。
   * Game 那边同一时刻还会调 env.setWeather(w) + water.setWeather(w)，
   * 于是雨雪、星空顶灯（由 env 建）、水面颜色、塔上光照全部对齐同一个天气。
   *
   * @param {object} w WEATHERS 里的预设（getWeather(id) / weatherForLayer() 返回）
   * @param {number} [layer] 当前层号：只用来高亮塔身上对应的那道进度光环
   */
  setWeather(w, layer = null) {
    if (!w) return;
    this.weather = w;
    const p = paletteFromWeather(w);
    const u = this.skyMat.uniforms;
    u.uZenith.value.copy(p.zenith);
    u.uHorizon.value.copy(p.horizon);
    u.uSunColor.value.copy(p.sun);
    u.uCloudLight.value.copy(p.cloudLight);
    u.uCloudDark.value.copy(p.cloudDark);
    u.uCloudCover.value = p.cloudCover;
    u.uSunGain.value = p.sunGain;
    u.uStars.value = p.stars;
    u.uSunDir.value.copy(p.sunDir);
    this.sunDir.copy(p.sunDir);

    // 灯光跟天气：黄昏橙、暴雪冷白、夜空蓝月 —— 塔和船要跟天一起变脸，
    // 否则"天是晚上、塔还是正午打光"一眼假。
    this.hemi.color.copy(p.hemiSky);
    this.hemi.groundColor.copy(p.hemiGround);
    this.hemi.intensity = THREE.MathUtils.clamp(p.hemiIntensity * 1.25, 0.55, 1.8);
    this.key.color.copy(p.sun);
    this.key.intensity = THREE.MathUtils.clamp(p.sunIntensity * 0.95, 0.35, 1.7);
    this.key.position.copy(p.sunPos).multiplyScalar(240);
    // 冷边光：夜景/暴雨里塔身背光面全靠它，不然整座塔糊成一块黑剪影
    const coldRim = w.id === 'starry' || w.id === 'storm';
    this.rim.color.set(w.id === 'dusk' ? 0xffb08a : coldRim ? 0x9fc4ff : 0x7fd8ff);
    this.rim.intensity = coldRim ? 1.05 : 0.7;

    // 玻璃反的就是地平线那圈亮色（掠射角最亮的就是这条带）
    if (this.glassMats) {
      for (const m of this.glassMats) m.uniforms.uSky.value.copy(p.horizon);
    }
    if (this.layerRings && layer != null) {
      this.layerRings.forEach((r, i) => { r.material.opacity = i === (layer | 0) ? 1 : 0.42; });
    }
  }

  /** 场景里跟着玩家高度走的太阳光方向（给 Water/Environment 用的可选接口） */
  getSunDir() { return this.sunDir.clone(); }

  update(dt) {
    this.t += dt;
    this.skyMat.uniforms.uTime.value = this.t;
    if (this.tip) {
      this.tip.rotation.y += dt * 0.18;
      this.tip.position.y = SKY_TOWER.SPIRE_H + 6 + Math.sin(this.t * 0.8) * 1.2;
    }
    // 光柱里的光环缓缓上升；锁定期只轻微呼吸，开启后才明显流动
    const H = SKY_TOWER.LAYER_Y[1] - SKY_TOWER.LAYER_Y[0];
    this.liftRings.forEach((g, gi) => {
      const open = !!this.upliftOpenAt[gi];
      g.userData.marks.forEach((m, k) => {
        const u = (k / 3 + this.t * (open ? 0.16 : 0.02) + gi * 0.11) % 1;
        m.position.y = 1.5 + u * (H - 3);
        m.material.opacity = (open ? 0.5 : 0.1) * Math.sin(u * Math.PI);
      });
    });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((m) => m.dispose());
      }
    });
    this.scene.remove(this.group);
    this.scene.remove(this.hemi, this.key, this.rim);
  }
}

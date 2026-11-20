import * as THREE from 'three';
import { waveUniforms, waveAmpSum, WAVE_AMP_SUM, clampWaveScale } from '../utils/waves.js';
import { faultRects } from '../utils/faults.js';

// 写实海洋（参考 game.jpg）：
// - Gerstner 波（尖峰波峰 + 水平收缩，更真实的三维浪形）
// - 解析法线 + 双层滚动细节法线（高频涟漪/太阳耀斑）
// - 菲涅尔天空反射（反射射线采样程序化天空渐变 + 太阳光晕）
// - 双瓣太阳高光（锐利耀斑 + 宽光带），浪尖白沫
// - 次表面散射（阳光穿透波峰的透射光）
// - 艇扰动波：玩家移动掀起白浪，氮气时波浪更大
// 主波形与 src/utils/waves.js 一致（浮力物理同步），细节波仅视觉

const MAX_WAVES = 5;
const MAX_BOATS = 4;
// 弧形尾迹：记录本地玩家的历史船尾位置，在着色器里连成一条泡沫带。
// 12 个采样点 → 11 段，高速时约覆盖 45 米；漂移时折线自然弯成弧。
const MAX_TRAIL = 12;
const MAX_TRAIL_SEG = MAX_TRAIL - 1;
// 尾迹存活时长（秒）：决定尾迹最远能拖多长
const TRAIL_LIFE = 2.6;
const ECHO = new THREE.Color(); // 复用：水面呼应天空时的中间色
const FOAM_WHITE = new THREE.Color(0xf4fcff);
const FOAM_TMP = new THREE.Color();
// 写实调色时水体压向的“深海蓝绿”，和着色器里的 deepen() 同一色值
const DEEP_WATER = new THREE.Color(0x1f5264);

// GLSL: 哈希噪声 + 值噪声（细节法线用）
const NOISE_GLSL = /* glsl */`
  float hash21(vec2 p) {
    p = fract(p * vec2(234.34, 435.345));
    p += dot(p, p + 34.23);
    return fract(p.x * p.y);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }
  // 值噪声 + 解析梯度：一次取 4 个角哈希，同时返回噪声值和 ∂n/∂x、∂n/∂y。
  // 细节法线原来用中心差分（每个倍频采样 3 次 = 12 次哈希），
  // 改成解析梯度后每倍频只要 4 次，片元开销降到三分之一，涟漪观感不变。
  vec3 vnoiseGrad(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    vec2 du = 6.0 * f * (1.0 - f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    float n = mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
    float nx = du.x * mix(b - a, d - c, u.y);
    float ny = du.y * mix(c - a, d - b, u.x);
    return vec3(n, nx, ny);
  }
`;

// 水面网格精度：波浪是低频大浪，法线细节在片元里算，
// 降低分段只影响水面轮廓的锯齿，画面几乎看不出差别。
// 256×256 = 13 万三角形铺满全屏，是每帧顶点开销的大头，降到 192 省 44%。
const WATER_SEGMENTS = { high: 192, medium: 128, low: 96 };

// ---- 环境反射（水面倒影用的 cubemap）----
// 128² 是为了让 mip 链够粗：掠射角下一个像素覆盖几十米水面，采样靠 mip 模糊出
// 远处的"银带"；再大就是纯浪费（倒影本来就要被粗糙度糊掉）。
const ENV_SIZE = 128;
const ENV_FAR = 6000;            // 远山在这个距离内，够用
const ENV_SKY_SCALE = 4000;      // 天空穹顶烘图时临时缩到这么小（见 #renderEnvCube）
const ENV_MIN_Y = 45;            // 烘图采样点最低抬到 45m，避免钻进礁石/船体内侧
const ENV_SKY_LAYER = 2;         // 天空额外挂的图层，供"只渲天空"的重烘使用
const ENV_REFRESH_SEC = 4;       // 昼夜循环下重烘的最小间隔

// 岸边接触阴影兜底：1×1 全黑，没有烘焙遮罩的地图（非峡谷）采样恒为 0，不压暗水色
function makeEmptyShoreShadowTexture() {
  const tex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  tex.needsUpdate = true;
  return tex;
}

function makeWaterGeometry(size, seg) {
  const geo = new THREE.PlaneGeometry(size, size, seg, seg);
  geo.rotateX(-Math.PI / 2);
  return geo;
}

/**
 * 熔岩主题的"冷却航道"遮罩：把 gates 连成一条粗白带，烘到 512² 的贴图里。
 *
 * 为什么用贴图而不是把 gates 传成 uniform 数组：片元里逐个门算点到线段距离要
 * 20 次循环/像素；贴图只要一次采样，而且能直接用 canvas 的两次描边做柔边。
 * 值域：1 = 航道内（熔岩冷却成黑色地壳），0 = 航道外（活跃岩浆）。
 * flipY 关掉，让 canvas 的 y 轴和世界 z 轴同向，uv 直接 (x,z) 映射不用翻。
 */
function makeLavaTrackMask(mapDef) {
  const R = (mapDef.boundary?.r ?? 300) * 1.3;
  const S = 512;
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, S, S);
  const px = (v) => (v + R) / (2 * R) * S;
  const gates = mapDef.gates || [];
  if (gates.length >= 3) {
    ctx.beginPath();
    gates.forEach((g, i) => {
      if (i === 0) ctx.moveTo(px(g[0]), px(g[1]));
      else ctx.lineTo(px(g[0]), px(g[1]));
    });
    ctx.closePath();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const core = (mapDef.gateWidth * 2 / (2 * R)) * S;
    // R 通道 = 冷却航道（G/B 必须保持 0，否则 shader 里按 B 取虚线会把整条路染黄）。
    // 0 / 0.42 / 1.0 三档还顺带给了 shader 一条现成的"路缘带"（见片元里的 rim）。
    ctx.strokeStyle = 'rgba(255,0,0,0.42)';
    ctx.lineWidth = core + 8;
    ctx.stroke();
    ctx.strokeStyle = '#ff0000';
    ctx.lineWidth = core;
    ctx.stroke();
    // G 通道 = 两侧连续发光路缘：把 gates 按法线各偏移一条折线。
    // 之前想"从 R 的 0.42 台阶里抠一条边"，纹理线性滤波一搅就把整条航道都算成边，
    // 实拍直接糊成一片黄。用独立通道画两条真实的线才确定。
    const N = gates.length;
    const off = mapDef.gateWidth + 1.5;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.setLineDash([]);
    ctx.strokeStyle = '#00ff00';
    ctx.lineWidth = 3;
    for (const s of [-1, 1]) {
      ctx.beginPath();
      for (let i = 0; i < N; i++) {
        const p = gates[i];
        const a = gates[(i - 1 + N) % N], b = gates[(i + 1) % N];
        const dx = b[0] - a[0], dz = b[1] - a[1];
        const len = Math.hypot(dx, dz) || 1;
        const x = p[0] - dz / len * off * s;
        const z = p[1] + dx / len * off * s;
        if (i === 0) ctx.moveTo(px(x), px(z));
        else ctx.lineTo(px(x), px(z));
      }
      ctx.closePath();
      ctx.stroke();
    }
    // B 通道 = 中央黄色虚线。lighter 叠加不会动 R/G，shader 各取一个通道即可。
    ctx.setLineDash([6, 11]);
    ctx.strokeStyle = '#0000ff';
    ctx.lineWidth = 2.2;
    ctx.stroke();
    ctx.restore();
  }
  // 近道也必须烘进「冷却航道」遮罩：Track 只画箭头/浮标，不画水面。
  // 少了这一步，抄近道时船脚下是活跃岩浆，看起来像在陆地上开船。
  // 只写 R 通道，G/B 路缘与中央虚线仍归主道，近道不会变成一整条黄灯带。
  for (const sc of mapDef.shortcuts || []) {
    const pts = sc.points || [];
    if (pts.length < 2) continue;
    ctx.beginPath();
    pts.forEach((p, i) => {
      if (i === 0) ctx.moveTo(px(p[0]), px(p[1]));
      else ctx.lineTo(px(p[0]), px(p[1]));
    });
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const scCore = ((sc.width || 4) * 2 / (2 * R)) * S;
    ctx.strokeStyle = 'rgba(255,0,0,0.42)';
    ctx.lineWidth = scCore + 6;
    ctx.stroke();
    ctx.strokeStyle = '#ff0000';
    ctx.lineWidth = scCore;
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.flipY = false;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return { tex, area: new THREE.Vector4(-R, -R, 1 / (2 * R), 0) };
}

/**
 * 断层遮罩：把裂谷矩形烘成一张"白块 = 挖洞"的贴图。
 *
 * 为什么要在水面 shader 里 discard，而不是继续用一块黑贴片盖住水面：
 * 盖上去的贴片永远是一块平面，人眼一读就是"贴纸"；discard 之后水面**真的有个洞**，
 * 底下就是 Track 建的真实裂谷（岩壁 + 熔岩底 + 瀑布），从追尾机位能直接看到纵深。
 * 裂纹矩形和 Track.#buildFaults 用同一份 `faultRects()`，不会错位。
 */
function makeFaultMask(mapDef) {
  const rects = faultRects(mapDef);
  if (!rects.length) return null;
  const R = (mapDef.boundary?.r ?? 300) * 1.3;
  const S = 512;
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, S, S);
  const px = (v) => ((v + R) / (2 * R)) * S;
  ctx.fillStyle = '#fff';
  for (const f of rects) {
    // 稍微放大一点：让水面洞口比岩壁宽 ~0.4m，避免水边压在岩石上闪 z-fighting
    const grow = 0.4;
    ctx.save();
    ctx.translate(px(f.cx), px(f.cz));
    // 世界 (fx,fz) → canvas (x,y) 的旋转角；canvas 的 x=世界x、y=世界z
    ctx.rotate(Math.atan2(f.fz, f.fx));
    ctx.fillRect(
      (-f.width / 2 - grow) / (2 * R) * S,
      (-f.halfAcross - grow) / (2 * R) * S,
      (f.width + grow * 2) / (2 * R) * S,
      (f.halfAcross * 2 + grow * 2) / (2 * R) * S,
    );
    ctx.restore();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.flipY = false;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return { tex, area: new THREE.Vector4(-R, -R, 1 / (2 * R), 0) };
}

/**
 * 冰原挖洞遮罩：冰汐海峡的冰壳是一块平面，浪峰永远会从中间穿出来，
 * 形成白/蓝交错的"乱码"。把冰壳覆盖的圆形区域在水面上 discard 掉，
 * 水面只剩冰壳这一层，赛道看起来就是单一表面。
 */
function makeIceHoleMask(mapDef) {
  const ice = mapDef.iceZone;
  if (!ice) return null;
  const R = ice.r + 8;
  const S = 1024;
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, S, S);
  // 注意：世界 x → canvas x、世界 z → canvas y，两者的原点不同（ice.x / ice.z），
  // 必须分开算。之前共用一个基于 ice.x 的 px()，圆盘被整体沿 z 平移了
  // (ice.x - ice.z) 米，导致冰圈外的正常水面被误挖掉（玩家看到"只有倒影没有水面"）。
  const px = (v) => ((v - (ice.x - R)) / (2 * R)) * S;
  const pz = (v) => ((v - (ice.z - R)) / (2 * R)) * S;
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  // 洞口比冰壳略大 0.6m：冰壳边缘外侧不留一圈被浪掀起的水缝
  ctx.arc(px(ice.x), pz(ice.z), (ice.r + 0.6) / (2 * R) * S, 0, Math.PI * 2);
  ctx.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.flipY = false;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return { tex, area: new THREE.Vector4(ice.x - R, ice.z - R, 1 / (2 * R), 0) };
}

export class Water {
  #boatArr = null;
  #trail = [];                 // 本地玩家历史船尾采样点 {x,z,age,speed}
  #pts = [];                   // 每帧拼好的折线（头顶点 + 历史点）
  #segCap = MAX_TRAIL_SEG;     // 画质降级后的最大段数
  #trailEnabled = true;
  // 环境反射（天空穹顶烘 cubemap）
  #envRT = null;               // WebGLCubeRenderTarget
  #envCam = null;              // CubeCamera
  #envCtx = null;              // { renderer, scene, skyMesh } —— 首次烘焙时记下来，供昼夜刷新用
  #envBakedAt = -1e9;          // 上次烘焙的 elapsed（秒）
  #envStale = false;           // 太阳/天光动了，需要重烘
  #envSun = new THREE.Vector3();  // 上次烘焙时的太阳方向
  // 烘倒影时要临时摘掉的物体（见 bakeEnvironment 的第 5 个参数）：
  // 星空天气的几千颗星星在 128² 的罐子里会糊成一片白（实测罐内 ~1.9 且三通道相等），
  // 夹 uEnvMax 之后整片海变成白板 —— 夜里水面比天还亮，赛道/浮标全看不见。
  #envExclude = [];

  constructor(mapDef, size = 700) {
    this.mapDef = mapDef;
    // 基准水色：昼夜循环时按天光亮度缩放，切天气时回填
    this.baseShallow = new THREE.Color(mapDef.waterColor);
    this.baseDeep = new THREE.Color(mapDef.waterDeep);
    // 水面雾的两套值：水面（天气预设）与水下（Environment 传进来），按 uwK 插值
    this.surfFogColor = new THREE.Color(mapDef.fogColor);
    this.surfFogDensity = mapDef.fogDensity;
    this.uwK = 0;
    this.uwFog = null;
    // 熔岩主题：航道遮罩只在带 lava 的地图烘一次，其它地图连 canvas 都不创建
    const lavaTrack = mapDef.lava ? makeLavaTrackMask(mapDef) : null;
    // 断层遮罩：只有声明了 faults 的地图才烘（目前仅熔岩图）
    const faultMask = mapDef.faults ? makeFaultMask(mapDef) : null;
    // 冰原挖洞：有 iceZone 的地图把冰壳覆盖区的水面挖掉（冰壳本身不透明）
    const iceHole = makeIceHoleMask(mapDef);
    const holeMask = iceHole || faultMask;
    this.uniforms = {
      uTime: { value: 0 },
      uWaveScale: { value: 1.0 },
      // 水面网格是"局部坐标 + mesh.position"铺的（Game 按 boundary 圆心平移）。
      // 波浪在 JS 侧（waveHeight）和片元法线里都用**世界坐标**求相位，
      // 顶点这里必须补上同一个平移，否则两边差一个 (350,200) 的相位偏移：
      // 视觉浪面和物理浪高对不上，贴浪的起点线会被"另一套浪"整个盖掉。
      uCenter: { value: new THREE.Vector2(0, 0) },
      uWaveAmpSum: { value: 1.0 },
      uWaveCount: { value: 0 },
      uWaves: {
        value: Array.from({ length: MAX_WAVES }, () => new THREE.Vector4(1, 0, 0.5, 0.1)),
      },
      uSpeeds: { value: [1, 1, 1, 1, 1] },
      uColorShallow: { value: new THREE.Color(mapDef.waterColor) },
      uColorDeep: { value: new THREE.Color(mapDef.waterDeep) },
      uColorSSS: { value: new THREE.Color(mapDef.waterColor).lerp(new THREE.Color(0x2fd0c0), 0.5) },
      uCrestColor: { value: new THREE.Color(mapDef.waterCrest ?? '#d8f2ee') },
      uSkyTop: { value: new THREE.Color(mapDef.skyTop) },
      uSkyBottom: { value: new THREE.Color(mapDef.skyBottom) },
      uSunDir: { value: new THREE.Vector3(0.45, 0.7, 0.3).normalize() },
      uSunColor: { value: new THREE.Color(mapDef.sunColor) },
      uFogColor: { value: new THREE.Color(mapDef.fogColor) },
      uFogDensity: { value: mapDef.fogDensity },
      // 水下：把水面自身压暗并把雾拉满（否则从下往上看是一片"蓝天"）
      uUnder: { value: 0 },
      uFogStrength: { value: 0.66 },
      // 艇扰动：xy=位置 z=强度(0~1) w=保留
      uBoats: { value: Array.from({ length: MAX_BOATS }, () => new THREE.Vector4(0, 0, 0, 0)) },
      // 船尾尾迹：xy=位置 zw=前进方向（水平单位向量）
      uWakes: { value: Array.from({ length: MAX_BOATS }, () => new THREE.Vector4(0, 0, 0, 1)) },
      uWakeStr: { value: [0, 0, 0, 0] },
      // 弧形尾迹：A=(x0,z0,x1,z1) 线段两端，B=(w0,w1,s0,s1) 两端宽度与强度
      uTrailA: { value: Array.from({ length: MAX_TRAIL_SEG }, () => new THREE.Vector4()) },
      uTrailB: { value: Array.from({ length: MAX_TRAIL_SEG }, () => new THREE.Vector4()) },
      uTrailSegs: { value: 0 },
      // 船首：xy=船首世界坐标 zw=前向单位向量；uBowFoam x=浪冠 y=V形双臂 z=臂厚度
      uBow: { value: new THREE.Vector4(0, 0, 0, 1) },
      uBowFoam: { value: new THREE.Vector3(0, 0, 0.4) },
      // 泡沫三层配色：核心实心白 / 外圈半透明水带
      uFoamCore: { value: new THREE.Color(0xf4fcff) },
      uFoamBand: { value: new THREE.Color(0xb9dfe6) },
      uFoamDetail: { value: 1 },
      // 自然白头浪的翻白强度（天气决定）：晴天≈看不见，暴风雨/暴风雪才成片
      uFoamStrength: { value: 0.4 },
      // 水体调色“中间档”：比纯写实压暗调亮一档，恢复天空倒影与水面纹理，
      // 但不回到早期镜面天光白的“度假海”。低画质只关细节项，配色三档一致
      uSat: { value: 1 },
      uExposure: { value: 1 },
      uGlint: { value: 0 },
      // 微表面粗糙度倍率：太阳高光用 GGX 分布，α 随"一个像素覆盖的水面尺度"增长。
      // 这是金色光路的来源——近处像素跨几厘米 → 点状闪光；远处跨好几米 →
      // 法线统计上更平 → 整片变宽变柔。低画质稍微加粗，省掉细碎闪烁的走样。
      uRough: { value: 1 },
      uSpecGain: { value: 1 },
      // 水体吸收系数（1/米）：视线在水里的路径越长越接近深海色，
      // 近处透亮、远处发沉，不用再靠 uSat/uExposure 硬压亮度。
      // 0.014 → 0.019：配合下面 pathLen 的常数项从 20 降到 4，近处才真的清亮、
      // 远处才真的沉下去 —— 只调一项的话近远还是会糊成一个色。
      uAbsorb: { value: 0.019 },
      // 天空反射里的云：让远处水面映出蓝天白云，而不是一块纯色
      uCloudAmt: { value: 0 },
      uCloudColor: { value: new THREE.Color(0xd8e4ef) },
      // 环境反射：把天空穹顶（含云、地平线、远山）烘成一张 cubemap 再采样。
      // 解析式 skyColor() 只能给渐变 + 一小段云带，掠射角下还会被透视压成白纹，
      // 山脊/云团根本进不来 —— "塑料板"感主要就是这里缺。
      // uEnv=0（没烘成功 / 老设备不支持半浮点）时整段退回解析天空，行为与改动前一致。
      uEnv: { value: null },
      uEnvOn: { value: 0 },
      uEnvAmt: { value: 0.85 },
      // 倒影亮度上限：天空 cubemap 是线性 HDR，云的亮部能到 10 以上，
      // 原样乘进菲涅尔会把水面糊成一片奶油白（"牛奶海"）。夹在 3.5 后
      // 亮部仍在、但不再整片翻白，暗处的浪谷才留得住 —— 有明暗才有"水"。
      uEnvMax: { value: 1.8 },
      // 掠射角下天空反射的占比上限（菲涅尔削顶）。
      // 0.80 是"贴着水面看"的物理值，但太阳高挂时整片中景会变成天空色的
      // 磨砂板 —— 晴天由天气给它一档更低的值（见 setWeather）
      uReflMax: { value: 0.80 },
      // 岸边接触阴影：岩岛落影烘成俯视遮罩（Environment 构建时填），
      // xy = 遮罩左下角世界坐标，z = 1/边长；z=0 表示该地图没有遮罩
      uShoreShadow: { value: makeEmptyShoreShadowTexture() },
      uShoreArea: { value: new THREE.Vector4(0, 0, 0, 0) },
      uShoreStrength: { value: 0.5 },
      // 熔岩主题（只有带 mapDef.lava 的地图会开）：
      // 这些 uniform 在 uLava=0 时完全不参与着色，其它地图的片元路径一字不变。
      // 放在这里而不是另起一套材质，是因为水面还得接着吃 uBoats/uWakes 的
      // 艇扰动与尾迹、以及 shadowmap_vertex 的阴影 —— 分家就得把那些全抄一遍。
      uLava: { value: mapDef.lava ? 1 : 0 },
      uLavaCrust: { value: new THREE.Color(mapDef.lava?.crust ?? 0x160b12) },
      uLavaHot: { value: new THREE.Color(mapDef.lava?.hot ?? 0xd8340c) },
      uLavaCore: { value: new THREE.Color(mapDef.lava?.core ?? 0xffc24a) },
      uLavaGlow: { value: mapDef.lava?.glow ?? 1.5 },
      uLavaFlow: { value: mapDef.lava?.flow ?? 0.11 },
      uLavaTrack: { value: lavaTrack?.tex ?? makeEmptyShoreShadowTexture() },
      uLavaTrackArea: { value: lavaTrack?.area ?? new THREE.Vector4(0, 0, 0, 0) },
      // 断层 / 冰壳：白块 = 把水面挖掉（discard）
      uFaultMask: { value: holeMask?.tex ?? makeEmptyShoreShadowTexture() },
      uFaultArea: { value: holeMask?.area ?? new THREE.Vector4(0, 0, 0, 0) },
    };

    const waves = waveUniforms();
    this.uniforms.uWaveCount.value = Math.min(waves.length, MAX_WAVES);
    this.uniforms.uWaveAmpSum.value = Math.max(waveAmpSum(), 1e-3);
    waves.slice(0, MAX_WAVES).forEach((w, i) => {
      this.uniforms.uWaves.value[i].set(w.dirX, w.dirZ, w.k, w.amp);
      this.uniforms.uSpeeds.value[i] = w.speed;
    });

    const geo = makeWaterGeometry(size, WATER_SEGMENTS.high);
    this.size = size;
    this.seg = WATER_SEGMENTS.high;

    const mat = new THREE.ShaderMaterial({
      side: THREE.DoubleSide, // 水下抬头也能看到水面
      // fwidth 用来估算"一个像素覆盖多少米水面"（LOD 与粗糙度都要用它），
      // WebGL2 里是核心功能，WebGL1 由 three 补 OES_standard_derivatives
      extensions: { derivatives: true },
      // 水面要接收方向光阴影（树影/岛影落在水上）：自写 ShaderMaterial 默认不参与灯光，
      // 打开 lights 并合并 lights uniform，才能用 three 的 shadowmap 通道拿到 shadowMask
      lights: true,
      uniforms: Object.assign(THREE.UniformsUtils.clone(THREE.UniformsLib.lights), this.uniforms),
      vertexShader: /* glsl */`
        #include <common>
        #include <shadowmap_pars_vertex>
        uniform float uTime;
        uniform float uWaveScale;
        uniform vec2 uCenter;
        uniform int uWaveCount;
        uniform vec4 uWaves[${MAX_WAVES}];
        uniform float uSpeeds[${MAX_WAVES}];
        uniform vec4 uBoats[${MAX_BOATS}];

        varying vec3 vWorldPos;
        varying vec3 vNormal;
        varying float vHeight;   // 波高（泡沫/SSS用）
        varying float vCrest;    // Gerstner 波峰压缩度（泡沫用）
        varying float vTurb;     // 艇扰动累计强度（泡沫用）

        void main() {
          vec3 pos = position;
          // 波浪相位统一用世界坐标（与 waveHeight / 片元法线同源）
          vec2 wpos = pos.xz + uCenter;
          float h = 0.0;
          float dhx = 0.0;   // ∂h/∂x
          float dhz = 0.0;   // ∂h/∂z
          float crest = 0.0; // 波峰压缩因子
          vec2 disp = vec2(0.0);

          for (int i = 0; i < ${MAX_WAVES}; i++) {
            if (i >= uWaveCount) break;
            vec4 w = uWaves[i]; // x=dirX y=dirZ z=k w=amp
            float phase = (wpos.x * w.x + wpos.y * w.y) * w.z - uTime * uSpeeds[i];
            float s = sin(phase);
            float c = cos(phase);
            h += w.w * s;
            dhx += w.w * w.z * c * w.x;
            dhz += w.w * w.z * c * w.y;
            // Gerstner 水平位移（向波峰收缩 → 尖峰浪形）
            float Q = 0.62;
            disp += vec2(w.x, w.y) * (Q * w.w * c);
            crest += Q * w.w * w.z * s;
          }
          h *= uWaveScale;
          dhx *= uWaveScale;
          dhz *= uWaveScale;
          crest *= uWaveScale;

          pos.x += disp.x * uWaveScale;
          pos.z += disp.y * uWaveScale;

          // 艇扰动波：向外扩散的环形波，随距离衰减
          float turb = 0.0;
          for (int i = 0; i < ${MAX_BOATS}; i++) {
            vec4 b = uBoats[i];
            if (b.z <= 0.001) continue;
            float d = distance(pos.xz, b.xy);
            float ring = sin(d * 1.6 - uTime * 9.0) * exp(-d * 0.16);
            float rh = ring * b.z * 0.55;
            h += rh;
            dhx += rh * 0.35; // 环形波坡度近似
            dhz += rh * 0.35;
            // 艇体周围的翻腾只留紧贴船身的一圈：远处交给弧形尾迹，
            // 否则指数衰减太慢会在船后糊成一大片白色雾墙
            turb += exp(-d * 0.30) * b.z * 0.8;
          }

          pos.y += h;
          vHeight = h;
          vCrest = crest;
          vTurb = turb;
          vNormal = normalize(vec3(-dhx, 1.0, -dhz));

          vec4 wp = modelMatrix * vec4(pos, 1.0);
          vWorldPos = wp.xyz;
          // 方向光阴影采样所需的顶点数据（three 的 shadowmap_vertex 通道）
          vec4 worldPosition = wp;
          vec3 transformedNormal = normalMatrix * vNormal;
          #include <shadowmap_vertex>
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */`
        #include <common>
        #include <packing>
        #include <lights_pars_begin>
        #include <shadowmap_pars_fragment>
        #include <shadowmask_pars_fragment>
        uniform vec3 uColorShallow;
        uniform vec3 uColorDeep;
        uniform vec3 uColorSSS;
        uniform vec3 uCrestColor;
        uniform vec3 uSkyTop;
        uniform vec3 uSkyBottom;
        uniform vec3 uSunDir;
        uniform samplerCube uEnv;
        uniform float uEnvOn;
        uniform float uEnvAmt;
        uniform float uEnvMax;
        uniform float uReflMax;
        uniform vec3 uSunColor;
        uniform vec3 uFogColor;
        uniform float uFogDensity;
        // 水下程度 0~1 + 雾量倍率。
        // 水面着色器有自己的一套雾 uniform（不吃 scene.fog），所以从水下抬头看时
        // 它一直用着"地表那套明亮天空雾"，读起来就是一片蓝天 —— 必须单独喂。
        uniform float uUnder;
        uniform float uFogStrength;
        uniform float uTime;
        uniform vec4 uWakes[${MAX_BOATS}];
        uniform float uWakeStr[${MAX_BOATS}];
        uniform vec4 uTrailA[${MAX_TRAIL_SEG}];
        uniform vec4 uTrailB[${MAX_TRAIL_SEG}];
        uniform int uTrailSegs;
        uniform vec4 uBow;
        uniform vec3 uBowFoam;
        uniform vec3 uFoamCore;
        uniform vec3 uFoamBand;
        uniform float uFoamDetail;
        uniform float uFoamStrength;
        uniform float uSat;
        uniform float uExposure;
        uniform float uGlint;
        uniform float uRough;
        uniform float uSpecGain;
        uniform float uAbsorb;
        uniform float uWaveScale;
        uniform float uWaveAmpSum;
        uniform int uWaveCount;
        uniform vec4 uWaves[${MAX_WAVES}];
        uniform float uSpeeds[${MAX_WAVES}];
        uniform float uCloudAmt;
        uniform vec3 uCloudColor;
        uniform sampler2D uShoreShadow;
        uniform vec4 uShoreArea;
        uniform float uShoreStrength;
        uniform float uLava;
        uniform vec3 uLavaCrust;
        uniform vec3 uLavaHot;
        uniform vec3 uLavaCore;
        uniform float uLavaGlow;
        uniform float uLavaFlow;
        uniform sampler2D uLavaTrack;
        uniform vec4 uLavaTrackArea;
        uniform sampler2D uFaultMask;
        uniform vec4 uFaultArea;

        varying vec3 vWorldPos;
        varying vec3 vNormal;
        varying float vHeight;
        varying float vCrest;
        varying float vTurb;

        ${NOISE_GLSL}

        // 片元端的 Gerstner 法线：和顶点同一套波参数，但逐像素求值。
        //
        // 为什么必须重算：水面网格是按地图边界铺的（ocean 图 1806m / 192 段 ≈ 9.4m 一个顶点），
        // 而最短的物理波只有 5m —— 每个波长不到一个顶点，顶点法线是纯混叠信号，
        // 插值出来就是"一片平 + 规律横条纹"。片元重算后 5m 波才真正变成细密水纹。
        // len 由 k 反推（2π/k），按像素足迹淡出，避免远处走样。
        vec3 gerstnerNormal(vec2 p, float t, float foot) {
          float dhx = 0.0;
          float dhz = 0.0;
          for (int i = 0; i < ${MAX_WAVES}; i++) {
            if (i >= uWaveCount) break;
            vec4 w = uWaves[i]; // x=dirX y=dirZ z=k w=amp
            float len = 6.2831853 / max(w.z, 1e-4);
            float lod = 1.0 - smoothstep(0.33, 1.0, foot / len);
            if (lod <= 0.001) continue;
            float phase = (p.x * w.x + p.y * w.y) * w.z - t * uSpeeds[i];
            float c = cos(phase) * lod;
            dhx += w.w * w.z * c * w.x;
            dhz += w.w * w.z * c * w.y;
          }
          return normalize(vec3(-dhx * uWaveScale, 1.0, -dhz * uWaveScale));
        }

        // 方向性波纹的解析梯度：返回 (∂h/∂x, ∂h/∂z)。
        // 真实海面的短波不是各向同性的噪点，而是顺风向拉长的一组组波列，
        // 所以这里用正弦波（梯度 = A*k*cos(phase)*dir），比噪声便宜也更像水。
        // foot = 一个像素覆盖的水面尺度：像素跨度超过 1/3 波长就开始淡出（奈奎斯特），
        // 不做这层过滤，远处的短波会退化成满屏爬动的噪点。
        vec2 rippleGrad(vec2 p, float ang, float len, float amp, float speed, float t,
                        float warp, float foot) {
          vec2 d1 = vec2(cos(ang), sin(ang));
          // 交叉的第二列波：单列正弦一眼就能看出"平行条纹"，交叉后读作碎浪
          vec2 d2 = vec2(cos(ang + 1.9), sin(ang + 1.9));
          float k = 6.2831853 / len;
          float ph1 = dot(p, d1) * k - t * speed + warp;
          float ph2 = dot(p, d2) * k * 1.37 - t * speed * 1.21 + warp * 1.3;
          vec2 g = d1 * (amp * k * cos(ph1)) + d2 * (amp * k * 0.55 * cos(ph2));
          float lod = 1.0 - smoothstep(0.33, 1.0, foot / len);
          return g * lod;
        }

        // 写实调色：不是往灰度压（青绿往灰度压会变成奶青色，整片海发白），
        // 而是往深海青绿靠——这才是“真实海水”，也顺手干掉了荧光松石绿
        vec3 deepen(vec3 c, float k) {
          return mix(vec3(0.004, 0.045, 0.062), c, k);
        }

        // 程序化天空：反射射线采样（与场景天空穹顶同色系）+ 高空云层投影
        vec3 skyColor(vec3 rd) {
          float t = pow(clamp(rd.y, 0.0, 1.0), 0.55);
          vec3 sky = mix(uSkyBottom, uSkyTop, t);
          // 云：把反射方向投到高空平面，两层噪声拼出成团的积云/条状云
          if (uCloudAmt > 0.001) {
            // 云的倒影只出现在接近地平线的反射里（正视水面几乎看不到云），
            // 否则高空平面的透视压缩会把噪声拉成一条条白纹，整片水被洗白
            float up = max(rd.y, 0.05);
            vec2 cp = rd.xz / (up + 0.5) + vec2(uTime * 0.006, -uTime * 0.004);
            float n = vnoise(cp * 0.35) * 0.6 + vnoise(cp * 0.9 + 13.1) * 0.4;
            float band = smoothstep(0.03, 0.16, rd.y) * (1.0 - smoothstep(0.30, 0.70, rd.y));
            float cloud = smoothstep(0.58, 0.86, n) * band * uCloudAmt;
            sky = mix(sky, mix(sky, uCloudColor, 0.7), cloud);
          }
          // 太阳光晕（倒影中的光源）
          float sunAmt = max(dot(rd, uSunDir), 0.0);
          sky += uSunColor * (pow(sunAmt, 60.0) * 0.5 + pow(sunAmt, 6.0) * 0.12);
          return sky;
        }

        void main() {
          vec3 viewDir = normalize(cameraPosition - vWorldPos);
          float dist = length(cameraPosition - vWorldPos);
          // 方向光阴影（树影/岛影）：没有阴影贴图的地图 getShadowMask 恒为 1
          float shadowMask = getShadowMask();
          float lit = mix(0.52, 1.0, shadowMask);

          // 一个像素在世界里覆盖的尺度（米）：高频波纹与高光瓣宽都要按它做 LOD
          vec2 fwp = fwidth(vWorldPos.xz);
          float foot = max(max(fwp.x, fwp.y), 1e-4);

          // ---- 细节法线：噪声碎波 + 三组方向性波纹（近处清晰，远处衰减）----
          // 写实水面的分工原则：大起伏归顶点位移（Gerstner），
          // 细节法线只负责"近处看得清的水纹"。之前三层噪声全在 1m 以下、
          // 又衰减到 325m 才干净，等于中远景铺满均匀碎光 → 读起来就是锡纸。
          //
          // 现在的衰减 exp(-dist*0.024)：90m 掉到 11%、190m 掉到 1%，
          // 与"远处只剩柔化的镜面"一致，近景该碎的照样碎。
          float detailFade = exp(-dist * 0.016);
          // 三层各转一个角度再叠：同一份值噪声平铺会出现肉眼可见的格子/重复条，
          // 转开就散（比再写两套噪声便宜得多）。缩放取 0.9 / 1.7 / 3.4 —— 非整数倍率，
          // 三层的格子不会周期对齐。
          mat2 rotA = mat2(0.5403, -0.8415, 0.8415, 0.5403);    // +57.3°
          mat2 rotB = mat2(-0.4161, 0.9093, -0.9093, -0.4161);  // +114.6°
          vec2 p1 = vWorldPos.xz * 0.9 + vec2(uTime * 0.55, uTime * 0.32);
          vec2 p2 = (rotA * vWorldPos.xz) * 1.7 - vec2(uTime * 0.42, uTime * 0.71);
          vec2 p3 = (rotB * vWorldPos.xz) * 3.4 + vec2(uTime * 0.95, -uTime * 0.66);
          // 2026-11-18「流动真实感」：纯线性滚动像传送带，纹路不会跟着大涌浪走。
          // 用主浪相位做低频域扭曲，让细涟漪被大浪推前/拉后，两层反向滚动
          // 再叠一次，读起来才是"水在流"而不是"贴图在平移"。
          // 幅度 1.8m ≈ 最短物理波的 1/3：再大就会把细纹扭成短划线。
          vec2 swellDir = vec2(0.0, 1.0);
          if (uWaveCount > 0) {
            vec2 d0 = vec2(uWaves[0].x, uWaves[0].y);
            if (dot(d0, d0) > 1e-6) swellDir = normalize(d0);
          }
          float flowPhase = dot(vWorldPos.xz, swellDir) * 0.12 - uTime * 0.35;
          vec2 flow = vec2(sin(flowPhase), cos(flowPhase * 0.83)) * 1.8;
          p1 += flow;
          p2 -= flow * 0.62;
          // 基础法线走片元重算，不用顶点插值的 vNormal（详见 gerstnerNormal 注释）
          vec3 normal = gerstnerNormal(vWorldPos.xz, uTime, foot);
          // 250 米外的细节法线衰减到 2%，肉眼已经看不出：整块跳过
          if (detailFade > 0.02) {
            // 解析梯度（原中心差分每个倍频要 3 次采样，这里 1 次搞定）
            vec3 g1 = vnoiseGrad(p1);
            vec3 g2 = vnoiseGrad(p2);
            vec3 g3 = vnoiseGrad(p3);
            // 0.09 是原差分步长，乘回去让涟漪强度与旧版保持一致
            // 分层权重：1.1m 那层最重（读作"水纹走向"），0.43m 中层减半，
            // 0.16m 高频压到几乎只做微光——高频铺满屏幕正是"锡纸感"的元凶。
            // 合计强度约为旧版的 0.40 倍（对应法线贴图 normalScale 0.35 的量级）。
            vec2 grad = vec2(g1.y, g1.z) * (0.46 * 0.09)
                      + vec2(g2.y, g2.z) * (0.26 * 0.09)
                      + vec2(g3.y, g3.z) * (0.13 * uGlint * 0.09);

            // 方向性波列：只补 Gerstner 覆盖不到的短波段（0.72 / 0.34 / 0.19m）。
            // 三组方向刻意错开，任何两组都不能接近平行——平行就会读出搓衣板条纹。
            // 幅度又压了约 40%：旧值在近景已经是"揉皱的纸"，现在 0.003 量级
            // 只在水面被太阳擦过时才显出细波纹。
            if (uGlint > 0.5) {
              float warp = (vnoise(vWorldPos.xz * 1.7 + uTime * 0.23) - 0.5) * 6.0;
              // 只补 Gerstner 覆盖不到的短波段（5m 以下）——长波已经由片元解析法线给出，
              // 这里再叠一遍纯属重复开销。三组波长差 3~4 倍，方向各自错开
              grad += rippleGrad(vWorldPos.xz, 0.15, 0.72, 0.0034, 2.60, uTime, warp, foot);
              grad += rippleGrad(vWorldPos.xz, 2.30, 0.34, 0.0022, 3.30, uTime, warp * 1.5, foot);
              grad += rippleGrad(vWorldPos.xz, -1.80, 0.19, 0.0013, 4.10, uTime, warp * 2.0, foot);
            }
            // 合成乘数 0.86+0.12 → 0.65+0.06：整段细节法线再压 25%，
            // 近景进一步接近"镜面"。风险是船头附近会偏"死"——补偿手段不是把这
            // 一项调回去，而是靠下面 GGX 高光的宽瓣和波列残余把水面撑住。
            normal = normalize(normal + vec3(-grad.x, 0.0, -grad.y) * (0.72 + 0.08 * uGlint) * detailFade);
          }

          // ---- 水体基色：Beer-Lambert 吸收（近浅远深）----
          // 沿视线在水里走一段路径，透射率 = exp(-路径长 * 吸收系数)。
          // 视线越贴水面（掠射）路径越长 → 远处发沉；俯视时路径最短 → 近处透亮。
          // 旧做法按 smoothstep(25,340) 的距离硬插值，俯视和仰视同色，
          // 所以整片海永远像一块均匀的塑料板。
          float distT = smoothstep(25.0, 340.0, dist);
          float grazing = clamp(viewDir.y, 0.035, 1.0);
          float pathLen = dist / grazing;
          // 常数项 20.0 → 4.0：那 20 米是硬抬的"虚拟水深"，让近处水面一上来就
          // 吃掉 43% 深水色 → 近处不透亮、近远一个色。压到 4 米后近处才真的清亮。
          float absorb = 1.0 - exp(-(pathLen + 4.0) * uAbsorb);
          vec3 bodyCol = mix(uColorShallow, uColorDeep, absorb);
          // 高/中画质：去荧光 + 压亮度，靠天空反射和碎波高光撑起质感
          bodyCol = deepen(bodyCol, uSat) * uExposure;

          // ---- 次表面散射：阳光穿过波峰的透射 ----
          // 用归一化波高（0~1）而不是绝对米数，避免放大浪高后整片海都发光
          float ampSum = max(uWaveAmpSum, 1e-3);
          float heightN = clamp(vHeight / ampSum, -1.0, 1.0);
          float crestN = clamp(vCrest / ampSum, 0.0, 2.0);
          float sss = clamp(heightN * 0.95 + crestN * 0.55, 0.0, 1.0);
          float sssDot = pow(max(dot(viewDir, -normalize(uSunDir + vec3(0.0, 0.35, 0.0))), 0.0), 3.0);
          bodyCol += deepen(uColorSSS, uSat) * sss * sssDot * 0.22 * uExposure * lit;

          // 树影/岛影落在水上：压一档水体亮度（阴影里没有直射天光）
          bodyCol *= mix(0.82, 1.0, shadowMask);

          // ---- 菲涅尔天空反射 ----
          vec3 reflDir = reflect(-viewDir, normal);
          reflDir.y = abs(reflDir.y); // 水面下的方向不采样，翻到水面以上
          // 倒影来源：优先用烘好的天空 cubemap（云、山脊、地平线都在里面），
          // 烘不出（老设备 / 半浮点不可用）才退回解析式 skyColor()。
          // cubemap 里的值是**线性 HDR**（three 渲染到 render target 时会自动关掉
          // 色调映射、并把输出色彩空间当 LinearSRGB），所以这里不能再去 gamma。
          // 但太阳盘亮度是上千量级，直接乘进菲涅尔会把整片水烧白 —— 夹一下。
          vec3 skyLit = skyColor(reflDir);
          if (uEnvOn > 0.5) {
            // 反射要随距离变糊：一个像素在 100m 外覆盖十几米水面，取样点其实
            // 已经是一堆法线的平均 —— 直接采 mip 0 会得到"镜面贴纸"，云影硬成
            // 一块块白斑。按 foot 推 lod，近处锐、远处柔，这才是粗糙表面的样子。
            float envLod = clamp(log2(max(foot, 1e-3) * 6.0) + 1.4, 0.0, 4.5);
            vec3 env = textureLod(uEnv, reflDir, envLod).rgb;
            skyLit = mix(skyLit, min(env, vec3(uEnvMax)), uEnvAmt);
          }
          // 天空色只掺一点深水（0.18 → 0.10）：倒影越"纯"，越像水而不是磨砂塑料
          vec3 sky = mix(skyLit * uExposure, uColorDeep * uExposure * 0.85, 0.10);
          float fresnel = 0.02 + 0.98 * pow(1.0 - max(dot(viewDir, normal), 0.0), 5.0);
          // 反射上限：真实水面的掠射反射率接近 1，但全给到 0.92 会让整片
          // 中景变成天空色（浅蓝白），海水的青绿全被洗掉。具体削到多少交给
          // 天气（uReflMax）：晴天太阳高挂，反射给满会把水面糊成天空色；
          // 天气没指定时是 0.80。
          float reflK = clamp(fresnel, 0.0, uReflMax);
          vec3 col = mix(bodyCol, sky, reflK);

          // ---- 太阳高光：GGX 微表面（金色光路的来源）----
          // 旧的 pow(ndh,700) 角度容差只有 0.15°，配上 0.1 量级的法线扰动，
          // 屏幕上根本凑不出连续像素 → 只有零星白点，没有"从地平线拉到近处的光路"。
          // 改成微表面分布后 α 随像素足迹增长：远处一个像素覆盖好几米水面，
          // 法线统计上更平 → 高光瓣变宽 → 点连成带。这才是效果图那条金光路的机制。
          vec3 halfDir = normalize(viewDir + uSunDir);
          float ndh = clamp(dot(normal, halfDir), 1e-4, 1.0);
          float ndv = clamp(dot(normal, viewDir), 1e-4, 1.0);
          float ndl = clamp(dot(normal, uSunDir), 0.0, 1.0);
          // α 必须和"法线扰动幅度"匹配：法线坡度约 0.3（≈17°），
          // 若 α 只给 0.03（1.7° 瓣宽），只有极少数像素能命中 → 光路碎成零星白点。
          // 近处 0.11（≈7° 瓣，光路边缘锋利）、远处 0.29（≈17°，点连成带）。
          // 下限 0.15 → 0.11、上限 0.46 → 0.40：瓣收窄一档，光路才是一条"带"
          // 而不是一团椭圆光斑（太宽的话近处和远处的高光糊在一起）。
          float alpha = clamp(mix(0.11, 0.29, smoothstep(0.005, 0.85, foot)) * uRough, 0.06, 0.40);
          float a2 = alpha * alpha;
          float dn = ndh * ndh * (a2 - 1.0) + 1.0;
          float D = a2 / (3.14159265 * dn * dn);
          float kG = alpha * 0.5;
          float G = (ndv / (ndv * (1.0 - kG) + kG)) * (ndl / (ndl * (1.0 - kG) + kG));
          float Fh = 0.02 + 0.98 * pow(1.0 - max(dot(halfDir, viewDir), 0.0), 5.0);
          // BRDF*NoL = D*F*G/(4*NoV)；太阳在地平线下时 NoL→0，G→0，高光自然消失
          // 上限 12 → 70：12 这个数把光路最亮的核心直接削平了，太阳在低仰角
          // （黄昏 10°）时中心亮度远超 12，削平后就只剩一条灰带，出不来"金色"。
          float spec = min(D * Fh * G / (4.0 * ndv), 70.0) * uSpecGain;
          // 宽瓣：浪面散射出的整体暖光晕，负责把光路两侧的过渡铺开
          float wide = pow(ndh, 26.0) * 0.105;
          col += uSunColor * (spec + wide) * (0.35 + 0.65 * shadowMask);

          // ---- 碎波反光：细碎亮点（不是一道道白划痕），随距离衰减 ----
          // 噪声频率从 9.0 降到 5.4：亮点成组地落在波纹上，而不是碎成一层浮尘
          if (uGlint > 0.001) {
            float gFade = exp(-dist * 0.045);
            float gn = vnoise(vWorldPos.xz * 5.4 + vec2(uTime * 1.2, -uTime * 0.95));
            float glint = smoothstep(0.74, 0.97, gn) * gFade * uGlint;
            col += uSunColor * glint * (0.05 + 0.14 * fresnel) * 0.6;
          }

          // ================= 泡沫场 =================
          // 260 米外的泡沫早被雾吞掉了，肉眼看不见：整块跳过，
          // 省下两次大尺度噪声 + 气泡噪声 + 尾迹循环，远景海面开销明显下降
          if (dist < 260.0) {
          // 大尺度噪声控制泡沫团块，小尺度是气泡纹理（让白色不是一块纯色）
          float foamNoise = vnoise(vWorldPos.xz * 1.4 + uTime * 0.4) * 0.6
                          + vnoise(vWorldPos.xz * 3.1 - uTime * 0.6) * 0.4;

          // 1) 自然白头：只有陡峭的波峰才翻白，不会让整片海面发白
          //    噪声沿"浪脊方向"拉长、垂直浪向压紧 → 白色读作贴在浪脊上的细长条，
          //    而不是随噪声漂移的圆白斑；再叠一层破碎噪声把长条切成碎段。
          vec2 waveDir0 = vec2(0.0, 1.0);
          if (uWaveCount > 0) {
            vec2 d0 = vec2(uWaves[0].x, uWaves[0].y);
            float dl = length(d0);
            if (dl > 1e-4) waveDir0 = d0 / dl;
          }
          vec2 wavePerp = vec2(-waveDir0.y, waveDir0.x);
          // 沿浪脊 0.36 / 横跨浪脊 2.2：白沫贴着浪脊走，但不再被压成一小节一小节。
          // 2026-11-18 斑点归因：老的 0.55/3.4 + ridgeBreak 把白条切成短横线，
          // 关掉 uFoamStrength 后中远景碎斑全消失（tests/water_spot_diag.mjs 实测）。
          vec2 ridgeP = vec2(dot(vWorldPos.xz, waveDir0) * 0.36,
                             dot(vWorldPos.xz, wavePerp) * 2.2);
          float ridgeNoise = vnoise(ridgeP + vec2(uTime * 0.16, -uTime * 0.07)) * 0.62
                           + vnoise(ridgeP * 2.7 - vec2(uTime * 0.26, uTime * 0.12)) * 0.38;
          // 破碎项只做很轻的明暗起伏，**不许把一条白沫切成一排短线**。
          float ridgeBreak = vnoise(vec2(dot(vWorldPos.xz, waveDir0) * 0.7 + uTime * 0.11,
                                         dot(vWorldPos.xz, wavePerp) * 1.1));
          float crestFoam = smoothstep(0.42, 1.05, crestN * 0.95 + heightN * 0.72)
                          * smoothstep(0.32, 0.78, ridgeNoise)
                          * mix(0.78, 1.0, smoothstep(0.2, 0.8, ridgeBreak));
          // 天气决定的翻白强度 + 距离收敛：远处只留雾，不再铺一层白噪点
          crestFoam = clamp(crestFoam * uFoamStrength * exp(-dist * 0.018), 0.0, 1.35);
          // 2) 艇体周围的翻腾（环形扰动波的泡沫）
          float turbFoam = clamp(vTurb, 0.0, 1.0) * (0.5 + 0.5 * foamNoise);

          // 3) AI 船只的简化尾迹带（本地玩家走下面的弧形尾迹）
          float wakeFoam = 0.0;
          for (int i = 0; i < ${MAX_BOATS}; i++) {
            float s = uWakeStr[i];
            if (s <= 0.01) continue;
            vec4 wk = uWakes[i];
            vec2 rel = vWorldPos.xz - wk.xy;
            float along = dot(rel, -wk.zw);                    // >0 = 船后方
            if (along < 0.5 || along > 42.0) continue;
            float lateral = abs(dot(rel, vec2(-wk.w, wk.z)));  // 侧向距离
            // 尾迹随距离张开（Y 形），中心最白、边缘渐隐。
            // AI 只做简化带：张开速率要明显小于玩家的精细尾迹，
            // 否则几十米外会变成一条比玩家还宽的白带抢戏。
            float width = 1.35 + along * 0.052;
            float band = 1.0 - smoothstep(width * 0.30, width, lateral);
            float decay = exp(-along * 0.068);
            float breakup = smoothstep(0.2, 0.72, foamNoise);
            wakeFoam = max(wakeFoam, band * decay * s * 0.75 * (0.5 + 0.5 * breakup));
          }

          // 4) 本地玩家弧形尾迹：沿历史轨迹连成的连续泡沫带。
          //    宽度随船速与年龄扩张、强度随年龄衰减 → 近处实心、远处散成水带。
          float trailFoam = 0.0;
          float trailCore = 0.0;
          float trailRim = 0.0;
          vec2 wp = vWorldPos.xz;
          // 边线噪声：真实泡沫边缘是撕开的泡沫丝，不是一条平滑弧线
          float lace = vnoise(wp * 2.4 + vec2(uTime * 0.30, -uTime * 0.22)) - 0.5;
          for (int i = 0; i < ${MAX_TRAIL_SEG}; i++) {
            if (i >= uTrailSegs) break;
            vec4 a = uTrailA[i];
            vec4 b = uTrailB[i];
            vec2 pa = a.xy;
            vec2 ab = a.zw - pa;
            float len2 = max(dot(ab, ab), 1e-4);
            float h = clamp(dot(wp - pa, ab) / len2, 0.0, 1.0);
            float d = length(wp - (pa + ab * h));
            float width = mix(b.x, b.y, h);
            float str = mix(b.z, b.w, h);
            float dw = d + lace * width * 0.62;
            float edge = 1.0 - smoothstep(width * 0.40, width, dw);
            // 实心核心只在中轴：越靠边越薄 → 泡沫带内部有明暗层次
            float core = 1.0 - smoothstep(width * 0.06, width * 0.70, dw);
            trailFoam = max(trailFoam, edge * edge * str);
            trailCore = max(trailCore, core * core * str);
            // 泡沫边缘的细碎涟漪（两侧各一道淡淡的亮带）
            trailRim = max(trailRim, edge * (1.0 - edge) * 4.0 * str);
          }

          // 5) 船首 V 形水墙：从船首向后张开的两条 Kelvin 臂 + 船首浪冠
          vec2 fwd = uBow.zw;
          vec2 relB = wp - uBow.xy;
          float back = -dot(relB, fwd);                        // >0 = 船首后方
          float lat = abs(dot(relB, vec2(-fwd.y, fwd.x)));
          if (uBowFoam.y > 0.001) {
            float line = max(back, 0.0) * 0.36;                // 19.5° 扩散角
            float th = uBowFoam.z + max(back, 0.0) * 0.028;    // 臂随距离缓慢变厚
            float dw = (lat - line) / th;
            float arm = exp(-dw * dw);
            // 细而淡的两条直线：读作 Kelvin 臂，不能宽到像第二条尾迹
            arm *= smoothstep(0.3, 2.0, back) * exp(-max(back, 0.0) * 0.085);
            trailFoam = max(trailFoam, arm * uBowFoam.y);
          }
          // 船首翻起的水墙（船身会挡住大半，露出的部分读作浪冠）
          float bowD = length(relB);
          float bowCap = (1.0 - smoothstep(0.7, 1.9, bowD)) * uBowFoam.x;
          trailFoam = max(trailFoam, bowCap * 0.85);
          trailCore = max(trailCore, bowCap * 0.9);

          float field = clamp(max(max(crestFoam, turbFoam), max(wakeFoam, trailFoam)), 0.0, 1.0);
          // 实心白只出现在尾迹中轴 / 船首浪冠 / 陡峭波峰；两侧是半透明水带
          float coreField = clamp(max(crestFoam * 0.9, trailCore), 0.0, 1.0);

          // ---- 气泡纹理：大小不一的气泡，明暗自然 ----
          float bubble = vnoise(vWorldPos.xz * 6.5 + vec2(uTime * 0.6, -uTime * 0.4));
          if (uFoamDetail > 0.5) {
            float fine = vnoise(vWorldPos.xz * 16.0 - vec2(uTime * 1.3, uTime * 0.9));
            bubble = bubble * 0.66 + fine * 0.34;
          }
          float grain = smoothstep(0.22, 0.80, bubble);

          // ---- 分层：最内实心白泡沫 → 中层半透明水带 → 外圈涟漪 ----
          // 团块遮罩：越稀薄的泡沫越破碎，避免远段拉成一条均匀白带
          float chunkMask = smoothstep(0.30, 0.76, foamNoise * 0.74 + bubble * 0.50);
          float fade = mix(1.0, 0.55, distT);
          float bandAlpha = clamp(smoothstep(0.05, 0.42, field) * (0.30 + 0.44 * grain)
            * mix(0.34, 1.0, chunkMask) * fade, 0.0, 0.80);
          // 核心不做到纯白：留出气泡的明暗起伏，读作泡沫而不是白纸
          float coreAlpha = clamp(smoothstep(0.26, 0.80, coreField) * (0.34 + 0.66 * grain)
            * mix(0.55, 1.0, chunkMask) * fade, 0.0, 0.88);
          // 气泡自身的阴影：低处泡沫偏灰，高处被阳光照亮 → 明暗起伏
          vec3 coreCol = uFoamCore * (0.80 + 0.20 * grain);
          col = mix(col, uFoamBand, bandAlpha * 0.78);
          col = mix(col, coreCol, coreAlpha * 0.96);
          col += uSunColor * coreAlpha * 0.14;                  // 泡沫高光
          col += uFoamBand * trailRim * 0.06;                   // 边缘涟漪
          }

          // ---- 岩岛接触阴影：俯视遮罩压暗岩岛根部的水色（比透明贴片稳，
          // 不会被水面自身的深度整片吃掉，还能跟着波浪起伏）----
          if (uShoreArea.z > 0.0) {
            vec2 shoreUV = (vWorldPos.xz - uShoreArea.xy) * uShoreArea.z;
            if (shoreUV.x > 0.0 && shoreUV.x < 1.0 && shoreUV.y > 0.0 && shoreUV.y < 1.0) {
              float shore = texture2D(uShoreShadow, shoreUV).r;
              col *= 1.0 - shore * uShoreStrength;
            }
          }

          // ---- 指数雾（远处融入天际线）----
          // 水面上雾压得比其他物体轻：水面本来就更“暗更透”，
          // 和地物用同样的雾量会让中景整片泛白
          //
          // 水下反过来：头顶那片水面就是"天空"，必须被雾吃干净。
          // uUnder 顺便把水面自身压暗一档 —— 从下往上看的是水体背面，
          // 不该有水面正面的那层高亮。
          col *= mix(1.0, 0.34, uUnder);
          float fogFactor = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);
          col = mix(col, uFogColor, clamp(fogFactor * uFogStrength, 0.0, 1.0));

          // ---- 熔岩流体（仅 uLava=1 的主题地图）----
          // 不改上面任何一行水面计算：整段放在最后覆盖 col。关掉时只多一个 if，
          // 其余 7 张地图的 Gerstner / GGX / 泡沫 / 雾结果完全不受影响。
          // 复用同一份材质是为了继续吃 uBoats/uWakes 的艇扰动与阴影，不用抄第二套。
          //
          // 先留一份"原始水面着色"：熔岩分支里要把它的高光 / 碎波 / 泡沫亮度
          // 借给亮蓝水道，否则航道只剩一块平涂的青蓝，浪面起伏完全看不见。
          vec3 waterShade = col;
          if (uLava > 0.5) {
            vec2 lp = vWorldPos.xz;
            float lt = uTime * uLavaFlow;
            // 域扭曲 + 整体漂移：熔岩是"往一个方向缓慢流"，不是原地沸腾
            vec2 base = lp * 0.026;
            float warp = vnoise(base * 0.42 + vec2(lt * 0.50, -lt * 0.31));
            vec2 q = base + vec2(warp * 1.9, warp * 1.3) + vec2(lt * 0.55, lt * 0.33);
            float n1 = vnoise(q);
            float n2 = vnoise(q * 2.3 + 5.7);
            float n3 = vnoise(q * 5.1 - 2.9);
            float f = n1 * 0.56 + n2 * 0.30 + n3 * 0.14;
            // 地壳：黑 ↔ 暗红交错，保证近处也不是一块死色
            vec3 crust = mix(uLavaCrust * 0.55, uLavaHot * 0.34, smoothstep(0.28, 0.74, f));
            // 裂隙用等值线（fract）而不是"低于阈值的整片区域"：阈值版会让近处
            // 一个噪声周期里近半面积全亮，实拍出来就是一整片红油漆。
            float bandA = 1.0 - abs(fract(f * 6.0 + lt * 0.28) - 0.5) * 2.0;
            float bandB = 1.0 - abs(fract((n2 + n3) * 3.4 - lt * 0.18) - 0.5) * 2.0;
            float crack = clamp(pow(bandA, 7.0) * 0.9 + pow(bandB, 9.0) * 0.45, 0.0, 1.0);
            // 远处高频裂隙会走样成一条亮带、再被 bloom 炸成白边，按距离收狠一点
            crack *= 0.12 + 0.88 * (1.0 - smoothstep(110.0, 380.0, dist));
            vec3 hot = mix(uLavaHot, uLavaCore, crack);
            vec3 lava = crust + hot * crack * 0.78;
            lava += uLavaCore * crack * crack * uLavaGlow * 0.42;
            lava *= 0.88 + 0.12 * clamp(vHeight / max(uWaveAmpSum, 1e-3), -1.0, 1.0);
            float lfog = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);
            lava = mix(lava, uFogColor * 0.5, clamp(lfog * 0.9, 0.0, 0.70));

            // 冷却航道：走廊里的熔岩凝成近黑地壳，只留一丝余温。
            // 这是整张图"能看出赛道"的关键 —— 整片都是亮岩浆时，赛艇、光墙、
            // 浮标全部糊进背景里，玩家根本读不出该往哪开。
            float track = 0.0;
            float edge = 0.0;
            float dash = 0.0;
            if (uLavaTrackArea.z > 0.0) {
              vec2 luv = (vWorldPos.xz - uLavaTrackArea.xy) * uLavaTrackArea.z;
              if (luv.x > 0.0 && luv.x < 1.0 && luv.y > 0.0 && luv.y < 1.0) {
                vec4 m = texture2D(uLavaTrack, luv);
                track = m.r;
                edge = m.g;   // 两侧连续的发光路缘
                dash = m.b;   // 中央虚线
              }
            }
            // 航道水面：**直接复用其它地图那一套水面着色**（GGX 太阳高光 / 碎波 /
            // 泡沫 / 菲涅尔 / 雾全在 waterShade 里，已经在上面算好了）。
            // 熔岩只负责"赛道之外"那片地壳，航道里就是一河清水 ——
            // 这样浪面、尾迹、光照手感和 ocean/lake 完全一致，不再是自己拼的一层色块。
            vec3 water = waterShade * vec3(0.90, 0.98, 1.06);
            lava = mix(lava, water, track);
            // 路缘仍留一圈熔岩光（读赛道边界），中央虚线压淡避免盖住水面
            lava += uLavaCore * edge * 0.55;
            lava += uLavaCore * dash * 0.30;
            col = lava;
          }

          // ---- 断层：把水面挖掉 ----
          // 白块 > 0.5 的像素直接 discard：水面真的破了个洞，下面是 Track 建的真实裂谷。
          // uFaultArea.z = 0（没有 faults 的地图）时整段不执行。
          if (uFaultArea.z > 0.0) {
            vec2 fav = (vWorldPos.xz - uFaultArea.xy) * uFaultArea.z;
            if (fav.x > 0.0 && fav.x < 1.0 && fav.y > 0.0 && fav.y < 1.0
                && texture2D(uFaultMask, fav).r > 0.5) {
              discard;
            }
          }

          gl_FragColor = vec4(col, 1.0);

          // 输出色彩空间：低画质直接渲染到画布、中/高画质走合成器（OutputPass 再编码一次），
          // 缺了这两行，同一条着色器在两条路径下颜色会差一大截——
          // 低画质是线性值直接当 sRGB 显示（偏深、饱和），中/高画质被二次提亮 → 整片海发白。
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    // 方向光阴影的接收者（没有 shadowMap 的地图无副作用）
    this.mesh.receiveShadow = true;
    // 远景海面：一块无波浪的环形平面铺到远山脚下，避免海天之间露出世界边缘；
    // 颜色在 #updateFoamColors 里按天光同步，和主水面雾色一致
    const farGeo = new THREE.RingGeometry(size * 0.46, size * 2.6, 48, 1);
    farGeo.rotateX(-Math.PI / 2);
    this.farSeaMat = new THREE.MeshBasicMaterial({ color: 0x9fd6e6, fog: false });
    this.farSea = new THREE.Mesh(farGeo, this.farSeaMat);
    this.farSea.position.y = -0.6;
    this.farSea.renderOrder = -1;
    this.mesh.add(this.farSea);
    // 高光增益拆成「画质」×「天气」两个因子：低画质要收强度防抖，
    // 暴风雪的天空是纯白漫射，高光会把水面打出一块死白（真实冰海是哑光的）
    this.qSpec = 1;
    this.wSpec = 1;
    // 天气自带的水体调色档（sat/exposure/absorb），见 #applyWaterGrade
    this.grade = null;
    this.#boatArr = this.uniforms.uBoats.value;
    this.#updateFoamColors(1);
  }

  /**
   * 每帧更新艇扰动、弧形尾迹与船首浪
   * @param {Array<{x:number,z:number,heading:number,speed:number,maxSpeed:number,
   *   boosting:boolean,isLocal?:boolean,length?:number}>} boats
   * @param {number} dt 帧步长（尾迹采样/老化用）
   */
  setBoatDisturbances(boats, dt = 1 / 60) {
    const wakes = this.uniforms.uWakes.value;
    const wakeStr = this.uniforms.uWakeStr.value;
    let local = null;
    for (let i = 0; i < this.#boatArr.length; i++) {
      const b = boats[i];
      if (!b || b.speed < 1.5) {
        this.#boatArr[i].z = 0;
        if (wakes[i]) wakeStr[i] = 0;
        continue;
      }
      const v = Math.min(1, b.speed / (b.maxSpeed || 30));
      // 氮气时波浪显著更大
      const strength = v * (b.boosting ? 1.0 : 0.45);
      this.#boatArr[i].set(b.x, b.z, strength, 0);
      // 玩家的尾迹交给下面的弧形泡沫带：直线带留空，避免两层叠成一团白
      if (b.isLocal) {
        local = b;
        if (wakes[i]) wakeStr[i] = 0;
        continue;
      }
      // AI 简化版：只认朝向的直线尾迹带
      const h = b.heading || 0;
      wakes[i]?.set(b.x, b.z, Math.sin(h), Math.cos(h));
      if (wakes[i]) wakeStr[i] = Math.min(1.15, v * (b.boosting ? 1.15 : 0.8));
    }
    this.#updateTrail(local, dt);
    this.#updateBow(local);
  }

  /**
   * 记录本地玩家的历史船尾位置，拼成一条随时间变宽变淡的折线。
   * 漂移时船尾轨迹本身是弯的，折线自然连成弧形泡沫尾迹。
   */
  #updateTrail(local, dt) {
    const u = this.uniforms;
    if (!this.#trailEnabled) {
      if (this.#trail.length) this.#trail.length = 0;
      u.uTrailSegs.value = 0;
      return;
    }
    const trail = this.#trail;
    for (const p of trail) p.age += dt;
    while (trail.length && trail[0].age > TRAIL_LIFE) trail.shift();

    if (local && local.speed > 2) {
      const h = local.heading || 0;
      const half = (local.length ?? 3) * 0.5;
      const sx = local.x - Math.sin(h) * half;
      const sz = local.z - Math.cos(h) * half;
      const last = trail[trail.length - 1];
      // 采样间距随速度拉长：慢速尾迹短而密，高速尾迹长而连续
      const gap = 1.0 + local.speed * 0.12;
      // 重生/换图会让船瞬移：旧轨迹要丢掉，否则会拖出一条横跨海面的白带
      if (last && Math.hypot(sx - last.x, sz - last.z) > 25) trail.length = 0;
      if (!last || !trail.length || Math.hypot(sx - last.x, sz - last.z) >= gap) {
        trail.push({ x: sx, z: sz, age: 0, speed: local.speed });
        while (trail.length > MAX_TRAIL - 1) trail.shift();
      }
    }

    // 折线 = 当前船尾（头）→ 最新的历史点 → … → 最旧的点
    const pts = this.#pts;
    pts.length = 0;
    if (local && local.speed > 1.2) {
      const h = local.heading || 0;
      const half = (local.length ?? 3) * 0.5;
      pts.push({
        x: local.x - Math.sin(h) * half,
        z: local.z - Math.cos(h) * half,
        age: 0,
        speed: local.speed,
      });
    }
    for (let i = trail.length - 1; i >= 0; i--) pts.push(trail[i]);

    const segs = Math.max(0, Math.min(this.#segCap, pts.length - 1));
    u.uTrailSegs.value = segs;
    for (let i = 0; i < segs; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const va = Math.min(1.3, a.speed / 32);
      const vb = Math.min(1.3, b.speed / 32);
      // 泡沫强度对速度做非线性放大：低速只是淡淡一层水痕，高速才拉出实心白带
      const sa = Math.min(1, Math.pow(va, 1.35));
      const sb = Math.min(1, Math.pow(vb, 1.35));
      const ta = Math.min(1, a.age / TRAIL_LIFE);
      const tb = Math.min(1, b.age / TRAIL_LIFE);
      // 越老越宽越淡：近处是实心白泡沫，远端散成半透明水带。
      // 宽度只温和扩张（真实尾迹是长条而不是喇叭口），强度衰减也放慢，
      // 让实心核心一路延续到远端，避免出现“亮条 + 远处白雾”两截的观感。
      u.uTrailA.value[i].set(a.x, a.z, b.x, b.z);
      u.uTrailB.value[i].set(
        (0.72 + ta * 1.70) * (0.50 + va * 1.05),
        (0.72 + tb * 1.70) * (0.50 + vb * 1.05),
        Math.pow(1 - ta, 0.95) * (0.10 + sa * 0.90),
        Math.pow(1 - tb, 0.95) * (0.10 + sb * 0.90),
      );
    }
  }

  /** 船首 V 形水墙：随船速抬高的浪冠 + 向后张开的两条 Kelvin 臂 */
  #updateBow(local) {
    const bow = this.uniforms.uBow.value;
    const foam = this.uniforms.uBowFoam.value;
    if (!local || local.speed < 2 || !this.#trailEnabled) {
      foam.set(0, 0, 0.4);
      return;
    }
    const h = local.heading || 0;
    const fx = Math.sin(h);
    const fz = Math.cos(h);
    const half = (local.length ?? 3) * 0.45;
    bow.set(local.x + fx * half, local.z + fz * half, fx, fz);
    const v = Math.min(1, local.speed / (local.maxSpeed || 30)) * (local.boosting ? 1.25 : 1);
    foam.set(
      THREE.MathUtils.smoothstep(v, 0.06, 0.60),               // 浪冠：低速几乎不起白
      THREE.MathUtils.smoothstep(v, 0.15, 0.85) * 0.50,         // 双臂：细而淡（适度加宽）
      0.20 + Math.min(1.25, v) * 0.34,                          // 臂厚度
    );
  }

  /** 画质档位降级：低画质只留 4 段尾迹、关掉细气泡噪声，中画质减到 7 段 */
  setQuality(q) {
    this.#segCap = q === 'low' ? 4 : q === 'medium' ? 7 : MAX_TRAIL_SEG;
    this.#trailEnabled = this.#segCap > 0;
    this.uniforms.uFoamDetail.value = q === 'high' ? 1 : 0;
    // 水面网格精度：13 万三角形的全屏平面是顶点开销大头，按画质降分段
    const seg = WATER_SEGMENTS[q] ?? WATER_SEGMENTS.high;
    if (this.mesh && seg !== this.seg) {
      const old = this.mesh.geometry;
      this.seg = seg;
      this.mesh.geometry = makeWaterGeometry(this.size ?? 700, seg);
      old?.dispose();
    }
    // 水体调色：三档看到的是同一片海，画质只决定细节多少。
    // 吸收项接管了"压暗"的职责，这里不再需要把水色往深水硬拽。
    // 0.80/0.84 → 0.88/0.92：吸收曲线收紧后近处变亮，饱和度要跟上补回来，
    // 否则整片会往灰里走（真实海水是"深但不灰"，靠 sat 而不是靠亮度）。
    // 具体数值交给 #applyWaterGrade：天气可以带自己的水体档（星空要比白天压得更狠），
    // 画质切换时按当前天气重新写一遍，不会被这里的默认值冲掉。
    this.#applyWaterGrade();
    // 细节项：碎波反光、云影倒影、方向性波纹只在中/高画质开
    const rich = q !== 'low';
    this.glintBase = rich ? 1 : 0;
    this.uniforms.uGlint.value = this.glintBase;
    this.uniforms.uCloudAmt.value = rich ? 0.36 : 0;
    // 低画质：高光瓣加粗一档（细碎闪点在低分辨率下会抖成噪点），总强度收一点
    this.uniforms.uRough.value = rich ? 1 : 1.5;
    this.qSpec = rich ? 1 : 0.7;
    this.uniforms.uSpecGain.value = this.qSpec * this.wSpec;
    // 远景海面配色依赖 uSat/uExposure，改完必须刷新
    this.#updateFoamColors(this.foamLight ?? 1);
    if (!this.#trailEnabled) {
      this.#trail.length = 0;
      this.uniforms.uTrailSegs.value = 0;
      this.uniforms.uBowFoam.value.set(0, 0, 0.4);
    }
  }

  /**
   * 水体调色档（uSat / uExposure / uAbsorb）。
   *
   * 默认值是白天那套（0.94 / 0.86 / 0.019）—— 它是配着"亮天空倒影"调出来的。
   * 星空天气不能沿用：夜里天空只剩深蓝 + 月光，用同一档水面会发灰发亮，
   * 赛道浮标全糊在背景里（用户反馈"水面太亮看不清赛道"）。
   * 天气对象可以带 `waterGrade: { sat, exposure, absorb }` 覆盖任意一项，
   * 没带就用默认值 —— 其它 7 张图、其它 4 个天气的数值一字不变。
   */
  #applyWaterGrade() {
    const g = this.grade || {};
    this.uniforms.uSat.value = g.sat ?? 0.94;
    this.uniforms.uExposure.value = g.exposure ?? 0.86;
    this.uniforms.uAbsorb.value = g.absorb ?? 0.019;
  }

  /** 泡沫三层配色：核心近纯白，外圈带一点海水的青，避免像贴上去的白纸 */
  #updateFoamColors(light = 1) {
    this.foamLight = light;
    const k = 0.38 + 0.62 * light;
    const crest = this.uniforms.uCrestColor.value;
    FOAM_TMP.copy(crest).lerp(FOAM_WHITE, 0.78).multiplyScalar(k);
    this.uniforms.uFoamCore.value.copy(FOAM_TMP);
    FOAM_TMP.copy(crest).lerp(FOAM_WHITE, 0.34).multiplyScalar(k * 0.92);
    this.uniforms.uFoamBand.value.copy(FOAM_TMP);
    // 远景海面：取深水色向雾色过渡，和主水面的雾化远景衔接
    if (this.farSeaMat) {
      FOAM_TMP.copy(this.uniforms.uColorDeep.value)
        .lerp(this.uniforms.uFogColor.value, 0.45)
        .multiplyScalar(0.55 + 0.45 * light);
      // 和主水面同一套调色：高/中画质压向深海色 + 压亮度，远海不会比近海还亮
      const sat = this.uniforms.uSat.value;
      FOAM_TMP.lerp(DEEP_WATER, 1 - sat).multiplyScalar(this.uniforms.uExposure.value);
      // 主水面在掠射角下带天空倒影，远处会亮一档：远海也掺一点天光，
      // 350 米处才不会出现“亮水面 → 暗远海”的接缝
      FOAM_TMP.lerp(this.uniforms.uSkyBottom.value, 0.16 * this.uniforms.uExposure.value);
      this.farSeaMat.color.copy(FOAM_TMP);
    }
  }

  /**
   * 水下雾同步。水面着色器有自己的一套雾 uniform（不吃 scene.fog），
   * 所以 Environment#setUnderwater 必须把它一起喂过来，否则从水下抬头看，
   * 头顶永远是地表那套明亮的天空雾 —— 视觉上就是"一片蓝天顶着一片沙滩"。
   *
   * @param {number} k 水下程度 0~1
   * @param {THREE.Color} fogColor 水下雾色（与 scene.fog.color 同源）
   * @param {number} fogDensity 水下雾密度
   */
  setUnderwater(k, fogColor, fogDensity) {
    this.uwK = Math.max(0, Math.min(1, Number(k) || 0));
    this.uwFog = { color: fogColor, density: fogDensity };
    this.#syncUnderFog();
  }

  /** 按当前 uwK 把"水面雾 ↔ 水下雾"插值写进 uniform */
  #syncUnderFog() {
    const k = this.uwK || 0;
    const u = this.uniforms;
    if (this.uwFog?.color) {
      u.uFogColor.value.copy(this.surfFogColor).lerp(this.uwFog.color, k);
      // 水下这一档要**比场景雾更浓**（×2.2）：
      // 相机在水下时，水面几乎铺满上半屏，而且都是掠射角 —— 低模波面的三角面
      // 在这个角度下会露出来，读成"洞里的一片碎岩顶"。雾浓到 30 米外全糊掉，
      // 头顶就只剩一小片真正贴着相机的水膜，那才是水下抬头的正确观感。
      const uwD = (this.uwFog.density ?? this.surfFogDensity) * 2.2;
      u.uFogDensity.value = THREE.MathUtils.lerp(this.surfFogDensity, uwD, k);
    }
    u.uUnder.value = k;
    // 远海平面（fog:false 的单色大圆盘）是给水面视角补地平线的，
    // 从水下抬头看它就是一块永远不会变暗的亮板 —— 必须关掉，
    // 否则整片上半个屏幕都是"天空"。这是实拍里最像陆地的一块元凶。
    if (this.farSea) this.farSea.visible = k < 0.5;
    // 水面上的雾只吃 55%（水面本身更暗更透，全量会糊成白）；
    // 水下要拉满，头顶那片必须被雾吃掉才算"深"。
    u.uFogStrength.value = THREE.MathUtils.lerp(0.66, 1, k);
  }

  /**
   * 应用天气预设：水色/雾色/太阳方向/波浪倍率
   * @param {object} w WEATHERS 中的预设
   */
  setWeather(w) {
    this.weather = w;
    const map = this.mapDef;
    const shallow = w.waterColor ?? map.waterColor;
    const deep = w.waterDeep ?? map.waterDeep;
    this.baseShallow.set(shallow);
    this.baseDeep.set(deep);
    this.uniforms.uColorShallow.value.set(shallow);
    this.uniforms.uColorDeep.value.set(deep);
    if (w.waterCrest) this.uniforms.uCrestColor.value.set(w.waterCrest);
    if (w.waterSSS) this.uniforms.uColorSSS.value.set(w.waterSSS);
    this.uniforms.uSkyTop.value.set(w.skyTop ?? map.skyTop);
    this.uniforms.uSkyBottom.value.set(w.skyBottom ?? map.skyBottom);
    this.uniforms.uFogColor.value.set(w.fogColor ?? map.fogColor);
    this.surfFogColor.set(w.fogColor ?? map.fogColor);
    this.surfFogDensity = w.fogDensity ?? map.fogDensity;
    this.#syncUnderFog();
    this.uniforms.uSunColor.value.set(w.sunColor ?? map.sunColor);
    this.uniforms.uSunDir.value.set(...(w.sunDir || [0.45, 0.7, 0.3])).normalize();
    // 与 physics 同源：非竞速/道具模式在这里自动收敛到平静海面
    const waveScale = clampWaveScale(w.waveScale ?? 1.0);
    this.uniforms.uWaveScale.value = waveScale;
    this.uniforms.uWaveAmpSum.value = Math.max(WAVE_AMP_SUM * waveScale, 1e-3);
    // 翻白强度按天气单独给：Gerstner 的浪高归一化后与倍率无关，
    // 如果不在这里分档，晴天也会翻出和暴风雨一样的白色团块。
    // 未知天气按浪高倍率线性推，保证以后新天气也有合理默认值。
    // 2026-11-18：晴天/星空/雪天的自然白头整体下调（旧值在晴天就撒一层白碎点）。
    // 暴风雨保留成片白浪（那是暴风雨该有的样子），但形状也按上面的新噪声走连续浪脊。
    // 船尾/船首泡沫**不走这个系数**，所以调这里不会削弱玩家尾迹。
    const foamByWeather = { day: 0.10, dusk: 0.34, storm: 1.0, blizzard: 0.32, starry: 0.12 };
    this.uniforms.uFoamStrength.value = foamByWeather[w.id]
      ?? Math.min(1.35, Math.max(0.3, 0.3 + (waveScale - 1) * 0.55));
    // 反射里的云色跟随天气（暴雨压暗，晴天发白），和天空云层同一套色
    this.uniforms.uCloudColor.value
      .set(w.cloudColor ?? 0xffffff)
      .lerp(new THREE.Color(w.skyTop ?? map.skyTop), 0.35);
    // 暴风雪：见构造函数注释。晴天按参考图加强太阳反光（大面积高光斑），
    // 其余天气保持 1（太阳低垂时高光本来就是主角）
    this.wSpec = w.id === 'blizzard' ? 0.5 : w.id === 'day' ? 1.15 : 1;
    this.uniforms.uSpecGain.value = this.qSpec * this.wSpec;
    // 碎波反光强度：白天按天气的 glintGain 放大（参考图要"一片会闪的光斑"），
    // 其它天气没有这个字段 → 保持原来的 1.0，观感不变。
    this.uniforms.uGlint.value = (this.glintBase ?? 0) * (w.glintGain ?? 1);
    // 倒影强度/亮度上限/掠射反射削顶：天气可以单独降档（晴天太阳高挂，
    // 反射给满整片海会变成天空色的磨砂板），没指定就维持原值
    this.uniforms.uEnvAmt.value = w.envAmt ?? 0.85;
    this.uniforms.uEnvMax.value = w.envMax ?? 1.8;
    this.uniforms.uReflMax.value = w.reflMax ?? 0.80;
    // 水体调色档：星空的夜海比白天压得暗一档（见 #applyWaterGrade）
    this.grade = w.waterGrade ?? null;
    this.#applyWaterGrade();
    // 泡沫与远景海面配色依赖水色/雾色，必须在上面赋值之后再更新。
    this.#updateFoamColors(this.foamLight ?? 1);
  }

  /** 昼夜循环：水面天光/水色跟随太阳（不重设波浪与天气参数） */
  applyDayTint(tint) {
    if (!tint) return;
    this.uniforms.uSkyTop.value.copy(tint.skyTop);
    this.uniforms.uSkyBottom.value.copy(tint.skyBottom);
    this.uniforms.uSunColor.value.copy(tint.sunColor);
    this.uniforms.uSunDir.value.copy(tint.sunDir);
    const k = 0.3 + 0.7 * tint.light;
    // 水色带上一点天空的色相，形成海天一色（幅度很小，保留各海域原本的水色）
    ECHO.copy(tint.skyTop).multiplyScalar(0.6);
    this.uniforms.uColorShallow.value.copy(this.baseShallow).lerp(ECHO, 0.16).multiplyScalar(k);
    this.uniforms.uColorDeep.value.copy(this.baseDeep).lerp(ECHO, 0.10).multiplyScalar(k);
    // 泡沫跟着天光走：夜里不会亮成一块白斑
    this.#updateFoamColors(tint.light);
    // 昼夜循环里太阳在动：倒影用的 cubemap 会过期（水面映出的太阳位置和
    // GGX 高光算出的太阳对不上，屏幕上等于有两个太阳）。标脏，等 update() 节流重烘。
    if (this.uniforms.uEnvOn.value > 0.5
        && this.#envSun.dot(tint.sunDir) < 0.9994) {          // ≈2°
      this.#envStale = true;
    }
  }

  /**
   * 把当前场景烘成一张环境 cubemap，供水面做镜面反射。
   *
   * 为什么需要它：原来的倒影来自解析式 `skyColor(rd)`，只有"渐变 + 一小段云带"，
   * 云团、山脊、地平线全进不来；而且掠射角下反射方向集中在极低仰角，那点云带
   * 被透视压成一条条白纹。水面读起来就是 "磨砂塑料板"。
   *
   * 烘出来的 cubemap 是**线性 HDR**：three 渲染到 render target 时会把 toneMapping
   * 自动降为 NoToneMapping、输出色彩空间当 LinearSRGB（见 WebGLPrograms），所以
   * 片元里直接 textureCube 拿到的就是未压缩的线性亮度，不能再去 gamma。
   *
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Scene} scene
   * @param {{x:number,y:number,z:number}} pos 采样点（方向为主，位置只影响近处遮挡）
   * @param {THREE.Object3D|null} skyMesh 天空穹顶，重烘时只渲它一个（省 5/6 的 draw call）
   * @param {THREE.Object3D[]|null} exclude 烘图期间要临时隐藏的物体（星空粒子等，见下）
   */
  bakeEnvironment(renderer, scene, pos, skyMesh = null, exclude = null) {
    if (!renderer || !scene) return false;
    // 半浮点渲染目标：天空是 HDR（太阳盘亮度上千），8 位目标会被削顶成死白，
    // 那还不如不烘。WebGL2 需要 EXT_color_buffer_float 才可渲染半浮点。
    const gl = renderer.getContext?.();
    if (!gl || !gl.getExtension('EXT_color_buffer_float')) {
      this.uniforms.uEnvOn.value = 0;
      return false;
    }
    if (skyMesh) {
      // 让天空同时待在图层 2 上：cubemap 相机可以只渲它，
      // 主相机（图层 0）看到的东西完全不变。
      skyMesh.layers.enable(ENV_SKY_LAYER);
    }
    // 记下来是为了**昼夜刷新时也照做**（#renderEnvCube 里 hide/restore），
    // 否则 4s 一次的"只渲天空"重烘会把星星又烘回去。
    this.#envExclude = Array.isArray(exclude) ? exclude.filter(Boolean) : [];
    if (!this.#envRT) {
      this.#envRT = new THREE.WebGLCubeRenderTarget(ENV_SIZE, {
        type: THREE.HalfFloatType,
        generateMipmaps: true,
        minFilter: THREE.LinearMipmapLinearFilter,
        magFilter: THREE.LinearFilter,
      });
      this.#envCam = new THREE.CubeCamera(2, ENV_FAR, this.#envRT);
    }
    this.#envCtx = { renderer, scene, skyMesh };
    if (!this.#renderEnvCube(pos, false)) return false;
    this.uniforms.uEnv.value = this.#envRT.texture;
    this.uniforms.uEnvOn.value = 1;
    return true;
  }

  /**
   * 真正执行一次 cubemap 渲染。
   * @param {object} pos 采样点
   * @param {boolean} skyOnly true = 只渲天空图层（昼夜刷新用，6 个 draw call）
   */
  #renderEnvCube(pos, skyOnly) {
    const ctx = this.#envCtx;
    if (!ctx) return false;
    const { renderer, scene, skyMesh } = ctx;
    const p = pos || this.mesh?.position || { x: 0, y: 0, z: 0 };
    // 水面自己不能进倒影（会无限自反射），远景海面同理
    const waterVis = this.mesh?.visible ?? true;
    const farVis = this.farSea?.visible ?? true;
    if (this.mesh) this.mesh.visible = false;
    // 天空穹顶半径 45 万米，远超 cubemap 相机的远平面。Sky 的顶点着色器把 z 顶到
    // 远平面，但球面顶点本身还在裁剪体外面，靠 near/far 放大会把地形深度精度毁掉。
    // 缩到 4000（Sky 只看方向，缩放无副作用），换回干净的地形深度。
    const skyScale = skyMesh ? skyMesh.scale.x : 0;
    if (skyMesh) skyMesh.scale.setScalar(ENV_SKY_SCALE);
    const prevLayers = this.#envCam.layers.mask;
    // 没有天空句柄时不能"只渲图层 2"——那样一个物体都筛不出来，渲出全黑。
    this.#envCam.layers.set(skyOnly && skyMesh ? ENV_SKY_LAYER : 0);
    this.#envCam.position.set(
      p.x ?? 0,
      // 抬到地形之上：贴着水面烘会把礁石/船的侧面糊进食指方向
      Math.max((p.y ?? 0) + 12, ENV_MIN_Y),
      p.z ?? 0,
    );
    // 6 个面 = 6 次 renderer.render，每次都重算阴影贴图。倒影不需要自己那份阴影，
    // 直接关掉自动更新，用完还回去（否则每帧多 5 次全场景 shadow pass）。
    const autoShadow = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    // 星空粒子必须摘掉再烘：几千颗白星在 128² 的罐子里不是一个一个点，
    // 而是平均成一片 ~1.9 的**中性白**（三通道相等，实测），夹 uEnvMax 之后
    // 整片水反射变成白板 —— 夜里水面比天还亮，赛道和浮标全糊在背景里。
    const hidden = [];
    for (const o of this.#envExclude) {
      hidden.push([o, o.visible]);
      o.visible = false;
    }
    try {
      this.#envCam.update(renderer, scene);
    } finally {
      // 必须 finally：中途抛错（显存/驱动）时若把 autoUpdate 留在 false，
      // 整局游戏的阴影就再也不更新了 —— 比烘不出倒影严重得多。
      for (const [o, v] of hidden) o.visible = v;
      renderer.shadowMap.autoUpdate = autoShadow;
      this.#envCam.layers.mask = prevLayers;
      if (skyMesh) skyMesh.scale.setScalar(skyScale);
      if (this.mesh) this.mesh.visible = waterVis;
      if (this.farSea) this.farSea.visible = farVis;
    }
    this.#envBakedAt = this.uniforms.uTime.value;
    this.#envSun.copy(this.uniforms.uSunDir.value);
    this.#envStale = false;
    return true;
  }

  update(t) {
    this.uniforms.uTime.value = t;
    // 网格随 boundary 圆心平移，波浪相位要跟着回到世界坐标（见 uCenter 注释）
    this.uniforms.uCenter.value.set(this.mesh.position.x, this.mesh.position.z);
    // 昼夜循环刷新：只渲天空（不碰地形），代价是 6 个 draw call。
    // 4 秒节流 —— 全场景烘一次要提交上百个 draw call，跟着帧率走会明显掉帧。
    if (this.#envStale && this.#envCtx && t - this.#envBakedAt > ENV_REFRESH_SEC) {
      this.#renderEnvCube(null, true);
    }
  }

  /** 释放 GPU 资源：环境反射的 cubemap 是本类唯一持有的 render target */
  dispose() {
    this.#envRT?.dispose();
    this.#envRT = null;
    this.#envCam = null;
    this.#envCtx = null;
    this.uniforms.uEnv.value = null;
    this.uniforms.uEnvOn.value = 0;
  }
}

import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';

// 写实天空：three 官方 Sky 插件（Preetham 大气散射）+ 内嵌分层云 + 地平线雾霾。
// 只在竞速 / 道具 / 弹射模式使用；怪物模式仍走 Environment 里原来的渐变穹顶。
// 云层直接写进天空着色器，用“高空平面投影”产生近大远小与地平线压缩，
// 不再用一堆白球拼云，也没有额外的透明面片开销。

const CLOUD_TEXTURE_SIZE = 512;

// 各天气的大气参数：浑浊度越高天空越灰白，rayleigh 越高越蓝，mie 决定太阳周围的光晕
// exposure/sat 用来把 Preetham 的 HDR 结果收回显示范围（否则蓝绿通道溢出→整片灰白）
// cover 经阈值重映射后才是真实云量，数值越大云越多
const SKY_PRESETS = {
  day: {
    // 参考图 2：通透大晴天 —— 天顶饱和亮蓝、地平线浅蓝白、云薄而白。
    // 用户反馈原来那版"像阴天"：浑浊度 5.0 + rayleigh 1.15 + sat 1.12 把天穹
    // 压成一层灰蓝。降浑浊 / 升瑞利散射 / 提饱和度，天才会又亮又蓝；
    // mie 保持 0.0012（高了会在太阳周围烘出白雾团吞掉太阳盘，见下）。
    turbidity: 2.6, rayleigh: 2.50, mie: 0.0012, g: 0.72,
    // 云量 0.42→0.30，让太阳盘真的露出来。太阳盘来自大气散射着色器本身的
    // sundisk 项（不是程序化贴图/几何体圆盘），sunDisc 420 让它在晴天比黄昏耀眼。
    // haloPow 900：日晕只铺开 ±3°（原来的 26 次幂铺 ±20°，一片白雾），
    // halo 0.32 给盘面一圈亮而不过曝的光晕；具体数值由天气表可覆盖。
    // 夏天正午的观感：天顶是饱和的亮蓝，靠近地平线过度到干净的蓝白；
    // exposure 0.45→0.56 整体再抬一档亮度，sat 1.45→1.58 保住蓝不被抬白；
    // tint 从淡蓝白换成近白（只留一点点冷调），云本身就是纯白。
    cover: 0.30, opacity: 0.86, cirrus: 0.30, haze: 0.50, tint: 0xf0f7ff,
    exposure: 0.46, sat: 1.90, halo: 0.32, haloPow: 900, overcast: 0.0,
    sunDisc: 420,
    top: 0x6dabef,            // 水面反射取这个色，和天顶一致
    horizonColor: 0xd4e8ff,   // 地平线干净的蓝白，不再是阴天的灰白
    cloudLight: 0xffffff, cloudShadow: 0xdceaf7, cloudRim: 0xffffff,
  },
  dusk: {
    turbidity: 9.0, rayleigh: 2.7, mie: 0.012, g: 0.86,
    cover: 0.78, opacity: 0.95, cirrus: 0.5, haze: 0.72, tint: 0xffffff,
    exposure: 0.22, sat: 1.8, halo: 0.55, overcast: 0.06,
    top: 0x4a5a9c,
  },
  storm: {
    turbidity: 18, rayleigh: 4.4, mie: 0.03, g: 0.76,
    // 暴雨天空：不堆“黑色浮云”。整片压成接近黑色的天幕（overcast 拉满），
    // 只留密集但极暗的云理，做细微的明暗起伏；地平线保留一条浅灰亮带。
    cover: 0.40, opacity: 0.55, cirrus: 0.16, haze: 0.88, tint: 0x2f343b,
    exposure: 0.085, sat: 0.55, halo: 0, overcast: 1.0,
    top: 0x46566a,            // 水面反射取这个色：暴雨水面用户认可，保持原样
    sunDisc: 24,              // 太阳完全被云挡住，不留亮盘
    horizonColor: 0x4f5860,   // 地平线那条浅灰亮带（比天空亮，但不刺眼）
    cloudLight: 0x2a323b, cloudShadow: 0x090b0e, cloudRim: 0x353e48,
  },
  blizzard: {
    // 参数按“冬季暴雪”规范：高浑浊（12）让云层厚而不透，低 rayleigh（0.6）
    // 去掉暖色和蓝天饱和，mie 0.018 只给云层一层柔和泛光；云色直接给亮冷白，
    // 暗部用冷灰蓝而不是黑灰——暴雪的云是“亮而弥散”，不是压暗的一团黑。
    turbidity: 12, rayleigh: 0.6, mie: 0.018, g: 0.78,
    // 2026-11-17：原来 exposure 0.54 + 近白地平线 + 冷白后处理叠加，
    // 整个雪天被洗成一片灰白、看不清航道。温和收一档：天空仍冷白透亮，
    // 但把曝光/地平线/云暗部压下来，留出浮桶和旗帜的对比。
    // 2026-11-18：天空饱和 0.88→0.80，跟 PostFx 的暴雪调色一起往下收一档，
    // 地平线更接近参考图那种"雪白漫射"，但 turbidity/rayleigh/mie 不动 ——
    // 那三个一动云层厚度的观感就变了。
    cover: 0.94, opacity: 1.0, cirrus: 0.42, haze: 0.9, tint: 0xf1f7fd,
    exposure: 0.44, sat: 0.80, halo: 0, overcast: 0.86,
    top: 0xb6cce0,
    sunDisc: 3,               // 太阳被雪云糊住，只留一团极淡的白
    horizonColor: 0xcadcea,
    cloudLight: 0xf2f7fc, cloudShadow: 0x839bb1, cloudRim: 0xf6fbff,
  },
  starry: {
    // 夜空只留一层极淡的天光过渡：不给太阳盘，云量几乎为 0，
    // 星星/银河由 NightSky 画在前景，这里负责“深蓝紫的底”和地平线的微光。
    // 曝光原来给 0.055，天空被压成纯黑，星星像悬在虚空里；
    // 抬到 0.13 并混入一层深蓝夜色，才有参考图里“深蓝渐变到地平线微光”的底子
    turbidity: 5.5, rayleigh: 2.6, mie: 0.004, g: 0.8,
    cover: 0.05, opacity: 0.5, cirrus: 0.04, haze: 0.9, tint: 0x2b3a6c,
    exposure: 0.22, sat: 1.32, halo: 0, overcast: 0, nightMix: 0.88,
    nightColor: 0x2c4374,
    top: 0x101c3a,
    sunDisc: 0,
    horizonColor: 0x4c67a2,
    cloudLight: 0x3a476b, cloudShadow: 0x0a0f1d, cloudRim: 0x4b5c88,
  },
};

// ---------- 可平铺的 fbm 噪声纹理 ----------
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

/** 在 [0,1) 上可无缝平铺的二维 value noise 层（x/y 可分别指定格数，用来拉出条状云） */
function tileNoise(freqX, freqY, rand) {
  const grid = new Float32Array(freqX * freqY);
  for (let i = 0; i < grid.length; i++) grid[i] = rand();
  const at = (x, y) => grid[((y % freqY + freqY) % freqY) * freqX + ((x % freqX + freqX) % freqX)];
  const fade = (t) => t * t * (3 - 2 * t);
  return (x, y) => {
    const fx = x * freqX;
    const fy = y * freqY;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fade(fx - x0);
    const ty = fade(fy - y0);
    const a = at(x0, y0);
    const b = at(x0 + 1, y0);
    const c = at(x0, y0 + 1);
    const d = at(x0 + 1, y0 + 1);
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  };
}

/**
 * 生成云密度纹理（单通道灰度，写到 RGB）。
 * stretchX 让噪声在 x 方向拉长（高空被风吹成条状的卷云），
 * 但频率仍是整数，纹理左右边缘才能无缝衔接。
 */
function createCloudTexture(seed, octaves = 5, stretchX = 1) {
  const size = CLOUD_TEXTURE_SIZE;
  const rand = mulberry32(seed);
  const layers = [];
  for (let i = 0; i < octaves; i++) {
    const f = 4 << i;
    layers.push({ noise: tileNoise(Math.max(1, Math.round(f * stretchX)), f, rand), amp: 0.5 ** i });
  }
  const norm = layers.reduce((sum, l) => sum + l.amp, 0);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      let n = 0;
      for (const l of layers) n += l.noise(u, v) * l.amp;
      n /= norm;
      // 拉一下对比度，让云团边缘更清晰、内部更实
      const d = Math.max(0, Math.min(1, (n - 0.34) / 0.46));
      const value = Math.round(Math.pow(d, 1.25) * 255);
      const o = (y * size + x) * 4;
      img.data[o] = value;
      img.data[o + 1] = value;
      img.data[o + 2] = value;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

const CLOUD_FRAGMENT_HEAD = /* glsl */`
  uniform vec3 sunPosition;
  uniform vec3 uTint;
  uniform vec3 uHorizonColor;
  uniform float uHorizonStrength;
  uniform float uExposure;
  uniform float uSkySaturation;
  uniform float uNightMix;
  uniform vec3 uNightColor;
  uniform vec3 uSunColor;
  uniform float uSunHalo;
  uniform float uSunHaloPow;
  uniform float uSunDisc;
  uniform sampler2D uCloudMapA;
  uniform sampler2D uCloudMapB;
  uniform vec2 uCloudOffsetA;
  uniform vec2 uCloudOffsetB;
  uniform float uCloudCover;
  uniform float uCloudOpacity;
  uniform float uCloudCirrus;
  uniform float uOvercast;
  uniform vec3 uCloudLight;
  uniform vec3 uCloudShadow;
  uniform vec3 uCloudRim;
`;

const CLOUD_FRAGMENT_BODY = /* glsl */`
    // ---------- 曝光 / 饱和度 / 夜空：把 Preetham 的 HDR 收回显示范围 ----------
    retColor *= uExposure;
    float skyLum = dot(retColor, vec3(0.2126, 0.7152, 0.0722));
    retColor = mix(vec3(skyLum), retColor, uSkySaturation);
    retColor *= uTint;
    retColor = mix(retColor, uNightColor, clamp(uNightMix, 0.0, 1.0));

    float sunCos = clamp(cosTheta, 0.0, 1.0);
    // 太阳柔和光晕（Bloom 之外再补一圈紧贴太阳的辉光，形成镜头眩光感）
    // 指数决定"多快从太阳亮斑过渡到天空底色"：26 是很慢的衰减（±20° 都是白雾，
    // 大晴天太阳就糊成一大团白光）；晴天用 uSunHaloPow 收到 600~900，
    // 光晕只铺开 ±3°，太阳盘才读得出是一个"盘"而不是一片过曝。
    retColor += uSunColor * (pow(sunCos, uSunHaloPow) * 0.9 + pow(sunCos, 8.0) * 0.08)
      * uSunHalo * (1.0 - uNightMix);

    // 地平线附近压一层雾色，远处景物和天空连成一片
    float horizon = pow(1.0 - clamp(direction.y, 0.0, 1.0), 6.0);
    retColor = mix(retColor, uHorizonColor, clamp(horizon * uHorizonStrength, 0.0, 0.9));

    // 阴天：先把整片天压成灰底，云层再叠上去（暴风雨/暴雪看不到蓝天）
    vec3 overcastCol = mix(uCloudShadow, uCloudLight, 0.5) * 1.3;
    retColor = mix(retColor, overcastCol, clamp(uOvercast, 0.0, 1.0));

    // 云：把噪声投影到高空平面，天顶到地平线的透视压缩就是近大远小
    float upness = max(direction.y, 0.02);
    float cloudFade = smoothstep(0.008, 0.075, direction.y) * smoothstep(0.0, 0.06, uCloudCover);
    vec2 plane = direction.xz / upness;

    // 中层积云
    vec2 uvA = plane * 0.42 + uCloudOffsetA;
    float thA = mix(0.52, 0.05, clamp(uCloudCover, 0.0, 1.0));
    float dA = texture2D(uCloudMapA, uvA).r;
    float aA = smoothstep(thA, thA + 0.22, dA);

    // 体积感：沿太阳方位采样密度梯度，当作受光面 / 背光面
    vec2 sunAz = normalize(sunPosition.xz + vec2(1e-4));
    float towardSun = texture2D(uCloudMapA, uvA + sunAz * 0.018).r;
    float shade = clamp((dA - towardSun) * 6.0, -1.0, 1.0);

    // 高空卷云：横轴压扁 → 被风吹成细长条，颜色更亮更薄
    vec2 uvB = plane * vec2(0.13, 0.30) + uCloudOffsetB;
    float dB = texture2D(uCloudMapB, uvB).r;
    float thB = mix(0.72, 0.22, clamp(uCloudCover, 0.0, 1.0));
    float aB = smoothstep(thB, thB + 0.34, dB) * uCloudCirrus;

    float cloudAlpha = clamp(aA * 0.92 + aB * 0.38, 0.0, 1.0) * cloudFade * uCloudOpacity;
    float lit = clamp(0.52 - shade * 0.42 + 0.42 * pow(sunCos, 4.0), 0.0, 1.0);
    vec3 cloudCol = mix(uCloudShadow, uCloudLight, lit);
    cloudCol = mix(cloudCol, uCloudRim, pow(sunCos, 16.0) * 0.55 * (1.0 - shade * 0.5));
    retColor = mix(retColor, cloudCol, cloudAlpha);
`;

export class RealSky {
  constructor() {
    const shader = Sky.SkyShader;
    // 注意：Sky 的着色器源码用制表符缩进，锚点只取不含缩进的片段，避免匹配失败
    const fragment = shader.fragmentShader
      .replace('uniform vec3 up;', `uniform vec3 up;\n${CLOUD_FRAGMENT_HEAD}`)
      // 太阳盘亮度收到 uSunDisc：默认的 19000 会让整块天空过曝
      .replace(
        'L0 += ( vSunE * 19000.0 * Fex ) * sundisk;',
        'L0 += ( vSunE * uSunDisc * Fex ) * sundisk;',
      )
      .replace(
        'gl_FragColor = vec4( retColor, 1.0 );',
        `${CLOUD_FRAGMENT_BODY}
			gl_FragColor = vec4( retColor, 1.0 );
			// 输出色彩空间：低画质直接渲染到画布、中/高画质走合成器，
			// 补上这两行后两条路径看到的是同一片天空
			#include <tonemapping_fragment>
			#include <colorspace_fragment>`,
      );
    if (!fragment.includes('uCloudMapA') || !fragment.includes('uSunDisc')) {
      throw new Error('RealSky: 天空着色器注入失败');
    }

    this.cloudMapA = createCloudTexture(1337, 6, 1);
    this.cloudMapB = createCloudTexture(90210, 5, 2.6);

    this.material = new THREE.ShaderMaterial({
      name: 'RealSkyShader',
      uniforms: THREE.UniformsUtils.merge([
        shader.uniforms,
        {
          uTint: { value: new THREE.Color(0xffffff) },
          uHorizonColor: { value: new THREE.Color(0xcfeaff) },
          uHorizonStrength: { value: 0.5 },
          uExposure: { value: 0.15 },
          uSkySaturation: { value: 1.85 },
          uNightMix: { value: 0 },
          uNightColor: { value: new THREE.Color(0x223354) },
          uSunColor: { value: new THREE.Color(0xfff5d6) },
          uSunHalo: { value: 0.3 },
          uSunHaloPow: { value: 26 },
          uSunDisc: { value: 260 },
          uCloudMapA: { value: null },
          uCloudMapB: { value: null },
          uCloudOffsetA: { value: new THREE.Vector2() },
          uCloudOffsetB: { value: new THREE.Vector2() },
          uCloudCover: { value: 0.42 },
          uCloudOpacity: { value: 0.92 },
          uCloudCirrus: { value: 0.5 },
          uOvercast: { value: 0 },
          uCloudLight: { value: new THREE.Color(0xffffff) },
          uCloudShadow: { value: new THREE.Color(0xbfd4e6) },
          uCloudRim: { value: new THREE.Color(0xfff3d0) },
        },
      ]),
      vertexShader: shader.vertexShader,
      fragmentShader: fragment,
      side: THREE.BackSide,
      depthWrite: false,
    });
    this.material.uniforms.uCloudMapA.value = this.cloudMapA;
    this.material.uniforms.uCloudMapB.value = this.cloudMapB;

    // 用球面而不是 Sky 默认的立方体：立方体每个面是独立几何，
    // 面与面交界处纹理导数跳变会让 mip 级别突变，天空上留下一条硬边
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), this.material);
    this.mesh.scale.setScalar(450000);
    this.mesh.frustumCulled = false;

    this.u = this.material.uniforms;
    this.weather = null;
    this.wind = { a: new THREE.Vector2(0.0032, 0.0011), b: new THREE.Vector2(0.0014, 0.0006) };
  }

  /**
   * 按天气套用大气参数。
   * @param {object} w 天气配置（maps.js / WEATHERS）
   */
  setWeather(w) {
    this.weather = w;
    // 天空预设：默认按天气 id 取；主题地图可以只给 `skyPreset` 指定另一套大气，
    // 而不改天气对象里的水色/雾/光照/雪量 —— 怪物模式四关就是这么换天空的。
    const preset = SKY_PRESETS[w.skyPreset || w.id] || SKY_PRESETS.day;
    // 主题地图的逐天气微调层（maps.js 的 lava.weatherBy[x].sky）：
    // 不新增天气 id、也不动 SKY_PRESETS，只在预设之上覆写单个 uniform。
    // 这样"熔岩图的晴朗白天/黄昏/雷暴/雪暴/星夜"能各自给出不同的大气观感，
    // 而普通地图（没有 w.sky）的行为与改动前完全一致。
    const o = w.sky || {};
    const pick = (key, dflt) => (o[key] !== undefined ? o[key] : dflt);
    const u = this.u;
    u.turbidity.value = pick('turbidity', preset.turbidity);
    u.rayleigh.value = pick('rayleigh', preset.rayleigh);
    u.mieCoefficient.value = pick('mie', preset.mie);
    u.mieDirectionalG.value = pick('g', preset.g);
    u.uCloudCover.value = pick('cover', preset.cover);
    u.uCloudOpacity.value = pick('opacity', preset.opacity);
    u.uCloudCirrus.value = pick('cirrus', preset.cirrus);
    u.uOvercast.value = pick('overcast', preset.overcast);
    u.uHorizonStrength.value = pick('haze', preset.haze);
    u.uTint.value.set(pick('tint', preset.tint));
    u.uExposure.value = pick('exposure', preset.exposure);
    u.uSkySaturation.value = pick('sat', preset.sat);
    u.uSunHalo.value = pick('halo', preset.halo);
    u.uSunHaloPow.value = pick('haloPow', preset.haloPow ?? 26);
    u.uSunDisc.value = pick('sunDisc', preset.sunDisc ?? 260);
    // 星空这类“预设好的夜景”直接把夜色混进去；白天/昼夜循环仍从 0 开始
    u.uNightMix.value = pick('nightMix', preset.nightMix ?? 0);
    const nightColor = pick('nightColor', preset.nightColor);
    if (nightColor !== undefined) u.uNightColor.value.set(nightColor);
    this.skyTop = new THREE.Color(pick('top', preset.top));

    const sunPos = w.sunPos || [180, 260, 120];
    u.sunPosition.value.set(...sunPos).normalize();
    u.uSunColor.value.set(w.sunColor ?? 0xfff5d6);

    const fogColor = w.fogColor ?? 0xcfeaff;
    // 地平线雾色默认跟场景雾走；暴雨这类极端天气在 preset 里单独指定
    u.uHorizonColor.value.set(pick('horizonColor', preset.horizonColor ?? fogColor));
    // 水面反射的天空底色仍用场景雾色：暴雨天空虽然压黑了，
    // 但要保持用户认可的水面观感不变
    this.waterSkyBottom = new THREE.Color(fogColor);

    // 云的受光/暗部由天气的云色和太阳色派生，避免每关都一套硬编码；
    // 暴雨这类极端天气在 preset 里直接给定，不再跟着 w.cloudColor 走
    const cloud = new THREE.Color(w.cloudColor ?? 0xffffff);
    const sun = new THREE.Color(w.sunColor ?? 0xfff5d6);
    const cloudLight = pick('cloudLight', preset.cloudLight);
    if (cloudLight !== undefined) {
      u.uCloudLight.value.set(cloudLight);
      u.uCloudShadow.value.set(pick('cloudShadow', preset.cloudShadow ?? 0x909090));
      u.uCloudRim.value.set(pick('cloudRim', preset.cloudRim ?? 0xffffff));
    } else {
      u.uCloudLight.value.copy(cloud).lerp(sun, 0.42);
      u.uCloudShadow.value.copy(cloud).multiplyScalar(0.2);
      u.uCloudRim.value.copy(cloud).lerp(sun, 0.88);
    }
  }

  /** 水面调色板：让海面反射的“天空”和真实天空同一套颜色，上下呼应 */
  waterTint() {
    return {
      skyTop: this.skyTop.clone(),
      skyBottom: (this.waterSkyBottom ?? this.u.uHorizonColor.value).clone(),
      sunColor: this.u.uSunColor.value.clone(),
      sunDir: this.u.sunPosition.value.clone().normalize(),
      // 各天气的水色本身已按美术调好，这里不再额外压暗，只提供反射用的天空色
      light: 1,
    };
  }

  setVisible(v) {
    this.mesh.visible = !!v;
  }

  /**
   * @param {number} dt
   * @param {number} speed 本船速度（m/s）：高速时云层加速掠过，制造速度感
   */
  update(dt, speed = 0) {
    const boost = 1 + Math.min(1, Math.max(0, speed / 30)) * 3.4;
    this.u.uCloudOffsetA.value.addScaledVector(this.wind.a, dt * boost);
    this.u.uCloudOffsetB.value.addScaledVector(this.wind.b, dt * boost);
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.cloudMapA.dispose();
    this.cloudMapB.dispose();
  }
}

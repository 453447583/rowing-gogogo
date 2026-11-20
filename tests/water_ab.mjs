// 水面真实感 A/B 观景探针（**只做运行时实验，不改源码**）
//
// 做的事：把船藏起来、用自定机位对着太阳拍同一片水面，然后逐个变体
// 在页面里改 uniform + 用字符串替换打补丁到 fragmentShader（改完 needsUpdate），
// 每个变体在**同一个 JS 任务**里 render + toDataURL 存一张图。
// 因此比对的是"同一帧、同一机位、只差几行参数"，而不是两次跑的近似画面。
//
//   node tests/water_ab.mjs
//   MAP=ocean FRAME=horizon VARIANT=base,path,all node tests/water_ab.mjs
//   FRAME=top node tests/water_ab.mjs            # 俯瞰近景（看波纹/白沫）
//
// FRAME：horizon（低机位掠射朝太阳）/ top（中高俯视）/ side（侧逆光）
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/water-ab-${stamp}`);
const port = 9640 + (Number(stamp.slice(-3)) % 40);
const url = process.env.WB_URL || 'http://127.0.0.1:5199/';
const outDir = path.resolve('shots/water');
const mapId = process.env.MAP || 'ocean';
const frame = process.env.FRAME || 'horizon';

// 机位：高度 / 俯角（度）/ 距水面中心的前后偏移（正=往太阳方向挪，负=退后）
const FRAMES = {
  horizon: { h: 4.2, pitch: 5.0, back: 130 },
  top:     { h: 11.0, pitch: 24.0, back: 40 },
  side:    { h: 3.0, pitch: 3.0, back: -60, yaw: 68 },
  // 追尾机位（贴近游戏里的真实视角）：相机在船后 9.5m 平视前方
  chase:   { h: 3.4, pitch: 6.0, back: 9.5 },
  // 山脉专用：站高一点平视地平线，整圈山脊都能看见；YAW 可 env 覆盖，转一圈拍四个方向
  mountain: { h: 42, pitch: 2.0, back: 0 },
};
const F = { ...(FRAMES[frame] ?? FRAMES.horizon) };
if (process.env.YAW !== undefined) F.yaw = Number(process.env.YAW);
if (process.env.CAMH !== undefined) F.h = Number(process.env.CAMH);
if (process.env.PITCH !== undefined) F.pitch = Number(process.env.PITCH);

// ---- 星空：给 cubemap 加"曝光"的公共片段 ----
// 归因结论：中景白板的元凶是 env cubemap —— 烘图走 NoToneMapping，罐里存的是线性 HDR
// （夜景天空在屏幕上看是暗的，进罐后仍是 >1 的值），夹 1.8 之后整片饱和成白。
// 解药不是把 uEnvMax 压到 0.3（那会丢掉色相，白乘小系数仍是灰），而是采样后先乘一个
// 夜间曝光再夹 —— 三个通道一起缩，蓝紫关系保留，只是不再爆掉。
const ENVEXP = (k) => `
  mat.uniforms.uEnvExp = mat.uniforms.uEnvExp || { value: ${k} };
  mat.uniforms.uEnvExp.value = ${k};
  P('uniform samplerCube uEnv;', 'uniform samplerCube uEnv;\\n uniform float uEnvExp;');
  P('min(env, vec3(uEnvMax))', 'min(env * uEnvExp, vec3(uEnvMax))');
`;

// ---- 变体表 ----------------------------------------------------------------
// 每个变体是「在页面里跑的一段 JS」，可用：
//   w   = water 实例（w.uniforms / w.mesh.material / w.farSeaMat）
//   P(a,b) = 把 fragmentShader 里的字面量 a 换成 b（每变体都先从原始串重建）
// 空字符串 = 原样（基线）。
const VARIANTS = {
  // ---- 0. 基线 ----
  base: '',

  // ---- 关掉环境反射（= 只剩解析天空，用来对比 B 档贡献了多少）----
  noenv: `w.uniforms.uEnvOn.value = 0;`,

  // ---- 倒影强度/亮度上限的几档（防"牛奶海"）----
  e1: `
    w.uniforms.uEnvAmt.value = 0.72;
    w.uniforms.uEnvMax.value = 2.6;
  `,
  e2: `
    w.uniforms.uEnvAmt.value = 0.60;
    w.uniforms.uEnvMax.value = 2.2;
    w.uniforms.uSat.value = 0.94;
    w.uniforms.uExposure.value = 0.86;
  `,
  e3: `
    w.uniforms.uEnvAmt.value = 0.85;
    w.uniforms.uEnvMax.value = 1.8;
    w.uniforms.uSat.value = 0.94;
    w.uniforms.uExposure.value = 0.86;
  `,

  // ---- 1. 只调 uniform（零 shader 改动，风险最低）----
  // 现在 uSat 0.80 / uExposure 0.84 是"防止吸收+压暗叠加后整片发黑"的保守值，
  // 结果就是整片海偏灰偏平；吸收系数也只 0.014（300m 才吃掉 1-e^-4.5≈99%，
  // 但前 60m 几乎没变化）→ 近处远处一个色。
  color: `
    w.uniforms.uSat.value = 0.98;
    w.uniforms.uExposure.value = 1.02;
    w.uniforms.uAbsorb.value = 0.021;
  `,

  // ---- 2. 金光光路（GGX 上限 + 瓣宽）----
  // 现在 spec 上限 12、宽瓣 0.055、alpha 下限 0.15：高光"点点闪"连不成带。
  path: `
    P('min(D * Fh * G / (4.0 * ndv), 12.0)', 'min(D * Fh * G / (4.0 * ndv), 90.0)');
    P('pow(ndh, 22.0) * 0.055', 'pow(ndh, 26.0) * 0.115');
    P('mix(0.15, 0.34, smoothstep(0.005, 0.85, foot)) * uRough, 0.08, 0.46',
      'mix(0.10, 0.28, smoothstep(0.005, 0.85, foot)) * uRough, 0.055, 0.38');
  `,

  // ---- 3. 反射层次（掠射反射率 + 倒影纯度）----
  // reflK 上限 0.62 是"怕中景被洗成天蓝"的保守值，代价是 100m 外整片水
  // 永远只有 62% 天空色 → 没有"靠近地平线越来越亮"的过渡带。
  refl: `
    P('clamp(fresnel, 0.0, 0.62)', 'clamp(fresnel, 0.0, 0.95)');
    P('uColorDeep * uExposure * 0.85, 0.18', 'uColorDeep * uExposure * 0.85, 0.05');
  `,

  // ---- 4. 细节不塌（法线衰减 + 短波列）----
  // exp(-dist*0.024) 让 90m 只剩 11%，但掠射机位下屏幕 80% 的面积都在 100m 外
  // → 那些像素等于没有法线，只有一片平滑渐变 = "塑料板"。
  detail: `
    P('exp(-dist * 0.024)', 'exp(-dist * 0.0085)');
    P('(0.65 + 0.06 * uGlint)', '(0.90 + 0.12 * uGlint)');
    P('if (uGlint > 0.5) {', 'if (uGlint > 0.001) {');
    P('0.72, 0.0034, 2.60', '0.72, 0.0055, 2.60');
    P('0.34, 0.0022, 3.30', '0.34, 0.0036, 3.30');
    P('0.19, 0.0013, 4.10', '0.19, 0.0022, 4.10');
  `,

  // ---- 5. 浪尖白沫 ----
  foam: `
    w.uniforms.uFoamStrength.value = 0.78;
    P('smoothstep(0.30, 0.86, crestN * 0.95 + heightN * 0.72)',
      'smoothstep(0.14, 0.72, crestN * 0.95 + heightN * 0.72)');
    P('smoothstep(0.34, 0.72, ridgeNoise)', 'smoothstep(0.20, 0.62, ridgeNoise)');
  `,

  // ---- 5b. 天空倒影带回细节 ----
  // 云带写在 rd.y ∈ [0.03, 0.70]：4m 眼高看 100m 外的水面，反射方向仰角只有 0.05，
  // 正好卡在 smoothstep 起点之外（权重 0.008）→ 整条中景永远是"一个天空色平铺"。
  // 把云带下沿压到 0.004 并抬云量，中景才有云影和明暗变化。
  sky: `
    w.uniforms.uCloudAmt.value = 0.55;
    P('smoothstep(0.03, 0.16, rd.y) * (1.0 - smoothstep(0.30, 0.70, rd.y))',
      'smoothstep(0.004, 0.085, rd.y) * (1.0 - smoothstep(0.30, 0.70, rd.y))');
    P('pow(clamp(rd.y, 0.0, 1.0), 0.55)', 'pow(clamp(rd.y, 0.0, 1.0), 0.42)');
  `,

  // ---- 5c. 深度分层 ----
  // absorb = 1-exp(-(pathLen+20)*uAbsorb)：那个 "+20" 是硬抬的常数项，
  // 让近处水面一上来就吃掉 43% 深水色 → 近处不透亮，近远一个色。
  depth: `
    w.uniforms.uAbsorb.value = 0.019;
    P('(pathLen + 20.0) * uAbsorb', '(pathLen + 3.0) * uAbsorb');
  `,

  // ---- 6. 全叠（推荐方案的样子）----
  all: `
    w.uniforms.uSat.value = 0.96;
    w.uniforms.uExposure.value = 1.04;
    w.uniforms.uAbsorb.value = 0.020;
    w.uniforms.uFoamStrength.value = 0.72;
    P('min(D * Fh * G / (4.0 * ndv), 12.0)', 'min(D * Fh * G / (4.0 * ndv), 90.0)');
    P('pow(ndh, 22.0) * 0.055', 'pow(ndh, 26.0) * 0.115');
    P('mix(0.15, 0.34, smoothstep(0.005, 0.85, foot)) * uRough, 0.08, 0.46',
      'mix(0.11, 0.29, smoothstep(0.005, 0.85, foot)) * uRough, 0.06, 0.40');
    P('clamp(fresnel, 0.0, 0.62)', 'clamp(fresnel, 0.0, 0.92)');
    P('uColorDeep * uExposure * 0.85, 0.18', 'uColorDeep * uExposure * 0.85, 0.07');
    P('exp(-dist * 0.024)', 'exp(-dist * 0.0090)');
    P('(0.65 + 0.06 * uGlint)', '(0.86 + 0.11 * uGlint)');
    P('if (uGlint > 0.5) {', 'if (uGlint > 0.001) {');
    P('0.72, 0.0034, 2.60', '0.72, 0.0050, 2.60');
    P('0.34, 0.0022, 3.30', '0.34, 0.0032, 3.30');
    P('0.19, 0.0013, 4.10', '0.19, 0.0020, 4.10');
    P('smoothstep(0.30, 0.86, crestN * 0.95 + heightN * 0.72)',
      'smoothstep(0.18, 0.76, crestN * 0.95 + heightN * 0.72)');
    P('smoothstep(0.34, 0.72, ridgeNoise)', 'smoothstep(0.24, 0.66, ridgeNoise)');
  `,

  // ---- 7. 推荐版 v2：只保留"真的能提真实感、且不引入织纹"的几条 ----
  v2: `
    // 水体：吸收更早生效 + 略提饱和（不往紫推）、亮度别压太低
    w.uniforms.uAbsorb.value = 0.019;
    w.uniforms.uSat.value = 0.88;
    w.uniforms.uExposure.value = 0.92;
    P('(pathLen + 20.0) * uAbsorb', '(pathLen + 4.0) * uAbsorb');
    // 天空倒影：云带下移 + 云量抬高 + 反射梯度更陡 → 中景不再是单色板
    w.uniforms.uCloudAmt.value = 0.52;
    P('smoothstep(0.03, 0.16, rd.y) * (1.0 - smoothstep(0.30, 0.70, rd.y))',
      'smoothstep(0.004, 0.09, rd.y) * (1.0 - smoothstep(0.30, 0.70, rd.y))');
    P('pow(clamp(rd.y, 0.0, 1.0), 0.55)', 'pow(clamp(rd.y, 0.0, 1.0), 0.44)');
    // 掠射反射上限 0.62 → 0.80（0.95 会把中景洗成天蓝，只放一半）
    P('clamp(fresnel, 0.0, 0.62)', 'clamp(fresnel, 0.0, 0.80)');
    P('uColorDeep * uExposure * 0.85, 0.18', 'uColorDeep * uExposure * 0.85, 0.10');
    // 金光路
    P('min(D * Fh * G / (4.0 * ndv), 12.0)', 'min(D * Fh * G / (4.0 * ndv), 70.0)');
    P('pow(ndh, 22.0) * 0.055', 'pow(ndh, 26.0) * 0.105');
    P('mix(0.15, 0.34, smoothstep(0.005, 0.85, foot)) * uRough, 0.08, 0.46',
      'mix(0.11, 0.29, smoothstep(0.005, 0.85, foot)) * uRough, 0.06, 0.40');
    // 远处法线不塌：衰减放宽一倍，并给一个随距离升起的坡度底（0.34）
    P('exp(-dist * 0.024)', 'exp(-dist * 0.0125)');
    P('(0.65 + 0.06 * uGlint)', '(0.72 + 0.08 * uGlint)');
    // 浪尖白沫
    w.uniforms.uFoamStrength.value = 0.68;
    P('smoothstep(0.30, 0.86, crestN * 0.95 + heightN * 0.72)',
      'smoothstep(0.17, 0.75, crestN * 0.95 + heightN * 0.72)');
    P('smoothstep(0.34, 0.72, ridgeNoise)', 'smoothstep(0.24, 0.66, ridgeNoise)');
  `,

  // ================= 星空天气：水面压暗实验 =================
  // 夜里水面的病根：倒影吃的是"地平线那圈亮蓝"（env 夹到 1.8 后仍然很亮），
  // 再乘 0.8 的掠射反射率 → 整片水比天还亮，赛道/浮标全糊在背景里。
  // 下面三档从"只调 uniform"到"改高光瓣"，看哪一档既压得下去又留得住月光路。

  // n1 只调 uniform：压曝光 + 压倒影上限 + 加深吸收
  n1: `
    w.uniforms.uExposure.value = 0.52;
    w.uniforms.uSat.value = 1.08;
    w.uniforms.uAbsorb.value = 0.032;
    w.uniforms.uEnvAmt.value = 0.52;
    w.uniforms.uEnvMax.value = 0.55;
    w.uniforms.uSpecGain.value = 0.55;
  `,

  // n2 uniform + 反射率上限（多留水体本色，少映天空）
  n2: `
    w.uniforms.uExposure.value = 0.58;
    w.uniforms.uSat.value = 1.10;
    w.uniforms.uAbsorb.value = 0.034;
    w.uniforms.uEnvAmt.value = 0.55;
    w.uniforms.uEnvMax.value = 0.60;
    w.uniforms.uSpecGain.value = 0.5;
    P('clamp(fresnel, 0.0, 0.80)', 'clamp(fresnel, 0.0, 0.56)');
  `,

  // n3 月亮路收窄：高光瓣压窄压短，水体更暗 → 深蓝水面 + 一条银色月光
  n3: `
    w.uniforms.uExposure.value = 0.46;
    w.uniforms.uSat.value = 1.14;
    w.uniforms.uAbsorb.value = 0.038;
    w.uniforms.uEnvAmt.value = 0.48;
    w.uniforms.uEnvMax.value = 0.48;
    P('clamp(fresnel, 0.0, 0.80)', 'clamp(fresnel, 0.0, 0.50)');
    P('min(D * Fh * G / (4.0 * ndv), 70.0)', 'min(D * Fh * G / (4.0 * ndv), 26.0)');
    P('pow(ndh, 26.0) * 0.105', 'pow(ndh, 26.0) * 0.055');
    P('mix(0.11, 0.29, smoothstep(0.005, 0.85, foot)) * uRough, 0.06, 0.40',
      'mix(0.075, 0.17, smoothstep(0.005, 0.85, foot)) * uRough, 0.05, 0.26');
  `,

  // n4/n5 归因：在 n3 参数上分别关掉"太阳高光"和"环境反射"，
  // 看中景那条灰白横带到底是谁贡献的（只用于定位，不是候选方案）
  n4: `
    w.uniforms.uExposure.value = 0.46;
    w.uniforms.uSat.value = 1.14;
    w.uniforms.uAbsorb.value = 0.038;
    w.uniforms.uEnvAmt.value = 0.48;
    w.uniforms.uEnvMax.value = 0.48;
    w.uniforms.uSpecGain.value = 0.0;
  `,
  n5: `
    w.uniforms.uExposure.value = 0.46;
    w.uniforms.uSat.value = 1.14;
    w.uniforms.uAbsorb.value = 0.038;
    w.uniforms.uEnvOn.value = 0;
    w.uniforms.uSpecGain.value = 0.5;
  `,

  // ---- 9. 归因：逐个隐藏可疑物体，看中景那条灰白横带是谁画的 ----
  h_far: `
    w.farSea.visible = false;
  `,
  h_water: `
    w.mesh.visible = false;
    w.farSea.visible = false;
  `,
  h_mtn: `
    if (g.env.mountains) g.env.mountains.visible = false;
  `,
  h_sky: `
    if (g.env.sky) g.env.sky.visible = false;
    if (g.env.nightSky) g.env.nightSky.setVisible(false);
  `,

  // ---- 10. 分量拆解：只输出水体基色 / 天空倒影 / 太阳高光，看谁把中景洗白了 ----
  o_body: `
    P('gl_FragColor = vec4(col, 1.0);', 'gl_FragColor = vec4(bodyCol, 1.0);');
  `,
  o_sky: `
    P('gl_FragColor = vec4(col, 1.0);', 'gl_FragColor = vec4(sky, 1.0);');
  `,
  o_spec: `
    P('gl_FragColor = vec4(col, 1.0);', 'gl_FragColor = vec4(vec3(spec * 0.04 + wide), 1.0);');
  `,
  // 环境 cubemap 原始值（线性 HDR，夹到 0..1 看饱和度）：若整片发白 = cubemap 本身太亮
  o_env: `
    P('gl_FragColor = vec4(col, 1.0);',
      'gl_FragColor = vec4(clamp(textureLod(uEnv, reflDir, 2.0).rgb, 0.0, 1.0), 1.0);');
  `,
  // 解析天空（不吃 cubemap）的亮度：对比上面一张，就知道白是烘图带来的还是公式自带
  o_skyonly: `
    P('gl_FragColor = vec4(col, 1.0);', 'gl_FragColor = vec4(skyColor(reflDir) * 3.0, 1.0);');
  `,

  // ================= 星空：给 cubemap 加"曝光" =================
  ne1: `${ENVEXP(0.22)}
    w.uniforms.uExposure.value = 0.80;
    w.uniforms.uSat.value = 1.06;
    w.uniforms.uAbsorb.value = 0.026;
  `,
  ne2: `${ENVEXP(0.13)}
    w.uniforms.uExposure.value = 0.66;
    w.uniforms.uSat.value = 1.12;
    w.uniforms.uAbsorb.value = 0.032;
  `,
  ne3: `${ENVEXP(0.34)}
    w.uniforms.uExposure.value = 0.86;
    w.uniforms.uSat.value = 1.04;
    w.uniforms.uAbsorb.value = 0.024;
  `,

  // ---- 星空：摘星之后再压一档水体（候选调色）----
  g1: `
    w.uniforms.uExposure.value = 0.76;
    w.uniforms.uSat.value = 1.04;
    w.uniforms.uAbsorb.value = 0.024;
  `,
  g2: `
    w.uniforms.uExposure.value = 0.68;
    w.uniforms.uSat.value = 1.10;
    w.uniforms.uAbsorb.value = 0.030;
  `,

  // ---- 0b. 复现"修复前"：故意把星空粒子重新烘进倒影罐 ----
  // 用于同一个会话里做前后对照（源码已经在 Game 里传了 exclude，这里传 null 绕过）
  old: `
    if (w.bakeEnvironment) w.bakeEnvironment(g.renderer, g.scene, g.camera.position, g.env.sky, null);
  `,

  // ================= 星空：把星空粒子从倒影罐里摘掉再重烘 =================
  // 归因：cubemap 里存的是**几千颗星星在 128² 罐里糊成的一片白**（实测 env≈1.9 且三通道相等），
  // 夹 1.8 之后整片饱和 → 水面比天还亮。把 NightSky.group 摘掉重烘，罐里就只剩深蓝夜空+山影。
  nstar: `
    const ns = g.env.nightSky;
    if (ns) ns.group.visible = false;
    w.bakeEnvironment(g.renderer, g.scene, g.camera.position, g.env.sky);
    if (ns) ns.group.visible = true;
  `,
  // 同上 + 水体再压一档（曝光/吸收），看是否需要额外调色
  nstar2: `
    const ns = g.env.nightSky;
    if (ns) ns.group.visible = false;
    w.bakeEnvironment(g.renderer, g.scene, g.camera.position, g.env.sky);
    if (ns) ns.group.visible = true;
    w.uniforms.uExposure.value = 0.72;
    w.uniforms.uAbsorb.value = 0.026;
    w.uniforms.uSat.value = 1.08;
  `,

  // ---- 8. 环境反射（真正拉开差距的那一档）----
  // 现在的"天空倒影"是解析式 skyColor()：只有渐变 + 一小段云带，
  // 山脊、岛、云团都进不来，掠射角下还会被透视压成白纹。
  // 这里在页面里把**真实天空穹顶**渲进一张 cubemap，再让水面 textureCube 采样。
  // 纯运行时验证，不动源码。
  env: `
    const THREE2 = window.__THREE || (window.__THREE = await import('/node_modules/three/build/three.module.js'));
    if (!window.__ENVCUBE) {
      const rt = new THREE2.WebGLCubeRenderTarget(256, { generateMipmaps: true, minFilter: THREE2.LinearMipmapLinearFilter });
      const cc = new THREE2.CubeCamera(0.5, 4000, rt);
      cc.position.copy(g.camera.position);
      const wv = w.mesh.visible;
      w.mesh.visible = false;                       // 别把水面自己拍进去
      const oldTone = g.renderer.toneMapping;
      g.renderer.toneMapping = THREE2.NoToneMapping;
      cc.update(g.renderer, g.scene);
      g.renderer.toneMapping = oldTone;
      w.mesh.visible = wv;
      g.renderer.setRenderTarget(null);
      window.__ENVCUBE = rt.texture;
    }
    mat.uniforms.uEnv = { value: window.__ENVCUBE };
    P('uniform vec3 uSunDir;', 'uniform vec3 uSunDir;\\n        uniform samplerCube uEnv;');
    P('skyColor(reflDir) * uExposure', 'pow(textureCube(uEnv, reflDir).rgb, vec3(2.2)) * uExposure * 0.9');
    w.uniforms.uSat.value = 0.88;
    w.uniforms.uExposure.value = 0.92;
    w.uniforms.uAbsorb.value = 0.019;
    P('(pathLen + 20.0) * uAbsorb', '(pathLen + 4.0) * uAbsorb');
    P('clamp(fresnel, 0.0, 0.62)', 'clamp(fresnel, 0.0, 0.90)');
    P('uColorDeep * uExposure * 0.85, 0.18', 'uColorDeep * uExposure * 0.85, 0.04');
    P('min(D * Fh * G / (4.0 * ndv), 12.0)', 'min(D * Fh * G / (4.0 * ndv), 70.0)');
    P('pow(ndh, 22.0) * 0.055', 'pow(ndh, 26.0) * 0.105');
    P('mix(0.15, 0.34, smoothstep(0.005, 0.85, foot)) * uRough, 0.08, 0.46',
      'mix(0.11, 0.29, smoothstep(0.005, 0.85, foot)) * uRough, 0.06, 0.40');
    P('exp(-dist * 0.024)', 'exp(-dist * 0.0125)');
    P('(0.65 + 0.06 * uGlint)', '(0.72 + 0.08 * uGlint)');
    w.uniforms.uFoamStrength.value = 0.68;
    P('smoothstep(0.30, 0.86, crestN * 0.95 + heightN * 0.72)',
      'smoothstep(0.17, 0.75, crestN * 0.95 + heightN * 0.72)');
  `,
};
const want = (process.env.VARIANT || 'base,color,path,refl,detail,foam,all').split(',');

const child = spawn(edge, [
  '--headless', '--no-sandbox', '--disable-gpu',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, `--window-size=${process.env.SIZE || '900x520'}`, url,
], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
function cdp(method, params = {}, timeout = 90000) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`cdp timeout: ${method}`)); }, timeout);
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evaluate = (expression) => cdp('Runtime.evaluate', {
  expression, awaitPromise: true, returnByValue: true,
});

async function waitForJson(u, timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(u); if (r.ok) return r.json(); } catch { /* 还没起来 */ }
    await sleep(150);
  }
  throw new Error(`timeout ${u}`);
}

async function main() {
  const info = await waitForJson(`http://127.0.0.1:${port}/json/list`);
  const page = info.find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      console.log('EXC', msg.params.exceptionDetails.exception?.description?.slice(0, 600)
        || msg.params.exceptionDetails.text);
    }
    if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
      const txt = msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ');
      console.log(`CONSOLE.${msg.params.type}`, String(txt).slice(0, 500));
    }
  });
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__errs = [];
      addEventListener('error', (e) => window.__errs.push('ERR ' + (e.message || '') + ' @' + (e.filename || '') + ':' + (e.lineno || 0)));
      addEventListener('unhandledrejection', (e) => window.__errs.push('REJ ' + ((e.reason && (e.reason.stack || e.reason.message)) || String(e.reason))));`,
  });
  await cdp('Page.reload');
  await sleep(1200);

  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    if ((await evaluate('!!window.__audio && !!document.querySelector("#btn-solo")')).result?.value) break;
    await sleep(250);
  }
  await evaluate('document.querySelector("#btn-solo")?.click(); 1');
  await sleep(900);
  let cardsReady = false;
  for (let i = 0; i < 12 && !cardsReady; i++) {
    await evaluate('document.querySelector("#btn-lobby-map")?.click(); 1');
    await sleep(800);
    cardsReady = (await evaluate('!!document.querySelector(".lp-card[data-map]")')).result?.value === true;
  }
  if (!cardsReady) throw new Error('地图抽屉一直没打开');
  const picked = await evaluate(`(() => {
    const cards = [...document.querySelectorAll('.lp-card[data-map]')];
    const c = cards.find(x => x.dataset.map === ${JSON.stringify(mapId)});
    if (!c) return 'missing:' + cards.map(x => x.dataset.map).join(',');
    c.click(); return 'ok';
  })()`);
  if (picked.result?.value !== 'ok') throw new Error(`地图 ${mapId} 选不到：${picked.result?.value}`);
  await sleep(400);
  // MODE=boss：大厅「模式」抽屉里切到怪物模式。四关主题各自换 mountainStyle 色板，
  // 但山体几何/法线/顶点色是同一套，验一关就够确认暗色板没被新明暗压黑。
  if (process.env.MODE) {
    for (let i = 0; i < 6; i++) {
      await evaluate('document.querySelector("#btn-lobby-mode")?.click(); 1');
      await sleep(500);
      const m = await evaluate(`(() => {
        const b = document.querySelector('[data-mode=${JSON.stringify(process.env.MODE)}]');
        if (!b) return 'missing'; b.click(); return 'ok'; })()`);
      if (m.result?.value === 'ok') break;
    }
    await sleep(400);
  }
  // WEATHER：发车前在大厅改天气（dusk 的太阳只有 10° 仰角，才拍得出金光光路；
  // 白天档太阳 46° 高，物理上不可能出现"从地平线拉到近处"的光带）
  if (process.env.WEATHER) {
    await evaluate('document.querySelector("#btn-lobby-weather")?.click(); 1');
    await sleep(500);
    const w = await evaluate(`(() => {
      const b = document.querySelector('[data-weather=${JSON.stringify(process.env.WEATHER)}]');
      if (!b) return 'missing';
      b.click(); return 'ok';
    })()`);
    if (w.result?.value !== 'ok') throw new Error(`天气 ${process.env.WEATHER} 选不到：${w.result?.value}`);
    await sleep(300);
  }
  await evaluate('document.querySelector("#btn-start-race")?.click(); 1');

  const t2 = Date.now();
  let ok = false;
  while (Date.now() - t2 < 60000) {
    if ((await evaluate('!!window.__game && !!window.__game.track')).result?.value) { ok = true; break; }
    await sleep(400);
  }
  if (!ok) throw new Error('对局没起来');
  // 立刻掐掉结算回调再等 WARM：单人模式下船不动也会走完超时判定，
  // 一旦结算 main.js 会 dispose，window.__game 就没了。
  await evaluate(`(() => { const g = window.__game;
    if (g?.opts) { g.opts.onFinish = () => {}; g.opts.onQuit = () => {}; }
    if (g) { g.phase = 'racing'; g.countdownLeft = 0; }
    return 1; })()`);
  await sleep(Number(process.env.WARM || 22000));
  for (let i = 0; i < 20; i++) {
    if ((await evaluate('!!window.__game?.water')).result?.value) break;
    await sleep(300);
  }
  const alive = await evaluate(`({ game: !!window.__game, mark: window.__MARK || null, errs: (window.__errs || []).slice(0, 6) })`);
  console.log('alive:', JSON.stringify(alive.result?.value));

  // ---- 摆机位 ----
  const setup = await evaluate(`(() => {
    const g = window.__game;
    g.phase = 'racing'; g.countdownLeft = 0;
    if (g.opts) { g.opts.onFinish = () => {}; g.opts.onQuit = () => {}; }
    const w = g.water;
    // 船藏起来：效果图只看水面（船模型 + 尾迹会把近景占满）
    // KEEP_BOAT=1 时保留，用来对照玩家真实追尾视角
    if (!${process.env.KEEP_BOAT ? 'true' : 'false'}) {
      if (g.localBoat?.modelRoot) g.localBoat.modelRoot.visible = false;
      if (g.localBoat?.label) g.localBoat.label.visible = false;
    }
    g.cameraRig.follow = () => {};                 // 否则后面 180 帧 follow 抢回机位
    // 锚点用**船位**（赛道中点，保证脚下是水、前方没东西挡），不用水面中心 ——
    // 海图的水面中心很可能正对着岛/礁，摆过去就是一张全黑的岩壁。
    const boat = g.localBoat;
    const N = g.mapDef.gates.length;
    const gi = ${JSON.stringify(Number(process.env.GATE ?? 4))} % N;
    const ga = g.mapDef.gates[gi], gb = g.mapDef.gates[(gi + 1) % N];
    const t = ${JSON.stringify(Number(process.env.GATE_T ?? 0.5))};
    const ax = ga[0] + (gb[0] - ga[0]) * t;
    const az = ga[1] + (gb[1] - ga[1]) * t;
    boat.resetTo(ax, az, Math.atan2(gb[0] - ga[0], gb[1] - ga[1]));
    boat.speed = 0; boat.vel.set(0, 0);
    boat.diveTargetY = g.track.diveHeightAt(boat.pos, gi);
    boat.pos.y = boat.diveTargetY ?? 0;
    const c = boat.pos;                                   // 锚点（水面高度）
    const sd = w.uniforms.uSunDir.value;
    const hl = Math.hypot(sd.x, sd.z) || 1;
    let dx = sd.x / hl, dz = sd.z / hl;
    if (${JSON.stringify(F.yaw ?? null)} !== null) {
      const a = ${JSON.stringify(F.yaw ?? 0)} * Math.PI / 180;
      const nx = dx * Math.cos(a) - dz * Math.sin(a);
      const nz = dx * Math.sin(a) + dz * Math.cos(a);
      dx = nx; dz = nz;
    }
    const H = c.y + ${JSON.stringify(F.h)};
    const p = ${JSON.stringify(F.pitch)} * Math.PI / 180;
    const back = ${JSON.stringify(F.back)};
    g.camera.position.set(c.x - dx * back, H, c.z - dz * back);
    g.camera.lookAt(
      c.x + dx * Math.cos(p) * 900,
      H - Math.sin(p) * 900,
      c.z + dz * Math.cos(p) * 900,
    );
    g.camera.updateMatrixWorld(true);
    window.__FS0 = w.mesh.material.fragmentShader;   // 原始着色器备份，每个变体都从它重建
    return {
      map: g.mapDef.id, sun: [+sd.x.toFixed(2), +sd.y.toFixed(2), +sd.z.toFixed(2)],
      water: [+c.x.toFixed(0), +c.z.toFixed(0)], size: w.size,
      fog: !!w.farSea?.visible,
    };
  })()`);
  console.log('setup:', JSON.stringify(setup.result?.value ?? setup.exceptionDetails?.exception?.description));

  // DIAG：临时诊断片段（返回可序列化值就打印）
  if (process.env.DIAG) {
    const r = await evaluate(process.env.DIAG);
    console.log('diag:', JSON.stringify(r.result?.value ?? r.exceptionDetails?.exception?.description));
  }

  await sleep(Number(process.env.SETTLE || 1600));

  for (const name of want) {
    const body = VARIANTS[name];
    if (body == null) { console.log(`未知变体 ${name}`); continue; }
    const r = await evaluate(`(async () => {
      const g = window.__game;
      const w = g.water;
      const mat = w.mesh.material;
      mat.fragmentShader = window.__FS0;                       // 每次从原始串重建，补丁不叠加
      const P = (a, b) => {
        if (!mat.fragmentShader.includes(a)) return 'MISS:' + a.slice(0, 40);
        mat.fragmentShader = mat.fragmentShader.split(a).join(b);
        return null;
      };
      // uniform 复位：只在 RESET=1 时做（早期实验用）。现在源码已经改过，
      // 默认**不动** uniform，拍到的就是当前代码的真实样子。
      ${process.env.RESET ? `
      w.uniforms.uSat.value = 0.80;
      w.uniforms.uExposure.value = 0.84;
      w.uniforms.uAbsorb.value = 0.014;
      w.uniforms.uFoamStrength.value = 0.4;
      ` : ''}
      const miss = [];
      ${body}
      mat.needsUpdate = true;
      g.post.render(1/60);
      return { miss, url: g.renderer.domElement.toDataURL('image/jpeg', 0.88) };
    })()`);
    const v = r.result?.value;
    if (r.exceptionDetails) {
      console.log(`${name} EXC:`, r.exceptionDetails.exception?.description?.slice(0, 400));
      continue;
    }
    if (!v || typeof v.url !== 'string' || !v.url.startsWith('data:image')) {
      console.log(`${name} 截图失败`);
      continue;
    }
    await fs.mkdir(outDir, { recursive: true });
    const f = path.join(outDir, `${process.env.TAG ? `${process.env.TAG}-${mapId}` : mapId}-${process.env.WEATHER || 'day'}-${frame}-y${Math.round(F.yaw ?? 0)}-${name}.jpg`);
    await fs.writeFile(f, Buffer.from(v.url.slice(v.url.indexOf(',') + 1), 'base64'));
    console.log(`${name}`, v.miss?.length ? `PATCH MISS ${JSON.stringify(v.miss)}` : 'ok', '->', path.basename(f));
  }
}

main().catch((e) => { console.error('FAIL', e.message); process.exitCode = 1; }).finally(async () => {
  try { ws?.close(); } catch { /* 已断 */ }
  child.kill();
  await sleep(400);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
});

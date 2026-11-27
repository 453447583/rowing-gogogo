// 船体涂装：着色器选择性换漆（方案 B）
//
// 为什么不用 material.color 乘算：乘算只能压暗、不能加色相，蓝船乘红色只会变暗紫褐。
// 这里在 map_fragment 之后按「贴图色彩特征」筛出船壳像素，用目标色 × 原图明暗替换，
// 灯带 / 玻璃 / 深色装甲保持原样，明暗与装甲缝细节全部保留，且零额外显存、零额外 draw call。
//
// 8 艘船分两种模式（依据各自 2048 图集的主色统计，见 docs/8艘赛艇-建模方案与决策记录.md）：
//   hue   —— 船壳是高饱和单色系（红 / 青 / 琥珀 / 蓝），按色相带圈定
//   white —— 船壳是白 / 浅灰装甲（磐石号、流光号、牛来号），按「低饱和 + 高明度」圈定，
//            青色灯带因为饱和度高会自动被排除
//
// 注意：7 艘 tripo 船都是「1 网格 + 1 材质 + 1 张贴图」，没有分件，
// 所以这里只能做纹理级筛选，不能按部件挑。

/** 每艘船的换漆参数。hueSrc/hueTol 为 HSV 色相单位（0~1），其余为明暗重建参数。 */
export const PAINT_TINT = {
  // 赤焰号：玫红壳（345°）+ 青灯带 → 只染 345° 一带
  rower: { mode: 'hue', hueSrc: 0.958, hueTol: 0.1, satMin: 0.16, valMin: 0.05, base: 0.5, gain: 1.12 },
  // 绯鲨号：红橙壳（0~15°）+ 青灯带（已调过，出图确认）
  skiff: { mode: 'hue', hueSrc: 0.015, hueTol: 0.11, satMin: 0.13, valMin: 0.07, base: 0.5, gain: 1.12 },
  // 青锋号：薄荷青壳（185°），灯带与船壳同色系，一起换
  falcon: { mode: 'hue', hueSrc: 0.514, hueTol: 0.075, satMin: 0.25, valMin: 0.09, base: 0.48, gain: 1.1 },
  // 磐石号：白色装甲 + 青灯带 → 浅色区换漆
  titan: { mode: 'white', satMin: 0.3, valMin: 0.2, base: 0.55, gain: 0.95 },
  // 流光号：冷白 / 银灰壳 + 蓝紫内嵌 → 浅色区换漆
  dolphin: { mode: 'white', satMin: 0.3, valMin: 0.18, base: 0.55, gain: 0.95 },
  // 琥珀号：琥珀黄壳（45°），图集非常单一
  vintage: { mode: 'hue', hueSrc: 0.125, hueTol: 0.09, satMin: 0.22, valMin: 0.06, base: 0.5, gain: 1.1 },
  // 长鲸号：灰蓝壳（215°）
  longship: { mode: 'hue', hueSrc: 0.6, hueTol: 0.08, satMin: 0.14, valMin: 0.06, base: 0.5, gain: 1.12 },
  // 牛来号：蒙皮 + 顶点色（无贴图），身体是土黄/牛皮色（≈38°）→ 按色相带染身体，
  // 角 / 蹄是浅灰白，色相带之外，自动保留
  cow: { mode: 'hue', hueSrc: 0.105, hueTol: 0.075, satMin: 0.12, valMin: 0.05, base: 0.5, gain: 1.05 },
};

/** 色卡 → 渲染提亮系数：ACES 会把中间调压暗，冷色最明显，逐色抬一点才接近卡面。 */
const BOOST = {
  paint_red: 1.06,
  paint_blue: 1.18,
  paint_jade: 1.12,
  paint_violet: 1.12,
  paint_gold: 1.15,
  paint_tide: 1.16,
};

/** 兼容老调用：传 #rrggbb 时按色值反查提亮系数 */
const BOOST_BY_HEX = {
  '#ff5a3c': 1.06, '#6fc8ff': 1.18, '#3fd08a': 1.12,
  '#a86bff': 1.12, '#f0c060': 1.15, '#46e0d0': 1.16,
};

/**
 * 色卡 → 着色器里用的线性目标色（已乘 ASCES 提亮系数）。
 * 选艇页预览换色时只改这个 uniform，不重建材质，所以单独暴露。
 */
export function paintTargetRgb(THREE, hex, paintKey) {
  const boost = (paintKey ? BOOST[paintKey] : undefined)
    ?? BOOST_BY_HEX[String(hex).toLowerCase()]
    ?? 1;
  const c = new THREE.Color(hex);
  return [c.r * boost, c.g * boost, c.b * boost];
}

/**
 * 给一艘船生成换漆材质。
 * @param {THREE.Material} srcMat 原始材质（会被 clone，不会改原对象）
 * @param {string} hex 目标漆色 '#rrggbb'
 * @param {string} boatId BOATS 里的 id，用来取 PAINT_TINT
 * @param {{boost?:number}} [opt]
 */
export function makePaintMaterial(THREE, srcMat, hex, boatId, opt = {}) {
  const p = PAINT_TINT[boatId] || PAINT_TINT.skiff;
  const o = opt.paintKey ? BOOST[opt.paintKey] : BOOST_BY_HEX[String(hex).toLowerCase()];
  const boost = opt.boost ?? o ?? 1;

  const mat = srcMat.clone();
  const col = new THREE.Color(hex);
  const u = {
    uPaint: { value: new THREE.Vector3(col.r * boost, col.g * boost, col.b * boost) },
    uAmt: { value: 1 },
    uMode: { value: p.mode === 'white' ? 1 : 0 },
    uHueSrc: { value: p.hueSrc ?? 0 },
    uHueTol: { value: p.hueTol ?? 0 },
    uSatMin: { value: p.satMin ?? 0.14 },
    uValMin: { value: p.valMin ?? 0.05 },
    uBase: { value: p.base ?? 0.5 },
    uGain: { value: p.gain ?? 1.1 },
  };
  mat.userData.paintUniforms = u;

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform vec3 uPaint;
        uniform float uAmt, uMode, uHueSrc, uHueTol, uSatMin, uValMin, uBase, uGain;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          vec3 src = diffuseColor.rgb;
          float mx = max(max(src.r, src.g), src.b);
          float mn = min(min(src.r, src.g), src.b);
          float d  = mx - mn;
          float sat = mx > 1e-5 ? d / mx : 0.0;
          float mask;
          if (uMode < 0.5) {
            // 色相带模式：只圈定原图里同色系的船壳
            float hue = 0.0;
            if (d > 1e-5) {
              if (mx == src.r)      hue = mod((src.g - src.b) / d, 6.0) / 6.0;
              else if (mx == src.g) hue = ((src.b - src.r) / d + 2.0) / 6.0;
              else                  hue = ((src.r - src.g) / d + 4.0) / 6.0;
            }
            float hd   = abs(fract(hue - uHueSrc + 0.5) - 0.5);
            float band = 1.0 - smoothstep(uHueTol * 0.72, uHueTol, hd);
            mask = band
                 * smoothstep(uSatMin, uSatMin + 0.14, sat)
                 * smoothstep(uValMin, uValMin + 0.05, mx);
          } else {
            // 浅色区模式：白色 / 浅灰装甲换漆，高饱和灯带自动排除
            mask = (1.0 - smoothstep(uSatMin, uSatMin + 0.15, sat))
                 * smoothstep(uValMin, uValMin + 0.2, mx);
          }
          float luma = dot(src, vec3(0.2126, 0.7152, 0.0722));
          vec3 painted = uPaint * (uBase + uGain * luma);
          diffuseColor.rgb = mix(src, painted, clamp(mask, 0.0, 1.0) * uAmt);
        }`,
      );
  };
  mat.customProgramCacheKey = () => 'paintB_' + p.mode;
  mat.needsUpdate = true;
  return mat;
}

/** 把整艘模型（或某个零件根节点）刷成目标漆色；返回被替换的 mesh 列表，便于复原。 */
export function paintModel(THREE, root, hex, boatId, opt = {}) {
  const out = [];
  root.traverse((obj) => {
    if (!obj.isMesh) return;
    if (obj.visible === false) return;
    // 蒙皮网格（牛来号）也要染：这里只换材质，不做任何几何操作，蒙皮不受影响
    const base = obj.userData.__paintBase || obj.material;
    if (!base) return;
    obj.userData.__paintBase = base;
    obj.material = makePaintMaterial(THREE, base, hex, boatId, opt);
    out.push(obj);
  });
  return out;
}

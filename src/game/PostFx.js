import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';

/**
 * 电影级调色：青橙分离 + 轻微色差 + 胶片颗粒 + 暗角 + 对比度/饱和度。
 * 放在 OutputPass（色调映射 + sRGB）之后，所有计算都在显示空间里做。
 * 参数刻意做得克制——赛艇要看清航道/弹道，过重的颗粒和色差会显得“糊”。
 */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uVignette: { value: 0.3 },
    uGrain: { value: 0.008 },
    uAberration: { value: 0.0006 },
    uContrast: { value: 1.07 },
    uSaturation: { value: 1.05 },
    // 天气气候色：暴雪时青橙分离必须关掉（暖橙高光会把冷白天空又染回暖灰），
    // 再叠一层冷白，把草地/岩石的暖绿统一压到冬季色温。
    uSplit: { value: 1 },
    uClimate: { value: new THREE.Color(0xffffff) },
    uClimateAmt: { value: 0 },
    // 水下程度 0~1：深海龙宫潜下去时整屏往深蓝压（详见 shader 里的吸收模型）
    uUnderwater: { value: 0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uVignette;
    uniform float uGrain;
    uniform float uAberration;
    uniform float uContrast;
    uniform float uSaturation;
    uniform float uSplit;
    uniform vec3 uClimate;
    uniform float uClimateAmt;
    uniform float uUnderwater;
    varying vec2 vUv;

    const vec3 TEAL = vec3(0.055, 0.395, 0.5);
    const vec3 ORANGE = vec3(1.0, 0.585, 0.225);

    void main() {
      vec2 uv = vUv;
      vec2 d = uv - 0.5;
      float r2 = dot(d, d);

      // 色差：只在画面边缘轻微偏色
      float ca = uAberration * (0.35 + r2 * 2.4);
      vec3 col = vec3(
        texture2D(tDiffuse, uv + d * ca).r,
        texture2D(tDiffuse, uv).g,
        texture2D(tDiffuse, uv - d * ca).b
      );

      float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
      // 青橙分离：暗部压青、高光偏橙（uSplit=0 时整体关掉，暴雪不吃这层暖调）
      col = mix(col, mix(TEAL, col, 0.78), (1.0 - smoothstep(0.12, 0.72, lum)) * 0.26 * uSplit);
      col = mix(col, mix(ORANGE, col, 0.84), smoothstep(0.5, 1.0, lum) * 0.2 * uSplit);

      // 高对比 + 饱和度
      col = clamp((col - 0.5) * uContrast + 0.5, 0.0, 1.0);
      lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(lum), col, uSaturation);

      // 气候色：往 uClimate 掺一层再整体提亮一点，冬季的冷白漫射光靠它统一
      vec3 climate = mix(col, uClimate, 0.26) * 1.03;
      col = mix(col, climate, uClimateAmt);

      // 水下光学吸收：水对长波吸收最快（红 > 绿 > 蓝），这是"深海蓝调"的物理来源。
      // 必须用逐通道指数衰减而不是一层 tint —— tint 会把高光一起洗成灰蓝，
      // 指数衰减才有"光一层层被水吃掉"的层次：近处白墙还是白的，50m 外的白墙退成青色。
      //
      // 这里的作用范围是"全屏"，跟距离无关，所以强度要克制（0.6 档）：
      // 距离衰减交给场景雾去算，否则近处的珊瑚也会被染成同一个蓝，整屏糊成一块。
      // 第一轮就是给了满档，出来是一张均匀的蓝色卡片，完全没有纵深。
      if (uUnderwater > 0.001) {
        float k = uUnderwater;
        vec3 absorb = exp(-vec3(1.62, 0.58, 0.20) * k * 0.62);
        col *= absorb;
        // 水中悬浮微粒的散射：给暗部垫一层很薄的水色底。
        // 一点点就够 —— 垫多了远景就塌不到黑，深海的"深"全靠远处敢黑下来。
        col += vec3(0.010, 0.038, 0.056) * k;
        // 整体压向深海色，越暗的地方压得越狠（光越弱，水色越主导）
        float deep = 1.0 - smoothstep(0.0, 0.52, lum);
        col = mix(col, vec3(0.018, 0.072, 0.118), deep * 0.2 * k);
      }

      // 暗角
      col *= 1.0 - uVignette * smoothstep(0.22, 1.0, r2 * 1.9);

      // 胶片颗粒（每帧变化，避免变成静态噪点）
      float n = fract(sin(dot(uv * vec2(1.0, 1.31) + uTime * 0.731, vec2(12.9898, 78.233))) * 43758.5453);
      col += (n - 0.5) * uGrain;

      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

/**
 * 画质档位只做“真正影响观感/性能”的三件事：分辨率倍率、泛光强度、是否调色。
 * 景深（BokehPass）与运动模糊（AfterimagePass）已移除：
 * 前者要整场景再渲一遍深度、再做 41 抽样模糊，代价极高；
 * 且焦点距离与跟随镜头不匹配时会把整个画面糊掉。
 */
const QUALITY = {
  // 高画质：弱泛光 + SMAA（边缘抗锯齿但不像 FXAA 那样把整屏磨软）。
  // pixelRatio 上限 1.5 让高分屏也能超采样；DPR=1 的桌面屏靠设置的渲染分辨率拉到 125%。
  high:   { pixelRatio: 1.5, bloom: 0.16, grade: true, aa: 'smaa' },
  medium: { pixelRatio: 1.0, bloom: 0.2, grade: true, aa: 'fxaa' },
  low:    { pixelRatio: 1.0, bloom: 0, grade: false, aa: null },
};

// 天气 → 调色。暴雪不做青橙分离（那层暖橙会把冷白天空又染回暖灰），
// 饱和度压下来、叠冷白气候色，整屏统一到“冷白漫射 + 冷蓝暗部”。
const WEATHER_GRADES = {
  blizzard: {
    // 2026-11-18：用户要"像参考图那样再降一点饱和 + 远方加一层雾"，但明确
    // "不要降太多、要看清赛道"。饱和 0.88→0.80（累计比默认 1.05 低约 24%，
    // 但没有压到灰白），冷白气候色 0.18→0.21 补一点漫射感。
    // 别再往下压了：0.7 以下浮桶的蓝白条纹和红黄旗会开始糊在一起。
    saturation: 0.80, split: 0, climate: 0xc3d7e6, climateAmt: 0.21,
    vignette: 0.32, grain: 0.022,
  },
  storm: {
    saturation: 0.88, split: 0.35, climate: 0xa8bccb, climateAmt: 0.2,
  },
  starry: {
    // 星空：暗部留住蓝紫；暗角从 0.38 收到 0.22，
    // 否则屏幕四角的船和航道会被压黑，玩家反馈"太暗看不清"
    saturation: 1.02, split: 0, climate: 0x35477f, climateAmt: 0.06,
    vignette: 0.22, grain: 0.018,
  },
};

// 泛光在半分辨率上做：模糊链的像素量降到 1/4，扩散范围按屏幕比例不变，
// 观感和全分辨率几乎一样，却是后处理里最贵的一环
const BLOOM_SCALE = 0.5;
// 注意：这里刻意不再做“动态分辨率”。早先的实现会在帧时偏高时每隔 1.6s 调一次
// 像素比/画布尺寸，连带重建合成器的两张全屏缓冲和泛光 mip 链。在 Windows 的
// ANGLE/D3D11 上，这种运行中的反复重建会让交换链整帧闪黑——帧时在 45~51fps
// 之间抖动时还会一升一降来回切换，表现就是“开局/冲线后不停黑屏闪屏，过一会儿
// 又好了”。改成固定分辨率，卡顿交给 Game 里的一次性画质降档来处理。

/**
 * 后期处理流水线：泛光 → 色调映射 → 青橙调色 → SMAA（高）/ FXAA（中）。
 * 低画质直接走 renderer.render（零额外开销）。
 */
export class PostFx {
  /**
   * @param {number} opts.bloomScale 泛光强度倍率：怪物模式的主题场景（熔岩/极光）自发光面片多，
   *   用 0.55 压一档，避免整屏发光；其它模式保持原来的 1。
   * @param {number} opts.bloomThreshold 泛光阈值：怪物模式抬到 1.0，只让最亮的熔岩/极光发光。
   */
  constructor(renderer, scene, camera, {
    quality = 'high', bloomScale = 1, bloomThreshold = 0.92, fx = null,
  } = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.fx = fx; // Effekseer 粒子（护盾/氮气/爆炸…），需要画进合成器里
    this.bloomScale = bloomScale;
    this.bloomThreshold = bloomThreshold;
    this.quality = null; // 首帧必须真正执行一次 setQuality（含像素比的设置）
    this.grade = null; // 天气调色配置（WEATHER_GRADES）
    this.uwTarget = 0; // 水下程度目标值，render() 里向 uUnderwater 插值
    this.composer = null;
    this.gradePass = null;
    this.bloomPass = null;
    this.aaPass = null;
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.setQuality(quality);
  }

  get isActive() {
    return !!this.composer;
  }

  /**
   * 按天气切换调色。暴雪需要整套冷白气候色（关青橙分离 + 降饱和 + 冷白叠加），
   * 其它天气回到默认的电影感调色。
   */
  setWeather(weather) {
    this.weather = weather || null;
    this.grade = WEATHER_GRADES[weather?.id] || null;
    this.#applyGrade();
  }

  /**
   * 地图专属调色档（目前只有湖泊环线用）。只在「晴朗白天」覆盖天气档，
   * 其它天气仍走 WEATHER_GRADES，保证暴雪/星空的冷调不被冲掉。
   * 传 null 即撤销；没有地图档的地图行为与改动前完全一致。
   */
  setMapGrade(grade) {
    this.mapGrade = grade || null;
    this.#applyGrade();
  }

  #applyGrade() {
    if (!this.gradePass) return;
    const byMap = this.weather?.id === 'day' && this.mapGrade;
    const g = (byMap ? this.mapGrade : this.grade) || {};
    const u = this.gradePass.uniforms;
    u.uSaturation.value = g.saturation ?? 1.05;
    u.uContrast.value = g.contrast ?? 1.07;
    u.uSplit.value = g.split ?? 1;
    u.uClimate.value.set(g.climate ?? 0xffffff);
    u.uClimateAmt.value = g.climateAmt ?? 0;
    u.uVignette.value = g.vignette ?? 0.3;
    u.uGrain.value = g.grain ?? 0.008;
  }

  /** 渲染分辨率倍数（0.7~1.25）。改完必须强制重建一次。 */
  setPixelScale(k) {
    const v = Math.max(0.5, Math.min(1.25, Number(k) || 1));
    if (Math.abs((this.pixelScale || 1) - v) < 0.001) return;
    this.pixelScale = v;
    this.setQuality(this.quality, true);
  }

  /**
   * @param {string} quality 低/中/高
   * @param {boolean} force 画质没变也要重建（改渲染分辨率倍数时用）
   */
  setQuality(quality, force = false) {
    const level = QUALITY[quality] ? quality : 'high';
    if (!force && level === this.quality) return;
    this.quality = level;
    const cfg = QUALITY[level];
    // pixelScale 来自设置页的「渲染分辨率」：在不改画质档位的前提下单独降内部分辨率，
    // 这是提帧最有效的一档（画质档位决定"开哪些效果"，它决定"画多少像素"）。
    const ratio = Math.min(window.devicePixelRatio || 1, cfg.pixelRatio) * (this.pixelScale || 1);
    // 只在像素比真的变了才动画布尺寸：无意义的 setPixelRatio/setSize 同样会
    // 重建底层缓冲，在部分驱动上就是一次黑闪。
    if (Math.abs(this.renderer.getPixelRatio() - ratio) > 0.001) {
      this.renderer.setPixelRatio(ratio);
    }
    this.renderer.setSize(this.width, this.height);

    this.#disposeComposer();
    if (!cfg.bloom && !cfg.grade && !cfg.aa) return;
    try {
      const composer = new EffectComposer(this.renderer);
      composer.setSize(this.width, this.height);
      composer.addPass(new RenderPass(this.scene, this.camera));

      // Effekseer 直接画到“当前绑定的帧缓冲”，必须在合成器内部绘制：
      // 塞在 RenderPass 之后、泛光之前，道具特效才会进入同一张图。
      // 旧做法是主渲染之后单独 draw，中/高画质下会被合成器的输出整帧覆盖，
      // 表现就是“只有低画质看得到道具特效”。
      const fx = this.fx;
      if (fx) {
        const camera = this.camera;
        composer.addPass({
          enabled: true,
          needsSwap: false, // 原地叠在 readBuffer 上，不交换缓冲
          clear: false,
          renderToScreen: false,
          render(rend, writeBuffer, readBuffer) {
            if (!fx.ctx) return;
            rend.setRenderTarget(readBuffer);
            fx.draw(camera);
            rend.resetState(); // Effekseer 会弄脏 GL 状态
          },
          setSize() {},
          dispose() {},
        });
      }

      if (cfg.bloom > 0) {
        // 阈值高一点，只有太阳反光/爆炸/霓虹才发光，避免整个画面糊成一片
        const bw = Math.max(1, Math.round(this.width * BLOOM_SCALE));
        const bh = Math.max(1, Math.round(this.height * BLOOM_SCALE));
        this.bloomPass = new UnrealBloomPass(
          new THREE.Vector2(bw, bh),
          cfg.bloom * this.bloomScale, 0.42, this.bloomThreshold,
        );
        // 合成器会按全分辨率尺寸调用 setSize，这里统一折半，
        // 让泛光的多级模糊始终跑在半分辨率上
        const baseSetSize = this.bloomPass.setSize.bind(this.bloomPass);
        this.bloomPass.setSize = (w, h) => baseSetSize(
          Math.max(1, Math.round(w * BLOOM_SCALE)),
          Math.max(1, Math.round(h * BLOOM_SCALE)),
        );
        composer.addPass(this.bloomPass);
      }

      composer.addPass(new OutputPass());

      if (cfg.grade) {
        this.gradePass = new ShaderPass(GradeShader);
        composer.addPass(this.gradePass);
        this.#applyGrade();
      }
      if (cfg.aa === 'smaa') {
        // SMAA 比 FXAA 多几张查找纹理和三次全屏绘制，但只作用在边缘，
        // 不会像 FXAA 那样把水面纹理和远景一起磨软。
        this.aaPass = new SMAAPass(this.width, this.height);
        composer.addPass(this.aaPass);
      } else if (cfg.aa === 'fxaa') {
        this.aaPass = new ShaderPass(FXAAShader);
        composer.addPass(this.aaPass);
        this.#updateAaResolution();
      }
      this.composer = composer;
    } catch (err) {
      console.warn('[post] 后处理初始化失败，回退到直接渲染', err);
      this.#disposeComposer();
      this.renderer.setSize(this.width, this.height);
    }
  }

  #updateAaResolution() {
    if (!this.aaPass?.material?.uniforms?.resolution) return; // SMAA 自己按 setSize 走
    const pr = this.renderer.getPixelRatio();
    this.aaPass.material.uniforms.resolution.value.set(
      1 / (this.width * pr), 1 / (this.height * pr),
    );
  }

  /**
   * 水下程度 0~1（由 Game 每帧按相机 y 算出来传进来）。
   * 这里只记目标值，真正写 uniform 在 render() 里做插值：
   * 相机穿过水面时 uwK 是一帧跳变的，直接写进去会看到整屏"啪"地变色。
   */
  setUnderwater(k) {
    this.uwTarget = Math.max(0, Math.min(1, Number(k) || 0));
  }

  setSize(width, height) {
    this.width = width;
    this.height = height;
    this.composer?.setSize(width, height);
    this.#updateAaResolution();
    if (!this.composer) {
      this.renderer.setSize(width, height);
    }
  }

  render(dt) {
    if (!this.composer) {
      this.renderer.render(this.scene, this.camera);
      return;
    }
    if (this.gradePass) {
      this.gradePass.uniforms.uTime.value += dt;
      const u = this.gradePass.uniforms.uUnderwater;
      const target = this.uwTarget || 0;
      if (Math.abs(u.value - target) > 0.002) {
        // 0.35s 左右到位的指数逼近：入水/出水都不突兀，又不会拖到手感之外
        u.value += (target - u.value) * Math.min(1, dt * 9);
      } else {
        u.value = target;
      }
    }
    this.composer.render(dt);
  }

  /**
   * 显卡上下文丢失/恢复（驱动重置）后重建合成器。
   * WebGLRenderTarget 的帧缓冲在上下文恢复时不会自动回来，继续用旧实例会整屏黑。
   */
  rebuild() {
    const level = this.quality || 'high';
    this.quality = null; // 强制 setQuality 真正执行一次
    this.setQuality(level);
  }

  #disposeComposer() {
    if (!this.composer) return;
    this.composer.passes.forEach((p) => p.dispose?.());
    this.composer.dispose?.();
    this.composer = null;
    this.gradePass = null;
    this.bloomPass = null;
    this.aaPass = null;
  }

  dispose() {
    this.#disposeComposer();
  }
}

import * as THREE from 'three';

/**
 * 道具局部倒影（P1）：把「艇 / 浮标」这类贴近水面、玩家最容易盯着看的物体
 * 单独渲进一张低分辨率平面反射图，供水面着色器采样。
 *
 * 为什么不做全场景平面反射：
 * 整场景再渲一遍 = 地形/树/特效/阴影统统翻倍，竞速游戏里帧率比倒影重要。
 * 而水面读起来"假"的地方其实只有近处那几米 —— 浮标底下没有自己的倒影、
 * 船像悬在水面上。只镜这几类物体，代价是 1 次低分辨率 pass（几个 draw call），
 * 换到的是"物体真的立在水里"。
 *
 * 实现要点（镜像相机数学照抄 three 的 Reflector，那套是被验证过的）：
 * - 相机按水面（y = waterY）镜像：位置 / up / 注视点全部反射后重新 lookAt。
 *   直接给相机乘反射矩阵会让世界矩阵 det < 0（左手系），three 的正面剔除会反过来，
 *   模型变成"看内壁"；用 lookAt 重建正交基没这个问题。
 * - 物体用图层筛（PROP_LAYER）：镜像相机只认这一层，水面自己（图层 0）不会进倒影。
 * - 采样用 textureMatrix（bias × proj × viewInverse）：水面上任意一点 P 用同一个
 *   矩阵投影出的 UV，正好等于它在镜像图里该被取的位置 —— 不用屏幕 UV，
 *   也不受画质缩放影响。
 */
export const PROP_LAYER = 3;

const _n = new THREE.Vector3(0, 1, 0);
const _planePoint = new THREE.Vector3();
const _camPos = new THREE.Vector3();
const _view = new THREE.Vector3();
const _target = new THREE.Vector3();
const _lookAt = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _rot = new THREE.Matrix4();
const _clear = new THREE.Color();
const _viewport = new THREE.Vector4();
const _clipPlane = new THREE.Plane();
const _clipV = new THREE.Vector4();
const _clipQ = new THREE.Vector4();
// 斜裁剪面往外推 4mm：正好贴在水线上的浮桶底沿不会被自己裁掉
const CLIP_BIAS = 0.004;

export class PropReflection {
  #seen = [];
  #lastKey = '';
  #lastSync = -1;

  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {{width?:number,height?:number}} [opts] 渲染分辨率（半分辨率够用，倒影本来就要糊）
   */
  constructor(renderer, { width = 480, height = 270 } = {}) {
    const gl = renderer?.getContext?.();
    // 半浮点：船体金属/自发光 >1 的部分不能被 8 位目标削顶，否则倒影是一块死白。
    // 拿不到扩展就退 8 位 —— 倒影里这点过曝不致命，但不能因此整块功能失效。
    const hdr = !!(gl && gl.getExtension('EXT_color_buffer_float'));
    const webgl2 = !!renderer?.capabilities?.isWebGL2;
    this.width = width;
    this.height = height;
    this.hdr = hdr;
    // 有 mip 链，水面才能"按一个像素实际覆盖多大"去取更糊的一级。
    // 这是浮桶倒影不闪的关键：480×270 的图铺满屏幕，一只 1.2m 的桶在中景
    // 只有 1~2 个 texel 宽，只采 0 级就是在"有/无"之间做二选一，整帧一跳。
    // 非 2 的幂纹理要 mip 必须 WebGL2；老设备保持无 mip，采样自然回到 0 级。
    this.mip = webgl2;
    this.rt = new THREE.WebGLRenderTarget(width, height, {
      type: hdr ? THREE.HalfFloatType : THREE.UnsignedByteType,
      minFilter: this.mip ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: this.mip,
      // 4×MSAA：先把桶的轮廓在倒影图里磨软，再去 mip 模糊，边缘就不会一格一格地爬。
      // 480×270 的填充率可以忽略，但这是"薄物体倒影不抖"最便宜的一步。
      samples: webgl2 ? 4 : 0,
    });
    this.camera = new THREE.PerspectiveCamera();
    // 只认道具层：镜像 pass 里水面 / 地形 / 天空一个都不画
    this.camera.layers.set(PROP_LAYER);
    // 采样矩阵（世界坐标 → 这张 RT 的 uv）
    this.textureMatrix = new THREE.Matrix4();
    this.enabled = true;
    // 水面以下的几何不进倒影（见 render 里的斜裁剪面）
    this.clipUnderwater = true;
    this.sources = [];
    this.frames = 0;
    this.skipped = 0;
  }

  /**
   * 登记需要进倒影的物体。每帧调用也没关系：清单没变就跳过（400ms 兜底重扫一次，
   * 给异步加载完的 GLB 子网格补图层）。
   * @param {THREE.Object3D[]} list
   */
  setSources(list) {
    const arr = [];
    let key = '';
    for (const o of list || []) {
      if (!o) continue;
      arr.push(o);
      key += o.uuid + ',';
    }
    this.sources = arr;
    if (key === this.#lastKey && performance.now() - this.#lastSync < 400) return;
    this.#lastKey = key;
    this.#lastSync = performance.now();
    // 先摘掉上一轮的图层再重挂：船/浮标加载完会把子网格换成新的，
    // 只"补"不"清"会越积越多，换图后旧模型还留在图层里。
    for (const o of this.#seen) o.layers.disable(PROP_LAYER);
    this.#seen.length = 0;
    for (const root of arr) {
      root.traverse((c) => {
        c.layers.enable(PROP_LAYER);
        this.#seen.push(c);
      });
    }
  }

  /**
   * 渲一帧倒影图。
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Scene} scene
   * @param {THREE.PerspectiveCamera} camera 主相机
   * @param {number} waterY 水面高度
   * @returns {boolean} 是否真的渲了（false = 这一帧跳过，调用方沿用上一帧的图）
   */
  render(renderer, scene, camera, waterY = 0) {
    if (!this.enabled || !renderer || !scene || !camera) return false;
    // 相机在水下（或贴得比水面还低）：镜像相机翻到水面上方会拍到天空，倒影错位
    if (camera.position.y < waterY + 0.35) { this.skipped++; return false; }
    if (!this.sources.length) { this.skipped++; return false; }

    // 平面法线恒为 +Y（水面水平），取相机正下方的水面点做镜像中心
    _planePoint.set(camera.position.x, waterY, camera.position.z);
    // 主相机的 matrixWorld 是在 renderer.render() 里才刷新的，而这个 pass 跑在
    // 它之前。不手动刷一次，镜像相机拿到的是"上一帧的机位/朝向"，倒影整块慢一帧：
    // 追尾机位一直在动，屏幕上就是倒影相对浮桶缓慢滑移 —— 薄物体的边缘在这种
    // 亚像素位移下会持续闪烁。刷新后采样矩阵与渲染用的是同一帧的相机。
    camera.updateMatrixWorld();
    _camPos.setFromMatrixPosition(camera.matrixWorld);

    // 镜像后的相机位置
    _view.subVectors(_planePoint, _camPos).reflect(_n).negate().add(_planePoint);

    // 注视点同样镜像
    _rot.extractRotation(camera.matrixWorld);
    _lookAt.set(0, 0, -1).applyMatrix4(_rot).add(_camPos);
    _target.subVectors(_planePoint, _lookAt).reflect(_n).negate().add(_planePoint);

    const cam = this.camera;
    cam.position.copy(_view);
    cam.up.set(0, 1, 0).applyMatrix4(_rot).reflect(_n);
    // 退化保护：主相机正对水面俯视时，镜像后的 up 会和视线平行，lookAt 算不出
    // 正交基（矩阵全是 NaN），整张倒影图会作废。这一帧直接跳过、沿用上一帧。
    _dir.subVectors(_target, _view).normalize();
    if (Math.abs(_dir.dot(cam.up)) > 0.995) { this.skipped++; return false; }
    cam.lookAt(_target);
    cam.near = camera.near;
    cam.far = camera.far;
    cam.updateMatrixWorld();
    cam.projectionMatrix.copy(camera.projectionMatrix);

    // 斜近裁剪面（数学同 three 的 Reflector）：把水面以下那半截几何挡在倒影之外。
    // 浮桶桶身是沉在水下 0.6m 的，不裁的话这部分也被镜像到水面**上方**，
    // 正好压在它自己正确的倒影上；两张面在水线附近互相咬，随浪上下起伏，
    // 整条水线带就会一直闪。改投影矩阵而不是 renderer.clippingPlanes，是因为
    // 后者会改材质的 NUM_CLIPPING_PLANES，每帧开关等于每帧重编译全部着色器。
    // 只动 z 行，x/y 行不变 → 采样矩阵投出的 uv 不受影响。
    if (this.clipUnderwater) {
      const p = _clipPlane.set(_n, -waterY).applyMatrix4(cam.matrixWorldInverse);
      // 注意：这里的 q/multiplyScalar 都在 Vector4 上算（Plane 没有这些方法），
      // 数学照抄 three 的 Reflector —— 它把平面拷进 Vector4 再算。
      _clipV.set(p.normal.x, p.normal.y, p.normal.z, p.constant);
      const e = cam.projectionMatrix.elements;
      _clipQ.x = (Math.sign(_clipV.x) + e[8]) / e[0];
      _clipQ.y = (Math.sign(_clipV.y) + e[9]) / e[5];
      _clipQ.z = -1.0;
      _clipQ.w = (1.0 + e[10]) / e[14];
      _clipV.multiplyScalar(2.0 / _clipV.dot(_clipQ));
      e[2] = _clipV.x;
      e[6] = _clipV.y;
      e[10] = _clipV.z + 1.0 - CLIP_BIAS;
      e[14] = _clipV.w;
    }

    // 世界坐标 → RT uv（bias * proj * viewInverse）
    this.textureMatrix.set(
      0.5, 0.0, 0.0, 0.5,
      0.0, 0.5, 0.0, 0.5,
      0.0, 0.0, 0.5, 0.5,
      0.0, 0.0, 0.0, 1.0,
    );
    this.textureMatrix.multiply(cam.projectionMatrix);
    this.textureMatrix.multiply(cam.matrixWorldInverse);

    const prevRT = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const prevBg = scene.background;
    const prevFog = scene.fog;
    const prevShadow = renderer.shadowMap.autoUpdate;
    renderer.getClearColor(_clear);
    const prevAlpha = renderer.getClearAlpha();
    renderer.getViewport(_viewport);

    try {
      // 背景必须透明：alpha=0 的地方水面着色器才知道"这里没有倒影"
      scene.background = null;
      // 倒影不吃雾：水面自己在片元末尾按距离加雾，这里再雾一次就是双层
      scene.fog = null;
      renderer.shadowMap.autoUpdate = false;
      renderer.autoClear = true;
      renderer.setClearColor(0x000000, 0);
      renderer.setRenderTarget(this.rt);
      renderer.clear();
      renderer.render(scene, cam);
    } finally {
      // 必须 finally：中途抛错（驱动/显存）不能把背景色、阴影开关留在半截状态
      scene.background = prevBg;
      scene.fog = prevFog;
      renderer.shadowMap.autoUpdate = prevShadow;
      renderer.autoClear = prevAutoClear;
      renderer.setClearColor(_clear, prevAlpha);
      renderer.setRenderTarget(prevRT);
      renderer.setViewport(_viewport);
    }
    this.frames++;
    return true;
  }

  dispose() {
    for (const o of this.#seen) o.layers.disable(PROP_LAYER);
    this.#seen.length = 0;
    this.sources = [];
    this.rt?.dispose();
    this.rt = null;
  }
}

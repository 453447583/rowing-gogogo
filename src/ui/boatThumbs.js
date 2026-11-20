import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { BOATS } from '../data/boats.js';
import { measureModelBox } from '../game/modelBounds.js';

// 选艇卡片的缩略图：把每艘船的真实模型离屏渲染成一张小图（透明背景），
// 生成后缓存，卡片重绘时直接复用。8 艘船共用同一个 WebGL 上下文，画完立即释放。
const THUMB_W = 320;
const THUMB_H = 180;

const cache = new Map();
let started = false;

/** 已生成好的缩略图 dataURL；还没画好时返回空串，卡片显示占位块 */
export function boatThumbUrl(id) {
  return cache.get(id) || '';
}

/** 把新画好的缩略图补进当前 DOM（抽屉可能已经重绘过很多次） */
function paintDom(id, url) {
  document.querySelectorAll(`[data-boat-thumb="${id}"]`).forEach((el) => {
    el.innerHTML = `<img src="${url}" alt="">`;
    el.classList.add('ready');
  });
}

/**
 * 首次调用时开始后台生成全部赛艇缩略图。
 * 串行加载避免 8 个 GLB 同时解码把主线程卡住。
 */
export function ensureBoatThumbs() {
  if (started || typeof document === 'undefined') return;
  started = true;

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  } catch {
    return; // 没有 WebGL 就保持占位块，不影响选艇
  }
  renderer.setPixelRatio(1);
  renderer.setSize(THUMB_W, THUMB_H, false);

  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xbde9ff, 0x04263f, 2.4));
  const key = new THREE.DirectionalLight(0xfff1cf, 2.6);
  key.position.set(-5, 9, 6);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x59d8ff, 2.4);
  rim.position.set(4, 2, -6);
  scene.add(rim);

  const camera = new THREE.PerspectiveCamera(32, THUMB_W / THUMB_H, 0.1, 60);
  camera.position.set(3.6, 2.3, 5.0);
  camera.lookAt(0, 0.72, 0);

  const loader = new GLTFLoader();
  (async () => {
    for (const boat of BOATS) {
      try {
        const gltf = await loader.loadAsync(boat.model);
        const url = renderThumb(renderer, scene, camera, gltf, boat);
        if (!url) continue;
        cache.set(boat.id, url);
        paintDom(boat.id, url);
      } catch {
        // 单艘船加载失败只影响它自己的卡片，继续画下一艘
      }
    }
    renderer.dispose();
    renderer.forceContextLoss?.();
  })();
}

function renderThumb(renderer, scene, camera, gltf, boat) {
  const hasSkin = gltf.scene.getObjectByProperty('isSkinnedMesh', true) !== undefined;
  const model = hasSkin ? cloneSkinned(gltf.scene) : gltf.scene.clone(true);

  const box = measureModelBox(model);
  const size = box.getSize(new THREE.Vector3());
  const fwdLen = Math.max(size.x, size.z, 0.001);
  // 朝向与 BoatShowcase / 比赛里保持一致：统一把船头转到 +Z
  if (Number.isFinite(boat.modelRotationX) || Number.isFinite(boat.modelRotationY)) {
    model.rotation.x = Number.isFinite(boat.modelRotationX) ? boat.modelRotationX : 0;
    model.rotation.y = Number.isFinite(boat.modelRotationY) ? boat.modelRotationY : 0;
  } else {
    model.rotation.y = size.x > size.z ? -Math.PI / 2 : 0;
  }
  // 竖着站的角色（牛来号）按身高定标，否则会被拉成一根长条
  const charScale = !Number.isFinite(boat.fitHeight)
    ? 0
    : (boat.fitHeight * 0.62) / Math.max(size.y, 0.001);
  const s = charScale > 0 ? charScale : 3.1 / fwdLen;
  model.scale.setScalar(s);
  model.updateMatrixWorld(true);

  const box2 = measureModelBox(model);
  const center = box2.getCenter(new THREE.Vector3());
  model.position.x -= center.x;
  model.position.z -= center.z;
  model.position.y -= box2.min.y;

  scene.add(model);
  renderer.render(scene, camera);

  const out = document.createElement('canvas');
  out.width = THUMB_W;
  out.height = THUMB_H;
  const ctx = out.getContext('2d');
  // 底部一圈冷色光晕，让透明背景不至于空荡
  const glow = ctx.createRadialGradient(
    THUMB_W * 0.5, THUMB_H * 0.84, 6,
    THUMB_W * 0.5, THUMB_H * 0.84, THUMB_W * 0.55,
  );
  glow.addColorStop(0, 'rgba(92, 190, 240, 0.34)');
  glow.addColorStop(0.55, 'rgba(46, 120, 168, 0.14)');
  glow.addColorStop(1, 'rgba(20, 60, 96, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, THUMB_W, THUMB_H);
  ctx.drawImage(renderer.domElement, 0, 0, THUMB_W, THUMB_H);

  scene.remove(model);
  return out.toDataURL('image/png');
}

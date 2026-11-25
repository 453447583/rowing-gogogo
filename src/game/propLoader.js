import * as THREE from 'three';
import { createGLTFLoader } from './gltfLoader.js';

/**
 * 场景道具 GLB 的统一加载器（天梯这几个新层共用）。
 *
 * 为什么不直接用 `loadMonsterModel`：那个是给带骨骼的怪物准备的（会 cloneSkinned、
 * 强制 castShadow、按高度归一化到"贴水面"），拿来摆静态道具会多做一堆无用功。
 * 这里只做三件事：缓存 promise、按尺寸归一化、把材质手感压到同一档。
 */

const cache = new Map();

/** 载体级缓存：同一个 url 只下载一次，失败就删掉缓存以便重试 */
export function loadProp(url) {
  if (!cache.has(url)) {
    const p = new Promise((resolve, reject) => {
      createGLTFLoader().load(url, resolve, undefined, reject);
    });
    p.catch(() => cache.delete(url));
    cache.set(url, p);
  }
  return cache.get(url);
}

/** 克隆一份（几何/材质共享，别逐实例 clone，GLB 几个 MB 会卡） */
export async function cloneProp(url, target, opts = {}) {
  const gltf = await loadProp(url);
  const obj = gltf.scene.clone(true);
  if (opts.materials !== false) styleMaterials(obj);
  normalizeProp(obj, target, opts.by || 'max');
  return obj;
}

/**
 * 归一化：缩放到目标尺寸，水平居中，底部贴 y=0。
 * by='max' → 按最大边长（石头/道具）；by='height' → 按高度（门/柱子）。
 */
export function normalizeProp(obj, target, by = 'max') {
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  const ref = by === 'height' ? size.y : Math.max(size.x, size.y, size.z);
  obj.scale.multiplyScalar(target / Math.max(0.001, ref));
  obj.updateMatrixWorld(true);
  const fitted = new THREE.Box3().setFromObject(obj);
  const center = fitted.getCenter(new THREE.Vector3());
  obj.position.x -= center.x;
  obj.position.z -= center.z;
  obj.position.y -= fitted.min.y;
  obj.traverse((o) => {
    if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
  });
  return fitted.getSize(new THREE.Vector3());
}

/**
 * 材质手感统一。GLB 各自带着不同的粗糙度/金属度，
 * 直接沿用会出现"同一个世界里有的像铁、有的像塑料"（Track.js 里那套规则的简化版）。
 */
export function styleMaterials(obj) {
  obj.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of ms) {
      if (!m || m.userData.__styled) continue;
      const name = `${m.name || ''} ${m.type || ''}`;
      if (/metal|steel|iron|gold|brass|bronze|chrome|frame|rail/i.test(name)) {
        m.roughness = Math.min(m.roughness ?? 0.5, 0.38);
        m.metalness = Math.max(m.metalness ?? 0, 0.75);
      } else if (/rock|stone|granite|base|obsidian/i.test(name)) {
        m.roughness = Math.max(m.roughness ?? 0.5, 0.9);
        m.metalness = Math.min(m.metalness ?? 0, 0.06);
      }
      m.userData.__styled = true;
      m.needsUpdate = true;
    }
  });
}

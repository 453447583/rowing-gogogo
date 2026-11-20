import * as THREE from 'three';

/**
 * 世界空间包围盒（蒙皮感知）。
 *
 * 为什么不能直接用 `new THREE.Box3().setFromObject(root)`：
 * 它对蒙皮网格取的是 **绑定姿势的 geometry.boundingBox**，而骨骼矩阵可能带着
 * 缩放/位移 —— 牛来号的实测结果是偏小 2.31 倍（量出 1.16m，实际渲染 2.69m），
 * 于是 `fitTo:'height'` 按 2.3 去缩，最后甩出一头 5.3m 高的巨牛。
 *
 * 这里对 SkinnedMesh 走 `computeBoundingBox()`（内部逐顶点做 boneTransform，
 * 结果在 mesh 局部空间），再乘 matrixWorld 进世界空间；普通网格仍用几何包围盒。
 * 只在加载时调一次，几万顶点的开销可以忽略。
 */
export function measureModelBox(root) {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3();
  const tmp = new THREE.Box3();
  let hit = false;
  root.traverse((obj) => {
    if (!obj.isMesh || !obj.geometry) return;
    if (obj.isSkinnedMesh && typeof obj.computeBoundingBox === 'function') {
      // 骨骼矩阵要先刷新，否则 computeBoundingBox 用的是上一帧的矩阵
      obj.skeleton?.update?.();
      obj.computeBoundingBox();
      if (obj.boundingBox) tmp.copy(obj.boundingBox).applyMatrix4(obj.matrixWorld);
      else return;
    } else {
      if (!obj.geometry.boundingBox) obj.geometry.computeBoundingBox();
      if (!obj.geometry.boundingBox) return;
      tmp.copy(obj.geometry.boundingBox).applyMatrix4(obj.matrixWorld);
    }
    box.union(tmp);
    hit = true;
  });
  return hit ? box : new THREE.Box3().setFromObject(root);
}

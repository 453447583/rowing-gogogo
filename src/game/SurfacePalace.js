// 海上龙宫：把深海龙宫第二段潜行的那座白色大理石宫殿搬到水面上做远景。
// 几何与 PalaceUndersea.js 的 undersea-palace 同源；这里只改三件事：
//   ① 材质按水面光照重调（水下版靠 HDR 暖光穿过吸收层，水面会过曝）；
//   ② 穹顶压扁系数放宽，水面上不用再怕顶穿海面；
//   ③ 不加水下点光、不参与水下可见性切换，纯静态布景。
// 每块几何在末尾标 propAO，防止 Track 的道具 AO 再给暖窗套一层暗边。
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export function buildSurfacePalace() {
  const palace = new THREE.Group();
  palace.name = 'surface-dragon-palace';

  const marble = new THREE.MeshStandardMaterial({
    color: 0xe9e2d2, roughness: 0.62, metalness: 0.02,
    emissive: 0x2b2a26, emissiveIntensity: 0.12,
  });
  const marbleLite = new THREE.MeshStandardMaterial({
    color: 0xfaf5e8, roughness: 0.5, metalness: 0.02,
    emissive: 0x33312b, emissiveIntensity: 0.14,
  });
  const marbleDark = new THREE.MeshStandardMaterial({
    color: 0xb5afa2, roughness: 0.8, metalness: 0.0,
    emissive: 0x24231f, emissiveIntensity: 0.1,
  });
  const gold = new THREE.MeshStandardMaterial({
    color: 0xd8b16a, roughness: 0.3, metalness: 0.7,
    emissive: 0x6a4a14, emissiveIntensity: 0.5,
  });
  const glass = new THREE.MeshStandardMaterial({
    color: 0xbfe9f8, roughness: 0.1, metalness: 0.2,
    transparent: true, opacity: 0.52, side: THREE.DoubleSide,
    emissive: 0x2f86b0, emissiveIntensity: 0.55,
  });
  // 水面没有水下吸收层，HDR 暖光会直接烧成白块，用普通暖色即可
  const warm = new THREE.MeshBasicMaterial({ color: 0xf6b268 });
  const warmCore = new THREE.MeshBasicMaterial({ color: 0xffe2ab });
  const warmHalo = new THREE.MeshBasicMaterial({
    color: 0xff9c4a, transparent: true, opacity: 0.28,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  });

  const add = (geo, mat, x, y, z, ry = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.y = ry;
    palace.add(m);
    return m;
  };
  const batches = new Map();
  const box = (w, h, d, mat, x, y, z) => {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(x, y, z);
    if (!batches.has(mat)) batches.set(mat, []);
    batches.get(mat).push(g);
  };

  // 台基 + 正面大台阶
  box(60, 1.0, 36, marbleDark, 0, 0.5, 0);
  box(56, 1.0, 33, marble, 0, 1.4, 0);
  const PLAT = 1.8;
  for (let i = 0; i < 4; i++) {
    const h = 0.45;
    box(17 - i * 0.7, h, 1.75, marbleLite, 0, h * 0.5 + i * h, 18.2 + (3 - i) * 1.7);
  }

  // 柱廊：正面 13 根 + 两侧各 5 根，合成一个 InstancedMesh
  const parts = [];
  const push = (g, y) => { g.translate(0, y, 0); parts.push(g); };
  push(new THREE.BoxGeometry(1.9, 0.32, 1.9), 0.16);
  push(new THREE.CylinderGeometry(1.02, 1.14, 0.42, 12), 0.53);
  push(new THREE.CylinderGeometry(0.6, 0.78, 4.7, 14), 0.6 + 2.35);
  push(new THREE.CylinderGeometry(0.72, 0.6, 0.26, 14), 5.43);
  push(new THREE.BoxGeometry(1.62, 0.36, 1.62), 5.74);
  push(new THREE.BoxGeometry(1.92, 0.24, 1.92), 6.04);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const v = new THREE.CylinderGeometry(0.19, 0.19, 0.3, 6);
      v.rotateZ(Math.PI / 2);
      v.translate(sx * 0.72, 5.72, sz * 0.42);
      parts.push(v);
    }
  }
  const colGeo = mergeGeometries(parts, false);
  parts.forEach((g) => g.dispose());
  const COL_H = 4.93;
  const colPos = [];
  for (let i = 0; i < 13; i++) colPos.push([-21 + i * 3.5, 13.4]);
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 5; i++) colPos.push([sx * 21, 10 - i * 3.6]);
  }
  const cols = new THREE.InstancedMesh(colGeo, marbleLite, colPos.length);
  {
    const d = new THREE.Object3D();
    colPos.forEach(([x, z], i) => {
      d.position.set(x, PLAT, z);
      d.rotation.set(0, 0, 0);
      d.scale.set(1, COL_H / 6.16, 1);
      d.updateMatrix();
      cols.setMatrixAt(i, d.matrix);
    });
    cols.instanceMatrix.needsUpdate = true;
  }
  cols.frustumCulled = false;
  palace.add(cols);
  const COL_TOP = PLAT + COL_H;

  // 殿身 + 檐壁 + 齿饰
  box(34, COL_TOP + 0.9 - PLAT, 14, marble, 0, (PLAT + COL_TOP + 0.9) / 2, 0);
  box(34.4, 6.8, 0.5, marbleDark, 0, PLAT + 3.4, 8.25);
  box(45, 1.05, 30, marble, 0, COL_TOP + 0.52, 0);
  box(47, 0.46, 31.6, marbleLite, 0, COL_TOP + 1.28, 0);
  const ROOF = COL_TOP + 1.51;
  for (let i = 0; i < 26; i++) {
    box(0.62, 0.42, 0.5, marbleLite, -22.5 + i * 1.8, COL_TOP + 0.52, 14.9);
  }

  // 断山花：中间让开，穹顶从缺口升起
  for (const sx of [-1, 1]) {
    const x0 = sx * 23, x1 = sx * 9.0, xm = sx * 16.0;
    const shape = new THREE.Shape();
    shape.moveTo(Math.min(x0, x1), 0);
    shape.lineTo(Math.max(x0, x1), 0);
    shape.lineTo(xm, 1.8);
    shape.closePath();
    const geo = new THREE.ExtrudeGeometry(shape, { depth: 1.8, bevelEnabled: false });
    geo.translate(0, 0, -0.9);
    const m = add(geo, marbleLite, 0, ROOF, 13.6);
    m.frustumCulled = false;
    add(new THREE.TorusGeometry(0.8, 0.15, 4, 10, Math.PI), gold, sx * 9.3, ROOF + 0.28, 14.5);
  }

  const arched = (w, h) => {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.PlaneGeometry(w, h), warm);
    body.position.y = h / 2;
    const arc = new THREE.Mesh(new THREE.CircleGeometry(w / 2, 14, 0, Math.PI), warm);
    arc.position.y = h;
    const core = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.6, h * 0.76), warmCore);
    core.position.set(0, h * 0.5, 0.02);
    const halo = new THREE.Mesh(new THREE.PlaneGeometry(w * 1.9, (h + w / 2) * 1.4), warmHalo);
    halo.position.set(0, (h + w / 2) * 0.5, 0.06);
    g.add(halo, body, arc, core);
    return g;
  };

  // 正面弓形窗 + 中央大门
  const winZ = 8.56;
  for (const x of [-12.4, -6.2, 6.2, 12.4]) {
    const wgrp = arched(2.0, 3.4);
    wgrp.position.set(x, PLAT + 1.3, winZ);
    palace.add(wgrp);
    box(0.18, 4.2, 0.14, marbleDark, x, PLAT + 2.9, winZ + 0.06);
    box(2.3, 0.18, 0.14, marbleDark, x, PLAT + 2.4, winZ + 0.06);
    box(0.34, 4.6, 0.3, marbleLite, x - 1.24, PLAT + 2.35, winZ + 0.02);
    box(0.34, 4.6, 0.3, marbleLite, x + 1.24, PLAT + 2.35, winZ + 0.02);
  }
  {
    const door = arched(4.2, 4.2);
    door.position.set(0, PLAT + 0.1, winZ - 0.02);
    palace.add(door);
    for (const sx of [-1, 1]) {
      box(0.55, 6.0, 0.5, marbleLite, sx * 2.55, PLAT + 3.0, winZ + 0.05);
    }
    box(6.2, 0.5, 0.5, marbleLite, 0, PLAT + 6.0, winZ + 0.05);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(2.8, 0.28, 5, 14, Math.PI), marbleLite);
    ring.position.set(0, PLAT + 4.3, winZ + 0.05);
    palace.add(ring);
  }
  for (const x of [-17.4, -9.3, -3.1, 3.1, 9.3, 17.4]) {
    box(1.0, 5.6, 0.7, marbleLite, x, PLAT + 3.0, winZ + 0.1);
    box(1.3, 0.35, 1.0, marbleLite, x, PLAT + 5.85, winZ + 0.1);
  }

  // 两侧角亭 + 小穹顶
  for (const sx of [-1, 1]) {
    const px = sx * 23.5, pz = 8.2;
    box(9.4, 5.6, 9.4, marble, px, PLAT + 2.8, pz);
    box(10.2, 0.5, 10.2, marbleLite, px, PLAT + 5.85, pz);
    const drum = add(new THREE.CylinderGeometry(3.5, 3.7, 0.9, 14), marbleLite, px, PLAT + 6.55, pz);
    drum.frustumCulled = false;
    const dome = new THREE.SphereGeometry(3.5, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2);
    const dm = add(dome, glass, px, PLAT + 7.0, pz);
    dm.scale.y = 0.62;
    dm.frustumCulled = false;
    add(new THREE.SphereGeometry(0.34, 8, 6), gold, px, PLAT + 9.3, pz);
    for (const s of [-1, 1]) {
      const wgrp = arched(1.2, 2.0);
      wgrp.position.set(px + s * 2.6, PLAT + 1.9, pz + 4.72);
      palace.add(wgrp);
    }
  }

  // 中央琉璃穹顶：鼓座 + 扁穹顶 + 8 根金肋
  {
    const DRUM_R = 7.8, DRUM_Y = ROOF + 0.55, DRUM_H = 1.1;
    const DOME_SQUASH = 0.52;   // 水面版不用怕顶穿海面，比水下版更饱满
    const drum = add(new THREE.CylinderGeometry(DRUM_R, DRUM_R + 0.25, DRUM_H, 22), marble, 0, DRUM_Y, 0);
    drum.frustumCulled = false;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const x = Math.sin(a) * (DRUM_R + 0.12);
      const z = Math.cos(a) * (DRUM_R + 0.12);
      const wg = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 0.72), warm);
      wg.position.set(x, DRUM_Y, z);
      wg.rotation.y = a;
      palace.add(wg);
      const hg = new THREE.Mesh(new THREE.PlaneGeometry(2.3, 1.4), warmHalo);
      hg.position.set(x * 0.985, DRUM_Y, z * 0.985);
      hg.rotation.y = a;
      palace.add(hg);
    }
    const domeBase = DRUM_Y + DRUM_H / 2;
    const dome = add(
      new THREE.SphereGeometry(DRUM_R, 26, 14, 0, Math.PI * 2, 0, Math.PI / 2),
      glass, 0, domeBase, 0,
    );
    dome.scale.y = DOME_SQUASH;
    dome.frustumCulled = false;
    const inner = add(
      new THREE.SphereGeometry(DRUM_R * 0.94, 22, 12, 0, Math.PI * 2, 0, Math.PI / 2),
      warmHalo.clone(), 0, domeBase, 0,
    );
    inner.material.opacity = 0.14;
    inner.scale.y = DOME_SQUASH;
    inner.frustumCulled = false;
    for (let k = 0; k < 8; k++) {
      const rib = new THREE.Mesh(new THREE.TorusGeometry(DRUM_R, 0.14, 4, 16, Math.PI / 2), gold);
      rib.position.set(0, domeBase, 0);
      rib.rotation.y = (k / 8) * Math.PI * 2;
      rib.scale.y = DOME_SQUASH;
      rib.frustumCulled = false;
      palace.add(rib);
    }
    add(new THREE.SphereGeometry(0.46, 10, 8), gold, 0, domeBase + DRUM_R * DOME_SQUASH - 0.1, 0);
  }

  for (const [mat, geos] of batches) {
    const merged = mergeGeometries(geos, false);
    geos.forEach((g) => g.dispose());
    const mesh = new THREE.Mesh(merged, mat);
    mesh.frustumCulled = false;
    palace.add(mesh);
  }
  batches.clear();

  // 别让 Track 的道具 AO 把暖窗/白墙再压暗一遍：这座宫殿自带明暗层次
  palace.traverse((obj) => {
    if (obj.isMesh && obj.geometry) obj.geometry.userData.propAO = true;
  });
  return palace;
}

// 船体涂装 A/B 预览（方案 B：着色器选择性换漆）
//
// 与游戏内**同一份实现**：换漆逻辑走 src/data/paintTint.js，
// 所以这个页面出的图就是赛道上的颜色（光照也按 Environment.js 的口径摆）。
//
// 用法：/preview/paint_ab.html?boat=skiff
// 页面暴露 window.__paintAB 给 tests/paint_ab_shots.mjs 驱动。

import * as THREE from 'three';
import { createGLTFLoader } from '../src/game/gltfLoader.js';
import { getBoat, BOATS } from '../src/data/boats.js';
import { makePaintMaterial } from '../src/data/paintTint.js';
import { measureModelBox } from '../src/game/modelBounds.js';

const W = 1200;
const H = 800;

export const VARIANTS = [
  { key: 'default', name: '原色 · 未涂装', hex: '' },
  { key: 'paint_red', name: '赤焰红', hex: '#ff5a3c' },
  { key: 'paint_blue', name: '霜蓝', hex: '#6fc8ff' },
  { key: 'paint_jade', name: '翡翠', hex: '#3fd08a' },
  { key: 'paint_violet', name: '紫电', hex: '#a86bff' },
  { key: 'paint_gold', name: '金砂', hex: '#f0c060' },
  { key: 'paint_tide', name: '潮青', hex: '#46e0d0' },
];

// ---------- 渲染器 / 场景（光照对齐 Environment.js 的海图口径） ----------
const stage = document.getElementById('stage');
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(W, H);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = skyTexture();
const camera = new THREE.PerspectiveCamera(30, W / H, 0.1, 300);

const hemi = new THREE.HemisphereLight(0x8db8dd, 0x3a4a52, 0.85 * 0.82);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff2dd, 1.6 * 1.14);
sun.position.set(6.5, 9, 5.5);
scene.add(sun);
const fill = new THREE.DirectionalLight(0x9fd0ff, 0.42);
fill.position.set(-7.5, 3.2, -5.5);
scene.add(fill);
const rim = new THREE.DirectionalLight(0xffffff, 0.3);
rim.position.set(-1, 2.2, -9);
scene.add(rim);

function skyTexture() {
  const c = document.createElement('canvas');
  c.width = 4; c.height = 512;
  const g = c.getContext('2d');
  const grd = g.createLinearGradient(0, 0, 0, 512);
  grd.addColorStop(0.0, '#cfe6f3');
  grd.addColorStop(0.40, '#a8ccdd');
  grd.addColorStop(0.46, '#3f7f97');
  grd.addColorStop(1.0, '#12384a');
  g.fillStyle = grd;
  g.fillRect(0, 0, 4, 512);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function contactShadow(span = 4.8) {
  const s = 256;
  const c = document.createElement('canvas');
  c.width = s; c.height = s;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(s / 2, s / 2, 4, s / 2, s / 2, s / 2);
  grd.addColorStop(0, 'rgba(4,20,28,0.55)');
  grd.addColorStop(0.55, 'rgba(4,20,28,0.22)');
  grd.addColorStop(1, 'rgba(4,20,28,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(c);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(1.45 * span, 0.85 * span),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.005;
  return mesh;
}

// ---------- 旧实现（源码原状）：材质乘算，只做对照用 ----------
function paintByMultiply(src, hex) {
  const mat = src.clone();
  const tint = new THREE.Color(hex);
  mat.color = mat.color.clone().lerp(tint, 0.7);
  if (mat.emissive) mat.emissive = mat.emissive.clone().lerp(tint, 0.12);
  mat.needsUpdate = true;
  return mat;
}

// ---------- 状态 ----------
const state = { boatId: new URLSearchParams(location.search).get('boat') || 'skiff', variant: 0, mode: 'shader' };
let group = null;          // 场景里的船 + 柔影
let paintTargets = [];     // [{ mesh, base }]
const loader = createGLTFLoader();

function layoutCamera(root) {
  // 蒙皮网格（牛来号）的绑定姿势包围盒偏小 2.31 倍，必须用蒙皮感知版本
  const box = measureModelBox(root);
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const size = box.getSize(new THREE.Vector3());
  // 按「3/4 视角投影宽 + 物体高」算距离，长船与竖立的牛分别都能刚好占满画面
  const vFov = (camera.fov * Math.PI) / 180;
  const long = Math.max(size.x, size.z);
  const short = Math.min(size.x, size.z);
  const projW = long * 0.78 + short * 0.6;
  const needW = (projW / 2) / (Math.tan(vFov / 2) * (W / H));
  const needH = (size.y / 2) / Math.tan(vFov / 2);
  const tall = size.y > long * 0.55;                 // 竖着站的（牛来号）多留一截
  const dist = (Math.max(needW, needH, 2) + 0.3) * (tall ? 1.45 : 1.12);
  const dir = new THREE.Vector3(0.6, 0.36, 0.71).normalize();
  camera.position.copy(sphere.center).add(dir.multiplyScalar(dist));
  camera.lookAt(sphere.center.x, sphere.center.y, sphere.center.z);
  camera.updateMatrixWorld(true);
}

function disposeBoat() {
  if (!group) return;
  scene.remove(group);
  group.traverse((o) => {
    if (!o.isMesh) return;
    o.geometry?.dispose?.();
    const m = o.material;
    (Array.isArray(m) ? m : [m]).forEach((x) => x?.dispose?.());
  });
  group = null;
  paintTargets = [];
}

async function loadBoat(id) {
  disposeBoat();
  state.boatId = id;
  const def = getBoat(id);
  const gltf = await loader.loadAsync(def.model);
  const root = gltf.scene;

  if (def.hideNodes) {
    for (const pattern of def.hideNodes) {
      const re = pattern instanceof RegExp ? pattern : new RegExp(pattern, 'i');
      root.traverse((o) => { if (re.test(o.name)) o.visible = false; });
    }
  }

  // 与 Boat.js 相同的定标口径（船长 / 身高）
  const box = measureModelBox(root);
  const size = box.getSize(new THREE.Vector3());
  const fwdLen = Math.max(size.x, size.z);
  const scale = def.fitTo === 'height'
    ? (def.fitHeight || 2.6) / (size.y || 1)
    : def.hull.length / (fwdLen || 1) * (def.modelScale || 1);
  root.scale.setScalar(scale);
  if (Number.isFinite(def.modelRotationY)) root.rotation.y = def.modelRotationY;
  root.updateMatrixWorld(true);

  const b2 = measureModelBox(root);
  const c2 = b2.getCenter(new THREE.Vector3());
  root.position.set(-c2.x, -b2.min.y, -c2.z);
  root.updateMatrixWorld(true);

  group = new THREE.Group();
  group.add(root);
  group.add(contactShadow(Math.max(def.hull.length, 3)));
  scene.add(group);

  paintTargets = [];
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = false; o.receiveShadow = false;
    paintTargets.push({ mesh: o, base: o.material });
  });
  layoutCamera(root);
  return def;
}

function applyVariant(i, mode = state.mode) {
  state.variant = i;
  state.mode = mode;
  const v = VARIANTS[i];
  for (const t of paintTargets) {
    if (t.mesh.material !== t.base) t.mesh.material.dispose?.();
    if (!v.hex) t.mesh.material = t.base;
    else if (mode === 'multiply') t.mesh.material = paintByMultiply(t.base, v.hex);
    else t.mesh.material = makePaintMaterial(THREE, t.base, v.hex, state.boatId, { paintKey: v.key });
  }
  renderer.render(scene, camera);
  hud();
}

function hud() {
  const el = document.getElementById('hud');
  if (!el) return;
  const def = getBoat(state.boatId);
  const v = VARIANTS[state.variant];
  el.innerHTML = `<b>${def.name}</b> (${state.boatId}) · ${v.name} ${v.hex || ''} · ${state.mode}
    <br>meshes=${paintTargets.length} · ${def.model}`;
}

// ---------- 对外接口 ----------
window.__paintAB = {
  ready: false,
  variants: VARIANTS,
  get boatId() { return state.boatId; },
  boats: BOATS.map((b) => ({ id: b.id, name: b.name })),
  setBoat: async (id) => {
    const def = await loadBoat(id);
    applyVariant(state.variant, state.mode);
    return { id: def.id, name: def.name, meshes: paintTargets.length };
  },
  setVariant: (i, mode) => { applyVariant(i, mode); return VARIANTS[i].key; },
  dbg: () => {
    const b = new THREE.Box3().setFromObject(group);
    return {
      cam: camera.position.toArray().map((v) => +v.toFixed(2)),
      fov: camera.fov,
      box: [b.min.toArray().map((v) => +v.toFixed(2)), b.max.toArray().map((v) => +v.toFixed(2))],
      targets: paintTargets.length,
    };
  },
  shot: () => { renderer.render(scene, camera); return renderer.domElement.toDataURL('image/png'); },
  shotLabeled: (title, sub, hex) => {
    renderer.render(scene, camera);
    const BAR = 84;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H + BAR;
    const g = c.getContext('2d');
    g.fillStyle = '#0d1b24';
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(renderer.domElement, 0, 0);
    g.textBaseline = 'middle';
    let x = 28;
    if (hex) {
      g.fillStyle = hex;
      g.fillRect(x, H + BAR / 2 - 13, 26, 26);
      g.strokeStyle = 'rgba(255,255,255,.55)';
      g.lineWidth = 1.5;
      g.strokeRect(x, H + BAR / 2 - 13, 26, 26);
      x += 40;
    }
    g.fillStyle = '#ffd166';
    g.font = '700 27px "Microsoft YaHei", "PingFang SC", system-ui, sans-serif';
    g.fillText(title + (hex ? '  ' + hex.toUpperCase() : ''), x, H + BAR / 2);
    if (sub) {
      g.fillStyle = '#8fb7c8';
      g.font = '400 18px "Microsoft YaHei", "PingFang SC", system-ui, sans-serif';
      g.fillText(sub, W - 28 - g.measureText(sub).width, H + BAR / 2 + 1);
    }
    return c.toDataURL('image/png');
  },
};

(async () => {
  try {
    const def = await loadBoat(state.boatId);
    applyVariant(0, 'shader');
    window.__paintAB.ready = true;
    window.__paintABInfo = { ready: true, boat: def.id, meshes: paintTargets.length };
  } catch (e) {
    document.getElementById('hud').textContent = 'error: ' + (e.stack || e.message);
    window.__paintABInfo = { ready: false, error: String(e.stack || e.message) };
    console.error(e);
  }
})();

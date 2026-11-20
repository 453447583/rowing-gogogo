/**
 * 怪物动画查看器：逐个切换 GLB 内的所有动画 clip，并显示骨骼 / 特效挂点。
 * 直接由 index.html 通过 importmap 加载，无构建步骤。
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const $ = (s) => document.querySelector(s);

// ---------- 场景 ----------
const canvas = $('#cv');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14161c);
scene.fog = new THREE.Fog(0x14161c, 14, 34);

const camera = new THREE.PerspectiveCamera(38, 1, 0.05, 200);
camera.position.set(4.2, 3.0, 5.6);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, 1.6, 0);
controls.minDistance = 1.5;
controls.maxDistance = 30;
controls.maxPolarAngle = Math.PI * 0.92;

// 灯光
scene.add(new THREE.HemisphereLight(0xbcd4ff, 0x2a2118, 1.15));
const key = new THREE.DirectionalLight(0xffffff, 2.4);
key.position.set(5, 9, 6);
key.castShadow = true;
key.shadow.mapSize.set(1024, 1024);
key.shadow.camera.near = 0.5;
key.shadow.camera.far = 30;
const sc = 5;
Object.assign(key.shadow.camera, { left: -sc, right: sc, top: sc, bottom: -sc });
scene.add(key);
const rim = new THREE.DirectionalLight(0x88aaff, 1.0);
rim.position.set(-6, 4, -5);
scene.add(rim);
const fill = new THREE.DirectionalLight(0xffd7a8, 0.55);
fill.position.set(-2, 2, 7);
scene.add(fill);

// 地面 + 网格
const grid = new THREE.GridHelper(24, 24, 0x3a4356, 0x232a36);
grid.position.y = 0;
scene.add(grid);
const shadowPlane = new THREE.Mesh(
  new THREE.PlaneGeometry(40, 40),
  new THREE.ShadowMaterial({ opacity: 0.35 })
);
shadowPlane.rotation.x = -Math.PI / 2;
shadowPlane.receiveShadow = true;
scene.add(shadowPlane);

// ---------- 状态 ----------
const state = {
  gltf: null,
  mixer: null,
  actions: [],
  current: -1,
  playing: true,
  loop: true,
  speed: 1,
  autoRotate: false,
  showBones: false,
  wireframe: false,
  skeletonHelper: null,
  fxMarks: [],
};

const loader = new GLTFLoader();

// 候选路径：方便从不同根目录下打开都能取到模型
// ?model=/models/xxx.glb 可指定任意模型，默认回落到 crab.glb
const qsModel = new URLSearchParams(location.search).get('model');
const CANDIDATES = [
  ...(qsModel ? [qsModel] : []),
  '../../public/monsters/crab.glb',
  '/public/monsters/crab.glb',
  '/monsters/crab.glb',
  './crab.glb',
];

const CN = [
  [/idle|breath|stand/i, '待机'],
  [/walk|run|move/i, '移动'],
  [/attack|atk|bite|claw|hit/i, '近战攻击'],
  [/skill|cast|spell|shoot|fire/i, '技能释放'],
  [/block|guard|shield|defend/i, '格挡'],
  [/death|die|dead/i, '死亡'],
];
const cnOf = (n) => (CN.find(([re]) => re.test(n || '')) || [null, '动作'])[1];

function setStatus(msg, kind) {
  const el = $('#status');
  el.textContent = msg || '';
  el.dataset.kind = kind || '';
}

async function loadFirstAvailable() {
  for (const url of CANDIDATES) {
    try {
      const gltf = await new Promise((res, rej) => loader.load(url, res, undefined, rej));
      onLoaded(gltf, url);
      return;
    } catch (e) {
      /* 试下一个 */
    }
  }
  setStatus('没找到 crab.glb，把 .glb 文件拖进窗口即可查看', 'warn');
}

function clearModel() {
  if (state.skeletonHelper) {
    scene.remove(state.skeletonHelper);
    state.skeletonHelper.dispose?.();
    state.skeletonHelper = null;
  }
  state.fxMarks.forEach((m) => m.parent?.remove(m));
  state.fxMarks = [];
  if (state.gltf) {
    scene.remove(state.gltf.scene);
    state.gltf.scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((m) => {
          for (const k in m) {
            const v = m[k];
            if (v && v.isTexture) v.dispose();
          }
          m.dispose();
        });
      }
    });
  }
  if (state.mixer) {
    state.mixer.stopAllAction();
    state.mixer = null;
  }
  state.gltf = null;
  state.actions = [];
  state.current = -1;
}

function onLoaded(gltf, url) {
  clearModel();
  state.gltf = gltf;
  scene.add(gltf.scene);

  // 阴影 / 双面
  let tris = 0;
  let meshes = 0;
  let skinned = 0;
  gltf.scene.traverse((o) => {
    if (o.isMesh) {
      meshes++;
      o.castShadow = true;
      o.receiveShadow = true;
      const g = o.geometry;
      if (g?.index) tris += g.index.count / 3;
      else if (g?.attributes?.position) tris += g.attributes.position.count / 3;
      if (o.isSkinnedMesh) skinned++;
      state.gltf.scene.userData.wireTargets ||= [];
      state.gltf.scene.userData.wireTargets.push(o);
    }
  });

  // 骨骼统计
  let bones = 0;
  gltf.scene.traverse((o) => {
    if (o.isBone) bones++;
  });

  // 包围盒 → 相机与地面
  const box = computeBox();
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const h = size.y || 1;
  controls.target.set(center.x, center.y, center.z);
  camera.near = Math.max(0.01, h / 300);
  camera.far = h * 80;
  fitCamera(box, new THREE.Vector3(0.52, 0.3, 0.8).normalize());
  scene.fog.near = Math.max(h, size.x, size.z) * 4;
  scene.fog.far = Math.max(h, size.x, size.z) * 14;
  grid.position.y = box.min.y;
  shadowPlane.position.y = box.min.y + 0.002;

  // 特效挂点可视化（fx_ / socket / muzzle 这类空骨）
  gltf.scene.traverse((o) => {
    if (o.isBone && /^fx_|socket|muzzle|attach/i.test(o.name)) {
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(h * 0.022, 12, 10),
        new THREE.MeshBasicMaterial({ color: 0xff5a3c, depthTest: false, transparent: true, opacity: 0.9 })
      );
      m.renderOrder = 999;
      o.add(m);
      state.fxMarks.push(m);
    }
  });

  // 动画
  state.mixer = new THREE.AnimationMixer(gltf.scene);
  state.actions = (gltf.animations || []).map((clip) => {
    const a = state.mixer.clipAction(clip);
    a.clampWhenFinished = true;
    return a;
  });

  // 侧栏信息
  $('#meta').innerHTML = `
    <div><span>文件</span><b>${url.split('/').pop()}</b></div>
    <div><span>三角面</span><b>${Math.round(tris).toLocaleString()}</b></div>
    <div><span>网格 / 蒙皮</span><b>${meshes} / ${skinned}</b></div>
    <div><span>骨骼</span><b>${bones}</b></div>
    <div><span>动画</span><b>${state.actions.length} 个</b></div>
  `;

  renderClipList();
  if (state.actions.length) playClip(0);
  else setStatus('这个模型没有动画', 'warn');

  if (!state.skeletonHelper && bones) {
    state.skeletonHelper = new THREE.SkeletonHelper(gltf.scene);
    state.skeletonHelper.visible = state.showBones;
    state.skeletonHelper.material.linewidth = 2;
    scene.add(state.skeletonHelper);
  }
  setStatus(state.actions.length ? '' : '');

  // 调试钩子：排查取景/包围盒问题用，不影响正常使用
  window.__animViewer = {
    THREE, scene, camera, controls, state,
    bbox: () => {
      const lazy = new THREE.Box3().setFromObject(gltf.scene);
      const real = computeBox();
      return {
        lazy: lazy.getSize(new THREE.Vector3()).toArray().map((n) => +n.toFixed(3)),
        real: real.getSize(new THREE.Vector3()).toArray().map((n) => +n.toFixed(3)),
        realMin: real.min.toArray().map((n) => +n.toFixed(3)),
        realMax: real.max.toArray().map((n) => +n.toFixed(3)),
      };
    },
    cam: () => ({
      pos: camera.position.toArray(),
      target: controls.target.toArray(),
      dist: camera.position.distanceTo(controls.target),
      aspect: camera.aspect, fov: camera.fov,
      canvas: [canvas.clientWidth, canvas.clientHeight],
    }),
  };
}

function renderClipList() {
  const box = $('#clips');
  box.innerHTML = '';
  state.actions.forEach((a, i) => {
    const btn = document.createElement('button');
    btn.className = 'clip';
    btn.dataset.i = i;
    const d = a.getClip().duration;
    const ch = a.getClip().tracks.length;
    btn.innerHTML = `
      <em>${i + 1}</em>
      <span class="cname">${a.getClip().name}</span>
      <span class="ctag">${cnOf(a.getClip().name)}</span>
      <span class="cmeta">${d.toFixed(2)}s · ${ch} 通道</span>`;
    btn.onclick = () => playClip(i, true);
    box.appendChild(btn);
  });
  markActive();
}

function markActive() {
  document.querySelectorAll('.clip').forEach((b) => {
    b.classList.toggle('on', Number(b.dataset.i) === state.current);
  });
}

function playClip(i, restart) {
  if (i < 0 || i >= state.actions.length) return;
  const next = state.actions[i];
  if (state.current === i && !restart) return;
  const prev = state.actions[state.current];
  if (prev && prev !== next) prev.fadeOut(0.22);
  next.reset();
  next.setEffectiveTimeScale(state.speed);
  next.setLoop(state.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
  next.clampWhenFinished = true;
  next.fadeIn(0.22).play();
  state.current = i;
  state.playing = true;
  $('#play').textContent = '⏸ 暂停';
  $('#cur-clip').textContent = `${cnOf(next.getClip().name)} · ${next.getClip().name}`;
  markActive();
  setStatus('');
}

function nextClip() {
  const n = state.actions.length;
  playClip((state.current + 1) % n, true);
}

// ---------- UI 绑定 ----------
$('#play').onclick = () => {
  state.playing = !state.playing;
  $('#play').textContent = state.playing ? '⏸ 暂停' : '▶ 播放';
};

$('#loop').onchange = (e) => {
  state.loop = e.target.checked;
  if (state.current >= 0) playClip(state.current, true);
};

$('#speed').oninput = (e) => {
  state.speed = Number(e.target.value);
  $('#speedv').textContent = state.speed.toFixed(2) + '×';
  if (state.current >= 0) state.actions[state.current].setEffectiveTimeScale(state.speed);
};

$('#autorot').onchange = (e) => {
  state.autoRotate = e.target.checked;
  controls.autoRotate = state.autoRotate;
  controls.autoRotateSpeed = 1.6;
};

$('#bones').onchange = (e) => {
  state.showBones = e.target.checked;
  if (state.skeletonHelper) state.skeletonHelper.visible = state.showBones;
};

$('#wire').onchange = (e) => {
  state.wireframe = e.target.checked;
  const targets = state.gltf?.scene.userData.wireTargets || [];
  targets.forEach((o) => {
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    mats.forEach((m) => (m.wireframe = state.wireframe));
  });
};

$('#grid').onchange = (e) => {
  grid.visible = e.target.checked;
};

$('#next').onclick = nextClip;
$('#replay').onclick = () => state.current >= 0 && playClip(state.current, true);

// 视角预设 + 精确取景
const on = (id, fn) => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('click', fn);
};

/**
 * 模型真实包围盒。
 * 注意：Box3.setFromObject 默认走 geometry.boundingBox 缓存，在蒙皮网格上会算小
 * （实测 3.03m vs 真实 3.98m，导致相机凑太近、头盔被切），所以用 precise 模式
 * 逐顶点算，再把骨骼位置并进去兜底。
 */
function computeBox() {
  if (!state.gltf) return new THREE.Box3();
  // 必须先刷新世界矩阵：add() 之后立刻算，matrixWorld 还是旧的，
  // 会把包围盒算偏（实测取景中心差 0.8m，模型被切掉半个头）。
  state.gltf.scene.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(state.gltf.scene, true);
  const v = new THREE.Vector3();
  state.gltf.scene.traverse((o) => {
    if (o.isBone) b.expandByPoint(o.getWorldPosition(v));
  });
  return b;
}

/**
 * 按画布宽高比和 FOV 算相机距离，让模型整体刚好装进视锥。
 * 只按"最长边 × 系数"会把竖长的模型切头，所以纵向/横向分别算再取大值。
 */
function fitCamera(box, dir) {
  const w = canvas.clientWidth || 1;
  const hgt = canvas.clientHeight || 1;
  if (Math.abs(camera.aspect - w / hgt) > 1e-4) {
    camera.aspect = w / hgt;
    camera.updateProjectionMatrix();
  }
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const vFov = (camera.fov * Math.PI) / 180;
  const distV = size.y / 2 / Math.tan(vFov / 2);
  const distH = Math.max(size.x, size.z) / 2 / Math.tan(vFov / 2) / camera.aspect;
  const dist = Math.max(distV, distH) * 1.45;
  controls.target.copy(center);
  const d = (dir ? dir.clone() : camera.position.clone().sub(center)).normalize();
  camera.position.copy(center).addScaledVector(d, dist);
  controls.minDistance = Math.max(0.3, dist * 0.2);
  controls.maxDistance = dist * 4;
  camera.lookAt(center);
}

function setView(pos) {
  if (!state.gltf) return;
  fitCamera(computeBox(), new THREE.Vector3(pos[0], pos[1], pos[2]).normalize());
}
on('v-front', () => setView([0, 0.08, 1]));
on('v-side', () => setView([1, 0.08, 0]));
on('v-top', () => setView([0.05, 1, 0.05]));
on('v-45', () => setView([0.62, 0.35, 0.86]));

// 拖拽载入任意 glb
addEventListener('dragover', (e) => {
  e.preventDefault();
  document.body.classList.add('drag');
});
addEventListener('dragleave', () => document.body.classList.remove('drag'));
addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('drag');
  const f = e.dataTransfer.files?.[0];
  if (!f) return;
  const url = URL.createObjectURL(f);
  setStatus('载入中…');
  loader.load(
    url,
    (g) => {
      onLoaded(g, f.name);
      URL.revokeObjectURL(url);
    },
    undefined,
    (err) => setStatus('载入失败：' + (err?.message || err), 'warn')
  );
});

addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    e.preventDefault();
    $('#play').click();
  } else if (/^Digit[1-9]$/.test(e.code)) {
    playClip(Number(e.code.slice(5)) - 1, true);
  } else if (e.code === 'ArrowRight') {
    nextClip();
  }
});

// ---------- 渲染循环 ----------
const clock = new THREE.Clock();
const bar = $('#bar');
const timeEl = $('#time');

function resize() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== w * renderer.getPixelRatio() || canvas.height !== h * renderer.getPixelRatio()) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
}

function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.05);
  resize();
  if (state.mixer && state.playing) state.mixer.update(dt);
  if (state.skeletonHelper?.visible) state.skeletonHelper.update?.();
  controls.update();
  renderer.render(scene, camera);

  const a = state.actions[state.current];
  if (a) {
    const clip = a.getClip();
    const t = a.time % (clip.duration || 1);
    bar.style.width = ((t / (clip.duration || 1)) * 100).toFixed(1) + '%';
    timeEl.textContent = `${t.toFixed(2)} / ${clip.duration.toFixed(2)}s`;
  }
}

loadFirstAvailable();
tick();

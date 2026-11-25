import * as THREE from 'three';
import { createGLTFLoader } from '../game/gltfLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { getBoat } from '../data/boats.js';
import { measureModelBox } from '../game/modelBounds.js';

const modelCache = new Map();
function loadModel(url) {
  if (!modelCache.has(url)) {
    const loader = createGLTFLoader();
    modelCache.set(url, new Promise((resolve, reject) => loader.load(url, resolve, undefined, reject)));
  }
  return modelCache.get(url);
}

export class PodiumShowcase {
  constructor(container, entries = []) {
    this.container = container;
    this.entries = entries.slice(0, 3);
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x071d36);
    this.camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
    this.camera.position.set(0, 6.5, 14);
    this.camera.lookAt(0, 2.1, 0);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    container.innerHTML = '';
    container.appendChild(this.renderer.domElement);
    this.models = [];
    this.#buildScene();
    this.#resize();
    this.onResize = () => this.#resize();
    window.addEventListener('resize', this.onResize);
    this.running = true;
    this.#animate();
  }

  #buildScene() {
    this.scene.add(new THREE.HemisphereLight(0x9bdcff, 0x052039, 2.3));
    const key = new THREE.DirectionalLight(0xffe3b0, 3.2); key.position.set(-5, 10, 8); this.scene.add(key);
    const water = new THREE.Mesh(new THREE.PlaneGeometry(34, 24), new THREE.MeshStandardMaterial({ color: 0x0d76a1, metalness: 0.15, roughness: 0.2, transparent: true, opacity: 0.84 }));
    water.rotation.x = -Math.PI / 2; this.scene.add(water);
    const podiums = [{ x: 0, y: 1.25, w: 3.3, h: 2.5, color: 0xf0bf43 }, { x: -4.1, y: 0.8, w: 2.8, h: 1.6, color: 0xb9c8d3 }, { x: 4.1, y: 0.5, w: 2.8, h: 1.0, color: 0xbd754e }];
    for (const p of podiums) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(p.w, p.h, 2.8), new THREE.MeshStandardMaterial({ color: p.color, metalness: 0.45, roughness: 0.3 }));
      mesh.position.set(p.x, p.y, 0); this.scene.add(mesh);
      const trim = new THREE.Mesh(new THREE.BoxGeometry(p.w * 1.04, 0.12, 2.92), new THREE.MeshStandardMaterial({ color: 0x61e1ff, emissive: 0x1a8fb5, emissiveIntensity: 1.5 }));
      trim.position.set(p.x, p.y + p.h * 0.5, 0); this.scene.add(trim);
    }
    this.entries.forEach((entry, index) => this.#loadBoat(entry, index));
  }

  #loadBoat(entry, index) {
    const def = getBoat(entry.boatId);
    const holder = new THREE.Group();
    holder.position.set(index === 0 ? 0 : index === 1 ? -4.1 : 4.1, [2.55, 1.62, 1.1][index], 0);
    holder.rotation.y = index === 1 ? 0.28 : index === 2 ? -0.28 : 0;
    this.scene.add(holder); this.models[index] = holder;
    if (!def?.model) return;
    loadModel(def.model).then((gltf) => {
      if (!this.running) return;
      // 带蒙皮的角色模型必须用 SkeletonUtils 克隆，否则多人同款会共享骨骼
      const hasSkin = gltf.scene.getObjectByProperty('isSkinnedMesh', true) !== undefined;
      const model = hasSkin ? cloneSkinned(gltf.scene) : gltf.scene.clone(true);
      const size = measureModelBox(model).getSize(new THREE.Vector3());
      model.scale.setScalar(2.15 / Math.max(size.x, size.y, size.z, 1)); model.rotation.y = Math.PI;
      model.traverse((obj) => { if (obj.isMesh) { obj.castShadow = false; obj.receiveShadow = false; } });
      // 领奖台动作：带 dance 动作的角色（牛来号）在台上直接跳
      const danceName = def.anim?.dance;
      const clip = danceName ? gltf.animations?.find((c) => c.name === danceName) : null;
      if (clip) {
        const mixer = new THREE.AnimationMixer(model);
        const act = mixer.clipAction(clip);
        act.setLoop(THREE.LoopRepeat, Infinity);
        act.play();
        holder.userData.mixer = mixer;
      }
      holder.add(model);
    }).catch(() => {});
  }

  #resize() { const w = Math.max(1, this.container.clientWidth); const h = Math.max(1, this.container.clientHeight); this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); this.renderer.setSize(w, h, false); }
  #animate = () => {
    if (!this.running) return;
    requestAnimationFrame(this.#animate);
    const now = performance.now() * 0.001;
    const dt = Math.min(0.05, this.lastT ? now - this.lastT : 0.016);
    this.lastT = now;
    const t = now;
    for (const [i, model] of this.models.entries()) {
      if (!model) continue;
      model.position.y += (Math.sin(t * (1.2 + i * 0.18) + i) * 0.08 - (model.userData.wave || 0)) * 0.12;
      model.userData.wave = Math.sin(t * (1.2 + i * 0.18) + i) * 0.08;
      model.rotation.z = i === 0 ? Math.sin(t * 1.5) * 0.07 : i === 1 ? -0.08 + Math.sin(t * 1.1) * 0.025 : Math.sin(t * 0.75) * 0.11;
      model.userData.mixer?.update(dt);
    }
    this.renderer.render(this.scene, this.camera);
  };
  dispose() { this.running = false; window.removeEventListener('resize', this.onResize); this.renderer.dispose(); this.scene.traverse((obj) => { if (obj.isMesh) { obj.geometry.dispose(); if (obj.material) obj.material.dispose(); } }); this.container.innerHTML = ''; }
}

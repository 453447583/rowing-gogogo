// 深海龙宫的水下生态：把用户要的"海底景观"一次性补齐。
//
// 设计原则（针对"画面不用太精美，差不多就可以"）：
//   ① **零贴图**：全部靠几何 + flatShading + 自发光，进游戏不额外拉任何资源；
//   ② **合批优先**：鱼群/鲨鱼/水母/珊瑚/海藻全部走 InstancedMesh，
//      一个种类一次 draw call —— 水下已经有 400 多个 mesh，再逐个 add 会直接掉帧；
//   ③ **确定性**：位置全部用传进来的 rng()（LCG），不用 Math.random()，
//      否则每次进图珊瑚和沉船都会换地方，联机两端看到的布景也不一样；
//   ④ **纯装饰**：不写进 colliders。用户明确说"能穿过去也行，当装饰也行"，
//      而这条路线上已经有旋转门/活塞柱一堆碰撞体，再加水草碰撞只会让人莫名卡住。
//
// 分组：buildPalaceUndersea 只负责"摆"，每帧的动作统一在 updatePalaceUndersea 里，
// 这样 Environment#updatePalace 只需要多调一个函数，不用把动画散进 900 行的建场代码里。
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const SEABED = -14;

/** 把 x 轴朝向的鱼身拼成单个几何体，整条鲨鱼只占 1 次 draw call */
function fishGeometry(len, opts = {}) {
  const { bodyR = 0.16, nose = 0.55, dorsal = 0.55 } = opts;
  const parts = [];
  const body = new THREE.SphereGeometry(1, 10, 8);
  body.scale(len * 0.5, len * bodyR, len * bodyR * 0.82);
  parts.push(body);
  // 吻部：锥体朝 +X
  const snout = new THREE.ConeGeometry(len * bodyR * 0.82, len * nose * 0.42, 8);
  snout.rotateZ(-Math.PI / 2);
  snout.translate(len * (0.42 + nose * 0.16), 0, 0);
  parts.push(snout);
  // 尾鳍：上下两片扁锥
  for (const sgn of [1, -1]) {
    const tail = new THREE.ConeGeometry(len * 0.1, len * 0.34, 6);
    tail.scale(0.35, 1, 1);
    tail.rotateZ(-Math.PI / 2);
    tail.rotateX(sgn * 0.62);
    tail.translate(-len * 0.5, sgn * len * 0.06, 0);
    parts.push(tail);
  }
  // 背鳍
  const fin = new THREE.ConeGeometry(len * 0.075, len * dorsal * 0.42, 5);
  fin.scale(0.28, 1, 1);
  fin.rotateZ(-Math.PI / 7);
  fin.translate(-len * 0.04, len * bodyR * 0.95, 0);
  parts.push(fin);
  // 胸鳍
  for (const sgn of [1, -1]) {
    const p = new THREE.ConeGeometry(len * 0.05, len * 0.2, 5);
    p.scale(0.3, 1, 1);
    p.rotateZ(-Math.PI / 2);
    p.rotateX(sgn * 1.05);
    p.translate(len * 0.14, -len * bodyR * 0.2, sgn * len * bodyR * 0.85);
    parts.push(p);
  }
  const merged = mergeGeometries(parts, false);
  parts.forEach((g) => g.dispose());
  return merged;
}

/**
 * 搭水下生态。
 * @param {{group:THREE.Group, rng:()=>number, seabedY:(x:number,z:number)=>number, gateWidth:number}} ctx
 */
export function buildPalaceUndersea({ group, rng, seabedY, gateWidth = 12 }) {
  const life = {
    group: new THREE.Group(),
    jellies: null, jellyBells: null, jellyData: [],
    schools: [], sharks: null, sharkData: [],
    whale: null, whaleData: null,
    clams: [], kelp: [], surfaceTint: null, volcanoGlow: null,
  };
  life.group.name = 'palace-undersea';
  group.add(life.group);

  // ============ 1. 水母：半透明伞盖 + 内发光，成片悬在潜行区上方 ============
  // 伞盖用半球 + 一个倒锥裙边，两个 InstancedMesh 就够；颜色靠 instanceColor，
  // 一次 draw call 出十六只不同颜色的发光水母。
  {
    const N = 18;
    const capGeo = new THREE.SphereGeometry(1, 10, 7, 0, Math.PI * 2, 0, Math.PI * 0.56);
    const capMat = new THREE.MeshBasicMaterial({
      transparent: true, opacity: 0.42, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: true,
    });
    const caps = new THREE.InstancedMesh(capGeo, capMat, N);
    const skirtGeo = new THREE.ConeGeometry(0.86, 1.7, 9, 1, true);
    skirtGeo.translate(0, -0.85, 0);
    const skirtMat = new THREE.MeshBasicMaterial({
      transparent: true, opacity: 0.2, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: true,
    });
    const skirts = new THREE.InstancedMesh(skirtGeo, skirtMat, N);
    caps.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    skirts.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const palette = [0xff9ecb, 0x8ce8ff, 0xc79dff, 0x9dffd8, 0xffd79d];
    const col = new THREE.Color();
    // 沿两段潜行区（殿内 2→6、遗迹 9→12）各撒一半，保证水下一直有东西可看
    const lanes = [
      [[150, 100], [110, 135], [55, 145], [0, 130]],
      [[-150, -15], [-155, -65], [-120, -110], [-65, -130]],
    ];
    for (let i = 0; i < N; i++) {
      const lane = lanes[i % lanes.length];
      const seg = lane[Math.floor(rng() * (lane.length - 1))];
      const nxt = lane[lane.indexOf(seg) + 1] || seg;
      const k = rng();
      const bias = (rng() - 0.5) * (gateWidth * 2.6);
      const nx = -(nxt[1] - seg[1]);
      const nz = nxt[0] - seg[0];
      const nl = Math.hypot(nx, nz) || 1;
      life.jellyData.push({
        x: seg[0] + (nxt[0] - seg[0]) * k + (nx / nl) * bias,
        z: seg[1] + (nxt[1] - seg[1]) * k + (nz / nl) * bias,
        y: -3.2 - rng() * 5.5,
        scale: 1.5 + rng() * 1.9,
        phase: rng() * 6.28,
        rate: 0.5 + rng() * 0.5,
      });
      col.setHex(palette[i % palette.length]);
      caps.setColorAt(i, col);
      skirts.setColorAt(i, col);
    }
    if (caps.instanceColor) caps.instanceColor.needsUpdate = true;
    if (skirts.instanceColor) skirts.instanceColor.needsUpdate = true;
    caps.frustumCulled = false;
    skirts.frustumCulled = false;
    caps.visible = false;
    skirts.visible = false;
    life.group.add(caps, skirts);
    life.jellies = caps;
    life.jellyBells = skirts;
  }

  // ============ 2. 鲸鲨 + 鲨鱼：绕着潜行区巡游的大型剪影 ============
  // 鲸鲨 18m、鲨鱼 6.5m。它们的作用不是"看清细节"，而是在蓝雾里给一个
  // 尺度参照 —— 有东西从头顶慢慢游过去，水下才有"深"的感觉。
  {
    const whaleGeo = fishGeometry(18, { bodyR: 0.17, nose: 0.7, dorsal: 0.5 });
    const whaleMat = new THREE.MeshStandardMaterial({
      color: 0x3d6b84, roughness: 0.75, flatShading: true,
      emissive: 0x0d2434, emissiveIntensity: 0.6,
    });
    const whale = new THREE.Mesh(whaleGeo, whaleMat);
    whale.frustumCulled = false;
    whale.visible = false;
    // 位置每帧由 updatePalaceUndersea 直接写 matrix，关掉自动更新省一次 compose
    whale.matrixAutoUpdate = false;
    life.group.add(whale);
    life.whale = whale;
    life.whaleData = { cx: 60, cz: 40, r: 105, y: -9.5, speed: 3.4, phase: 0.4 };

    // 鲨鱼：3 条不同半径/高度/相位，用 InstancedMesh 合成一次 draw call
    const sharkGeo = fishGeometry(6.5, { bodyR: 0.15, nose: 0.6, dorsal: 0.7 });
    const sharkMat = new THREE.MeshStandardMaterial({
      color: 0x5d7385, roughness: 0.8, flatShading: true,
      emissive: 0x0a1a26, emissiveIntensity: 0.5,
    });
    const sharks = new THREE.InstancedMesh(sharkGeo, sharkMat, 3);
    sharks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    sharks.frustumCulled = false;
    sharks.visible = false;
    life.group.add(sharks);
    life.sharks = sharks;
    life.sharkData = [
      { cx: 120, cz: 115, r: 52, y: -6.5, speed: 5.2, phase: 1.1 },
      { cx: -110, cz: -85, r: 44, y: -8.0, speed: 6.0, phase: 3.4 },
      { cx: 20, cz: 40, r: 78, y: -11.0, speed: 4.4, phase: 5.0 },
    ];
  }

  // ============ 3. 热带鱼群：三团绕着珊瑚礁打转的小鱼 ============
  {
    const N = 3 * 16;
    const bodyGeo = new THREE.OctahedronGeometry(0.42, 0);
    bodyGeo.scale(1, 0.62, 0.34);
    const bodyMat = new THREE.MeshStandardMaterial({
      roughness: 0.55, flatShading: true, emissiveIntensity: 0.35,
    });
    const fish = new THREE.InstancedMesh(bodyGeo, bodyMat, N);
    const tailGeo = new THREE.OctahedronGeometry(0.3, 0);
    tailGeo.scale(0.7, 0.8, 0.18);
    const tails = new THREE.InstancedMesh(tailGeo, bodyMat, N);
    fish.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    tails.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    fish.frustumCulled = false;
    tails.frustumCulled = false;
    fish.visible = false;
    tails.visible = false;
    const palette = [0xffb347, 0xff7043, 0x54d6ff, 0xffe066, 0xff5fa2, 0x6effc4];
    const col = new THREE.Color();
    // 三团：殿前珊瑚礁、遗迹柱廊、开阔水域各一团
    const hubs = [
      { cx: 130, cz: 118, cy: -6, r: 16 },
      { cx: -128, cz: -92, cy: -7.5, r: 13 },
      { cx: 20, cz: 70, cy: -10, r: 22 },
    ];
    for (let i = 0; i < N; i++) {
      const hub = hubs[Math.floor(i / 16)];
      col.setHex(palette[Math.floor(rng() * palette.length)]);
      life.schools.push({
        hub,
        a: rng() * Math.PI * 2,
        rr: hub.r * (0.35 + rng() * 0.65),
        y: hub.cy + (rng() - 0.5) * 4,
        speed: (1.6 + rng() * 1.4) * (rng() > 0.5 ? 1 : -1),
        bob: rng() * 6.28,
        scale: 0.7 + rng() * 0.8,
      });
      fish.setColorAt(i, col);
      tails.setColorAt(i, col);
    }
    if (fish.instanceColor) fish.instanceColor.needsUpdate = true;
    if (tails.instanceColor) tails.instanceColor.needsUpdate = true;
    life.group.add(fish, tails);
    life.fish = fish;
    life.fishTails = tails;
  }

  // ============ 4. 发光巨蚌：张合的两片壳 + 中间一颗亮珍珠 ============
  {
    const N = 5;
    const shellGeo = new THREE.SphereGeometry(2.4, 12, 7, 0, Math.PI * 2, 0, Math.PI * 0.5);
    const shellMat = new THREE.MeshStandardMaterial({
      color: 0xe8d3b4, roughness: 0.62, flatShading: true,
      emissive: 0x4a3a5c, emissiveIntensity: 0.3, side: THREE.DoubleSide,
    });
    const pearlGeo = new THREE.SphereGeometry(0.62, 12, 10);
    const pearlMat = new THREE.MeshStandardMaterial({
      color: 0xfff4d6, emissive: 0xffd98a, emissiveIntensity: 2.2, roughness: 0.15,
    });
    const spots = [[138, 108], [-134, -86], [66, 146], [-96, -122], [12, 122]];
    for (let i = 0; i < N; i++) {
      const [x, z] = spots[Math.floor(i % spots.length)];
      const g = new THREE.Group();
      const lower = new THREE.Mesh(shellGeo, shellMat);
      lower.rotation.x = Math.PI;           // 下半壳朝上开口
      const upper = new THREE.Mesh(shellGeo, shellMat);
      const pearl = new THREE.Mesh(pearlGeo, pearlMat);
      pearl.position.y = 0.5;
      g.add(lower, upper, pearl);
      g.position.set(x + (rng() - 0.5) * 10, seabedY(x, z) + 0.7, z + (rng() - 0.5) * 10);
      g.rotation.y = rng() * 6.28;
      const s = 1.5 + rng() * 1.1;
      g.scale.setScalar(s);
      life.group.add(g);
      life.clams.push({ group: g, upper, phase: rng() * 6.28, rate: 0.35 + rng() * 0.3 });
    }
  }

  // ============ 5. 海藻：成片的细长叶片，随水流整体轻摆 ============
  // 用 InstancedMesh 一次出 72 片；摆动实现成"整片绕根部小角度偏航"，
  // 不做顶点弯曲（那要自定义 shader），远看已经够像水草在动。
  {
    const bladeGeo = new THREE.PlaneGeometry(1.5, 9, 1, 4);
    bladeGeo.translate(0, 4.5, 0);       // 原点移到根部，方便绕根旋转
    const mat = new THREE.MeshStandardMaterial({
      color: 0x2f8f6a, roughness: 0.95, flatShading: true,
      side: THREE.DoubleSide, emissive: 0x0a2b22, emissiveIntensity: 0.5,
    });
    const matB = mat.clone();
    matB.color.setHex(0x4fae7e);
    const N = 36;
    const beds = [
      { cx: 146, cz: 116, r: 22 }, { cx: -120, cz: -74, r: 20 },
      { cx: 28, cz: 134, r: 24 }, { cx: -60, cz: -128, r: 18 },
    ];
    for (const [mi, m] of [mat, matB].entries()) {
      const inst = new THREE.InstancedMesh(bladeGeo, m, N);
      inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      inst.frustumCulled = false;
      inst.visible = false;
      const dummy = new THREE.Object3D();
      for (let i = 0; i < N; i++) {
        const bed = beds[(i + mi) % beds.length];
        const a = rng() * Math.PI * 2;
        const rr = Math.sqrt(rng()) * bed.r;
        const x = bed.cx + Math.cos(a) * rr;
        const z = bed.cz + Math.sin(a) * rr;
        life.kelp.push({
          inst, index: i,
          x, z, y: seabedY(x, z),
          h: 0.7 + rng() * 0.9,
          lean: (rng() - 0.5) * 0.35,
          yaw: rng() * 6.28,
          phase: rng() * 6.28,
        });
      }
      life.group.add(inst);
    }
  }

  // ============ 6. 复古沉船：断成两截的木质船体 + 断桅 ============
  {
    const wreck = new THREE.Group();
    const wood = new THREE.MeshStandardMaterial({
      color: 0x4b3826, roughness: 0.95, flatShading: true,
      emissive: 0x140d06, emissiveIntensity: 0.6,
    });
    const woodDark = wood.clone();
    woodDark.color.setHex(0x2e2117);
    // 船体：侧倾 22° 斜插在沙里，前半截还连着，后半截断在不远处
    const hull = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 4.4, 17, 9, 1, true, 0, Math.PI), wood);
    hull.rotation.z = Math.PI / 2;
    hull.rotation.y = 0.2;
    hull.material.side = THREE.DoubleSide;
    wreck.add(hull);
    // 肋骨
    for (let i = -3; i <= 3; i++) {
      const rib = new THREE.Mesh(new THREE.TorusGeometry(3.5, 0.24, 4, 10, Math.PI), woodDark);
      rib.position.x = i * 2.4;
      rib.rotation.z = Math.PI / 2;
      wreck.add(rib);
    }
    // 断桅 + 残帆
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.42, 13, 7), woodDark);
    mast.position.set(2.5, 5.2, 0);
    mast.rotation.z = 0.42;
    wreck.add(mast);
    const sailMat = new THREE.MeshStandardMaterial({
      color: 0x8d8577, roughness: 1, side: THREE.DoubleSide,
      transparent: true, opacity: 0.72,
    });
    const sail = new THREE.Mesh(new THREE.PlaneGeometry(7, 5.4), sailMat);
    sail.position.set(4.4, 8.4, 0);
    sail.rotation.set(0.1, 0.5, 0.34);
    wreck.add(sail);
    // 后半截
    const stern = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 3.6, 9, 9, 1, true, 0, Math.PI), wood);
    stern.rotation.set(Math.PI / 2, 0, 1.9);
    stern.material.side = THREE.DoubleSide;
    stern.position.set(-11, 0.6, 3.4);
    wreck.add(stern);

    const wx = -34, wz = 96;
    wreck.position.set(wx, seabedY(wx, wz) + 2.6, wz);
    wreck.rotation.set(0.16, 0.9, 0.32);
    life.group.add(wreck);
    life.wreck = wreck;
  }

  // ============ 7. 远景海底火山：暗色锥体 + 发红岩浆口 + 上升热流 ============
  {
    const vg = new THREE.Group();
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(92, 74, 12, 3),
      new THREE.MeshStandardMaterial({ color: 0x232b33, roughness: 1, flatShading: true }),
    );
    cone.position.y = -18;
    vg.add(cone);
    // 火山口：一层自发光的橙红圆盘，水下看就是一条发亮的裂缝
    const crater = new THREE.Mesh(
      new THREE.CircleGeometry(26, 16),
      new THREE.MeshBasicMaterial({ color: 0xff7a3c, transparent: true, opacity: 0.85, fog: true }),
    );
    crater.rotation.x = -Math.PI / 2;
    crater.position.y = 19.6;
    vg.add(crater);
    // 热流：向上渐隐的锥体（加色混合），模拟岩浆柱被水压冲淡
    const plume = new THREE.Mesh(
      new THREE.CylinderGeometry(9, 26, 70, 10, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xff9a5c, transparent: true, opacity: 0.16,
        blending: THREE.AdditiveBlending, depthWrite: false,
        side: THREE.DoubleSide, fog: true,
      }),
    );
    plume.position.y = 52;
    vg.add(plume);
    const vx = 58, vz = 232;
    vg.position.set(vx, seabedY(vx, vz), vz);
    vg.visible = false;
    life.group.add(vg);
    life.volcano = vg;
    life.volcanoGlow = crater;
    life.volcanoPlume = plume;
  }

  // ============ 8. 石桥：横跨遗迹走廊的半圆拱 + 两根桥墩 ============
  {
    const bridge = new THREE.Group();
    const stone = new THREE.MeshStandardMaterial({
      color: 0x9a9386, roughness: 0.92, flatShading: true,
      emissive: 0x1b2430, emissiveIntensity: 0.35,
    });
    const stoneDark = stone.clone();
    stoneDark.color.setHex(0x74706a);
    const R = 26;
    const arch = new THREE.Mesh(new THREE.TorusGeometry(R, 1.5, 6, 18, Math.PI), stone);
    arch.position.y = 0;
    bridge.add(arch);
    for (const sx of [-1, 1]) {
      const pier = new THREE.Mesh(new THREE.CylinderGeometry(1.9, 2.6, 12, 8), stoneDark);
      pier.position.set(sx * R, -6, 0);
      bridge.add(pier);
    }
    // 桥面：沿拱顶铺几块石板
    for (let i = -2; i <= 2; i++) {
      const slab = new THREE.Mesh(new THREE.BoxGeometry(4.4, 0.6, 6), stoneDark);
      const a = (i / 2.4) * (Math.PI / 2) * 0.55;
      slab.position.set(Math.sin(a) * R * 0.02 + i * 4.2, R + Math.cos(a * 0.4) * 1.2, 0);
      bridge.add(slab);
    }
    // 遗迹段走廊中点：(-137, -87)，桥横跨方向与走廊垂直
    const bx = -137, bz = -87;
    bridge.position.set(bx, -16, bz);
    bridge.rotation.set(0, Math.atan2(-(-155 - -120), -(-15 - -110)), 0);
    life.group.add(bridge);
    life.bridge = bridge;
  }

  // ============ 9. 彩色珊瑚丛：给灰白沙地上色 ============
  {
    const geo = new THREE.IcosahedronGeometry(1, 0);
    const colors = [0xe07a63, 0x8f7cc8, 0xffb057, 0x4fb8a8];
    const beds = [[150, 104], [104, 140], [-146, -60], [-104, -118], [36, 128], [96, 118]];
    colors.forEach((hex, ci) => {
      const mat = new THREE.MeshStandardMaterial({
        color: hex, roughness: 0.78, flatShading: true,
        emissive: hex, emissiveIntensity: 0.12,
      });
      const N = 26;
      const inst = new THREE.InstancedMesh(geo, mat, N);
      inst.frustumCulled = false;
      inst.visible = false;
      const dummy = new THREE.Object3D();
      for (let i = 0; i < N; i++) {
        const bed = beds[(i + ci * 2) % beds.length];
        const a = rng() * Math.PI * 2;
        const rr = Math.sqrt(rng()) * 13;
        const x = bed[0] + Math.cos(a) * rr;
        const z = bed[1] + Math.sin(a) * rr;
        dummy.position.set(x, seabedY(x, z) + 0.6, z);
        dummy.rotation.set(rng() * 3, rng() * 6, rng() * 3);
        dummy.scale.set(0.7 + rng() * 1.1, 0.5 + rng() * 0.9, 0.7 + rng() * 1.1);
        dummy.updateMatrix();
        inst.setMatrixAt(i, dummy.matrix);
      }
      inst.instanceMatrix.needsUpdate = true;
      life.group.add(inst);
      life.coralBeds = life.coralBeds || [];
      life.coralBeds.push(inst);
    });
  }

  // ============ 10. 水面压暗层：从水下抬头看，水面不该是一片蓝天 ============
  // Water 是双面渲染的，从下面看就是一张亮蓝色的大图，读起来像"天空"。
  // 在 y=-0.55 铺一张跟着相机走的深色半透明面，把这片亮色压成水膜，
  // 这是让"水下感"立起来最便宜的一招（1 次 draw call，无 shader）。
  //
  // fog 必须开！第一版这里是 fog:false，结果这张 900×900 的面片在远处
  // 永远不变暗 —— 画面上半屏变成一块亮度均匀的蓝板，读起来还是"天空"。
  // 开雾之后它跟着水下雾一起衰减，近处是亮的水膜、远处沉进暗蓝，
  // 抬头就有了"越远越深"的梯度（这就是水下和天空最重要的区别）。
  {
    const tintGeo = new THREE.PlaneGeometry(900, 900);
    const tintMat = new THREE.MeshBasicMaterial({
      color: 0x0a3a52, transparent: true, opacity: 0,
      depthWrite: false, side: THREE.DoubleSide, fog: true,
    });
    const tint = new THREE.Mesh(tintGeo, tintMat);
    tint.rotation.x = -Math.PI / 2;
    tint.position.y = -0.55;
    tint.renderOrder = -1;
    tint.visible = false;
    life.group.add(tint);
    life.surfaceTint = tint;
  }

  // ============ 11. 白色雕花欧式宫殿 + 琉璃穹顶（只在第二段水下出现）============
  // 用户原始提示词里的那句："宏伟的海底水晶宫殿，白色雕花欧式建筑搭配琉璃穹顶，
  // 暖光从窗内透出"。第一段潜行（2→6，龙宫大殿）保持原样不动；这座宫殿只立在
  // 第二段潜行（9→12，亚特兰蒂斯遗迹）的走廊外侧 —— 深蓝水里一排暖黄窗光，
  // 是水下最抓眼的东西，也是"水下和天空"最容易区分的视觉锚点。
  //
  // ⚠️ 高度是硬约束：海面在 y=0、海床在 -14，所以整座建筑**从海床起最多 14m**。
  //    第一版按"大教堂"比例做到 30m，穹顶直接从水面穿出去，变成澡盆里泡的模型。
  //    现在总高 13.2m（穹顶尖 ≈ -1.1，刚好潜在水下），靠"横向铺开 + 柱廊节奏
  //    + 一圈暖窗"出体量，而不是靠高度。
  //
  // ⚠️ 点光源要挂在 life.group 上、不能挂进 palace：挂进 palace 的话，
  //    palace.visible=false 时灯光会一起被剔除，three 的 numPointLights 变化
  //    会触发全场材质重编译 —— 跑图中间卡一下就是这么来的。
  {
    const palace = new THREE.Group();
    palace.name = 'undersea-palace';
    palace.visible = false;

    // 白大理石：水下蓝雾里整片会压成灰蓝，给一档自发光才"白"得起来
    const marble = new THREE.MeshStandardMaterial({
      color: 0xe9e2d2, roughness: 0.62, metalness: 0.02,
      emissive: 0x2b2a26, emissiveIntensity: 0.18,
    });
    const marbleLite = new THREE.MeshStandardMaterial({
      color: 0xfaf5e8, roughness: 0.5, metalness: 0.02,
      emissive: 0x33312b, emissiveIntensity: 0.22,
    });
    const marbleDark = new THREE.MeshStandardMaterial({
      color: 0xb5afa2, roughness: 0.8, metalness: 0.0,
      emissive: 0x24231f, emissiveIntensity: 0.2,
    });
    const gold = new THREE.MeshStandardMaterial({
      color: 0xd8b16a, roughness: 0.3, metalness: 0.7,
      emissive: 0x6a4a14, emissiveIntensity: 0.9,
    });
    // 琉璃穹顶：半透明 + 自发光，从下往上看是"透光的琉璃"，不是一块白壳
    const glass = new THREE.MeshStandardMaterial({
      color: 0xbfe9f8, roughness: 0.1, metalness: 0.2,
      transparent: true, opacity: 0.46, side: THREE.DoubleSide,
      emissive: 0x2f86b0, emissiveIntensity: 1.15,
    });
    // 窗内暖光：不受光照影响（MeshBasic），只有雾衰减；远看就是一排暖黄的亮点。
    // ⚠️ 颜色必须饱和：第一版用 0xffcf8f 这种奶油色，穿进青蓝的水下色调里
    //    直接被冲成"黄绿色"，完全读不出"暖光从窗内透出"。用琥珀橙才压得住水色。
    // ⚠️ 水下的后处理会按 exp(-(1.62,0.58,0.20)*0.62) 吸收，红光只剩 36%、绿光 70%：
    //    任何橙色表面经过这一层都会变成黄绿，怎么调 hex 都调不出暖光。
    //    唯一能破的办法是走 HDR —— 合成器是 HalfFloat 缓冲，把颜色写到 1 以上，
    //    乘完吸收系数之后红色仍然是全场最高，出来才是真正的橙暖色。
    //    前提是 toneMapped=false：默认的色调映射会在材质里先把 >1 压回 0~1。
    const warm = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    warm.color.setRGB(1.6, 0.62, 0.16);
    const warmCore = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    warmCore.color.setRGB(2.5, 1.15, 0.38);
    const warmHalo = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.4, toneMapped: false,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    warmHalo.color.setRGB(1.25, 0.26, 0.03);

    const add = (geo, mat, x, y, z, ry = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.rotation.y = ry;
      palace.add(m);
      return m;
    };
    // 静态方块不合批的话，光这座宫殿就是 90+ 个 draw call（26 个齿饰、12 根壁柱、
    // 十几扇窗套……）。按材质攒成 3 个几何，最后各合并成 1 个 mesh。
    const batches = new Map();
    const box = (w, h, d, mat, x, y, z) => {
      const g = new THREE.BoxGeometry(w, h, d);
      g.translate(x, y, z);
      if (!batches.has(mat)) batches.set(mat, []);
      batches.get(mat).push(g);
    };

    // ---- 台基：两级石台 + 正面大台阶（高度 0 → 1.8）----
    box(60, 1.0, 36, marbleDark, 0, 0.5, 0);
    box(56, 1.0, 33, marble, 0, 1.4, 0);
    const PLAT = 1.8;
    for (let i = 0; i < 4; i++) {
      const h = 0.45;
      box(17 - i * 0.7, h, 1.75, marbleLite, 0, h * 0.5 + i * h, 18.2 + (3 - i) * 1.7);
    }

    // ---- 柱廊：正面 13 根 + 两侧各 4 根（合并成一个几何，一次 draw call）----
    const parts = [];
    const push = (g, y) => { g.translate(0, y, 0); parts.push(g); };
    push(new THREE.BoxGeometry(1.9, 0.32, 1.9), 0.16);                     // 柱础方座
    push(new THREE.CylinderGeometry(1.02, 1.14, 0.42, 12), 0.53);          // 柱脚圆盘
    push(new THREE.CylinderGeometry(0.6, 0.78, 4.7, 14), 0.6 + 2.35);      // 柱身（上细下粗）
    push(new THREE.CylinderGeometry(0.72, 0.6, 0.26, 14), 5.43);           // 柱颈线
    push(new THREE.BoxGeometry(1.62, 0.36, 1.62), 5.74);                   // 科林斯柱头
    push(new THREE.BoxGeometry(1.92, 0.24, 1.92), 6.04);                   // 顶板
    // 涡卷：柱头四角两对小卷（"雕花"最省的表达，远看就是柱头有细节）
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
    const COL_H = 4.93;              // = 6.16 × 0.8，柱身按比例压矮（见下面的 d.scale）
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
    const COL_TOP = PLAT + COL_H;   // 7.96

    // ---- 殿身：主体块 + 檐部 + 檐口 ----
    box(34, COL_TOP + 0.9 - PLAT, 14, marble, 0, (PLAT + COL_TOP + 0.9) / 2, 0);
    // 柱廊与窗之间的深色凹壁：没有这层，13 根柱 + 白墙糊成一片白，柱间读不出进深
    box(34.4, 6.8, 0.5, marbleDark, 0, PLAT + 3.4, 8.25);
    box(45, 1.05, 30, marble, 0, COL_TOP + 0.52, 0);          // 额枋/檐壁
    box(47, 0.46, 31.6, marbleLite, 0, COL_TOP + 1.28, 0);    // 檐口压顶
    const ROOF = COL_TOP + 1.51;                              // 9.47
    // 檐壁上的齿饰（dentil）：一排小方块，远看是"雕花檐口"的明暗节奏
    for (let i = 0; i < 26; i++) {
      box(0.62, 0.42, 0.5, marbleLite, -22.5 + i * 1.8, COL_TOP + 0.52, 14.9);
    }

    // ---- 正面断山花：两侧各一段三角楣，中间断开让穹顶露出来 ----
    // 完整三角楣会把穹顶整块挡住（山花顶 12.6 vs 穹顶尖 13.4，低角度看就是一条平檐）。
    // 巴洛克常见的断山花正好解决这个：中间让开，琉璃穹顶从缺口里升出来。
    {
      for (const sx of [-1, 1]) {
        const x0 = sx * 23, x1 = sx * 9.0, xm = sx * 16.0;
        const shape = new THREE.Shape();
        // 顶点顺序统一成逆时针，否则 ExtrudeGeometry 出来的正面朝里，从外面看是空的
        shape.moveTo(Math.min(x0, x1), 0);
        shape.lineTo(Math.max(x0, x1), 0);
        shape.lineTo(xm, 1.8);
        shape.closePath();
        const geo = new THREE.ExtrudeGeometry(shape, { depth: 1.8, bevelEnabled: false });
        geo.translate(0, 0, -0.9);
        const m = add(geo, marbleLite, 0, ROOF, 13.6);
        m.frustumCulled = false;
        // 缺口两侧的金色涡卷压顶
        add(new THREE.TorusGeometry(0.8, 0.15, 4, 10, Math.PI), gold, sx * 9.3, ROOF + 0.28, 14.5);
      }
    }

    // ---- 窗：殿身正面 5 扇弓形窗 + 中央大门（暖光从窗内透出）----
    const arched = (w, h) => {
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.PlaneGeometry(w, h), warm);
      body.position.y = h / 2;
      const arc = new THREE.Mesh(new THREE.CircleGeometry(w / 2, 14, 0, Math.PI), warm);
      arc.position.y = h;
      // 内芯：比窗框更亮的一层，读起来像屋里点着灯，而不是贴了一块橙色纸
      const core = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.6, h * 0.76), warmCore);
      core.position.set(0, h * 0.5, 0.02);
      const halo = new THREE.Mesh(new THREE.PlaneGeometry(w * 1.9, (h + w / 2) * 1.4), warmHalo);
      halo.position.set(0, (h + w / 2) * 0.5, 0.06);
      g.add(halo, body, arc, core);
      return g;
    };
    const winZ = 8.56;
    for (const x of [-12.4, -6.2, 6.2, 12.4]) {
      const wgrp = arched(2.0, 3.4);
      wgrp.position.set(x, PLAT + 1.3, winZ);
      palace.add(wgrp);
      // 窗棂（十字）+ 窗套
      box(0.18, 4.2, 0.14, marbleDark, x, PLAT + 2.9, winZ + 0.06);
      box(2.3, 0.18, 0.14, marbleDark, x, PLAT + 2.4, winZ + 0.06);
      box(0.34, 4.6, 0.3, marbleLite, x - 1.24, PLAT + 2.35, winZ + 0.02);
      box(0.34, 4.6, 0.3, marbleLite, x + 1.24, PLAT + 2.35, winZ + 0.02);
    }
    // 中央大门：两层拱 + 门洞里透出的暖光
    {
      const door = arched(4.2, 4.2);
      door.position.set(0, PLAT + 0.1, winZ - 0.02);
      palace.add(door);
      for (const sx of [-1, 1]) {
        box(0.55, 6.0, 0.5, marbleLite, sx * 2.55, PLAT + 3.0, winZ + 0.05);
      }
      box(6.2, 0.5, 0.5, marbleLite, 0, PLAT + 6.0, winZ + 0.05);
      // 门头半圆拱券（一瓣环，做出"券脸"）
      const ring = new THREE.Mesh(new THREE.TorusGeometry(2.8, 0.28, 5, 14, Math.PI), marbleLite);
      ring.position.set(0, PLAT + 4.3, winZ + 0.05);
      palace.add(ring);
    }
    // 壁柱（殿身正面）：把 5 扇窗隔开，正面才有"分间"的节奏
    for (const x of [-17.4, -9.3, -3.1, 3.1, 9.3, 17.4]) {
      box(1.0, 5.6, 0.7, marbleLite, x, PLAT + 3.0, winZ + 0.1);
      box(1.3, 0.35, 1.0, marbleLite, x, PLAT + 5.85, winZ + 0.1);
    }

    // ---- 两侧角亭：小方块 + 小穹顶 + 圆窗，撑开横向体量 ----
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

    // ---- 中央琉璃穹顶：鼓座 + 扁穹顶 + 8 根金色肋 ----
    {
      const DRUM_R = 7.8, DRUM_Y = ROOF + 0.55, DRUM_H = 1.1;
      const DOME_SQUASH = 0.38;          // 扁穹顶：压扁才不会顶穿水面（见本节顶部的高度约束）
      const drum = add(new THREE.CylinderGeometry(DRUM_R, DRUM_R + 0.25, DRUM_H, 22), marble, 0, DRUM_Y, 0);
      drum.frustumCulled = false;
      // 鼓座一圈暖窗：这是"琉璃穹顶透出暖光"最关键的一圈
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
      // 穹顶内侧的一层暖光壳（加色），让"琉璃"从里往外发亮，而不是一块冷玻璃
      const inner = add(
        new THREE.SphereGeometry(DRUM_R * 0.94, 22, 12, 0, Math.PI * 2, 0, Math.PI / 2),
        warmHalo.clone(), 0, domeBase, 0,
      );
      inner.material.opacity = 0.16;
      inner.scale.y = DOME_SQUASH;
      inner.frustumCulled = false;
      // 8 根金肋：四分之一圆环 = 一条穹顶经线，绕 Y 转 8 份
      for (let k = 0; k < 8; k++) {
        const rib = new THREE.Mesh(new THREE.TorusGeometry(DRUM_R, 0.14, 4, 16, Math.PI / 2), gold);
        rib.position.set(0, domeBase, 0);
        rib.rotation.y = (k / 8) * Math.PI * 2;
        rib.scale.y = DOME_SQUASH;
        rib.frustumCulled = false;
        palace.add(rib);
      }
      // 顶饰（宝顶）：小圆球 + 细尖，压在穹顶尖下面 0.2m，不出水面
      add(new THREE.SphereGeometry(0.46, 10, 8), gold, 0, domeBase + DRUM_R * DOME_SQUASH - 0.1, 0);
    }

    // ---- 把攒下来的方块按材质各合并成一个 mesh（3 个 draw call 撑完整座宫殿）----
    for (const [mat, geos] of batches) {
      const merged = mergeGeometries(geos, false);
      geos.forEach((g) => g.dispose());
      const mesh = new THREE.Mesh(merged, mat);
      mesh.frustumCulled = false;
      palace.add(mesh);
    }
    batches.clear();

    // ---- 定位：第二段潜行走廊（-155,-65 → -120,-110）外侧 46m，正面朝走廊 ----
    const PX = -178, PZ = -110;
    const seat = seabedY(PX, PZ);
    palace.position.set(PX, seat, PZ);
    // 朝向走廊最近点（约 -141,-83），让柱廊正面正对来车方向
    palace.rotation.y = Math.atan2(-141 - PX, -83 - PZ);
    life.group.add(palace);
    life.palace = palace;
    life.palaceCenter = new THREE.Vector3(PX, seat, PZ);

    // 暖光：两盏距离有限的点光，挂在 life.group 上（见上面的重编译说明）。
    // 距离 60~70m，出了水面段就影响不到任何东西，也不会照亮第一段潜行区。
    const lampA = new THREE.PointLight(0xffb066, 62, 78, 2);
    lampA.position.set(PX + Math.sin(palace.rotation.y) * 8, seat + 5.4, PZ + Math.cos(palace.rotation.y) * 8);
    const lampB = new THREE.PointLight(0xffd9a8, 34, 46, 2);
    lampB.position.set(PX, seat + 10.6, PZ);
    life.group.add(lampA, lampB);
    life.palaceLights = [lampA, lampB];
  }

  return life;
}

const _dummy = new THREE.Object3D();

/** 每帧动作。@param {number} uw 水下程度 0~1（由 Environment 传入）*/
export function updatePalaceUndersea(life, t, dt, camera, uw = 0) {
  if (!life) return;
  const on = uw > 0.35;
  // 水下才显示：水面阶段这些布景全在海床附近，看不见还白吃一次视锥剔除
  for (const key of ['jellies', 'jellyBells', 'sharks', 'fish', 'fishTails', 'volcano', 'surfaceTint']) {
    if (life[key]) life[key].visible = on;
  }
  for (const inst of life.coralBeds || []) inst.visible = uw > 0.2;
  for (const k of life.kelp) k.inst.visible = uw > 0.2;
  for (const c of life.clams) c.group.visible = uw > 0.2;
  if (life.wreck) life.wreck.visible = uw > 0.2;
  if (life.bridge) life.bridge.visible = uw > 0.2;
  // 白色欧式宫殿只属于第二段潜行区（亚特兰蒂斯遗迹）。第一段潜行（龙宫大殿）
  // 必须保持原样，所以这里再叠一层"离得近才显示"：相机在两段之间/第一段时
  // 距离 palaceCenter 三百米开外，整组直接隐藏，连远景雾里那点暖光都不会漏。
  if (life.palace) {
    const near = !camera || camera.position.distanceTo(life.palaceCenter) < 190;
    life.palace.visible = uw > 0.2 && near;
  }
  if (!on) return;

  // 水面压暗层：跟着相机走，避免 900×900 的面片边缘被看到
  if (life.surfaceTint && camera) {
    life.surfaceTint.position.x = camera.position.x;
    life.surfaceTint.position.z = camera.position.z;
    life.surfaceTint.material.opacity = 0.16 * uw;
  }

  // 水母：上下浮沉 + 缓慢自转 + 伞盖一鼓一缩
  if (life.jellies) {
    life.jellyData.forEach((j, i) => {
      const pulse = 1 + 0.12 * Math.sin(t * 1.6 * j.rate + j.phase);
      const y = j.y + Math.sin(t * 0.55 * j.rate + j.phase) * 0.9;
      _dummy.position.set(j.x, y, j.z);
      _dummy.rotation.set(0, t * 0.12 * j.rate + j.phase, 0);
      _dummy.scale.set(j.scale * pulse, j.scale * (2 - pulse) * 0.9, j.scale * pulse);
      _dummy.updateMatrix();
      life.jellies.setMatrixAt(i, _dummy.matrix);
      _dummy.position.y = y - j.scale * 0.55;
      _dummy.scale.set(j.scale * pulse * 0.95, j.scale * 1.1, j.scale * pulse * 0.95);
      _dummy.updateMatrix();
      life.jellyBells.setMatrixAt(i, _dummy.matrix);
    });
    life.jellies.instanceMatrix.needsUpdate = true;
    life.jellyBells.instanceMatrix.needsUpdate = true;
  }

  // 鲸鲨 / 鲨鱼：圆形巡游，朝向取切线
  const cruise = (d) => {
    const a = d.phase + (t * d.speed) / d.r;
    const x = d.cx + Math.cos(a) * d.r;
    const z = d.cz + Math.sin(a) * d.r;
    // 切线方向 (-sin, cos)
    const dx = -Math.sin(a);
    const dz = Math.cos(a);
    _dummy.position.set(x, d.y + Math.sin(t * 0.4 + d.phase) * 0.8, z);
    _dummy.rotation.set(0, Math.atan2(-dz, dx), Math.sin(t * 0.7 + d.phase) * 0.06);
    _dummy.scale.setScalar(1);
    _dummy.updateMatrix();
    return _dummy.matrix;
  };
  if (life.whale) {
    life.whale.matrix.copy(cruise(life.whaleData));
    life.whale.matrixWorldNeedsUpdate = true;
  }
  if (life.sharks) {
    life.sharkData.forEach((d, i) => life.sharks.setMatrixAt(i, cruise(d)));
    life.sharks.instanceMatrix.needsUpdate = true;
  }

  // 鱼群：绕各自的礁盘打转 + 上下轻浮
  if (life.fish) {
    life.schools.forEach((f, i) => {
      const a = f.a + (t * f.speed) / Math.max(4, f.rr);
      const x = f.hub.cx + Math.cos(a) * f.rr;
      const z = f.hub.cz + Math.sin(a) * f.rr;
      const dir = Math.sign(f.speed) || 1;
      const dx = -Math.sin(a) * dir;
      const dz = Math.cos(a) * dir;
      const yaw = Math.atan2(-dz, dx);
      const y = f.y + Math.sin(t * 1.9 + f.bob) * 0.5;
      _dummy.position.set(x, y, z);
      _dummy.rotation.set(0, yaw, Math.sin(t * 3 + f.bob) * 0.1);
      _dummy.scale.setScalar(f.scale);
      _dummy.updateMatrix();
      life.fish.setMatrixAt(i, _dummy.matrix);
      // 尾鳍跟着身体，稍微落后一点并左右摆
      _dummy.position.x -= Math.cos(yaw) * 0.55 * f.scale;
      _dummy.position.z += Math.sin(yaw) * 0.55 * f.scale;
      _dummy.rotation.y = yaw + Math.sin(t * 7 + f.bob) * 0.3;
      _dummy.updateMatrix();
      life.fishTails.setMatrixAt(i, _dummy.matrix);
    });
    life.fish.instanceMatrix.needsUpdate = true;
    life.fishTails.instanceMatrix.needsUpdate = true;
  }

  // 巨蚌张合
  for (const c of life.clams) {
    const open = 0.18 + 0.5 * (0.5 + 0.5 * Math.sin(t * c.rate + c.phase));
    c.upper.rotation.x = -open;
  }

  // 海藻：绕根部小角度整体摆动（yaw + lean），不做弯曲
  for (const k of life.kelp) {
    const sway = Math.sin(t * 0.8 + k.phase) * 0.16;
    _dummy.position.set(k.x, k.y - 0.4, k.z);
    _dummy.rotation.set(k.lean + sway * 0.5, k.yaw + sway, sway * 0.7);
    _dummy.scale.set(1, k.h, 1);
    _dummy.updateMatrix();
    k.inst.setMatrixAt(k.index, _dummy.matrix);
  }
  for (const inst of new Set(life.kelp.map((k) => k.inst))) inst.instanceMatrix.needsUpdate = true;

  // 火山：岩浆口呼吸 + 热流缓慢上飘
  if (life.volcanoGlow) {
    life.volcanoGlow.material.opacity = 0.6 + 0.28 * Math.sin(t * 0.9);
  }
  if (life.volcanoPlume) {
    life.volcanoPlume.material.opacity = 0.1 + 0.07 * Math.sin(t * 0.6 + 1.2);
    life.volcanoPlume.scale.y = 1 + 0.06 * Math.sin(t * 0.5);
  }

  // 宫殿暖光：轻微呼吸（像殿里有人走动），不要规则闪烁 —— 规则闪会像故障灯
  if (life.palaceLights) {
    life.palaceLights[0].intensity = 58 + Math.sin(t * 1.3) * 8 + Math.sin(t * 3.1) * 3;
    life.palaceLights[1].intensity = 32 + Math.sin(t * 0.9 + 1.7) * 6;
  }
}

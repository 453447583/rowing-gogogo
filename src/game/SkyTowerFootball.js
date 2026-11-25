import * as THREE from 'three';
import { SKY_TOWER, layerY } from '../data/skyTowerRun.js';
import { makeRockMaterial } from './Textures.js';
import { boatCollisionRadius } from './boatContact.js';
import { boatCollisionMass } from '../data/boats.js';
import { createBallState, resetBall, stepBall, BALL_PHYS } from './skyTowerBall.js';

/**
 * 第 1 层：水球赛（球 + 球门 + 障碍）。
 *
 * 场地：100×62 的矩形球场直接铺在第一层的玻璃盘上（对角 58.8m，盘半径 82m，余量充足）。
 * 三套边界，别混：
 *   ① 球场边线 = 能量围板：**只挡球不挡船**，球被关在球场里；
 *   ② 玻璃盘边缘 = 掉落线：船冲出去就落海（老逻辑，aren.constrain 管）；
 *   ③ 球门缺口：门柱之间的围板断开，球心越过门线即得分。
 *
 * 障碍（熔岩柱 / 礁石）用确定性种子生成：两端各自算同一份布局，
 * 不需要联机同步位置，只要同步球。
 *
 * 手感数值全在 data/skyTowerRun.js 的 FOOTBALL 与 game/skyTowerBall.js 的 BALL_PHYS。
 */

const C = SKY_TOWER.FOOTBALL;

/** 确定性随机（mulberry32）：同一 seed 在任何端都出同一份障碍布局 */
function mulberry32(a) {
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const lerpRange = (rng, [a, b]) => a + (b - a) * rng();

export class SkyTowerFootball {
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.opts = opts;
    this.layer = C.LAYER;
    this.deckY = layerY(this.layer) + 0.30;      // 玻璃盘顶面（SkyTowerScenery: disk.position.y = 0.30）
    this.fx = opts.fx || null;
    this.authority = opts.authority !== false;   // 房主（或单人）跑物理，客机只插值
    this.onGoal = opts.onGoal || (() => {});
    this.onEvent = opts.onEvent || (() => {});

    this.group = new THREE.Group();
    this.group.name = 'sky-tower-football';
    scene.add(this.group);

    this.ball = createBallState(0, 0);
    this.resetTimer = 0;
    this.kickoffLock = 0;
    this.remote = null;
    this.goals = new Map();       // id → 本层进球数
    this.fxCd = { boat: 0, obstacle: 0, board: 0, post: 0 };
    this.elapsed = 0;

    this.obstacles = [];
    this.#buildPitch();
    this.#buildBoards();
    this.#buildGoals();
    this.#buildObstacles(opts.colliders);
    this.#buildBall();
  }

  // ---------------------------------------------------------------- 场地

  /** 球场涂装：白线、中圈、禁区。全部用薄盒 + polygonOffset，避免和玻璃面 z-fighting */
  #buildPitch() {
    const lineMat = new THREE.MeshBasicMaterial({
      color: 0xdff6ff, transparent: true, opacity: 0.42,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
    });
    const y = this.deckY + 0.012;
    const W = 0.22;
    const g = this.group;

    // 场内一层极淡的青色：玻璃要透（这是天梯的特性），但没有底色的话
    // 白线在玻璃格子上完全读不出"这是一块球场"，远处看就是一块空盘子。
    const turf = new THREE.Mesh(
      new THREE.PlaneGeometry(C.HALF_L * 2 - 0.4, C.HALF_W * 2 - 0.4),
      new THREE.MeshBasicMaterial({
        color: 0x7fd8e8, transparent: true, opacity: 0.075, depthWrite: false,
      }),
    );
    turf.rotation.x = -Math.PI / 2;
    turf.position.set(0, this.deckY + 0.006, 0);
    g.add(turf);

    const line = (x, z, w, d) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.02, d), lineMat);
      m.position.set(x, y, z);
      g.add(m);
      return m;
    };
    // 四条边线（压住围板内侧，让"边线=墙"读得出来）
    line(0, -C.HALF_W, C.HALF_L * 2, W);
    line(0, C.HALF_W, C.HALF_L * 2, W);
    line(-C.HALF_L, 0, W, C.HALF_W * 2);
    line(C.HALF_L, 0, W, C.HALF_W * 2);
    // 中线 + 中圈
    line(0, 0, W, C.HALF_W * 2);
    const circle = new THREE.Mesh(new THREE.TorusGeometry(9, 0.16, 6, 64), lineMat);
    circle.rotation.x = Math.PI / 2;
    circle.position.set(0, y, 0);
    g.add(circle);
    const spot = new THREE.Mesh(
      new THREE.CylinderGeometry(0.45, 0.45, 0.02, 16),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, depthWrite: false }),
    );
    spot.position.set(0, y, 0);
    g.add(spot);
    // 两侧禁区（16.5m 深 × 40m 宽，按真实比例缩过，别让小禁区把门前挤满）
    for (const s of [-1, 1]) {
      const bx = s * (C.HALF_L - 11);
      line(bx, 0, W, 34);
      line(s * C.HALF_L, 17, 11, W);
      line(s * C.HALF_L, -17, 11, W);
    }
    // 中圈外的一圈淡色光带：给"开球点"一点存在感
    const halo = new THREE.Mesh(
      new THREE.RingGeometry(9.6, 10.6, 64),
      new THREE.MeshBasicMaterial({
        color: 0x8fe4ff, transparent: true, opacity: 0.10,
        side: THREE.DoubleSide, depthWrite: false,
      }),
    );
    halo.rotation.x = -Math.PI / 2;
    halo.position.set(0, y + 0.001, 0);
    g.add(halo);
  }

  /** 能量围板：两端各两段（中间留门洞），两侧各一整段。只挡球，船能直接开出去 */
  #buildBoards() {
    const mat = new THREE.MeshBasicMaterial({
      color: 0x7fe3ff, transparent: true, opacity: 0.20,
      side: THREE.DoubleSide, depthWrite: false,
    });
    const edgeMat = new THREE.MeshBasicMaterial({
      color: 0xcdf7ff, transparent: true, opacity: 0.7, depthWrite: false,
    });
    const y = this.deckY + C.BOARD_H / 2;
    const segH = C.BOARD_H;
    const addSeg = (x, z, len, rotY) => {
      const seg = new THREE.Mesh(new THREE.BoxGeometry(len, segH, 0.22), mat);
      seg.position.set(x, y, z);
      seg.rotation.y = rotY;
      this.group.add(seg);
      // 顶端亮边：一条极细的发光条，让"这里有墙"在远处也看得见
      const top = new THREE.Mesh(new THREE.BoxGeometry(len, 0.10, 0.30), edgeMat);
      top.position.set(x, this.deckY + segH, z);
      top.rotation.y = rotY;
      this.group.add(top);
    };
    // 两侧边线（沿 x 方向）
    addSeg(0, -C.HALF_W, C.HALF_L * 2, 0);
    addSeg(0, C.HALF_W, C.HALF_L * 2, 0);
    // 两端：球门两侧各一段（沿 z 方向）
    const wingLen = C.HALF_W - C.GOAL_W / 2;
    const wingZ = C.GOAL_W / 2 + wingLen / 2;
    for (const s of [-1, 1]) {
      addSeg(s * C.HALF_L, wingZ, wingLen, Math.PI / 2);
      addSeg(s * C.HALF_L, -wingZ, wingLen, Math.PI / 2);
    }
  }

  /** 球门：门柱 + 横梁 + 网格（LineSegments 手搓，不用贴图也不用 GridHelper 的方形限制） */
  #buildGoals() {
    const frameMat = new THREE.MeshStandardMaterial({
      color: 0xeafcff, roughness: 0.35, metalness: 0.25,
      emissive: 0x2a6f8a, emissiveIntensity: 0.6,
    });
    const netMat = new THREE.LineBasicMaterial({
      color: 0x9ff5ff, transparent: true, opacity: 0.42,
    });
    this.netMat = netMat;
    this.goalNets = [];
    const postGeo = new THREE.CylinderGeometry(C.POST_R, C.POST_R, C.GOAL_H, 10);
    const barGeo = new THREE.CylinderGeometry(C.POST_R, C.POST_R, C.GOAL_W, 10);

    for (const s of [-1, 1]) {
      const g = new THREE.Group();
      const x = s * C.HALF_L;
      for (const zs of [-1, 1]) {
        const post = new THREE.Mesh(postGeo, frameMat);
        post.position.set(x, this.deckY + C.GOAL_H / 2, zs * C.GOAL_W / 2);
        g.add(post);
      }
      const bar = new THREE.Mesh(barGeo, frameMat);
      bar.rotation.x = Math.PI / 2;
      bar.position.set(x, this.deckY + C.GOAL_H, 0);
      g.add(bar);
      // 后网 + 两张侧网：门后 3m 的空间，视觉上把门"框住"
      const depth = 3;
      const back = this.#makeNet(C.GOAL_W, C.GOAL_H, 8, 4);
      back.position.set(x + s * depth, this.deckY + C.GOAL_H / 2, 0);
      back.rotation.y = Math.PI / 2;
      g.add(back);
      for (const zs of [-1, 1]) {
        const side = this.#makeNet(depth, C.GOAL_H, 2, 4);
        side.position.set(x + s * depth / 2, this.deckY + C.GOAL_H / 2, zs * C.GOAL_W / 2);
        g.add(side);
      }
      // 门线发光条：进球判定就发生在这一条上
      const gl = new THREE.Mesh(
        new THREE.BoxGeometry(0.5, 0.03, C.GOAL_W),
        new THREE.MeshBasicMaterial({
          color: s > 0 ? 0xff9a5e : 0x6fd8ff, transparent: true, opacity: 0.5, depthWrite: false,
        }),
      );
      gl.position.set(x, this.deckY + 0.02, 0);
      g.add(gl);
      g.userData.lineMat = gl.material;
      // 门洞里的地面光斑：远处一眼能看出"这块是要攻的门"
      const mouth = new THREE.Mesh(
        new THREE.PlaneGeometry(4, C.GOAL_W),
        new THREE.MeshBasicMaterial({
          color: s > 0 ? 0xffb070 : 0x8fe4ff, transparent: true, opacity: 0.14,
          depthWrite: false,
        }),
      );
      mouth.rotation.x = -Math.PI / 2;
      mouth.position.set(x - s * 2.2, this.deckY + 0.014, 0);
      g.add(mouth);
      this.group.add(g);
      this.goalNets.push(g);
      // 门柱碰撞（球打柱会弹回来）：四条腿，用很小的 r 只为"柱"本身
      (this.postColliders || (this.postColliders = [])).push(
        { x, z: -C.GOAL_W / 2, r: C.POST_R },
        { x, z: C.GOAL_W / 2, r: C.POST_R },
      );
    }
  }

  /** 手搓网格：w×h 的矩形，切 nx×ny 格。比 GridHelper 好用的地方是能做成长方形 */
  #makeNet(w, h, nx, ny) {
    const pts = [];
    for (let i = 0; i <= nx; i++) {
      const x = -w / 2 + (w * i) / nx;
      pts.push(x, -h / 2, 0, x, h / 2, 0);
    }
    for (let j = 0; j <= ny; j++) {
      const y = -h / 2 + (h * j) / ny;
      pts.push(-w / 2, y, 0, w / 2, y, 0);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    return new THREE.LineSegments(geo, this.netMat);
  }

  // ---------------------------------------------------------------- 障碍

  /**
   * 礁石 + 熔岩柱：只在中圈带 |x|<26 / |z|<18 生成，中圈 7m 内留空（开球要干净），
   * 球门前 24m 内绝不出现 —— 否则守门员站在柱子后面，进攻方永远进不去。
   */
  #buildObstacles(colliders) {
    const rng = mulberry32(C.SEED);
    const n = C.OBS_COUNT[0] + (rng() < 0.45 ? 1 : 0);
    const list = [];
    let guard = 0;
    while (list.length < n && guard++ < 90) {
      // 头两个固定一柱一石：用户要的是"熔岩柱和礁石都有"，
      // 纯随机有 25% 概率整场两根都是石头，验收时看着像漏做了熔岩柱。
      const pillar = list.length === 0 ? true : list.length === 1 ? false : rng() < 0.5;
      const r = lerpRange(rng, pillar ? C.OBS_PILLAR_R : C.OBS_ROCK_R);
      const x = (rng() * 2 - 1) * C.OBS_BAND_X;
      const z = (rng() * 2 - 1) * C.OBS_BAND_Z;
      if (Math.hypot(x, z) < C.OBS_CENTER_CLEAR + r) continue;
      if (list.some((o) => Math.hypot(o.x - x, o.z - z) < o.r + r + 6)) continue;
      list.push({ type: pillar ? 'pillar' : 'rock', x, z, r, h: pillar ? lerpRange(rng, C.PILLAR_H) : 0 });
    }

    const rockMat = makeRockMaterial({ seed: 7, repeat: 2.4 });
    rockMat.color.set(0xb9c6cf);
    const glowMat = new THREE.MeshBasicMaterial({
      color: 0xff7a2a, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.lavaMats = [];

    for (const o of list) {
      const holder = new THREE.Group();
      holder.position.set(o.x, this.deckY, o.z);
      if (o.type === 'rock') {
        const geo = new THREE.IcosahedronGeometry(o.r, 2);
        const pos = geo.attributes.position;
        for (let i = 0; i < pos.count; i++) {
          const px = pos.getX(i), py = pos.getY(i), pz = pos.getZ(i);
          const k = 1
            + Math.sin(px * 0.9 + o.z) * 0.16
            + Math.cos(pz * 1.37 - o.x) * 0.13
            + Math.sin(py * 2.1 + i * 0.11) * 0.05;
          pos.setXYZ(i, px * k, py * k * 1.05, pz * k);
        }
        geo.computeVertexNormals();
        const rock = new THREE.Mesh(geo, rockMat);
        rock.position.y = o.r * 0.42;
        rock.castShadow = true;
        holder.add(rock);
      } else {
        // 熔岩柱 = 玄武岩短柱 + 顶部熔岩口（凹进去的一池岩浆）。
        // 第一版做成"上窄下宽的圆柱 + 顶上一块橙片"，看着像垃圾桶；
        // 这版给柱身加顶点扰动（不平滑的岩壁）+ 顶部一圈岩石唇口，
        // 岩浆放在唇口**里面**，才读得出"这是个口子"，而不是"扣了个盖"。
        // 柱身开口（openEnded）：不然圆柱自带顶盖，岩浆池被盖在柱子里，
        // 上面看就是一个"黑洞" —— 第一版就踩了这个坑。
        const geo = new THREE.CylinderGeometry(o.r * 0.9, o.r, o.h, 7, 3, true);
        const pos = geo.attributes.position;
        for (let i = 0; i < pos.count; i++) {
          const px = pos.getX(i), py = pos.getY(i), pz = pos.getZ(i);
          const a = Math.atan2(pz, px);
          const k = 1 + Math.sin(a * 3.3 + o.x) * 0.07 + Math.sin(py * 1.7 + o.z) * 0.05;
          pos.setXYZ(i, px * k, py, pz * k);
        }
        geo.computeVertexNormals();
        const body = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
          color: 0x2a2226, roughness: 0.94, metalness: 0.06,
          emissive: 0x3a1204, emissiveIntensity: 0.5, flatShading: true,
          side: THREE.DoubleSide,     // 开口之后要能看到内壁，否则从上面看是"通到天"
        }));
        body.position.y = o.h / 2;
        body.castShadow = true;
        holder.add(body);
        // 顶部岩石唇口
        const rim = new THREE.Mesh(
          new THREE.TorusGeometry(o.r * 0.74, 0.30, 6, 14),
          new THREE.MeshStandardMaterial({ color: 0x241c20, roughness: 0.9, metalness: 0.05, flatShading: true }),
        );
        rim.rotation.x = Math.PI / 2;
        rim.position.y = o.h - 0.1;
        holder.add(rim);
        // 岩浆：做成一坨从口子里鼓出来的熔岩丘，而不是"凹进去的一池"。
        // 凹池只在正上方看得见，赛艇的镜头永远贴着地面 —— 甲板高度的视角里就是全黑。
        const lavaMat = new THREE.MeshBasicMaterial({
          color: 0xffa63c, transparent: true, opacity: 0.95, toneMapped: false,
        });
        lavaMat.userData.baseOpacity = 0.95;
        const mound = new THREE.Mesh(
          new THREE.CylinderGeometry(o.r * 0.14, o.r * 0.84, 1.5, 9),
          lavaMat,
        );
        mound.position.y = o.h + 0.55;
        holder.add(mound);
        this.lavaMats.push(lavaMat);
        // 丘底一圈加色光晕：远处看是一团亮，不只是一块橙色
        const haloMat = glowMat.clone();
        haloMat.opacity = 0.5;
        haloMat.userData.baseOpacity = 0.5;
        const halo = new THREE.Mesh(new THREE.TorusGeometry(o.r * 0.8, 0.22, 6, 20), haloMat);
        halo.rotation.x = Math.PI / 2;
        halo.position.y = o.h + 0.12;
        holder.add(halo);
        this.lavaMats.push(haloMat);
        // 柱身竖向熔岩裂缝（跟着岩壁的不规则走不了，直接用几条发光细条贴面）
        const crackMat = new THREE.MeshBasicMaterial({
          color: 0xff7b2e, transparent: true, opacity: 0.85,
          blending: THREE.AdditiveBlending, depthWrite: false,
        });
        crackMat.userData.baseOpacity = 0.85;
        for (let k = 0; k < 3; k++) {
          const a = (k / 3) * Math.PI * 2 + 0.4;
          const crack = new THREE.Mesh(new THREE.BoxGeometry(0.14, o.h * 0.6, 0.09), crackMat);
          crack.position.set(Math.cos(a) * o.r * 0.9, o.h * 0.4, Math.sin(a) * o.r * 0.9);
          crack.rotation.y = -a;
          holder.add(crack);
        }
        this.lavaMats.push(crackMat);
        // 地面熔岩光斑：用普通混合，加色混合在这么亮的玻璃上会变成一团白
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(o.r * 1.02, o.r * 1.32, 32),
          new THREE.MeshBasicMaterial({
            color: 0xff6a22, transparent: true, opacity: 0.26, depthWrite: false,
          }),
        );
        ring.material.userData.baseOpacity = 0.26;
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = 0.03;
        holder.add(ring);
        this.lavaMats.push(ring.material);
      }
      this.group.add(holder);
      this.obstacles.push({ id: `obs${this.obstacles.length}`, type: o.type, x: o.x, z: o.z, r: o.r, holder });
      // 船也要撞：直接塞进竞技场的碰撞体列表（Boat 的扫掠圆认 x/z/r，另加 0.3 给石头的不规则边缘）。
      // 必须写死上下边界：10 层玻璃盘在 xz 上完全重叠，只给 2D 圆的话，第 2 层
      // 的船开到第 1 层礁石正上方照样会被弹开（玩家眼里就是"凭空撞了一下"）。
      // 高度严格贴模型：礁石是压扁的球（顶 r*0.42 + r*1.05*1.34），熔岩柱是 h 高的柱。
      const footY = this.deckY - (o.type === 'rock' ? o.r * 0.6 : 0.4);
      const headY = this.deckY + (o.type === 'rock' ? o.r * 1.50 : o.h + 0.35);
      colliders?.push({ x: o.x, z: o.z, r: o.r + 0.3, bottomY: footY, topY: headY });
    }
  }

  // ---------------------------------------------------------------- 球

  #buildBall() {
    const g = new THREE.Group();
    const r = C.BALL_R;
    const skin = new THREE.Mesh(
      new THREE.SphereGeometry(r, 28, 20),
      new THREE.MeshStandardMaterial({
        color: 0xf4fbff, roughness: 0.42, metalness: 0.05,
        emissive: 0x1c3f52, emissiveIntensity: 0.5,
      }),
    );
    g.add(skin);
    // 五边形黑块：从二十面体的 12 个顶点方向各贴一块五边形，
    // 任何角度都能看出"这是足球"，而线框在远处根本糊成一片白。
    const ico = new THREE.IcosahedronGeometry(1, 0);
    const ipos = ico.attributes.position;
    const dirs = [];
    const seen = new Set();
    for (let i = 0; i < ipos.count; i++) {
      const v = new THREE.Vector3().fromBufferAttribute(ipos, i).normalize();
      const key = `${v.x.toFixed(2)},${v.y.toFixed(2)},${v.z.toFixed(2)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      dirs.push(v);
    }
    ico.dispose();
    const patchGeo = new THREE.CircleGeometry(r * 0.44, 5);
    const patchMat = new THREE.MeshStandardMaterial({
      color: 0x1b2a33, roughness: 0.55, metalness: 0.1, side: THREE.DoubleSide,
    });
    const fwd = new THREE.Vector3(0, 0, 1);
    for (const d of dirs) {
      const patch = new THREE.Mesh(patchGeo, patchMat);
      patch.position.copy(d).multiplyScalar(r * 0.998);
      patch.quaternion.setFromUnitVectors(fwd, d);
      g.add(patch);
    }
    // 落地阴影：跟船一样靠一个暗圆表示离地高度，不然看不出球跳起来了
    const shadow = new THREE.Mesh(
      new THREE.CircleGeometry(r * 1.05, 24),
      new THREE.MeshBasicMaterial({ color: 0x001018, transparent: true, opacity: 0.32, depthWrite: false }),
    );
    shadow.rotation.x = -Math.PI / 2;
    this.group.add(shadow);
    this.ballShadow = shadow;
    // 球场上的"球在哪"提示环：玻璃盘很透，球色又浅，远处容易看丢
    const marker = new THREE.Mesh(
      new THREE.RingGeometry(r * 1.5, r * 1.85, 32),
      new THREE.MeshBasicMaterial({
        color: 0xffe9a0, transparent: true, opacity: 0.4,
        side: THREE.DoubleSide, depthWrite: false,
      }),
    );
    marker.rotation.x = -Math.PI / 2;
    this.group.add(marker);
    this.ballMarker = marker;

    this.ballMesh = g;
    this.group.add(g);
    this.#syncBallMesh(0);
  }

  #syncBallMesh(dt) {
    const b = this.ball;
    const y = this.deckY + C.BALL_R + b.hop;
    this.ballMesh.position.set(b.x, y, b.z);
    if (dt > 0 && b.spin) {
      // 绕"垂直于速度的水平轴"自转：滚动方向对得上，才不会读成"平移的球"
      this.ballMesh.rotateOnWorldAxis(
        new THREE.Vector3(b.spinX, 0, b.spinZ).normalize(),
        b.spin,
      );
      b.spin = 0;
    }
    this.ballShadow.position.set(b.x, this.deckY + 0.02, b.z);
    this.ballShadow.scale.setScalar(1 - Math.min(0.45, b.hop * 0.09));
    this.ballMarker.position.set(b.x, this.deckY + 0.03, b.z);
    const pulse = 0.34 + Math.sin(this.elapsed * 3.4) * 0.10;
    this.ballMarker.material.opacity = pulse;
    this.ballMarker.scale.setScalar(1 + Math.sin(this.elapsed * 3.4) * 0.05);
    const vis = !b.dead;
    this.ballMesh.visible = vis;
    this.ballShadow.visible = vis;
    this.ballMarker.visible = vis;
  }

  // ---------------------------------------------------------------- 每帧

  /**
   * @param {number} dt
   * @param {Array<{id:string, boat:object}>} entries 只有"在本层、活着、没落海"的船
   */
  update(dt, entries = []) {
    if (this.disposed) return;
    this.elapsed += dt;
    for (const k in this.fxCd) this.fxCd[k] = Math.max(0, this.fxCd[k] - dt);

    // 进球后的重置倒计时
    if (this.resetTimer > 0) {
      this.resetTimer -= dt;
      if (this.resetTimer <= 0) {
        resetBall(this.ball, 0, 0);
        this.kickoffLock = 0.55;
        this.fx?.play?.('ring', 0, this.deckY + 1, 0, 1.6);
      }
    }
    this.kickoffLock = Math.max(0, this.kickoffLock - dt);

    if (this.authority && this.resetTimer <= 0) {
      const world = this.#makeWorld(entries);
      const ev = stepBall(this.ball, dt, world);
      if (ev.length) this.#applyEvents(ev, entries);
    } else if (!this.authority) {
      this.#followRemote(dt);
    }

    this.#syncBallMesh(dt);
    this.#animateObstacles();
    this.#animateGoals();
  }

  #makeWorld(entries) {
    const boats = [];
    for (const e of entries) {
      const boat = e.boat;
      if (!boat) continue;
      // 开球保护：球刚回中圈时，贴在中圈里的船先不参与碰撞
      if (this.kickoffLock > 0 && Math.hypot(boat.pos.x - this.ball.x, boat.pos.z - this.ball.z) < C.KICKOFF_R) continue;
      const dx = this.ball.x - boat.pos.x;
      const dz = this.ball.z - boat.pos.z;
      const d = Math.hypot(dx, dz) || 1;
      const nx = dx / d, nz = dz / d;
      // 用真实船体在该法向上的支撑半径（细长船侧面窄、正撞长），再收 8%：
      // 全用外接圆会让球在船侧"隔空弹开"，读起来像磁铁。
      const radius = boat.def
        ? boatCollisionRadius(boat.def, boat.heading, nx, nz) * 0.92
        : 1.6;
      boats.push({
        id: e.id,
        x: boat.pos.x, z: boat.pos.z,
        vx: boat.vel.x, vz: boat.vel.y,
        r: radius,
        mass: boatCollisionMass(boat.def || {}),
        heading: boat.heading,
      });
    }
    return {
      halfL: C.HALF_L, halfW: C.HALF_W,
      goalW: C.GOAL_W, goalH: C.GOAL_H,
      r: C.BALL_R,
      boardE: BALL_PHYS.E_BOARD,
      ballMass: C.BALL_MASS_K * 4.6,   // 船质量中位数约 4.6，球 = 船的 1.7 倍
      obstacles: this.obstacles,
      posts: this.postColliders,
      boats,
    };
  }

  #applyEvents(ev, entries) {
    const byId = new Map(entries.map((e) => [e.id, e]));
    for (const e of ev) {
      if (e.type === 'goal') {
        this.ball.dead = true;
        this.resetTimer = C.RESET_DELAY;
        this.kickoffLock = 0;
        this.fx?.play?.('explosion', e.x, this.deckY + 2, e.z, 1.6);
        this.fx?.play?.('ring', e.x, this.deckY + 2, e.z, 2.4);
        this.onGoal(e.side);
        this.onEvent(e);
      } else if (e.type === 'boat') {
        const en = byId.get(e.id);
        if (en?.boat) {
          en.boat.vel.x += e.ix;
          en.boat.vel.y += e.iz;
        }
        if (e.speed > 5 && this.fxCd.boat <= 0) {
          this.fxCd.boat = 0.11;
          const boat = en?.boat;
          this.fx?.play?.('hit', boat?.pos.x ?? 0, boat?.pos.y ?? 0, boat?.pos.z ?? 0, 1 + Math.min(1.2, e.speed / 30));
          this.onEvent(e);
        }
      } else if (e.type === 'obstacle' || e.type === 'post') {
        if (e.speed > 6 && this.fxCd[e.type] <= 0) {
          this.fxCd[e.type] = 0.16;
          this.fx?.play?.('hit', e.x, this.deckY + C.BALL_R, e.z, 0.9 + Math.min(0.8, e.speed / 40));
          this.onEvent(e);
        }
      } else if (e.type === 'board') {
        if (e.speed > 6 && this.fxCd.board <= 0) {
          this.fxCd.board = 0.14;
          this.fx?.play?.('ring', e.x, this.deckY + 1, e.z, 0.7);
          this.onEvent(e);
        }
      }
    }
  }

  /** 客机：只跟房主快照，不跑物理（球的权威永远在房主） */
  #followRemote(dt) {
    const r = this.remote;
    if (!r) return;
    const k = 1 - Math.exp(-14 * dt);
    this.ball.x += (r.x - this.ball.x) * k;
    this.ball.z += (r.z - this.ball.z) * k;
    this.ball.vx = r.vx || 0;
    this.ball.vz = r.vz || 0;
    this.ball.hop += ((r.h || 0) - this.ball.hop) * k;
    this.ball.spin += (Math.hypot(r.vx || 0, r.vz || 0) / C.BALL_R) * dt;
    this.ball.dead = !!r.dead;
  }

  #animateObstacles() {
    const t = this.elapsed;
    // 各自按自己的基准亮度呼吸：熔岩口亮、底部光环暗，统一改成 0.6 会把光环烧成一块橙饼
    for (const m of this.lavaMats) {
      const base = m.userData.baseOpacity ?? 0.6;
      m.opacity = Math.max(0.05, base * (0.82 + Math.sin(t * 2.3) * 0.26));
    }
  }

  #animateGoals() {
    // 门线在进球瞬间闪一下（进球后 1.4s 内最亮），平时保持低亮度
    const f = this.resetTimer > 0 ? Math.min(1, this.resetTimer / 0.6) : 0;
    for (const g of this.goalNets) {
      const m = g.userData.lineMat;
      if (m) m.opacity = 0.35 + f * 0.65;
    }
  }

  // ---------------------------------------------------------------- 对外

  /** 进攻方向：+1 = 往 +X 的球门踢，-1 反之。1v1 时两人各一边 */
  attackDir(index) {
    return index % 2 === 0 ? 1 : -1;
  }

  /** 开球站位：站在自家半场，面向对方球门。同一边的第 2 人往外挪一格，别叠在一起 */
  spawnTransform(index, count = 2) {
    const dir = this.attackDir(index);
    const lane = Math.floor(index / 2);            // 同一边的第几个人（3 人局时 index 0/2 同边）
    const side = index % 2 === 0 ? -1 : 1;
    const z = Math.max(-C.HALF_W + 6, Math.min(C.HALF_W - 6, side * (8 + lane * 9)));
    return {
      x: -dir * C.HALF_L * 0.42,
      z,
      y: layerY(this.layer),
      heading: dir > 0 ? Math.PI / 2 : -Math.PI / 2,
      layer: this.layer,
    };
  }

  /**
   * AI 的踢球点：站到球的"自家一侧"再往前顶。
   * 比"直接朝球开"好用的地方：朝球开会从任意方向顶，经常把球顶向自家球门。
   */
  aiTarget(index) {
    const dir = this.attackDir(index);
    return { x: this.ball.x - dir * 7, z: this.ball.z * 0.88 };
  }

  addGoal(id) {
    this.goals.set(id, (this.goals.get(id) || 0) + 1);
  }

  /** 房主 → 客机：6 个浮点 */
  snapshot() {
    const b = this.ball;
    return {
      x: +b.x.toFixed(2), z: +b.z.toFixed(2),
      vx: +b.vx.toFixed(2), vz: +b.vz.toFixed(2),
      h: +b.hop.toFixed(2), dead: b.dead ? 1 : 0,
    };
  }

  applyRemote(s) {
    this.remote = s;
    if (s.dead) {
      this.ball.dead = true;
      if (this.resetTimer <= 0) this.resetTimer = C.RESET_DELAY;
    }
  }

  state() {
    return { x: this.ball.x, z: this.ball.z, goals: Object.fromEntries(this.goals) };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const ms = Array.isArray(o.material) ? o.material : [o.material];
        ms.forEach((m) => m.dispose());
      }
    });
    this.scene.remove(this.group);
  }
}

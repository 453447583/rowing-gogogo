import * as THREE from 'three';
import { SKY_TOWER, layerY, layerRadius } from '../data/skyTowerRun.js';
import { cloneProp } from './propLoader.js';
import { makeBubbleMaterial } from '../utils/bubbleMaterial.js';

/**
 * 云端天梯第 9 层：涂地竞速。
 *
 * 用户口径（2026-11-26）
 * --------------------
 * - 船尾自动留色，冲刺时涂宽 ×1.8；
 * - 地面 1.2m 网格归属制：对手可以覆盖，己方色上再涂没有收益；
 * - 撞人让对手「断笔」1.5 秒；按 1 丢泡泡，炸掉半径 4m 的颜色；
 * - 最后 15 秒涂抹效率 ×2；75 秒结束按覆盖率排名（[6,3,1]）；
 * - 障碍 = 中央塔柱 + 4 座冰山 + 2 根旋转障碍；不刷拾取物。
 *
 * 实现口径
 * --------
 * 地面是一张顶点色网格（每格 1.2m 一个 quad），归属存在 Int8Array 里，
 * 只有归属变化时才改顶点颜色，平时零开销。房主每 0.6 秒把整张归属表
 * 打包成字符串广播一次做纠偏；两端平时都按同步过来的船位姿本地涂抹，
 * 所以画面是连续的，不会一跳一跳。
 */

const D = SKY_TOWER.PAINT;
const TWO_PI = Math.PI * 2;
const DECK_Y = layerY(D.LAYER) + 0.30;

const R = layerRadius(D.LAYER);
const CELL = D.CELL;
const N = Math.max(8, Math.ceil((R * 2) / CELL));
const SPAN = N * CELL;
const HALF = SPAN / 2;
const PLAY_R = R - 0.35;

// 颜色：蓝 / 橙（避开红绿，色弱也能分）
const SIDE_RGB = [
  [0.28, 0.63, 1.0],
  [1.0, 0.58, 0.22],
];
const ALPHA = 0.62;

const idxOf = (ix, iz) => iz * N + ix;

export class SkyTowerPaintRun {
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.layer = D.LAYER;
    this.deckY = DECK_Y;
    this.myId = opts.myId;
    this.isHost = opts.isHost !== false;
    this.solo = !!opts.solo;
    this.fx = opts.fx || null;
    this.net = opts.net || { send() {} };
    this.onScore = opts.onScore || (() => 0);
    this.onEvent = opts.onEvent || (() => {});
    this.onToast = opts.onToast || (() => {});
    this.sideOf = typeof opts.sideOf === 'function' ? opts.sideOf : () => 0;
    this.isAi = typeof opts.isAi === 'function' ? opts.isAi : () => false;
    this.invulnOf = typeof opts.invulnOf === 'function' ? opts.invulnOf : () => 0;
    this.colliders = Array.isArray(opts.colliders) ? opts.colliders : null;

    this.boats = new Map();
    this.seen = new Set();
    this.owner = new Int8Array(N * N);   // -1 不可涂 / 0 中立 / 1 蓝 / 2 橙
    this.count = [0, 0];                 // side -> 已涂格数
    this.inkBreak = new Map();           // id -> 断笔剩余时间
    this.prevPos = new Map();
    this.ramCd = new Map();
    this.bubbleCd = new Map();
    this.bubbles = [];
    this.elapsed = 0;
    this.timeLeft = D.DURATION;
    this.started = false;
    this.clockOn = false;
    this.running = true;
    this.playable = 0;
    this.order = [];
    this.teams = [];
    this.winner = null;
    this.disposed = false;
    this._stateT = 0;
    this._dirty = new Set();

    this.group = new THREE.Group();
    this.group.name = 'sky-tower-paint';
    this.group.position.y = this.deckY;
    scene.add(this.group);

    this.#buildGrid();
    this.#buildObstacles();
    this.#buildDecor();
  }

  // ---------------------------------------------------------------- 场地

  #cellCenter(ix, iz) {
    return { x: -HALF + (ix + 0.5) * CELL, z: -HALF + (iz + 0.5) * CELL };
  }

  /** 地面网格：一张顶点色平面（每个格子 2 个三角形），不可涂的格子 alpha=0 */
  #buildGrid() {
    const verts = N * N * 4;
    const pos = new Float32Array(verts * 3);
    const col = new Float32Array(verts * 4);
    const indices = [];
    for (let iz = 0; iz < N; iz++) {
      for (let ix = 0; ix < N; ix++) {
        const i = idxOf(ix, iz);
        const { x, z } = this.#cellCenter(ix, iz);
        const inside = Math.hypot(x, z) <= PLAY_R;
        this.owner[i] = inside ? 0 : -1;
        if (inside) this.playable++;
        const x0 = x - CELL / 2, x1 = x + CELL / 2;
        const z0 = z - CELL / 2, z1 = z + CELL / 2;
        const v = i * 4;
        pos[v * 3] = x0; pos[v * 3 + 1] = 0.02; pos[v * 3 + 2] = z0;
        pos[(v + 1) * 3] = x1; pos[(v + 1) * 3 + 1] = 0.02; pos[(v + 1) * 3 + 2] = z0;
        pos[(v + 2) * 3] = x1; pos[(v + 2) * 3 + 1] = 0.02; pos[(v + 2) * 3 + 2] = z1;
        pos[(v + 3) * 3] = x0; pos[(v + 3) * 3 + 1] = 0.02; pos[(v + 3) * 3 + 2] = z1;
        for (let k = 0; k < 4; k++) col[(v + k) * 4 + 3] = 0;
        indices.push(v, v + 1, v + 2, v, v + 2, v + 3);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 4));
    geo.setIndex(indices);
    this.gridGeo = geo;
    this.gridMesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false,
      side: THREE.DoubleSide,
    }));
    this.gridMesh.renderOrder = 2;
    this.gridMesh.name = 'paint-grid';
    this.group.add(this.gridMesh);
  }

  #paintCellVisual(i) {
    const o = this.owner[i];
    const col = this.gridGeo.attributes.color;
    const v = i * 4;
    if (o <= 0) {
      for (let k = 0; k < 4; k++) col.setW(v + k, 0);
    } else {
      const c = SIDE_RGB[o - 1];
      for (let k = 0; k < 4; k++) {
        col.setXYZ(v + k, c[0], c[1], c[2]);
        col.setW(v + k, ALPHA);
      }
    }
    col.needsUpdate = true;
  }

  #buildObstacles() {
    const ice = [
      { x: 13, z: 9 }, { x: -13, z: 9 }, { x: 13, z: -9 }, { x: -13, z: -9 },
    ].slice(0, D.ICEBERGS);
    for (const p of ice) {
      cloneProp('/models/props/iceberg_small.glb', 6, { by: 'height' })
        .then((m) => {
          if (this.disposed) return;
          m.position.set(p.x, 0.02, p.z);
          m.rotation.y = Math.atan2(p.x, p.z);
          m.userData.glb = 'iceberg_small';
          m.name = 'paint-iceberg';
          this.group.add(m);
        })
        .catch(() => {});
      this.colliders?.push({ x: p.x, z: p.z, r: 2.2, bottomY: this.deckY - 1, topY: this.deckY + 5 });
    }
    this.rotors = [];
    const rotors = [{ x: 0, z: 11.5 }, { x: 0, z: -11.5 }].slice(0, D.ROTORS);
    for (const p of rotors) {
      const holder = new THREE.Group();
      holder.position.set(p.x, 0.02, p.z);
      this.group.add(holder);
      cloneProp('/models/props/rotating_obstacle.glb', 4.2, { by: 'height' })
        .then((m) => {
          if (this.disposed) return;
          m.userData.glb = 'rotating_obstacle';
          m.name = 'paint-rotor';
          holder.add(m);
        })
        .catch(() => {});
      this.colliders?.push({ x: p.x, z: p.z, r: 1.5, bottomY: this.deckY - 1, topY: this.deckY + 4 });
      this.rotors.push(holder);
    }
  }

  #buildDecor() {
    for (let i = 0; i < D.POLE_COUNT; i++) {
      const a = (i / D.POLE_COUNT) * TWO_PI + Math.PI / 9;
      cloneProp('/models/low_poly_street_light_pole.glb', 15, { by: 'height' })
        .then((m) => {
          if (this.disposed) return;
          m.position.set(Math.cos(a) * R * 0.95, 0.05, Math.sin(a) * R * 0.95);
          m.rotation.y = -a + Math.PI / 2;
          m.userData.glb = 'street_light_pole';
          m.name = 'paint-pole';
          this.group.add(m);
        })
        .catch(() => {});
    }
  }

  // ---------------------------------------------------------------- 每帧

  update(dt, entries = []) {
    if (this.disposed) return;
    this.elapsed += dt;
    this.boats = new Map(entries.map((e) => [e.id, e.boat]));
    for (const e of entries) this.seen.add(e.id);

    if (!this.started && entries.length) {
      this.started = true;
      this.onEvent({ type: 'start' });
    }
    if ((this.isHost || this.solo) && !this.clockOn) {
      if (entries.some((e) => !this.isAi(e.id))) this.clockOn = true;
    }
    const clock = this.started && this.running && this.clockOn;

    if (clock) {
      this.timeLeft -= dt;
      if (this.timeLeft <= 0) this.#finish();
    }
    for (const [id, t] of this.inkBreak) {
      const v = t - dt;
      if (v <= 0) this.inkBreak.delete(id); else this.inkBreak.set(id, v);
    }

    if (clock) {
      const rush = this.timeLeft <= D.FINAL_RUSH;
      for (const [id, boat] of this.boats) {
        if (!boat) continue;
        // 两端都按同步位姿本地涂抹；归属以房主快照为准
        this.#paintTrail(id, boat, rush);
      }
      this.#updateRam(clock);
    }
    this.#flushDirty();
    this.#updateBubbles(dt);
    for (const r of this.rotors) r.rotation.y += dt * 1.1;

    if (this.isHost && !this.solo && this.started) {
      this._stateT -= dt;
      if (this._stateT <= 0) { this.#sendState(); this._stateT = 0.6; }
    }
  }

  #paintTrail(id, boat, rush) {
    if ((this.inkBreak.get(id) || 0) > 0) return;
    const side = this.sideOf(id) ? 1 : 0;
    const tag = side + 1;
    const boost = (boat.boostTimer || 0) > 0;
    let rad = D.BRUSH_R * (boost ? D.BOOST_WIDTH : 1);
    if (rush) rad *= Math.sqrt(D.FINAL_MULT);
    // 船尾落笔：船头方向 (sin, cos)，船尾往后退 BRUSH_BACK
    const sx = boat.pos.x - Math.sin(boat.heading) * D.BRUSH_BACK;
    const sz = boat.pos.z - Math.cos(boat.heading) * D.BRUSH_BACK;
    this.#paintCircle(sx, sz, rad, tag);
  }

  /** 把以 (x,z) 为圆心、r 为半径的格子涂成 tag（只统计归属变化） */
  #paintCircle(x, z, r, tag) {
    const side = tag - 1;
    const ix0 = Math.max(0, Math.floor((x - r + HALF) / CELL));
    const ix1 = Math.min(N - 1, Math.floor((x + r + HALF) / CELL));
    const iz0 = Math.max(0, Math.floor((z - r + HALF) / CELL));
    const iz1 = Math.min(N - 1, Math.floor((z + r + HALF) / CELL));
    const r2 = r * r;
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const i = idxOf(ix, iz);
        const cur = this.owner[i];
        if (cur < 0 || cur === tag) continue;
        const c = this.#cellCenter(ix, iz);
        if ((c.x - x) ** 2 + (c.z - z) ** 2 > r2) continue;
        if (cur > 0) this.count[cur - 1] = Math.max(0, this.count[cur - 1] - 1);
        this.count[side] += 1;
        this.owner[i] = tag;
        this._dirty.add(i);
      }
    }
  }

  /** 泡泡清色：把半径内所有颜色打回中立 */
  #clearCircle(x, z, r) {
    const ix0 = Math.max(0, Math.floor((x - r + HALF) / CELL));
    const ix1 = Math.min(N - 1, Math.floor((x + r + HALF) / CELL));
    const iz0 = Math.max(0, Math.floor((z - r + HALF) / CELL));
    const iz1 = Math.min(N - 1, Math.floor((z + r + HALF) / CELL));
    const r2 = r * r;
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const i = idxOf(ix, iz);
        const cur = this.owner[i];
        if (cur <= 0) continue;
        const c = this.#cellCenter(ix, iz);
        if ((c.x - x) ** 2 + (c.z - z) ** 2 > r2) continue;
        this.count[cur - 1] = Math.max(0, this.count[cur - 1] - 1);
        this.owner[i] = 0;
        this._dirty.add(i);
      }
    }
  }

  #flushDirty() {
    if (!this._dirty.size) return;
    for (const i of this._dirty) this.#paintCellVisual(i);
    this._dirty.clear();
  }

  /** 撞人断笔：房主统一判，广播给被撞方；只有被撞的那个人失去涂色 1.5s */
  #updateRam(clock) {
    if (!clock) return;
    for (const [id, boat] of this.boats) {
      if (!boat) continue;
      if (id !== this.myId && !(this.isHost && this.isAi(id))) continue;
      if (this.elapsed < (this.ramCd.get(id) || 0)) continue;
      for (const [oid, ob] of this.boats) {
        if (oid === id || !ob) continue;
        if (this.sideOf(oid) === this.sideOf(id)) continue;
        const d = Math.hypot(ob.pos.x - boat.pos.x, ob.pos.z - boat.pos.z);
        if (d > 5.4) continue;
        const rel = Math.hypot(boat.vel.x - ob.vel.x, boat.vel.y - ob.vel.y);
        if (rel < D.RAM_MIN) continue;
        // 刚复活（或刚被推飞）的 2 秒无敌也挡断笔
        if (this.invulnOf(oid) > 0) continue;
        this.ramCd.set(id, this.elapsed + D.RAM_CD);
        if (this.isHost || this.solo) this.#breakInk(oid);
        else this.net.send?.({ t: 'towerPaintBreak', id: oid });
        break;
      }
    }
  }

  #breakInk(id) {
    this.inkBreak.set(id, D.INK_BREAK);
    const boat = this.boats.get(id);
    if (boat) {
      this.fx?.play?.('hit', boat.pos.x, boat.pos.y, boat.pos.z, 1.2);
      this.fx?.play?.('ring', boat.pos.x, this.deckY + 0.3, boat.pos.z, 1.2);
    }
    if (!this.solo && this.isHost) this.net.send?.({ t: 'towerPaintBreak', id, dur: D.INK_BREAK });
    this.onEvent({ type: 'break', id });
  }

  /** 按 1：在船头前方放一颗泡泡，0.8 秒后炸掉半径 4m 的颜色 */
  fireBubble(id = this.myId) {
    if (this.disposed || !this.running) return false;
    const boat = this.boats.get(id);
    if (!boat) return false;
    if (this.elapsed < (this.bubbleCd.get(id) || 0)) return false;
    this.bubbleCd.set(id, this.elapsed + D.BUBBLE_CD);
    const x = boat.pos.x + Math.sin(boat.heading) * 5;
    const z = boat.pos.z + Math.cos(boat.heading) * 5;
    if (this.isHost || this.solo) this.#spawnBubble(x, z, true);
    else {
      this.#spawnBubble(x, z, false);   // 本地先看到泡泡；清色等房主广播
      this.net.send?.({ t: 'towerPaintFire', by: id, x, z });
    }
    return true;
  }

  #spawnBubble(x, z, authoritative = false) {
    const mat = makeBubbleMaterial({ tint: 0xd9f6ff, opacity: 1, rim: 1.1, phase: Math.random() * TWO_PI });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.9, 18, 12), mat);
    mesh.position.set(x, 1.6, z);
    this.group.add(mesh);
    this.bubbles.push({ x, z, t: 0.8, mesh, mat, authoritative });
  }

  #updateBubbles(dt) {
    for (let i = this.bubbles.length - 1; i >= 0; i--) {
      const b = this.bubbles[i];
      b.t -= dt;
      if (b.mesh) {
        b.mesh.position.y = 1.6 + Math.sin((1 - b.t / 0.8) * Math.PI) * 1.2;
        b.mesh.rotation.y += dt * 2.5;
        if (b.mat?.uniforms?.uTime) b.mat.uniforms.uTime.value += dt;
      }
      if (b.t > 0) continue;
      if (b.authoritative) {
        this.#clearCircle(b.x, b.z, D.BUBBLE_R);
        this.fx?.play?.('ring', b.x, this.deckY + 0.3, b.z, 1.4);
        this.fx?.play?.('hit', b.x, this.deckY + 1.2, b.z, 1.2);
        if (!this.solo && this.isHost) this.net.send?.({ t: 'towerPaintPop', x: b.x, z: b.z });
      }
      b.mesh?.parent?.remove(b.mesh);
      b.mesh?.geometry?.dispose();
      b.mat?.dispose();
      this.bubbles.splice(i, 1);
    }
  }

  /**
   * AI：找最近一块「不是自己颜色」的地盘开过去。
   * 网格 44×44，逐格扫会有点贵，所以每 3 格采样一次（AI 看不出差别）。
   */
  aiTarget(boat, id) {
    if (!boat) return null;
    const tag = (this.sideOf(id) ? 1 : 0) + 1;
    let best = null, bd = Infinity;
    const lim = PLAY_R - 4;
    for (let iz = 1; iz < N; iz += 3) {
      for (let ix = 1; ix < N; ix += 3) {
        const i = idxOf(ix, iz);
        const o = this.owner[i];
        if (o < 0 || o === tag) continue;
        const c = this.#cellCenter(ix, iz);
        if (Math.hypot(c.x, c.z) > lim) continue;
        const d = (c.x - boat.pos.x) ** 2 + (c.z - boat.pos.z) ** 2;
        if (d < bd) { bd = d; best = c; }
      }
    }
    if (best) return best;
    const a = this.elapsed * 0.6 + (this.sideOf(id) ? Math.PI : 0);
    return { x: Math.cos(a) * lim * 0.6, z: Math.sin(a) * lim * 0.6 };
  }

  // ---------------------------------------------------------------- 结算

  ratioOf(side) {
    return this.playable > 0 ? this.count[side] / this.playable : 0;
  }

  /** 本层 1 分钟结束：场上泡泡消失（颜料地毯保留，作为本层战绩展示） */
  clearPickups() {
    for (const b of this.bubbles) if (b.mesh) b.mesh.visible = false;
    this.bubbles.length = 0;
  }

  #finish(remote = false, remoteOrder = null, remoteTeams = null) {
    if (!this.running) return;
    this.running = false;
    this.timeLeft = 0;
    const ids = this.seen.size ? [...this.seen] : [...this.boats.keys()];

    let order = remoteOrder;
    let teams = remoteTeams || [];
    if (!order) {
      const rows = ids.map((id, i) => ({
        id, s: this.sideOf(id) ? 1 : 0, i,
      }));
      const bySide = new Map();
      for (const r of rows) {
        const cur = bySide.get(r.s) || { s: r.s, rows: [], v: this.count[r.s] };
        cur.rows.push(r);
        cur.v = this.count[r.s];
        bySide.set(r.s, cur);
      }
      const sorted = [...bySide.values()].sort((a, b) => b.v - a.v || a.s - b.s);
      order = sorted.flatMap((t) => t.rows.map((r) => ({ id: r.id, n: Math.round(this.ratioOf(t.s) * 100) })));
      teams = sorted.map((t) => ({ ids: t.rows.map((r) => r.id), n: Math.round(this.ratioOf(t.s) * 100) }));
    }
    if (!teams.length) teams = order.map((o) => ({ ids: [o.id], n: o.n }));
    this.order = order;
    this.teams = teams;
    this.winner = teams[0]?.ids?.[0] || order[0]?.id || null;

    if (!remote && (this.isHost || this.solo)) {
      const rankOf = new Map();
      teams.forEach((t, i) => { for (const id of t.ids) rankOf.set(id, i); });
      for (const r of order) {
        const i = rankOf.get(r.id) ?? 0;
        const pts = D.SCORE_RANK[Math.min(i, D.SCORE_RANK.length - 1)];
        const s = this.onScore(r.id, pts, 'rank');
        if (!this.solo && Number.isFinite(s)) this.net.send?.({ t: 'towerScore', id: r.id, s });
      }
    }

    this.onEvent({
      type: 'finish',
      order,
      teams: teams.map((t) => ({ ids: t.ids, n: t.n })),
      rate: [Math.round(this.ratioOf(0) * 100), Math.round(this.ratioOf(1) * 100)],
    });
    if (!remote && !this.solo && this.isHost) {
      this.net.send?.({ t: 'towerPaintEnd', order, teams, rate: [
        Math.round(this.ratioOf(0) * 100), Math.round(this.ratioOf(1) * 100)] });
    }
  }

  // ---------------------------------------------------------------- 网络

  #packGrid() {
    const out = new Array(N * N);
    for (let i = 0; i < N * N; i++) out[i] = this.owner[i] < 0 ? 'x' : String(this.owner[i]);
    return out.join('');
  }

  #unpackGrid(s) {
    if (typeof s !== 'string' || s.length !== N * N) return;
    this.count[0] = 0;
    this.count[1] = 0;
    for (let i = 0; i < N * N; i++) {
      const ch = s[i];
      const v = ch === 'x' ? -1 : (ch === '1' || ch === '2' ? +ch : 0);
      this.owner[i] = v;
      if (v === 1) this.count[0]++;
      else if (v === 2) this.count[1]++;
      this._dirty.add(i);
    }
  }

  #sendState() {
    this.net.send?.({
      t: 'towerPaintState',
      left: +this.timeLeft.toFixed(1),
      c: [this.count[0], this.count[1]],
      g: this.#packGrid(),
    });
  }

  applyNet(e) {
    if (!e || this.disposed) return;
    switch (e.t) {
      case 'towerPaintState':
        if (!this.isHost) {
          if (Number.isFinite(e.left)) this.timeLeft = e.left;
          if (typeof e.g === 'string') this.#unpackGrid(e.g);
          else if (Array.isArray(e.c)) this.count = [+e.c[0] || 0, +e.c[1] || 0];
          this.clockOn = this.clockOn || this.started;
        }
        break;
      case 'towerPaintBreak':
        this.inkBreak.set(e.id, Number.isFinite(e.dur) ? e.dur : D.INK_BREAK);
        this.onEvent({ type: 'break', id: e.id, remote: true });
        break;
      case 'towerPaintFire':
        if (this.isHost) this.#spawnBubble(+e.x || 0, +e.z || 0, true);
        break;
      case 'towerPaintPop':
        if (!this.isHost) {
          this.#clearCircle(+e.x || 0, +e.z || 0, D.BUBBLE_R);
          this.fx?.play?.('ring', +e.x || 0, this.deckY + 0.3, +e.z || 0, 1.4);
          this.fx?.play?.('hit', +e.x || 0, this.deckY + 1.2, +e.z || 0, 1.2);
        }
        break;
      case 'towerPaintEnd': {
        const order = Array.isArray(e.order)
          ? e.order.map((r) => ({ id: r.id, n: r.n | 0 })) : null;
        const teams = Array.isArray(e.teams)
          ? e.teams.map((t) => ({ ids: t.ids || [], n: t.n | 0 })) : null;
        if (this.running) this.#finish(true, order, teams);
        break;
      }
      default: break;
    }
  }

  // ---------------------------------------------------------------- HUD

  hudState() {
    const side = this.sideOf(this.myId) ? 1 : 0;
    return {
      left: Math.max(0, this.timeLeft),
      mine: Math.round(this.ratioOf(side) * 100),
      foe: Math.round(this.ratioOf(1 - side) * 100),
      break: Math.max(0, this.inkBreak.get(this.myId) || 0),
      rush: this.timeLeft <= D.FINAL_RUSH,
      running: this.running,
      order: this.order,
    };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const b of this.bubbles) {
      b.mesh?.parent?.remove(b.mesh);
      b.mesh?.geometry?.dispose();
      b.mat?.dispose();
    }
    this.bubbles.length = 0;
    this.gridGeo?.dispose();
    this.gridMesh?.material?.dispose();
    // cloneProp 的道具材质与 GLB 缓存共享，不能在这里 dispose
    this.scene.remove(this.group);
  }
}

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { limitDriftStep, driftBoostCount, NITRO_CAPACITY, collectNitroCharge, DRIFT_TUNING, DRIFT_SPEED_RATIO } from '../src/game/Boat.js';
import { CameraRig } from '../src/game/CameraRig.js';
import { MAPS, WEATHERS } from '../src/data/maps.js';
import { faultRects } from '../src/utils/faults.js';
import { FX_DEFS } from '../src/game/Effects.js';
import { BOATS, boatStatProfile, boatCollisionMass } from '../src/data/boats.js';
import { boatCollisionResponse, boatCollisionRadius, boatCollisionRoll } from '../src/game/Game.js';
import { Track } from '../src/game/Track.js';
import { fallbackHullOutline, convexHull2D, simplifyOutline, outlineExtents } from '../src/utils/hull.js';
import {
  BOSS_LEVELS, BOSSES, BOSS_SKILLS, BOSS_DIFFICULTIES, BOSS_MINIONS,
  BOSS_ARENA, ARENA_ITEM_SPOTS, BOSS_ITEM_BEHAVIOR, BOSS_MAX_PLAYERS, BOSS_REVIVES,
  gradeStage, getBossLevel, getBossDifficulty, BOSS_PACE, BOSS_FIRE_CORE,
} from '../src/data/bosses.js';

const root = fileURLToPath(new URL('..', import.meta.url));

assert.equal(driftBoostCount(0.4), 0, 'short taps must not grant a spray');
assert.equal(driftBoostCount(0.7), 1, 'medium drift grants one spray');
assert.equal(driftBoostCount(1.5), 2, 'long drift grants CWW double spray');
// 角度口径（2026-11-16 起是正式口径）：30° 双喷 / 16° 单喷，短于点按不给
assert.equal(driftBoostCount(0.5, 0.2), 0, 'a shallow slip never grants a spray');
assert.equal(driftBoostCount(0.5, 0.33), 1, 'a 19 degree slip grants one spray');
assert.equal(driftBoostCount(0.5, 0.60), 2, 'a 34 degree slip grants the double spray');
assert.equal(driftBoostCount(0.1, 0.60), 0, 'a tap shorter than the minimum hold never grants a spray');
// 角度口径（2026-11-16 起是正式口径）：30° 双喷 / 16° 单喷，短于点按不给
assert.equal(driftBoostCount(0.5, 0.2), 0, 'a shallow slip never grants a spray');
assert.equal(driftBoostCount(0.5, 0.33), 1, 'a 19 degree slip grants one spray');
assert.equal(driftBoostCount(0.5, 0.60), 2, 'a 34 degree slip grants the double spray');
assert.equal(driftBoostCount(0.1, 0.60), 0, 'a tap shorter than the minimum hold never grants a spray');
assert.ok(Math.abs(limitDriftStep(9, 1 / 60)) <= 1.8 / 60 + 1e-9);
assert.ok(Math.abs(limitDriftStep(-9, 1 / 60)) <= 1.8 / 60 + 1e-9);
assert.equal(NITRO_CAPACITY, 2, 'race mode stores two nitro bottles');
const partialNitro = collectNitroCharge(0.72, 0, 0.2);
assert.ok(Math.abs(partialNitro.charge - 0.92) < 1e-9 && partialNitro.bottles === 0, 'partial drifting only fills the bottom gauge');
const firstBottle = collectNitroCharge(0.92, 0, 0.2);
assert.ok(Math.abs(firstBottle.charge - 0.12) < 1e-9 && firstBottle.bottles === 1, 'a full bottom gauge converts into one bottle');
assert.deepEqual(collectNitroCharge(0.9, 1, 0.2), { charge: 0, bottles: 2 }, 'the second bottle fills and resets the gauge');
assert.deepEqual(collectNitroCharge(0.7, 2, 0.5), { charge: 0, bottles: 2 }, 'full inventory cannot overfill or retain hidden charge');

const palace = MAPS.find((m) => m.id === 'palace');
const canyon = MAPS.find((m) => m.id === 'canyon');
const blizzard = WEATHERS.find((w) => w.id === 'blizzard');
assert.ok(palace, 'palace map exists');
assert.ok(canyon?.shortcuts?.[0], 'canyon has a dedicated shortcut branch');
assert.equal(canyon.shortcuts[0].shape, undefined, 'canyon shortcut does not weave through the main route');
assert.ok(blizzard?.snow > 0, 'blizzard weather enables snow particles');
assert.equal(blizzard?.rain, 0, 'blizzard does not also spawn rain');
assert.equal(palace.palaceGate.gate, 2);
assert.equal(palace.coaster.mode, 'manual');
assert.ok(palace.coaster.apex >= 12 && palace.coaster.apex <= 24);
// 熔岩夜航（magma）主题化验收：亮蓝水道 / 大浪 / 冷色资产裁剪 / 专属障碍。
const magma = MAPS.find((m) => m.id === 'magma');
assert.ok(magma, 'magma map exists');
// 熔岩图的航道水面复用其它地图的着色路径（Water.js 里走廊内直接用 waterShade）：
// 这里只给它一套"夜航蓝"水色。水色必须是冷蓝 —— 旧版是暖橙，
// 整条航道像一块橙黑地壳，玩家看不出浪面起伏。
const magmaShallow = magma.waterColor;
assert.ok((magmaShallow & 0xff) > ((magmaShallow >> 16) & 0xff) + 20, 'magma shallow water is a cool blue tone');
assert.ok((magma.waterDeep & 0xff) > 30, 'magma deep water keeps a blue channel');
assert.ok((magma.lava.weather?.waveScale ?? 0) >= 1.2, 'magma raises the swell so waves are visibly big');
assert.ok(!magma.lava?.azure, 'magma no longer paints its own azure water layer');
// 冷色通用 GLB（青绿加速水道 / 黑色弹射器 / 紫环传送门）在熔岩图里裁掉：
// 赛道着色是黑橙，冷色资产既出戏、又和新增的喷发泉/浮桶抢节奏。
assert.deepEqual(magma.marineFeatures.skip, ['boost', 'launch'], 'magma skips the cold-tone boost lane and launcher GLBs');
assert.ok(!magma.courseProps.some((p) => p.kind === 'portal'), 'magma no longer uses the violet portal ring');
assert.ok(magma.courseProps.some((p) => p.kind === 'hammer'), 'magma keeps a readable hazard prop');
// 熔岩专属障碍：横向漂移浮桶 + 定时喷发泉，全部确定性摆位（联机两端一致）。
// 摆位必须避开起点/终点门与浮标门，否则会在起跑线上生成障碍。
const magmaReserved = new Set([0, magma.marineFeatures.buoyGate]);
for (const d of magma.magmaHazards?.drifters || []) {
  assert.ok(Number.isInteger(d.gate) && d.gate >= 0 && d.gate < magma.gates.length, 'magma drifter sits on the route');
  assert.ok(!magmaReserved.has(d.gate), 'magma drifter keeps clear of the start line and buoy gate');
  assert.ok(d.span > 0.6 && d.span < 1.4, 'magma drifter sweep leaves one side passable');
  assert.ok(d.period > 0 && d.period < 12, 'magma drifter cycles in a readable rhythm');
}
for (const g of magma.magmaHazards?.geysers || []) {
  assert.ok(Number.isInteger(g.gate) && g.gate >= 0 && g.gate < magma.gates.length, 'magma geyser sits on the route');
  assert.ok(!magmaReserved.has(g.gate), 'magma geyser keeps clear of the start line and buoy gate');
  assert.ok(Math.abs(g.side) > 0 && Math.abs(g.side) < 0.7, 'magma geyser is offset to one side so the other lane stays open');
}
assert.ok((magma.magmaHazards?.drifters?.length ?? 0) >= 2, 'magma ships drifting volcanic obstacles');
assert.ok((magma.magmaHazards?.geysers?.length ?? 0) >= 2, 'magma ships timed lava geysers');
assert.ok((magma.magmaHazards?.rollers?.length ?? 0) >= 2, 'magma ships rolling boulders');
assert.ok((magma.magmaHazards?.impactRocks?.length ?? 0) >= 1, 'magma ships ram-to-shatter rocks');
// 回归：滚石/喷发泉的失控必须挂在 #marineHit 的返回值上。
// 曾经写成「无条件 stunTimer = 0.5」，全图每帧都在失控 → 油门/转向全部被吞
// （症状就是"按前进左右键半天没反应"）。
{
  const trackSrc = fs.readFileSync(path.join(root, 'src', 'game', 'Track.js'), 'utf8');
  assert.ok(
    trackSrc.includes('if (this.#marineHit(boat, c, 0.45)) boat.stunTimer'),
    'magma roller only stuns the boat on a real hit',
  );
  assert.ok(
    trackSrc.includes('if (this.#marineHit(boat, c, 0.4)) boat.stunTimer'),
    'magma geyser only stuns the boat on a real hit',
  );
}

// 熔岩环线：东/西各一个 U 型发卡（48 门，手摆航点 + 弧长重采样）。
// 约束：不压起点门 / 浮标门，转角不会大到把护栏折穿。
assert.equal(magma.gates.length, 48, 'magma loop is the 48-gate U-turn layout');
assert.ok(magma.marineFeatures.buoyGate > 0 && magma.marineFeatures.buoyGate < magma.gates.length, 'magma buoy gate is on the new loop');
for (const h of [...magma.magmaHazards.drifters, ...magma.magmaHazards.geysers, ...magma.magmaHazards.rollers]) {
  assert.ok(Number.isInteger(h.gate) && h.gate > 0 && h.gate < magma.gates.length, `${h.gate} stays on the loop`);
}
// 最大相邻转角（近似）：48 门里不该出现 > 60° 的折角（那是旧 20 门才会有的急弯）
{
  const g = magma.gates;
  let maxTurn = 0;
  for (let i = 0; i < g.length; i++) {
    const p = g[(i - 1 + g.length) % g.length], c = g[i], n = g[(i + 1) % g.length];
    const a1 = Math.atan2(c[0] - p[0], c[1] - p[1]);
    const a2 = Math.atan2(n[0] - c[0], n[1] - c[1]);
    let d = Math.abs(a2 - a1);
    while (d > Math.PI) d = Math.abs(d - Math.PI * 2);
    maxTurn = Math.max(maxTurn, d);
  }
  assert.ok((maxTurn * 180) / Math.PI < 60, `magma U-turn layout has no wall-folding corner (max ${(maxTurn * 180 / Math.PI).toFixed(1)}deg)`);
}

// 断层火山带：硬核档 4 道（两道主环 + 东/西发卡出口各一道）。
// 上限按硬核档放宽到 width 18 / minSpeed 26，但下限也同步抬高，
// 防止以后有人把裂谷悄悄调回"随便开过去"的 10m / 15m/s。
assert.ok((magma.faults?.length ?? 0) >= 4, 'hardcore magma ships four fault rifts');
for (const f of magma.faults) {
  assert.ok(Number.isInteger(f.after) && f.after >= 1 && f.after < magma.gates.length, 'magma fault sits on a mid-course segment');
  assert.ok(f.width >= 12 && f.width <= 18, 'hardcore magma fault gap is wide and not trivial');
  assert.ok(f.minSpeed >= 18 && f.minSpeed <= 26, 'hardcore magma fault speed gate is demanding but reachable');
}
// 裂谷几何必须由 faults.js 单一真源算出来（Track 建几何 / Water 挖洞共用一份）
{
  const rects = faultRects(magma);
  assert.equal(rects.length, magma.faults.length, 'faultRects covers every authored fault');
  for (const r of rects) {
    assert.ok(Number.isFinite(r.cx) && Number.isFinite(r.cz), 'fault rect has a world position');
    assert.ok(Math.abs(Math.hypot(r.fx, r.fz) - 1) < 1e-6, 'fault rect has a unit forward vector');
    assert.ok(r.halfAcross === magma.gateWidth, 'fault rect spans the corridor width');
  }
}
// 硬核档：跳板保送和"浪尖抛飞白嫖"两条旁路都必须关掉，
// 否则 20m/s 的速度门槛会被这两条捷径架空（用户反馈"正常移动都能开过去"）。
assert.ok(!magma.magmaHazards?.jumpPads, 'hardcore magma has no guaranteed fault jump pads');
assert.ok(magma.noWaveLaunch === true, 'hardcore magma disables the free wave-launch bypass');
// Blender 岩石障碍：GLB 真的存在、门号不撞裂谷段/其它机关、碰撞代理写在 Track 里
{
  const obs = magma.magmaObstacles || [];
  assert.ok(obs.length >= 6, 'magma ships Blender-built rock obstacles');
  for (const name of ['volcanic_pillar', 'lava_spikes', 'obsidian_shard']) {
    assert.ok(fs.existsSync(path.join(root, 'public', 'models', 'magma', name + '.glb')),
      `${name}.glb is shipped`);
  }
  const faultSegs = new Set(magma.faults.map((f) => f.after));
  const hazardGates = new Set([
    ...magma.magmaHazards.drifters.map((x) => x.gate),
    ...magma.magmaHazards.geysers.map((x) => x.gate),
    ...magma.magmaHazards.rollers.map((x) => x.gate),
    ...magma.magmaHazards.impactRocks.map((x) => x.gate),
    ...magma.courseProps.filter((p) => Number.isInteger(p.gate)).map((p) => p.gate),
  ]);
  for (const o of obs) {
    assert.ok(Number.isInteger(o.gate) && o.gate > 0 && o.gate < magma.gates.length,
      `magma obstacle ${o.gate} sits on the loop`);
    assert.ok(!faultSegs.has(o.gate), `magma obstacle ${o.gate} keeps clear of fault segments`);
    assert.ok(!hazardGates.has(o.gate), `magma obstacle ${o.gate} keeps clear of other hazards`);
    assert.ok(Math.abs(o.side) > 0.5 && Math.abs(o.side) < 0.9,
      `magma obstacle ${o.gate} leaves the opposite lane passable`);
    assert.ok(['pillar', 'spikes', 'shard'].includes(o.kind), `magma obstacle ${o.gate} has a GLB prototype`);
  }
  const trackSrc = fs.readFileSync(path.join(root, 'src', 'game', 'Track.js'), 'utf8');
  assert.ok(trackSrc.includes("type: 'magmaObstacle'"), 'Blender rocks get JS circle collision proxies');
  assert.ok(trackSrc.includes('bottomY: y - 0.5, topY:'), 'static rock proxies also block airborne boats');
  // Step 2：两条发卡内切近道 + 冷却航道遮罩要一起烘，否则近道下面是活岩浆
  assert.ok((magma.shortcuts?.length ?? 0) >= 2, 'magma hardcore ships two hairpin shortcuts');
  const waterSrc = fs.readFileSync(path.join(root, 'src', 'game', 'Water.js'), 'utf8');
  assert.ok(waterSrc.includes('for (const sc of mapDef.shortcuts || [])'),
    'shortcut lanes are baked into the cooled-lava corridor mask');
}
// 熔岩「逐天气适配」：同一张火山图在白昼/黄昏/雷暴/雪暴/星夜下要各有面孔。
// 旧版把 weather.id 写死成 'starry'，RealSky 永远取同一套大气预设 → 切天气看不出来。
{
  const by = magma.lava.weatherBy;
  assert.ok(by, 'magma ships per-weather volcanic palettes');
  for (const id of ['day', 'dusk', 'storm', 'blizzard', 'starry']) {
    const w = by[id];
    assert.ok(w, `magma has a palette for ${id}`);
    assert.equal(w.id, undefined,
      `palette ${id} must not override the weather id (RealSky picks its atmosphere by id)`);
    assert.ok(w.sky && typeof w.sky === 'object' && w.sky.top, `palette ${id} grades the sky`);
    assert.ok(typeof w.name === 'string' && w.name.length > 0, `palette ${id} has a readable label`);
  }
  // 亮度/能见度/浪高必须真的拉开，否则玩家还是"区别不开"
  assert.ok(by.day.sunIntensity > by.starry.sunIntensity, 'magma day is brighter than the starry night');
  assert.ok(by.day.fogDensity < by.starry.fogDensity, 'magma day is clearer than the starry night');
  assert.ok(by.starry.sunIntensity > 0.78, 'magma night was lifted out of black-silhouette territory');
  assert.ok(by.storm.waveScale > by.starry.waveScale, 'magma thunderstorm raises the swell further');
  assert.ok(by.blizzard.hemiIntensity >= 1.2, 'magma snowstorm rides on cold sky light');
  assert.equal(by.day.noDayCycle, true, 'magma keeps its volcanic grade instead of the dynamic day cycle');
  assert.ok(by.storm.fogDarken > 0.34, 'magma thunderstorm keeps the volcanic range visible');

  const gameSrc = fs.readFileSync(path.join(root, 'src', 'game', 'Game.js'), 'utf8');
  assert.ok(gameSrc.includes('lava.weatherBy?.[base.id]'),
    'theme weather derives from the player-picked weather id');
  assert.ok(!gameSrc.includes("id: 'starry', name: '熔岩星夜'"),
    'magma no longer pins the weather id to starry');
  assert.ok(gameSrc.includes('merged.skyTop = palette.sky.top'),
    'sky top colour is mirrored to skyTop so water reflections follow it');
  const skySrc = fs.readFileSync(path.join(root, 'src', 'game', 'RealSky.js'), 'utf8');
  assert.ok(skySrc.includes('const o = w.sky || {}'), 'RealSky accepts per-map sky overrides');
  const envSrc = fs.readFileSync(path.join(root, 'src', 'game', 'Environment.js'), 'utf8');
  assert.ok(envSrc.includes('if (w.fogDarken)'), 'fog darkening is configurable per map');
  assert.ok(envSrc.includes('!w.noDayCycle'), 'the dynamic day cycle can be disabled per map');
}
// 熔岩障碍「贴图 + 烘焙」：Blender 侧要盒式投影 UV、射线烘 AO，GLB 要真的带贴图
{
  const src = fs.readFileSync(path.join(root, 'scripts', 'blender', 'build_magma_obstacles.py'), 'utf8');
  assert.ok(src.includes('def box_uv'), 'rock props use box-projected UVs for the tiling texture');
  assert.ok(src.includes('def bake_vertex_color'), 'rock props bake AO into vertex colours');
  assert.ok(src.includes('BVHTree.FromObject'), 'vertex AO is ray-cast, not faked');
  assert.ok(src.includes('def pvoronoi'), 'rock grain is generated procedurally, not downloaded');
  const glb = fs.readFileSync(path.join(root, 'public', 'models', 'magma', 'volcanic_pillar.glb'));
  const head = glb.toString('utf8', 0, Math.min(glb.length, 6000));
  assert.ok(head.includes('TEXCOORD_0'), 'rock GLB carries UVs');
  assert.ok(head.includes('baseColorTexture'), 'rock GLB carries an albedo texture');
  assert.ok(head.includes('emissiveTexture'), 'rock GLB carries an emissive crack texture');
  assert.ok(head.includes('COLOR_0'), 'rock GLB carries baked vertex AO');
  for (const t of ['basalt_albedo.jpg', 'basalt_emissive.png', 'obsidian_albedo.jpg', 'obsidian_emissive.png']) {
    const p = path.join(root, 'public', 'models', 'magma', 'tex', t);
    assert.ok(fs.existsSync(p), `texture ${t} exists`);
    assert.ok(fs.statSync(p).size > 2000, `texture ${t} is not a blank file`);
  }
  const trackSrc = fs.readFileSync(path.join(root, 'src', 'game', 'Track.js'), 'utf8');
  assert.ok(trackSrc.includes('function tuneMagmaMat'),
    'rock materials are tuned for repeat wrapping and emissive bloom');
  assert.ok(trackSrc.includes('uv.setXY(i, uv.getX(i) + ox'),
    'instances offset their UVs so nine rocks do not share one pattern');
}
// 硬物撞击：滚石/火成岩必须带 heavy 标记，Boat 才会走"回弹 + 侧翻 + 甩头"分支
{
  const trackSrc = fs.readFileSync(path.join(root, 'src', 'game', 'Track.js'), 'utf8');
  assert.ok(trackSrc.includes("type: 'magmaRoller', x: b.x, z: b.z, r: b.r, heavy: true"), 'rolling boulders are heavy bodies');
  assert.ok(trackSrc.includes("type: 'magmaImpact', x: rock.x, z: rock.z, r: rock.r, heavy: true"), 'impact rocks are heavy bodies');
  const boatSrc = fs.readFileSync(path.join(root, 'src', 'game', 'Boat.js'), 'utf8');
  assert.ok(boatSrc.includes('if (c.heavy)'), 'Boat has a dedicated heavy-impact branch');
  assert.ok(boatSrc.includes('this.heavyImpactSpeed = 0;'), 'heavy impact speed resets every frame');
  // 腾空穿模修复：动态障碍必须带高度范围（Boat 的 airborne sweep 只认 bottomY/topY），
  // applyMechs 也不能再对 airborne 整个早退，否则"飞过去"时连减速反馈都没有。
  assert.ok((trackSrc.match(/bottomY:/g) || []).length >= 4,
    'magma dynamic colliders expose vertical bounds so airborne boats cannot clip through them');
  assert.ok(trackSrc.includes('this.#airborneMagmaHit(boat)'),
    'applyMechs still resolves magma hits while the boat is airborne');
}

// 烘焙赛道（baked）是"Blender 几何 + 中心线"的另一套体系：没有浮标/加速带/弹射链，
// 也没有水面领奖台锚点，下面这批共享海面竞赛特性只对程序化水面赛道成立。
for (const map of MAPS.filter((m) => !m.baked)) {
  assert.ok(map.marineFeatures, `${map.id} defines shared sea-race features`);
  assert.ok(map.podium, `${map.id} has an authored offshore podium anchor`);
  assert.ok(Number.isFinite(map.podium.x) && Number.isFinite(map.podium.z), `${map.id} podium anchor has a valid water position`);
  const nearestGate = Math.min(...map.gates.map(([x, z]) => Math.hypot(map.podium.x - x, map.podium.z - z)));
  assert.ok(nearestGate > map.gateWidth * 3, `${map.id} podium is far outside its race route`);
  for (const key of ['boostGate', 'buoyGate']) {
    assert.ok(Number.isInteger(map.marineFeatures[key]), `${map.id} has ${key}`);
    assert.ok(map.marineFeatures[key] >= 0 && map.marineFeatures[key] < map.gates.length, `${map.id} ${key} is on the route`);
  }
  // 弹射链：并排交替黑色弹射器（旧 platformGate 单平台已废弃）
  const chain = map.marineFeatures.launchChain;
  assert.ok(chain, `${map.id} defines a launch chain`);
  assert.ok(Number.isInteger(chain.startGate) && chain.startGate >= 0 && chain.startGate < map.gates.length, `${map.id} launch chain starts on the route`);
  assert.ok(chain.count >= 3 && chain.count <= 4, `${map.id} launch chain has 3-4 pairs`);
  // 链尾不得扫回起点/终点区（旧 lake/ocean 链尾组正落在起点线旁的 bug）
  assert.ok(chain.startGate + chain.count * 2 <= map.gates.length + 2, `${map.id} launch chain tail stays clear of the start/finish gates`);
  if (map.dives?.length) {
    const inDive = map.dives.some((d) => chain.startGate >= d.from && chain.startGate <= d.to - 1);
    assert.ok(inDive, `${map.id} launch chain start gate sits inside a dive section`);
  }
  if (!chain.underwater) {
    for (const shortcut of map.shortcuts || []) {
      assert.ok(chain.startGate < shortcut.from - 1 || chain.startGate > shortcut.to, `${map.id} launch chain does not sit inside the ${shortcut.from}-${shortcut.to} shortcut corridor`);
    }
  }
}

// 全封闭管道隧道：仅存在于差异化地图，覆盖主道中段、窄于主道、远离近道。
for (const map of MAPS) {
  if (!map.tunnel) continue;
  assert.ok(Number.isInteger(map.tunnel.from) && Number.isInteger(map.tunnel.to), `${map.id} tunnel spans explicit gate indices`);
  assert.ok(map.tunnel.from >= 0 && map.tunnel.to < map.gates.length && map.tunnel.from < map.tunnel.to, `${map.id} tunnel is a mid-course span`);
  assert.ok(map.tunnel.radius > 0 && map.tunnel.radius < map.gateWidth, `${map.id} tunnel is narrower than its course`);
  for (const shortcut of map.shortcuts || []) {
    assert.ok(map.tunnel.to < shortcut.from || map.tunnel.from > shortcut.to, `${map.id} tunnel stays clear of the ${shortcut.from}-${shortcut.to} shortcut`);
  }
}

function pointToSegmentDistance(point, start, end) {
  const dx = end[0] - start[0];
  const dz = end[1] - start[1];
  const lengthSq = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dz) / lengthSq));
  return Math.hypot(point[0] - (start[0] + dx * t), point[1] - (start[1] + dz * t));
}

function pointToPolylineDistance(point, points) {
  let distance = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    distance = Math.min(distance, pointToSegmentDistance(point, points[i], points[i + 1]));
  }
  return distance;
}

const canyonShortcut = canyon.shortcuts[0];
const canyonMainSection = canyon.gates.slice(canyonShortcut.from, canyonShortcut.to + 1);
for (const point of canyonShortcut.points.slice(1, -1)) {
  assert.ok(pointToPolylineDistance(point, canyonMainSection) > 14, 'canyon shortcut middle stays outside the main-route corridor');
}
for (const rock of canyon.rocks) {
  const clearance = rock.r + canyonShortcut.width + 2.5;
  assert.ok(pointToPolylineDistance([rock.x, rock.z], canyonShortcut.points) > clearance, 'canyon rocks leave the shortcut corridor clear');
}
for (const map of MAPS) {
  for (const shortcut of map.shortcuts || []) {
    assert.ok(shortcut.width <= map.gateWidth * 0.42, `${map.id} shortcut remains much narrower than its main course`);
    assert.ok(shortcut.from >= 2 && shortcut.to <= map.gates.length - 3, `${map.id} shortcut stays mid-course, clear of the start/finish gates`);
    const startGate = map.gates[shortcut.from];
    const endGate = map.gates[shortcut.to];
    // Authored mouths stay beside their entry/exit gates; Track snaps the exact
    // endpoints onto the main-route centerline at runtime (see #snapShortcutEnds).
    assert.ok(Math.hypot(shortcut.points[0][0] - startGate[0], shortcut.points[0][1] - startGate[1]) < map.gateWidth * 2.2, `${map.id} shortcut mouth sits beside its entry gate`);
    assert.ok(Math.hypot(shortcut.points.at(-1)[0] - endGate[0], shortcut.points.at(-1)[1] - endGate[1]) < map.gateWidth * 2.2, `${map.id} shortcut merge sits beside its exit gate`);
    const routeLength = (points) => points.slice(1).reduce(
      (sum, point, index) => sum + Math.hypot(point[0] - points[index][0], point[1] - points[index][1]),
      0,
    );
    const mainPoints = [];
    for (let gate = shortcut.from; ; gate = (gate + 1) % map.gates.length) {
      mainPoints.push(map.gates[gate]);
      if (gate === shortcut.to) break;
    }
    assert.ok(routeLength(shortcut.points) < routeLength(mainPoints), `${map.id} shortcut provides a real route-length reward`);
  }
}

const falcon = BOATS.find((b) => b.id === 'falcon');
const skiff = BOATS.find((b) => b.id === 'skiff');
const dolphin = BOATS.find((b) => b.id === 'dolphin');
const titan = BOATS.find((b) => b.id === 'titan');
// 2026-11-13：6 艘换成 tripo 的轻量模型，统一由 scripts/boats/slim_boats.py 规整：
// 去旋转（长轴 → +Z）、船头朝 +Z、船底 y=0、船长归一到 1.0。
// 所以这 6 艘**不允许**再出现 modelRotation* / modelScale —— 一旦出现就说明有人又把
// 斜着的原始模型塞回来了，那种模型在游戏里会"歪着跑"。
const SLIM_HULLS = {
  rower: 'boat_speedboat',
  skiff: 'boat_redcar',
  falcon: 'boat_car6',
  dolphin: 'boat_flycar',
  vintage: 'boat_jetboat',
  longship: 'boat_ship',
};
for (const [id, file] of Object.entries(SLIM_HULLS)) {
  const boat = BOATS.find((b) => b.id === id);
  assert.equal(boat.model, `/models/${file}.glb`, id + ' uses the slimmed tripo hull');
  assert.ok(fs.existsSync(path.join(root, 'public', 'models', `${file}.glb`)), file + '.glb exists in public models');
  assert.equal(boat.modelRotationY, undefined, id + ' hull is already bow-forward at +Z');
  assert.equal(boat.modelRotationX, undefined, id + ' hull has no baked pitch correction');
  assert.equal(boat.modelScale, undefined, id + ' hull is normalized to length 1.0');
  assert.ok(boat.modelLiftY < 0 && boat.modelLiftY > -0.6, id + ' hull sinks to its waterline');
}
assert.equal(falcon.maxSpeed, 36, 'falcon keeps the top speed and acceleration profile');
assert.equal(dolphin.turnRate, 1.62, 'dolphin keeps the sharpest turn rate');
assert.equal(BOATS.find((b) => b.id === 'trawler'), undefined, 'trawler params were retired with the 6-boat swap');
for (const boat of BOATS) {
  assert.ok(Math.abs(boat.boostPower - 1.8) < 0.05, `${boat.id} nitro speed is distinctly faster than normal cruise`);
  assert.ok(boat.maxSpeed * boat.boostPower > boat.maxSpeed * 1.7, `${boat.id} nitro has a clear speed separation from normal movement`);
}
for (const boat of BOATS) {
  assert.deepEqual(boat.stats, boatStatProfile(boat), `${boat.id} HUD stats derive from physics`);
}
assert.ok(boatCollisionMass(titan) > boatCollisionMass(falcon), 'stable broad hull has greater collision mass');
const titanHit = boatCollisionResponse(titan, falcon, -10, 1);
const falconHit = boatCollisionResponse(falcon, titan, -10, 1);
assert.ok(titanHit.deltaNormal < falconHit.deltaNormal, 'stable boat receives less collision velocity change');
assert.ok(titanHit.deltaNormal <= 8 && falconHit.deltaNormal <= 8, 'collision impulse is motion-safe capped');
assert.equal(boatCollisionRoll(titan, falcon, 10, 1), 0, 'stable hull does not capsize from a less stable impact');
const falconRoll = boatCollisionRoll(falcon, titan, 10, -1);
assert.ok(Math.abs(falconRoll) >= 0.69 && Math.abs(falconRoll) <= 0.86, 'unstable hull rolls 40-50 degrees after a strong impact');
const sideRadius = boatCollisionRadius(titan, 0, 1, 0);
const bowRadius = boatCollisionRadius(titan, 0, 0, 1);
assert.ok(bowRadius > sideRadius, 'boat collision covers the hull length as well as its width');
assert.ok(
  boatCollisionRadius(falcon, 0, 0, 1) + boatCollisionRadius(dolphin, 0, 0, 1) > 4,
  'boat envelopes cannot pass through bow-to-stern',
);
assert.ok(sideRadius * 2 < 4.8, 'parallel start slots remain clear of collision overlap');

// The chase camera must keep looking along the hull even when velocity points
// backwards (reverse thrust) instead of snapping to the motion vector.
const camera = new THREE.PerspectiveCamera(62, 1, 0.1, 1000);
const rig = new CameraRig(camera);
const reverseBoat = {
  pos: new THREE.Vector3(0, 0, 0),
  heading: 0.35,
  speed: 20,
  vel: new THREE.Vector2(-Math.sin(0.35) * 20, -Math.cos(0.35) * 20),
  drifting: false,
  boostTimer: 0,
};
rig.snapTo(reverseBoat);
rig.follow(reverseBoat, 1 / 60);
const viewDir = camera.getWorldDirection(new THREE.Vector3());
const forward = new THREE.Vector3(Math.sin(reverseBoat.heading), 0, Math.cos(reverseBoat.heading)).normalize();
assert.ok(viewDir.dot(forward) > 0.94, 'reverse camera stays on the forward hull axis');

const g3 = palace.gates[3];
const g4 = palace.gates[4];
const palaceMid = [(g3[0] + g4[0]) * 0.5, (g3[1] + g4[1]) * 0.5];
assert.ok(Math.hypot(palaceMid[0] - 82.5, palaceMid[1] - 140) < 0.01, 'palace landmark is in the later stable-depth corridor');
assert.equal(palace.coaster.from, 6);
assert.equal(palace.coaster.to, 9);
const gameSource = fs.readFileSync(path.join(root, 'src', 'game', 'Game.js'), 'utf8');
assert.ok(gameSource.includes('this.#updateNitroFx()'), 'boost exhaust is driven by the per-boat nozzle updater');
assert.ok(gameSource.includes('this.fx.playAttached(key, cfg.fx, follow'), 'boost uses one authoritative effect layer per nozzle');
assert.ok(!/playAttached\(key, 'jet'/.test(gameSource), 'boost exhaust no longer hardcodes a single shared jet');
const trackSource = fs.readFileSync(path.join(root, 'src', 'game', 'Track.js'), 'utf8');
const mapsSource = fs.readFileSync(path.join(root, 'src', 'data', 'maps.js'), 'utf8');
const environmentSource = fs.readFileSync(path.join(root, 'src', 'game', 'Environment.js'), 'utf8');
assert.ok(environmentSource.includes('const p0 = gates[3], p1 = gates[4]'), 'procedural palace is moved behind the initial dive ramp');
assert.ok(environmentSource.includes('const palaceFrom = gates[3], palaceTo = gates[4]'), 'GLB palace shares the later stable-depth placement');
assert.ok(environmentSource.includes('const hallZ = 18'), 'palace hall preserves a clear exit from the later corridor');
assert.equal(trackSource.includes('const edgeGeo = new THREE.SphereGeometry'), false, 'course edges no longer use unexplained yellow spheres');
assert.ok(trackSource.includes('#buildNeonPathWalls(sc.renderPoints, sc.width'), 'shortcut edges use the shared continuous neon walls, clipped outside the main corridor');
assert.ok(trackSource.includes('#snapShortcutEnds'), 'shortcut endpoints are snapped onto the main-route centerline for seamless merges');
assert.ok(trackSource.includes('blendLen'), 'shortcut corridors blend their constraint width at both ends');
assert.ok(trackSource.includes('candidateX = THREE.MathUtils.lerp(main.px, loc.px, s)'), 'shortcut centerline blends smoothly into the main route');
assert.ok(trackSource.includes("edgeType: 'shortcut'"), 'shortcut walls have a distinct semantic edge type');
assert.ok(trackSource.includes('color: 0x38f0c4'), 'shortcut walls use a restrained teal cue');
assert.ok(trackSource.includes("edgeType === 'shortcut' ? 0.92 : 1.35"), 'shortcut walls are lower without changing collision width');
assert.ok(trackSource.includes('#buildMarineFeatures()'), 'track loads the three authored sea-race asset types');
assert.ok(trackSource.includes("'/models/boost_water_lane.glb'"), 'track loads the boost-water GLB');
// 浮标已从低模 GLB 改成程序化几何（Track.js 里有注释说明），这里改验"旧 GLB 已退役"
assert.equal(trackSource.includes("'/models/red_buoy_chain.glb'"), false, 'buoy chain is procedural (old low-poly GLB retired)');
assert.ok(trackSource.includes("'/models/launch_platform.glb'"), 'track loads the launch-platform GLB');
assert.ok(trackSource.includes('boat.marineBoostCooldown'), 'water lanes have an independent repeat cooldown');
assert.ok(trackSource.includes("type: 'buoy'"), 'buoy chain creates lightweight collision proxies');
assert.ok(trackSource.includes('#buildBuoyFallback'), 'buoy collision proxies always have visible fallback markers');
assert.ok(trackSource.includes('boat.launchCooldown = 0.45'), 'launchers fire on touch with only an anti-repeat cooldown');
assert.ok(trackSource.includes("audio.play('launcher_launch')"), 'launchers play the dedicated launcher_launch SFX on touch (not wave_launch)');
assert.ok(trackSource.includes('#simLaunchArc'), 'launch chain spacing is solved with the same gravity model as the boat');
assert.ok(trackSource.includes('[-pairGap, pairGap]'), 'launch mode preserves the two-platform pair layout');
assert.ok(trackSource.includes('launchLaneSign'), 'launch mode alternates platform pairs left and right');
assert.ok(trackSource.includes('pairEdgeOffset'), 'launch pairs hug the left/right edges instead of a centerline line');
assert.ok(!trackSource.includes('launchSpeed = len / Math.max(0.1, flight)'), 'launch mode keeps tangent direction instead of re-aiming toward an offset pair');
assert.ok(trackSource.includes("this.opts?.mode === 'race' || this.opts?.mode === 'item'"), 'race and item modes keep only one paired launcher group');
assert.ok(trackSource.includes('underwaterLandingY'), 'underwater launch chains land back at dive depth');
assert.ok(trackSource.includes('boat.airborne = true'), 'open launch platform starts the reusable boat launch physics');
assert.ok(trackSource.includes('boat.heading = platform.dir'), 'launch platform aligns every boat with the route tangent before takeoff');
assert.ok(trackSource.includes('boat.vel.x = platform.fx * boat.speed'), 'launch platform applies forward route velocity');
assert.ok(trackSource.includes('const fraction = (playerIndex + 1) / (count + 1)'), 'start slots use the actual player count');
assert.ok(trackSource.includes('const laneSpan = Math.max(12.6'), 'start line expands with the available course width');
assert.ok(trackSource.includes('const formationLateral = (fraction - 0.5) * laneSpan'), 'boats are evenly spaced on one straight starting line');
assert.ok(trackSource.includes('const soloLateral = count === 1'), 'solo maps can correct the starting camera lane');
assert.equal(MAPS.find((m) => m.id === 'canyon')?.soloStartLateral, 4.5, 'canyon solo start clears the opening obstacle');
assert.ok(!trackSource.includes('const row = Math.floor(playerIndex / 2)'), 'staggered two-row start is removed');
const boatsSource = fs.readFileSync(path.join(root, 'src', 'data', 'boats.js'), 'utf8');
// 朝向必须"有交代"：要么 boats.js 里显式写 modelRotationY（磐石号 / 牛来号），
// 要么模型在 Blender 里已经把船头烘到 +Z（6 艘轻量船）。
assert.equal(
  (boatsSource.match(/modelRotationY:/g) || []).length + Object.keys(SLIM_HULLS).length,
  BOATS.length,
  'every boat model has an explicit or pre-baked forward orientation',
);
assert.ok(gameSource.includes('spawnTransform(i, this.order.length)'), 'spawn spacing receives the actual racer count');
const cameraSource = fs.readFileSync(path.join(root, 'src', 'game', 'CameraRig.js'), 'utf8');
assert.ok(cameraSource.includes('focusPodium(group, dt)'), 'podium reveal uses a dedicated close camera');
const mainSource = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
const replayHandler = mainSource.slice(mainSource.indexOf("UI.el('btn-back-lobby').onclick"));
assert.ok(replayHandler.indexOf('enterMapSelect();') < replayHandler.indexOf("net.send({ t: 'backLobby' });"), 'final replay shows map selection before resetting the room');
assert.ok(gameSource.includes('showPodium(entries'), 'podium is created inside the active race scene');
assert.ok(gameSource.includes('this.scene.add(group)'), 'podium is a world-space scene object');
assert.ok(gameSource.includes('this.mapDef.podium'), 'podium uses the map-authored offshore anchor instead of the finish position');
assert.ok(gameSource.includes('finishWindowActive'), 'finisher enters an observation window instead of immediate settlement');
assert.ok(gameSource.includes('firstFinisher && this.solo'), 'solo AI first finisher opens the same observation window');
assert.ok(gameSource.includes('keepAfterFinishLine'), 'finisher cannot cross back over the finish line');
assert.ok(gameSource.includes('source.modelRoot || source.fallbackHull'), 'podium uses the loaded boat visual with a fallback hull');
assert.ok(fs.readFileSync(path.join(root, 'server', 'server.js'), 'utf8').includes('}, 10000);'), 'finish window closes ten seconds after the first finisher');
const serverSource = fs.readFileSync(path.join(root, 'server', 'server.js'), 'utf8');
assert.ok(!serverSource.includes('const allDone = racers.every'), 'all-finished shortcut cannot bypass the ten-second window');
assert.ok(serverSource.includes('racers.some((p) => p.finished && p.finishTime != null)'), 'server starts the window for AI or any human finisher');
assert.ok(serverSource.includes('Never end early when all remaining racers happen to finish in that window'), 'server documents the fixed finish window');
// Network snapshots must preserve the collision capsize signal and let the
// local client consume the server correction instead of dropping its own id.
assert.ok(gameSource.includes('r: +b.collisionRoll.toFixed(3)'), 'client serializes collision roll in its network state');
assert.ok(gameSource.includes('const [id, x, z, h, s, b, y, vx, vz, roll]'), 'snapshot decoding preserves collision roll');
assert.ok(gameSource.includes('setRemoteState'), 'snapshot handling applies server state through the boat remote-state path');
assert.ok(gameSource.includes('applyNetworkCollisionState'), 'local boats apply authoritative collision corrections from snapshots');
assert.ok(!gameSource.includes('if (id === this.myId) continue;'), 'local snapshots are not discarded before authoritative correction');
assert.ok(serverSource.includes('msg.r'), 'server persists the collision roll in authoritative snapshots');
assert.ok(serverSource.includes('me.id === getHostId()'), 'only the host may publish state for another racer (including AI)');
assert.ok(serverSource.includes('hostAuth') && /target\.ai[), ]+&&[ (]+hostAuth/.test(serverSource), 'non-host clients cannot spoof AI state');
assert.ok(mainSource.includes('function buildSoloResults(info)'), 'solo podium results are collected when the window closes');
assert.ok(mainSource.includes('filter((r) => !r.dnf && r.time != null)'), 'only completed racers are eligible for podium slots');
assert.ok(mainSource.includes('enterMapSelect()'), 'final replay returns the host to map selection');
assert.equal(trackSource.includes('const edgeGeo = new THREE.TorusGeometry(0.82, 0.12'), false, 'shortcut edges no longer use partial ring markers');
// 旧断言钉的是 pistonMarkerMat 这个变量名；活塞柱视觉后来被整体移除，
// 只剩地图里声明的门号用于道具布点避让。改成断言避让链路仍在，别把已删的实现钉死。
assert.ok(trackSource.includes('this.map.pistonIndices || []'), 'declared moving-obstacle gate indices still drive item placement clearance');
assert.ok(!mapsSource.includes('hidden: true'), 'all shortcuts show a readable entrance instead of blending into the main route');
const itemsSource = fs.readFileSync(path.join(root, 'src', 'game', 'Items.js'), 'utf8');
assert.ok(itemsSource.includes("if (!this.magnetAim.target)"), 'magnet aim cancels immediately without a target');
assert.ok(itemsSource.includes('#makeMagnetReticle'), 'magnet aim has a world-space lock reticle');
assert.ok(itemsSource.includes('color: 0xff283d'), 'locked magnet targets use a red reticle');
assert.ok(itemsSource.includes('noTargetGrace: 0.7'), 'neutral aim feedback is brief before an unlocked magnet cancels');
assert.ok(itemsSource.includes('d > 120'), 'magnet scans a broad forward range');
assert.ok(itemsSource.includes('lockDelay: 0.38'), 'magnet auto-pulls after a readable lock delay');
for (const item of ['slowboat', 'waterfall', 'bubblefly', 'tide']) {
  assert.ok(itemsSource.includes(`${item}:`), `${item} item definition exists`);
  assert.ok(itemsSource.includes(`case '${item}'`), `${item} item release logic exists`);
}
assert.ok(!itemsSource.includes("antimagn: { name: '反磁护盾', icon: '🧿', color: 0xff6d9a, desc:"), 'anti-magnet item is removed from the racing item pool');
assert.ok(!itemsSource.includes("decoy: { name: '诱饵艇', icon: '🛶', color: 0xffb45c, desc:"), 'decoy item is removed from the racing item pool');
// Boat.js 在 Windows 下是 CRLF：源码断言按 \n 写，先统一行尾再比对
const boatSource = fs.readFileSync(path.join(root, 'src', 'game', 'Boat.js'), 'utf8').replace(/\r\n/g, '\n');
assert.ok(boatSource.includes('this.networkCorrection = correction'), 'local authoritative corrections are buffered for smooth reconciliation');
assert.ok(boatSource.includes('distance > 5 || heightDelta > 4'), 'large network discontinuities still snap instead of drifting indefinitely');
assert.ok(boatSource.includes('Math.exp(-9 * dt)'), 'network reconciliation uses a damped correction instead of per-snapshot teleporting');
assert.ok(boatSource.includes('props with vertical bounds get a 3D sweep here'), 'airborne boats sweep static obstacle bounds');
assert.ok(boatSource.includes('Number.isFinite(c.bottomY)'), 'airborne collision ignores colliders without vertical bounds');
assert.ok(environmentSource.includes("type: 'rock'"), 'map rocks expose a distinct collision type');
assert.ok(environmentSource.includes('bottomY: centerY - halfHeight') && environmentSource.includes('topY: centerY + halfHeight'), 'rock colliders cover their visible vertical extent');
assert.ok(environmentSource.includes("type: 'island'"), 'map islands expose vertical collision bounds');
assert.ok(environmentSource.includes("type: 'cliff'"), 'canyon mountains expose a distinct collision type');
assert.ok(environmentSource.includes('shortcutClearance'), 'canyon shore props leave shortcut corridors clear');
// 2026-11-15 山脊"纵向拉丝"修复。旧验收只查无破面/色板/性能，
// 完全没有判据去抓贴图或阴影被拉成长条，所以带竖条的截图也 PASS 了。
assert.ok(environmentSource.includes('uvs[vi * 2 + 1] = arc / tileM;'),
  'mountain UVs use slope arc length so the texture cannot stretch into vertical streaks');
assert.ok(environmentSource.includes('normals.set(smoothN);'),
  'mountain normals are smoothed around the ring so lighting cannot paint vertical shadow bands');
assert.ok(environmentSource.includes('const nIso = makeMountainNoise2D'),
  'surface colour uses isotropic noise instead of nx-much-greater-than-ny stripe noise');
assert.ok(!environmentSource.includes("makeRockPhotoTexture('/textures/rock/aerial_rocks_02_diff_1k.jpg'"),
  'directional aerial-rock photo is no longer used on the ridge sheet');
assert.ok(environmentSource.includes('smoothstep(H, 0.0, 0.28)'),
  'mountain foot haze uses relative height to avoid a hard white band at the waterline');
// 2026-11-16 山脊"贴图贫瘠"二次修复。旧版把照片全删了，只剩近纯白 + 极淡圆斑，
// 乘上顶点色/大气透视后什么都看不见；110m 才铺一张又被 mipmap 抹平。
assert.ok(environmentSource.includes('const H = new Float32Array(S * S);'),
  'mountain rock texture builds a real height field instead of flat pale blobs');
assert.ok(environmentSource.includes('const gx = (at(x + 1, y) - at(x - 1, y)) * 6.0;'),
  'relief shading is baked from the height-field gradient (baked shadows + topology)');
assert.ok(environmentSource.includes("photo.src = '/textures/rock/rock_face_diff_1k.jpg';"),
  'real isotropic rock-face photo detail is layered on top, without its brown hue');
assert.ok(environmentSource.includes('tileM: 72'),
  'texture tile is small enough that rock detail survives mipmapping');
assert.ok(environmentSource.includes('Math.max(lowHaze, footFade)'),
  'foot haze no longer stacks into a white band that washes out the texture');
assert.ok(!environmentSource.includes('const worleyEdge'),
  'no cellular crack network: it reads as a tiled paving grid on distant peaks');
// 2026-11-16 删除 ocean 远景白色圆顶。它们不是冰山，是 #buildDistantIsles 的
// 7 个程序化半球被雾洗白（画面里只露出 2 个）。删几何体时必须照常消耗 35 次
// this.rng()，否则 #buildShores / #buildRocks / #buildWhales / #buildShips 全部挪位。
assert.ok(!environmentSource.includes('#buildDistantIsles('),
  'ocean distant isle half-spheres no longer generate geometry');
assert.ok(environmentSource.includes('#consumeDistantIslesRng()'),
  'the removed isles still consume their LCG slots so downstream props stay put');
assert.ok(environmentSource.includes('for (let k = 0; k < 5; k++) this.rng();'),
  'all 35 rng draws (7 isles x 5) are preserved');
assert.ok(environmentSource.includes('bottomY: -h * 0.4'), 'canyon mountain colliders cover their lower vertical extent');
assert.ok(environmentSource.includes('topY: h * 0.95'), 'canyon mountain colliders cover their upper vertical extent');
assert.ok(boatSource.includes('this.visualRotationY = Number.isFinite(def.visualRotationY) ? def.visualRotationY : 0'), 'visual boat rotation is protected from GLB animation transforms');
assert.ok(boatSource.includes('cancelDriftForCollision()'), 'boat exposes one authoritative drift-collision reset');
// 2026-11-16 漂移重做后的口径：撞障碍**只退掉本次漂移新增的集气**，氮气瓶一个都不掉
assert.ok(boatSource.includes('if (this.nitroCharge > this.driftGaugeStart) this.nitroCharge = this.driftGaugeStart;'),
  'collision rolls the bottom gauge back to the pre-drift value only');
assert.ok(!/cancelDriftForCollision\(\)[\s\S]{0,900}?this\.nitroBottles\s*=\s*0/.test(boatSource),
  'collision never wipes stored nitro bottles');
assert.ok(boatSource.includes('if (this.driftCollided || this.driftBoostCd > 0) return 0;'),
  'collided drift cannot grant an exit boost');

// ---------- 漂移模型契约（2026-11-16 重做）----------
assert.ok(DRIFT_SPEED_RATIO >= 0.9, 'drift ceiling stays within 10% of the straight-line top speed');
assert.ok(DRIFT_TUNING.speedRatio >= 0.9, 'drift speed cap is progressive, not a hard chop');
assert.ok(DRIFT_TUNING.pathYaw > 1, 'drift turns tighter than normal steering (otherwise drifting is strictly worse)');
assert.ok(DRIFT_TUNING.doubleAngle * 180 / Math.PI >= 23 && DRIFT_TUNING.doubleAngle * 180 / Math.PI <= 27,
  'double spray unlocks near 25 degrees and stays below the heaviest boat peak slip angle');
assert.ok(DRIFT_TUNING.angleBase + DRIFT_TUNING.angleGain <= 0.60, 'slip angle cap was reduced so the hull no longer slides outward ~37 degrees');
assert.ok(DRIFT_TUNING.pathYaw >= 1.4, 'drift trajectory is pulled inward (R = v / yawRate, was 28m / now ~22m)');
assert.ok(DRIFT_TUNING.pathYawTau <= 0.07, 'drift starts turning immediately instead of flinging wide for the first half second');
assert.ok(DRIFT_TUNING.singleAngle < DRIFT_TUNING.doubleAngle, 'single spray unlocks before the double spray');
assert.ok(DRIFT_TUNING.angleBase + DRIFT_TUNING.angleGain > DRIFT_TUNING.doubleAngle,
  'a full-speed drift can actually reach the double-spray slip angle');
assert.ok(DRIFT_TUNING.dragRamp > 0.2, 'drift deceleration ramps in over time instead of chopping speed on entry');
assert.ok(boatSource.includes('this.driftAngle = prevAng'), 'slip angle is a rate-limited continuous state');
assert.ok(boatSource.includes('this.heading += this.driftDA'), 'the nose follows the slip angle while the travel direction stays put');
assert.ok(boatSource.includes('vf = S * Math.cos(A)'), 'velocity is projected along the travel direction, not along the nose');
assert.ok(!boatSource.includes('driftCutTimer'), 'no residual entry speed chop from the old model');
assert.ok(!boatSource.includes('targetPull'), 'no step-switched steering multiplier from the old model');
assert.ok(boatSource.includes('this.driftChain = DRIFT_TUNING.chainWindow'), 'releasing drift opens the refill window instead of killing the charge');
assert.ok(boatSource.includes('this.driftBreak = Math.max(this.driftBreak, DRIFT_TUNING.relock);'),
  'straightening into a spray briefly blocks re-engaging, so the exit cannot stutter into a 0.1s drift');
assert.ok(boatSource.includes('const steerActive = Math.abs(steerTarget) > DRIFT_TUNING.steerDead;'),
  'rainbow counter-steer is judged on raw input, not the smoothed steer that crosses zero');
assert.ok(boatSource.includes('this.nitroBottles--;'), 'Ctrl consumes stored inventory rather than bottom charge');
assert.ok(boatSource.includes('collectNitroCharge(this.nitroCharge, this.nitroBottles'), 'drifting converts bottom charge into separate bottles');
assert.ok(trackSource.includes('boat.cancelDriftForCollision?.();'), 'track walls and every mechanic collision cancel the active drift reward');
assert.ok(boatSource.includes('bubbleTimer'), 'bubble trap limits steering through boat state');
assert.ok(itemsSource.includes('handle.setRotation'), 'directional item effects receive a heading');
assert.ok(gameSource.includes('getCamera: () => this.camera'), 'magnet reticle faces the active chase camera');
assert.ok(boatSource.includes('splashPool'), 'drift spray uses a pooled particle system');
assert.ok(boatSource.includes('#spawnDriftSplash'), 'drift spray is emitted from the stern');
assert.ok(boatSource.includes('new THREE.Mesh(this.wakeGeometry'), 'normal wakes use water-surface meshes instead of camera-facing sprites');
assert.ok(boatSource.includes('this.wakeGeometry.rotateX(-Math.PI / 2)'), 'normal wakes are horizontal on the water surface');
assert.ok(boatSource.includes('ctx.quadraticCurveTo(64, 70, 108, 8)'), 'wake texture is a directional V-shaped water ripple');
assert.ok(boatSource.includes('w.sprite.rotation.y = heading'), 'water ripples follow the boat heading');
assert.ok(boatSource.includes('this.wakeCrestGeometry = new THREE.PlaneGeometry'), 'normal wakes include a small upright stern-wave layer');
assert.ok(boatSource.includes('w.crest.material.color.copy(this.wakeColor.crest)'), 'upright stern waves inherit the weather-matched crest color');
assert.ok(boatSource.includes('w.sprite.material.color.copy(this.wakeColor.ripple)'), 'surface wake inherits the weather-matched water color');
assert.ok(boatSource.includes('this.#spawnDriftMark(this.pos.x, this.pos.z, velDir, 1)'), 'drift restores the twin water-surface tire marks');
assert.ok(!boatSource.includes('this.#spawnDriftSplash();\n        this.#spawnDriftSplash();'), 'drift no longer emits floating blue droplets');
// splashBurst 后来被重新实现为「落水/冲撞的水滴 + 水雾」（不再是空函数）。
// 断言拆成语义等价的两半：实现是水滴/水雾，且漂移段里没有再挂回爆发效果。
assert.ok(
  boatSource.includes('#splashBurst(intensity = 1)')
    && boatSource.includes('this.#emitDrop(') && boatSource.includes('this.#emitMist('),
  'splash burst is a droplet/mist impact effect instead of a radial fog burst',
);
assert.ok(
  !/if \(this\.drifting && this\.speed > 4\)[\s\S]{0,500}#splashBurst\(/.test(boatSource),
  'drift exit does not restore a radial fog burst',
);
assert.ok(boatSource.includes('this.bubbleTimer = 0'), 'angel clears active bubble steering restriction');
assert.ok(boatSource.includes('this.magnetTarget = null'), 'angel clears an active magnetic pull');
assert.ok(gameSource.includes('color: this.weather.waterColor ?? this.mapDef.waterColor'), 'boats receive the selected weather water color');
assert.ok(gameSource.includes('crest: this.weather.waterCrest ?? this.mapDef.waterCrest'), 'boats receive the selected weather water crest color');
for (const landmark of [
  'old_lighthouse.glb', 'lighthouse.glb', 'road_sign.glb',
  'british_road_sign.glb', 'low_poly_billboard_sign_-_standard.glb',
  'low_poly_street_light_pole.glb',
]) {
  assert.ok(environmentSource.includes(landmark), `${landmark} is registered as a course landmark`);
}
assert.ok(environmentSource.includes('#loadCourseLandmarks'), 'all maps load deterministic course landmarks');
assert.ok(environmentSource.includes('entries.indexOf(entry) * 700'), 'large landmarks are decoded progressively');
assert.ok(environmentSource.includes('#buildSnow'), 'environment has a dedicated snow particle system');
assert.ok(environmentSource.includes('const authoredBox = new THREE.Box3().setFromObject(root)'), 'palace GLB is fitted from its authored bounds');
assert.ok(environmentSource.includes('holder.scale.setScalar(fit)'), 'palace GLB is scaled as one outer scene');
assert.ok(environmentSource.includes('const aisle = Math.min(18'), 'palace keeps a central driving aisle');
assert.ok(environmentSource.includes('const wallLateral = atriumSide - 0.35'), 'palace wall colliders align with the inner wall line');
assert.ok(environmentSource.includes('for (let i = 0; i < 11; i++)'), 'palace side collision volumes cover the full crossing');
assert.ok(environmentSource.includes('const innerLateral = palaceAisle * 0.5'), 'palace inner red walls have dedicated collision coverage');
// 旧断言钉死了 '* 7' 这个魔法数；现在沿切线的位移抽成了 along 变量。
// 改判「朝向取自切线」+「侧向墙沿切线铺开」两个片段，语义不变但不绑行数。
assert.ok(
  environmentSource.includes('atrium.rotation.y = Math.atan2(pfx / plen, pfz / plen)')
    && environmentSource.includes('(pfx / plen) * along'),
  'palace hall follows the track tangent',
);
assert.ok(environmentSource.includes('const innerWallRadius = 1.35'), 'palace inner wall collision line uses a continuous proxy radius');
// 旧断言钉的是注释文本 'must not add invisible'。宫殿 GLB 后来改成可见，
// 只隐藏压到航道的柱子；等价判据：回调里确实隐藏了柱子，且整段不注册碰撞体。
const palaceBlock = environmentSource
  .slice(environmentSource.indexOf("loader.load('/models/coral_palace.glb'"))
  .split('// 沉船残骸')[0];
assert.ok(
  palaceBlock.includes('o.visible = false;') && !palaceBlock.includes('this.colliders.push'),
  'hidden authored palace columns do not add invisible collision volumes',
);
assert.ok(environmentSource.includes('maxDist2 = 110 * 110'), 'far landmarks are culled from the render path');
// 道具箱每排数量改成按赛道宽度分档（宽 7 / 窄 5），不再是写死的 7。
assert.ok(itemsSource.includes('const PER_ROW = width >= 12 ? 7 : 5;'), 'main item rows contain seven boxes on wide courses and five on narrow ones');
assert.ok(itemsSource.includes('for (const lane of [-1, 0, 1])'), 'shortcuts hold only three item boxes per branch');
assert.ok(itemsSource.includes("fx: 'magnet', dur: 0, target: null"), 'magnet broadcasts a clean cancellation when no target is available');
assert.ok(itemsSource.includes("if (boat.shieldTimer > 0)"), 'projectiles check shield state before applying hits');
assert.ok(itemsSource.includes("type: 'octopus'"), 'tracking octopus flies as a homing projectile');
assert.ok(itemsSource.includes("type: 'bubblefly'"), 'bubble dragonfly flies as a homing projectile');
assert.ok(itemsSource.includes('this.#attachOctopus(boat, p.mesh)'), 'octopus grabs the hull on impact');
assert.ok(boatSource.includes('GEYSER_LIFT_HEIGHT'), 'waterfall throws boats higher than the bubble vortex');
assert.ok(itemsSource.includes('#spawnGeyser'), 'waterfall reproduces the boss water column visual');
assert.ok(itemsSource.includes('#updateVoidWorld'), 'bubble dragonfly renders a pitch-black otherworld');
assert.ok(boatSource.includes('getEffectEnvelope()'), 'boats expose a loaded-hull defensive effect envelope');
assert.ok(itemsSource.includes('boat.getEffectEnvelope?.().scale || 1.25'), 'barriers fit each boat envelope dynamically');
assert.ok(itemsSource.includes("this.fx.playAttached(projectile.fxKey, 'itemBeam'"), 'bomb lightning stays attached throughout flight');
assert.ok(itemsSource.includes('this.#stopProjectileFx(p)'), 'projectile effects are cleaned up on termination');
assert.ok(itemsSource.includes('const DEFENSE_DURATION = 3'), 'all defensive item effects share a three-second duration');
assert.ok(boatSource.includes('this.halfSpeedTimer = Math.max(this.halfSpeedTimer, dur || 4)'), 'slow boat halves opponent top speed for four seconds');
assert.ok(boatSource.includes('this.octoGrabTimer = 0'), 'angel clears an active octopus grab');
assert.ok(itemsSource.includes("this.#playFx('tide'"), 'tide uses a dedicated flow effect');
assert.ok(itemsSource.includes("this.#playFx('bubble'"), 'bubble dragonfly uses a dedicated aura effect');
const effectsSource = fs.readFileSync(path.join(root, 'src', 'game', 'Effects.js'), 'utf8');
assert.ok(effectsSource.includes('handle.setScale(s.x, s.y, s.z)'), 'attached effects support per-boat scale');

for (const [name, def] of Object.entries(FX_DEFS)) {
  assert.ok(def.url.startsWith('/effects/'), `${name} must use a public effect path`);
  assert.ok(fs.existsSync(path.join(root, 'public', def.url.slice(1))), `${name} asset exists`);
}
for (const [name, file] of Object.entries({
  decoy: 'Basic/Simple_Turbulence_Particles.efkefc',
  tide: 'Basic/Simple_Track1.efkefc',
  bubble: 'Version16/Aura01.efkefc',
  antimagn: 'Version16/Barrior03.efkefc',
})) {
  assert.equal(FX_DEFS[name].url, `/effects/${file}`, `${name} uses the bundled Effekseer sample`);
}
assert.ok(itemsSource.includes("this.#playFx('bubble'"), 'bubble uses a dedicated aura effect');

// ---------- 怪物模式（打 BOSS）数据表 ----------
assert.equal(BOSS_LEVELS.length, 5, 'boss mode ships five stages (four originals + abyss herald)');
assert.deepEqual(
  BOSS_LEVELS.map((l) => l.weather),
  ['day', 'dusk', 'blizzard', 'storm', 'blizzard'],
  'boss stages use the existing day/dusk/blizzard/storm presets in order',
);
for (const level of BOSS_LEVELS) {
  // 天气必须来自现有预设，不能新增预设
  const weather = WEATHERS.find((w) => w.id === level.weather);
  assert.ok(weather, `stage ${level.stage} reuses an existing weather preset`);
  const boss = BOSSES[level.boss];
  assert.ok(boss, `stage ${level.stage} references a defined boss`);
  assert.equal(boss.id, level.boss);
  assert.ok(fs.existsSync(path.join(root, 'public', boss.model.slice(1))), `${boss.id} glb asset exists`);
  assert.ok(boss.hp > 0 && boss.radius > 0 && boss.speed > 0, `${boss.id} has combat stats`);
  assert.ok(boss.skills.length >= 2, `${boss.id} carries at least two skills`);
  // 第三、四关是冰霜系 BOSS：周身飘雪 + 技能喷雪花（不再一直冒火星）
  if (level.stage >= 3) {
    assert.equal(boss.fxTheme, 'ice', `stage ${level.stage} boss uses the ice/snow fx theme`);
  }
  for (const skillId of boss.skills) {
    const skill = BOSS_SKILLS[skillId];
    assert.ok(skill, `${boss.id} skill ${skillId} is defined`);
    assert.ok(skill.telegraph > 0, `${skillId} leaves a readable warning window`);
  }
  for (const anim of Object.values(boss.anims)) {
    assert.ok(typeof anim === 'string' && anim.length > 0, `${boss.id} animation mapping is non-empty`);
  }
  for (const summon of boss.summon || []) {
    assert.ok(summon.at > 0 && summon.at < 1, `${boss.id} summon triggers inside the health bar`);
    for (const group of summon.minions) {
      assert.ok(BOSS_MINIONS[group.id], `${boss.id} summons a defined minion`);
      assert.ok(group.count > 0 && group.count <= 3, `${boss.id} summon wave stays readable`);
    }
  }
  assert.equal(getBossLevel(level.stage).boss, level.boss, `getBossLevel(${level.stage}) resolves`);
}
for (const minion of Object.values(BOSS_MINIONS)) {
  assert.ok(fs.existsSync(path.join(root, 'public', minion.model.slice(1))), `${minion.id} glb asset exists`);
  assert.ok(minion.hp > 0 && minion.speed > 0, `${minion.id} has chase stats`);
  // 骨架兽的动作分在多个 glb 里（walk/attack/death 共用一个骨架），
  // 所以可用动作数 = anims 映射 + 额外动作集
  const animCount = Object.keys(minion.anims || {}).length + (minion.clipModels?.length || 0);
  if (!minion.procedural) {
    assert.ok(animCount >= 4, `${minion.id} authored model exposes animation states`);
  }
  for (const url of minion.clipModels || []) {
    assert.ok(fs.existsSync(path.join(root, 'public', url.slice(1))), `${minion.id} clip asset exists`);
  }
}

// 难度：三档且随档位递增
assert.equal(BOSS_DIFFICULTIES.length, 3, 'three difficulty tiers');
assert.deepEqual(BOSS_DIFFICULTIES.map((d) => d.id), ['normal', 'elite', 'nightmare']);
for (let i = 1; i < BOSS_DIFFICULTIES.length; i++) {
  const prev = BOSS_DIFFICULTIES[i - 1];
  const cur = BOSS_DIFFICULTIES[i];
  assert.ok(cur.hpScale > prev.hpScale, `${cur.id} scales boss health upward`);
  assert.ok(cur.dmgScale > prev.dmgScale, `${cur.id} scales boss damage upward`);
  assert.ok(cur.cdScale < prev.cdScale, `${cur.id} shortens boss cooldowns`);
}
assert.equal(getBossDifficulty('missing').id, 'normal', 'unknown difficulty falls back to normal');

// 竞技场：圆形边界 + 道具散布点都在场内
assert.ok(BOSS_ARENA.boundary.r > 0, 'boss arena has a circular boundary');
assert.equal(BOSS_ARENA.style, 'arena');
assert.equal(ARENA_ITEM_SPOTS.length, 12, 'arena scatters twelve item boxes');
for (const spot of ARENA_ITEM_SPOTS) {
  const d = Math.hypot(spot.x - BOSS_ARENA.boundary.x, spot.z - BOSS_ARENA.boundary.z);
  assert.ok(d > 8 && d < BOSS_ARENA.boundary.r - 8, 'every arena item box sits inside the safe ring');
}
assert.equal(BOSS_MAX_PLAYERS, 4, 'boss room supports up to four players');
assert.equal(BOSS_REVIVES, 1, 'each player gets a single revive');

// ---------- 全局节奏 ----------
// BOSS_PACE 后来整体重做：站桩机制取消，1~5 关从第一阶段就游走；
// 第三/四关改成「高压短预警」而不是旧版的「放慢节奏」。断言按当前设计写。
for (const stage of [1, 2, 3, 4, 5]) {
  assert.ok(BOSS_PACE[stage]?.move, `stage ${stage} boss roams from phase one`);
}
assert.ok(BOSS_PACE[1].speedScale < 1 && BOSS_PACE[1].cooldownScale > 1,
  'stage 1 stays the gentlest: slower chase and longer cooldowns');
assert.ok(BOSS_PACE[2].speedScale > 1, 'stage 2 boss chases faster once unlocked');
assert.ok(BOSS_PACE[3].telegraphScale < 1 && BOSS_PACE[3].cooldownScale <= 1,
  'stage 3 applies pressure with shorter telegraphs and normal cadence');
assert.ok(BOSS_PACE[3].speedScale >= 1, 'stage 3 boss does not slow down');
assert.ok(BOSS_PACE[4].telegraphScale < 0.8 && BOSS_PACE[4].telegraphScale < BOSS_PACE[3].telegraphScale,
  'stage 4 red circle resolves faster than stage 3');
assert.ok(BOSS_PACE[5].move && BOSS_PACE[5].telegraphScale > BOSS_PACE[4].telegraphScale,
  'stage 5 herald leaves a wider warning window than the stage 4 finale');

// ---------- 第二关锁 J 技能 + 火力核心 ----------
assert.ok(BOSSES.dragon_inferno.skills.includes('overheat'),
  'stage 2 owns the weapon-lock skill');
assert.equal(BOSS_SKILLS.overheat.kind, 'ground',
  'weapon lock is a dodgeable ground circle, not an unavoidable global');
assert.ok(BOSS_SKILLS.overheat.lockWeapon >= 6, 'scorched cannon locks J for six seconds');
assert.equal(BOSS_SKILLS.overheat.telegraph >= 1.5, true, 'lock skill leaves a dodge window');
assert.equal(BOSS_FIRE_CORE.shotMul, 3, 'fire core triples projectile particles');
assert.ok(BOSS_FIRE_CORE.shotDamage * BOSS_FIRE_CORE.shotMul > 1,
  'a boosted volley deals more total damage');
assert.ok(BOSS_FIRE_CORE.duration > 0 && BOSS_FIRE_CORE.interval > BOSS_FIRE_CORE.duration,
  'fire core buff has a longer cooldown than its uptime');

// ---------- 第四关技能差异化 ----------
// 第三关的横扫/冲锋不能出现在第四关：只允许共享「落雷」这一招
const stage3Skills = new Set(BOSSES.knight_thunder.skills);
const stage4Skills = BOSSES.blood_nightmare.skills;
for (const id of ['pull', 'blink', 'shadowTendrils', 'frostBreath', 'geyser']) {
  assert.ok(stage4Skills.includes(id), `stage 4 owns the ${id} skill`);
}
// 全屏大招「血幕降临」已按玩家反馈从第四关摘掉（试玩时无解）；
// 技能定义保留，想恢复只要把 'screen' 加回 skills。
assert.ok(!stage4Skills.includes('screen'),
  'stage 4 no longer fires the full-screen blood curtain');
assert.ok(!stage3Skills.has('screen'), 'stage 3 never had the ultimate either');
assert.ok(stage4Skills.length >= 5, 'stage 4 still keeps a full skill kit after removing the ultimate');
assert.ok(!stage4Skills.includes('slash') && !stage4Skills.includes('charge') && !stage4Skills.includes('rage'),
  'stage 4 does not reuse stage 3 melee/charge/rage skills');
assert.equal(stage4Skills.filter((id) => stage3Skills.has(id)).length, 1,
  'stage 4 shares exactly one skill (thunder) with stage 3');
assert.ok(BOSS_SKILLS.frostBreath.slowSpeed > 0, 'frost breath applies a slow debuff');
assert.ok(BOSS_SKILLS.geyser.waveDamage > 0, 'geyser pushes a damaging wave');
assert.ok(BOSS_SKILLS.blink.damage > 0 && BOSS_SKILLS.pull.damage > 0, 'blink/pull deal damage');

// ---------- 巨鲸鲨吐泡泡 ----------
const whale = BOSS_MINIONS.whale_shark;
assert.ok(whale.bubbleRange >= 18, 'whale shark has a ranged bubble range');
assert.ok(whale.bubbleSpeed > 0 && whale.bubbleSpeed <= 8,
  'bubbles drift slowly (slower than any boat at throttle)');
assert.ok(whale.bubbleLife >= 6, 'bubbles live long enough to be dodged');
assert.equal(whale.anims.cast, 'whale_shark_spit', 'whale shark plays its own spit clip');
assert.ok(whale.clipModels.some((p) => p.includes('whale_shark_spit')),
  'spit clip model is listed so loadMinionRig can merge it');
assert.ok(fs.existsSync(path.join(root, 'public/monsters/whale_shark_spit.glb')),
  'spit GLB exists on disk');

// 道具改写表覆盖全部现有道具
for (const itemId of Object.keys(BOSS_ITEM_BEHAVIOR)) {
  assert.ok(itemsSource.includes(`${itemId}:`), `${itemId} is a real item definition`);
}

// ---------- 怪物模式道具池（2026-11-13 改造） ----------
// 删 rvortex / octopus / magnet，加 harpoon / barrage / thunderrod / ramcrest，
// 保留 shield（用户明确要求）。注意那三个 id 在**竞速**池里仍然合法，不能从 Items.js 里整体删掉。
{
  const bossModeSource = fs.readFileSync(path.join(root, 'src', 'game', 'BossMode.js'), 'utf8');
  const poolStart = itemsSource.indexOf('export const BOSS_ITEM_DEFS = {');
  const poolEnd = itemsSource.indexOf('\n};', poolStart);
  const poolBlock = itemsSource.slice(poolStart, poolEnd);
  const poolIds = [...poolBlock.matchAll(/^\s{2}([a-zA-Z]+):\s*\{/gm)].map((m) => m[1]);

  assert.equal(poolIds.length, 16, 'boss item pool ships sixteen entries');
  for (const gone of ['rvortex', 'octopus', 'magnet', 'tide']) {
    assert.ok(!poolIds.includes(gone), `${gone} is gone from the boss item pool`);
  }
  // tide（方向转换器）2026-11-22 也摘掉了：BOSS 的「技能乱放」只对喷吐/冲锋生效，
  // 且怪物/海克斯里没有第二个真人可被反转操控，只留道具赛。
  assert.ok(!Object.keys(BOSS_ITEM_BEHAVIOR).includes('tide'), 'tide has no boss behavior entry');
  for (const added of ['harpoon', 'barrage', 'thunderrod', 'ramcrest', 'icecage', 'beacon', 'synergy']) {
    assert.ok(poolIds.includes(added), `${added} joined the boss item pool`);
    assert.ok(BOSS_ITEM_BEHAVIOR[added], `${added} has an entry in BOSS_ITEM_BEHAVIOR`);
  }
  assert.ok(poolIds.includes('shield'), 'shield survives the cleanup (explicit user request)');

  // 竞速池不受影响：被摘掉的三件在 ITEM_DEFS 里仍然有效
  const racePoolEnd = itemsSource.indexOf('\n};', itemsSource.indexOf('export const ITEM_DEFS = {'));
  const racePool = itemsSource.slice(itemsSource.indexOf('export const ITEM_DEFS = {'), racePoolEnd);
  for (const kept of ['rvortex', 'octopus', 'magnet']) {
    assert.ok(racePool.includes(`${kept}:`), `${kept} still exists in the racing item pool`);
  }

  // 数值护栏：新增的攻击道具必须真的能打疼 BOSS
  assert.ok(BOSS_ITEM_BEHAVIOR.harpoon.damage >= 300, 'harpoon is the hardest single hit');
  assert.ok(BOSS_ITEM_BEHAVIOR.harpoon.range > 0 && BOSS_ITEM_BEHAVIOR.harpoon.range <= 40,
    'harpoon has a short range so it rewards closing in');
  assert.ok(BOSS_ITEM_BEHAVIOR.barrage.shots >= 3, 'barrage fires a volley');
  assert.ok(BOSS_ITEM_BEHAVIOR.barrage.damage * BOSS_ITEM_BEHAVIOR.barrage.shots > BOSS_ITEM_BEHAVIOR.missile.damage,
    'a full barrage out-damages a missile');
  assert.ok(BOSS_ITEM_BEHAVIOR.thunderrod.stagger > 0, 'thunderrod contributes stagger');
  assert.equal(BOSS_ITEM_BEHAVIOR.ramcrest.ramMul, 3, 'ram crest triples hull ram damage');

  // 冲角护符的倍率必须真的进了撞船公式，而不是只写在数据表里
  assert.ok(bossModeSource.includes('crest ? crest.mul : 1'),
    'the ram branch multiplies by the crest bonus');
  assert.ok(bossModeSource.includes('ramBuff'), 'ram crest state is tracked on the mode');
  // 删掉的道具不能再有残留分支（tide 也一起清掉了）
  for (const gone of ['rvortex', 'octopus', 'tide']) {
    assert.ok(!new RegExp(`case '${gone}'`).test(bossModeSource), `${gone} has no leftover case branch`);
  }

  // 2026-11-22 三件新道具的数值口径
  assert.equal(BOSS_ITEM_BEHAVIOR.icecage.damage, 80, 'ice cage deals 80');
  assert.ok(BOSS_ITEM_BEHAVIOR.icecage.duration >= 2.5 && BOSS_ITEM_BEHAVIOR.icecage.silence > 0,
    'ice cage pins the boss and silences it');
  assert.ok(BOSS_ITEM_BEHAVIOR.beacon.heal > 0 && BOSS_ITEM_BEHAVIOR.beacon.revive > 0
    && BOSS_ITEM_BEHAVIOR.beacon.revive < 1, 'beacon heals and revives at partial hp');
  assert.ok(BOSS_ITEM_BEHAVIOR.synergy.duration >= 5, 'synergy holds the combo gauge long enough');
  // 漩涡改成水泡浮空：必须有 bubble 时长，而且不能走 airborne（airborne 是完全免疫）
  assert.ok(BOSS_ITEM_BEHAVIOR.vortex.bubble >= 2, 'vortex now lifts the boss instead of only damaging');
  assert.ok(bossModeSource.includes('status.bubble'),
    'vortex hit writes the bubble status');
  // 墨鱼要真的能打断读条，而不是只写一句注释
  assert.ok(bossModeSource.includes('interruptCast'),
    'ink / vortex / ice cage interrupt the current cast');
  // 飞鱼群空场伤害抬到 180
  assert.equal(BOSS_ITEM_BEHAVIOR.fish.damage, 180, 'fish hits the boss for 180 when no minions');
  // 天使保全队、护盾只保自己
  assert.ok(bossModeSource.includes('#applyAngelTo'), 'angel applies to every teammate');

  // 新道具的特效必须登记过，否则 play() 会静默什么都不放
  for (const fx of ['fxHarpoonFly', 'fxHarpoonHit', 'fxThunderFly', 'ramCrest',
    'fxIceBloom', 'fxIceShards', 'fxBenediction', 'fxMagic2Holy']) {
    assert.ok(FX_DEFS[fx], `${fx} is registered in FX_DEFS`);
  }
}

// 评级：越快越高，用完复活会被压分
assert.equal(gradeStage(60, 1, 1, 4, 1), 'S', 'fast clean clear earns S');
assert.equal(gradeStage(180, 0, 1, 4, 1), 'C', 'slow clear with no revive left earns C');
assert.ok(['S', 'A', 'B', 'C'].includes(gradeStage(100, 1, 1, 4, 1)), 'grade is one of S/A/B/C');
const gradeRank = { S: 4, A: 3, B: 2, C: 1 };
assert.ok(
  gradeRank[gradeStage(100, 1, 1, 4, 1)] >= gradeRank[gradeStage(100, 0, 1, 4, 1)],
  'revives left never lowers the grade',
);


// ---------- 新增赛艇 + 赛道道具 ----------
{
  const { getBoatWeapon, BOAT_WEAPONS } = await import('../src/data/boatWeapons.js');
  // 8 艘：磐石号 + 牛来号 + 6 艘轻量化的 tripo 未来载具（2026-11-13 第二次换装）。
  assert.equal(BOATS.length, 8, 'the garage ships eight boats');
  assert.equal(new Set(BOATS.map((b) => b.id)).size, 8, 'boat ids are unique');
  assert.equal(new Set(BOATS.map((b) => b.model)).size, 8, 'every boat ships its own GLB');
  for (const boat of BOATS) {
    const modelPath = path.join(root, 'public', boat.model.replace(/^\//, ''));
    assert.ok(fs.existsSync(modelPath), boat.id + ' model exists on disk');
    const weapon = getBoatWeapon(boat.id);
    assert.equal(weapon.id, boat.id, boat.id + ' has a dedicated weapon');
    assert.ok(['shot', 'torpedo', 'beam', 'blade'].includes(weapon.kind), boat.id + ' weapon kind is supported');
    assert.ok(weapon.damage > 0 && weapon.cadence > 0 && weapon.heat > 0, boat.id + ' weapon is balanced');
    assert.ok(boat.maxSpeed >= 24 && boat.maxSpeed <= 40, boat.id + ' top speed stays in band');
    assert.ok(boat.turnRate >= 1.05 && boat.turnRate <= 1.75, boat.id + ' turn rate stays in band');
    assert.ok(boat.stability > 0 && boat.stability <= 1, boat.id + ' stability stays in band');
  }
  assert.equal(Object.keys(BOAT_WEAPONS).length, 8, 'no orphan weapon definitions');

  // 每张「程序化水面地图」都拿到四个道具槽（旗门/传送门/旋转锤/漩涡），且引用的 GLB 真实存在。
  // baked 是 Blender 几何 + 中心线的另一套体系，布景写在 baked-track.js 里，
  // 和上面 marineFeatures 一样要排除，否则这条断言从 baked 加入起就一直是红的。
  const kinds = new Set();
  for (const map of MAPS.filter((m) => !m.baked)) {
    // deco 是纯布景，不占道具槽
    const props = (map.courseProps || []).filter((p) => p.kind !== 'deco');
    assert.equal(props.length, 4, map.id + ' declares four course props');
    for (const p of props) kinds.add(p.kind);
  }
  assert.deepEqual([...kinds].sort(), ['flag', 'hammer', 'portal', 'whirl'], 'all four prop kinds are used');
  for (const file of ['flag_gate', 'portal', 'rotating_obstacle', 'whirlpool_warning']) {
    const propPath = path.join(root, 'public', 'models', 'props', file + '.glb');
    assert.ok(fs.existsSync(propPath), 'prop ' + file + '.glb exists');
  }
}

// ---------------------------------------------------------------------------
// 赛道进度：分母必须是「本局圈数」，不是地图默认圈数（2026-11-18 用户 1 号 bug）
// 场景：霓虹海峡作者配 1 圈，单人设置里改成 3 圈跑。旧版分母仍是 1 圈 →
// 跑完第一圈进度条就 100%。现在必须是 33% / 50% / 100%。
// ---------------------------------------------------------------------------
{
  const ARC = 1000;
  let arcNow = 0;
  const fakeTrack = {
    arcTotal: ARC,
    laps: 1, // 地图默认圈数：故意设成 1，用来验证它不会再被当分母
    arcAt: () => ({ s: arcNow, d: 0, total: ARC }),
  };
  const ratio = (lap, s, laps, lapArc) => {
    arcNow = s;
    return Track.prototype.progressRatio.call(fakeTrack, lap, { x: 0, z: 0 }, laps, lapArc);
  };
  assert.equal(ratio(1, 0, 3), 0, 'progress starts at 0%');
  assert.ok(Math.abs(ratio(1, ARC * 0.5, 3) - 1 / 6) < 1e-6, 'half of lap 1 of 3 = 17%');
  assert.ok(Math.abs(ratio(2, 0, 3) - 1 / 3) < 1e-6, 'one full lap of 3 = 33% (was 100% before the fix)');
  assert.ok(Math.abs(ratio(2, ARC * 0.5, 3) - 0.5) < 1e-6, 'one and a half laps of 3 = 50%');
  assert.ok(Math.abs(ratio(4, 0, 3) - 1) < 1e-6, 'crossing the line on the last lap = 100%');
  // 圈尾位置（离终点线 1%）：仍然属于本圈，不能提前算成下一圈
  assert.ok(ratio(2, ARC * 0.99, 3) < 0.67 && ratio(2, ARC * 0.99, 3) > 0.66,
    'end of a lap stays inside that lap');
  // 单圈图（霓虹海峡默认 / 烘焙图）：跑完就是 100%
  assert.ok(Math.abs(ratio(2, 0, 1) - 1) < 1e-6, 'single-lap race reaches 100%');
  // 5 圈图：跑完 2 圈 = 40%
  assert.ok(Math.abs(ratio(3, 0, 5) - 0.4) < 1e-6, 'two of five laps = 40%');
  // 发车格在起点线后方 4m（弧长 = 上一圈的 99%）：进度必须是 0，不能一开局就 99%
  assert.ok(Math.abs(ratio(1, ARC * 0.996, 3, ARC * 0.996)) < 1e-6,
    'grid behind the start line reads 0%, not 99%');
  // 压线那一帧：船心还在线后 2m，新一圈的基准也取这一刻的弧长
  // → 本圈进度先从 0 起算，总进度正好是"已完成 1 圈"的 33%，不会先跳到 66%
  assert.ok(Math.abs(ratio(2, ARC * 0.998, 3, ARC * 0.998) - 1 / 3) < 1e-6,
    'right after crossing the line the new lap starts at 0%');
  // 发车后被水流/浪往**后**推 1 米（跨过弧长原点）：还是 0%，不能跳成 99%
  assert.ok(Math.abs(ratio(1, ARC * 0.996 - 1, 3, ARC * 0.996)) < 1e-6,
    'drifting backwards across the loop origin stays at 0%');
  // 基准之后继续跑：0.3 圈 → (1 + 0.3) / 3
  assert.ok(Math.abs(ratio(2, ARC * 0.3, 3, ARC * 0.998) - (1 + 0.302) / 3) < 1e-6,
    'lap fraction is measured from the lap base');
  // 总量口径：圈数由调用方传入，不再回落到地图默认值
  assert.equal(Track.prototype.totalProgressUnits.call({ arcTotal: ARC, laps: 1 }, 3), ARC * 3,
    'progress total uses the race lap count, not the map default');
}

// ---------------------------------------------------------------------------
// 船体轮廓（护栏碰撞形状）：必须真的盖住船体外缘，不能像旧版那样打折
// ---------------------------------------------------------------------------
{
  const outline = fallbackHullOutline({ length: 4.4, width: 1.6, bow: 1.3 });
  assert.ok(outline.length >= 8, 'fallback hull keeps at least four corners');
  let maxX = 0, maxZ = 0;
  for (let i = 0; i < outline.length; i += 2) {
    maxX = Math.max(maxX, Math.abs(outline[i]));
    maxZ = Math.max(maxZ, Math.abs(outline[i + 1]));
  }
  assert.ok(Math.abs(maxX - 0.8) < 1e-6, 'fallback hull spans the full beam');
  assert.ok(Math.abs(maxZ - 2.2) < 1e-6, 'fallback hull spans the full length');

  // 凸包：内部点必须被丢掉，四个角的极值必须保留
  const hull = convexHull2D(Float32Array.from([-2, -1, 2, -1, 2, 1, -2, 1, 0, 0, 0.5, 0.2]));
  assert.equal(hull.length / 2, 4, 'convex hull drops interior vertices');
  const ext = outlineExtents(hull);
  assert.equal(ext.halfW, 2, 'hull keeps the widest points');
  assert.equal(ext.halfLen, 1, 'hull keeps the fore/aft extremes');

  // 简化：共线的冗余顶点要删掉，但船头尖 / 船尾角这些真拐点必须留下
  const rect = [];
  for (let i = 0; i < 10; i++) rect.push(-2 + (4 * i) / 10, -1); // 下边
  for (let i = 0; i < 10; i++) rect.push(2, -1 + (2 * i) / 10);  // 右边
  for (let i = 0; i < 10; i++) rect.push(2 - (4 * i) / 10, 1);   // 上边
  for (let i = 0; i < 10; i++) rect.push(-2, 1 - (2 * i) / 10);  // 左边
  const simple = simplifyOutline(Float32Array.from(rect), 4, 0.02);
  assert.equal(simple.length / 2, 4, 'collinear vertices are dropped, corners are kept');
  const simpleExt = outlineExtents(simple);
  assert.equal(simpleExt.halfW, 2, 'simplified outline still spans the beam');
  assert.equal(simpleExt.halfLen, 1, 'simplified outline still reaches stem and stern');
}

console.log('gameplay unit checks: PASS');

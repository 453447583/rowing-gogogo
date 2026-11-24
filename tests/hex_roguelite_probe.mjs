// 海克斯随机玩法改造验收（2026-11-22）
//
//   node tests/hex_roguelite_probe.mjs
//
// 验四件事：
//   ① 6 张机制卡替换掉原来的纯数值卡，5 个流派核心入池
//   ② 10 条跨体系联动都能被 matchHexSynergies 正确识别
//   ③ 叠乘用的计数类字段走加法、总倍率在 BossMode 里有护栏
//   ④ buildRunPlan 的节奏：弱→强随机起点 / 静水层 / 主题关天气
// 这一份是纯数据 + 源码静态探针，秒出；浏览器端玩法由现有 e2e 覆盖。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HEX_CARDS, HEX_CORES, HEX_SYNERGIES, HEX_RULES, HEX_ADD_KEYS, HEX_HAZARDS,
  matchHexSynergies, mergeMods, combineMods, buildRunPlan, sanitizeHexEntry,
  HEX_BOSS_ORDER, HEX_ENDLESS_BOSSES, HEX_VARIANTS, HEX_SKILL_COUNT, HEX_START_BOSS_SLOTS,
  HEX_ARENA_PROP_DEFS, HEX_PROP_POOLS, planHexPropPlacements,
  HEX_FORMATION_PARTS, HEX_FORMATIONS, HEX_FORMATION_POOLS, planHexFormation,
} from '../src/data/hexRun.js';
import {
  BOSS_SKILLS, BOSSES, ARENA_ITEM_SPOTS, BOSS_SPAWN_DISTANCE,
} from '../src/data/bosses.js';

const root = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const bossSrc = fs.readFileSync(path.join(root, 'src/game/BossMode.js'), 'utf8');

// ---------- ① 卡牌 / 核心 ----------
const cards = Object.fromEntries(HEX_CARDS.map((c) => [c.id, c]));
for (const id of ['staggerHunter', 'armorPiercer', 'itemEcho', 'shockFeedback', 'lowHpFury', 'lastStand']) {
  assert.ok(cards[id], `${id} 已在通关卡池`);
  assert.ok(Object.keys(cards[id].mods || {}).length, `${id} 带真实效果`);
}
// 换掉的 6 张纯数值卡不该再出现
for (const id of ['whetstone', 'drilled', 'steady', 'keel', 'bulkhead', 'reinforce', 'crit', 'glass']) {
  assert.ok(!cards[id] && !HEX_CORES.some((c) => c.id === id), `${id} 已换掉`);
}
// 保留的卡仍要能提供纯数值选择
assert.ok(cards.pierce && cards.plate && cards.supply, '基础数值卡保留');
const cores = Object.fromEntries(HEX_CORES.map((c) => [c.id, c]));
for (const id of ['overload', 'detonate', 'reflect', 'combo', 'rewind']) {
  assert.ok(cores[id], `${id} 流派核心已入池`);
}
assert.equal(HEX_CORES.length, 9, '核心池 = 5 流派 + 4 基础（火力/钢铁/祝福/富甲）');
console.log(`① 卡池 ${HEX_CARDS.length} 张 / 核心 ${HEX_CORES.length} 张：6 张机制卡 + 5 个流派核心到位`);

// ---------- ② 10 条联动可被识别 ----------
assert.equal(HEX_SYNERGIES.length, 10, '十条跨体系联动');
const cases = [
  { rules: ['greed'], prefix: 'frost' },
  { rules: ['colossus', 'ironwall'] },
  { weather: 'storm', hazards: [{ id: 'thunder' }] },
  { prefix: 'decay', hazards: [{ id: 'poison' }] },
  { arena: 'maelstrom', prefix: 'frost' },
  { rules: ['fortune'] },
  { rules: ['trial'], arena: 'reef' },
  { weather: 'blizzard', hazards: [{ id: 'meteor' }] },
  { prefix: 'berserk', rules: ['rage'] },
  { weather: 'starry' },
];
const coreFor = ['', '', '', '', '', 'rich', '', '', '', ''];
const relicFor = [[], [], [], [], [], [], [], [], [], ['hourglass']];
for (let i = 0; i < cases.length; i++) {
  const hit = matchHexSynergies(cases[i], coreFor[i], relicFor[i]);
  assert.ok(hit.some((s) => s.id === HEX_SYNERGIES[i].id),
    `联动 ${HEX_SYNERGIES[i].id} 应被命中（实际 ${hit.map((s) => s.id)}）`);
}
// 不带任何条件时一条都不该触发
assert.equal(matchHexSynergies({ rules: [] }, null, []).length, 0, '空配置不触发联动');
console.log('② 10 条跨体系联动全部能被正确识别（规则 / 前缀 / 天气 / 危险物 / 场地 / 核心 / 遗物）');

// ---------- ③ 加法字段 + 总倍率护栏 ----------
for (const k of ['overload', 'detonate', 'reflectPct', 'comboStackPct', 'rewind', 'boxShield']) {
  assert.ok(HEX_ADD_KEYS.has(k), `${k} 是加法字段`);
}
const m = mergeMods(['overload'], HEX_CORES);
assert.equal(m.overload, 1, 'overload=1 不会变成伤害 ×2');
const combined = combineMods(m, mergeMods(['frostSupply'], HEX_SYNERGIES));
assert.equal(combined.boxShield, 1, '联动的 boxShield 走加法叠加');
for (const guard of ['bossHpMul', 'bossDmgMul', 'bossCdMul', 'playerDmgMul', 'playerTakenMul']) {
  assert.ok(bossSrc.includes(`hexMods.${guard} = clamp(`), `${guard} 有总上限护栏`);
}
console.log('③ 计数类字段走加法；五条总倍率都有叠乘护栏');

// ---------- ④ 节奏 ----------
const plan = buildRunPlan(20261122, 6);
assert.equal(plan.stages.length, 6, '生成 6 层计划');
assert.equal(new Set(plan.stages.slice(0, 4).map((s) => s.bossId)).size, 4, '前 4 层四头 BOSS 各一次（5 头里取 4 头，不重复）');
const dangers = plan.stages.slice(0, 4).map((s) => s.danger);
// 2026-11-22：池子从 4 头扩到 5 头，前 4 层是「5 头环上的连续 4 头」，
// 所以危险度是 [1..5] 的某个环状窗口（例：[5,1,2,3] / [3,4,5,1]），不再是 [1..4] 的旋转。
const ringOk = (() => {
  const N = 5;
  return [0, 1, 2, 3, 4].some((k) => dangers
    .every((v, i) => v === ((k + i) % N) + 1));
})();
assert.ok(ringOk, `前 4 层危险度是 5 头环上的连续窗口（实际 ${dangers}）`);
assert.equal(plan.stages[2].quiet, true, '第 3 层是静水层');
assert.equal(plan.stages[2].hazards.length, 0, '静水层没有危险物');
assert.ok(plan.stages[4].arena, '第 5 层有场地主题');
assert.ok(['storm', 'blizzard', 'dusk', 'starry'].includes(plan.stages[4].weather), '主题关天气跟着场地走');
assert.ok(plan.coreOptions.length === 3, '开局核心仍然是三选一');
console.log('④ BOSS 弱→强随机起点 / 第 3 层静水 / 第 5 层主题关：全部生效');

// ---------- ④b 召唤 / 龙卷风分层 ----------
for (let seed = 1; seed <= 60; seed++) {
  const p = buildRunPlan(seed * 7919, 12);
  for (const s of p.stages) {
    const summon = (s.skills || []).some((id) => BOSS_SKILLS[id]?.kind === 'gate');
    const tornado = (s.hazards || []).some((h) => h.id === 'vortex');
    if (s.stage < 5) {
      assert.ok(!summon, `seed=${seed} 第 ${s.stage} 层不该有召唤技能`);
      assert.ok(!tornado, `seed=${seed} 第 ${s.stage} 层不该有龙卷风`);
    }
    assert.ok(!(summon && tornado), `seed=${seed} 第 ${s.stage} 层召唤与龙卷风不能同层`);
  }
}
console.log('④b 60 个随机种子 × 12 层：第 5 层前无召唤/龙卷，第 5 层起两者不同层');

// ---------- ④c 运行时也必须遵守（计划干净 ≠ 场上不出现） ----------
// 2026-11-22 用户实测：第 2 层同时撞上追人龙卷 + 召唤门。
// 根因不在计划，而在 #vortexEnabled 用的是 ruleStage（BOSS 原本属于第几关）：
// 第 1 关的噬海龙被随机排到第 2 层，会把它第 1 关自带的龙卷一起带过来。
assert.ok(/HEX_HARD_MECH_MIN_STAGE/.test(bossSrc), '#vortexEnabled 必须用统一的解锁层常量');
assert.ok(/this\.variant === 'hex'[\s\S]{0,240}stage >= HEX_HARD_MECH_MIN_STAGE[\s\S]{0,80}#hexHas\('vortex'\)/.test(bossSrc),
  '海克斯龙卷风只按本局层数 + 追踪漩涡危险物开启，不能看 ruleStage');
assert.ok(/sanitizeHexEntry\(this\.hexPlan\.stages/.test(bossSrc),
  '每层开始时要用 sanitizeHexEntry 再收一遍（挡住旧计划 / 无尽续层 / BOSS 自带机制）');
// 前 4 层连 BOSS 的「血量阈值被动召唤」也不该有：火龙 4 波小怪 + 出怪时的风柱特效
// 正是玩家误读成"第 2 层就有召唤门 + 龙卷风"的来源。
assert.ok(new RegExp("this\\.summonWaves = \\(this\\.variant === 'hex' && this\\.stage < HEX_HARD_MECH_MIN_STAGE\\)[\\s\\S]{0,80}\\[\\]").test(bossSrc),
  '海克斯前 4 层关掉 BOSS 被动召唤（第 5 层恢复）');

// 旧计划（改码前已经在跑的那一份）也必须被兜住
const legacy = {
  stage: 2, bossId: 'dragon_inferno',
  skills: ['flame', 'summonGate', 'sweep'],
  hazards: [{ id: 'vortex' }, { id: 'heal' }],
  combos: [{ id: 'flame-summonGate', skills: ['flame', 'summonGate'] }],
};
const fixed = sanitizeHexEntry(legacy);
assert.ok(!fixed.skills.includes('summonGate'), '第 2 层的召唤门被裁掉');
assert.ok(!fixed.hazards.some((h) => h.id === 'vortex'), '第 2 层的龙卷危险物被裁掉');
assert.ok(fixed.hazards.some((h) => h.id === 'heal'), '无关危险物不能被误删');
assert.equal(fixed.combos.length, 0, '引用了被裁技能的连招一并移除');
// 第 5 层：有召唤门 → 龙卷让位；没有召唤门 → 龙卷保留
const s5gate = sanitizeHexEntry({
  stage: 5, skills: ['summonGate', 'flame'], hazards: [{ id: 'vortex' }], combos: [],
});
assert.equal(s5gate.hazards.length, 0, '同层有召唤门时不能同时有龙卷');
const s5free = sanitizeHexEntry({
  stage: 5, skills: ['flame', 'sweep'], hazards: [{ id: 'vortex' }], combos: [],
});
assert.ok(s5free.hazards.some((h) => h.id === 'vortex'), '第 5 层无召唤门时龙卷正常保留');
// 计划本身是干净的：sanitize 对每一层都应该是空操作（主机/客机裁剪结果必须一致，不能与计划分叉）
for (let seed = 1; seed <= 60; seed++) {
  const p = buildRunPlan(seed * 7919, 12);
  for (const s of p.stages) {
    assert.equal(sanitizeHexEntry(s), s, `seed=${seed} 第 ${s.stage} 层：计划和运行时裁剪结果一致`);
  }
}
console.log('④c 运行时收口：龙卷按本局层数判定、旧计划/续层被 sanitizeHexEntry 兜住、第 5 层召唤与龙卷互斥');

// ---------- ④d 无尽「继续 / 领奖」与选卡的先后顺序（2026-11-22 用户二次指定） ----------
// 用户口径：通关瞬间**先问继续还是领奖**，选了继续才发本层三选一，选完卡才升起去下一层的门。
// 所以"卡"不能在 BOSS 倒下时就弹（那样会先看到卡、后看到选择面板，顺序颠倒）。
const chooseSrc = bossSrc.slice(bossSrc.indexOf('chooseEndless(cont) {'), bossSrc.indexOf('#continueEndless()'));
assert.ok(chooseSrc.length > 200, 'chooseEndless 源码可定位');
const iOffer = chooseSrc.indexOf('#offerHexCards()');
const iNext = chooseSrc.indexOf("this.portalMode = 'next'");
assert.ok(iOffer > 0 && iNext > iOffer,
  '选「继续挑战」必须先弹三选一，选完卡才升起去下一层的门（offer 在 next 之前）');
assert.ok(/if \(!cont\)[\s\S]{0,200}portalMode = 'lobby'/.test(chooseSrc), '选「结束领奖」直接升起回大厅的门');
assert.ok(/const lastOfRun = this\.variant === 'hex'[\s\S]{0,140}if \(!lastOfRun\) this\.#offerHexCards\(\);/.test(bossSrc),
  '本局最后一层的卡不在 BOSS 倒下时发（先问继续/领奖）');
assert.ok(/this\.endlessPendingPortal = true;/.test(bossSrc)
  && /if \(this\.endlessPendingPortal\)[\s\S]{0,220}portalMode = 'next'/.test(bossSrc),
  '选完卡由 endlessPendingPortal 触发出下一层的门');
assert.ok(/hexCards: 1/.test(bossSrc) && /msg\.hexCards/.test(bossSrc),
  '联机客机也跟着弹同一层的三选一（bossState 捎带 hexCards 标记，不用新协议）');
console.log('④d 无尽顺序：先问继续/领奖 → 选了继续再选卡 → 选完卡才升去下一层的门');

// ---------- ④e 新 BOSS（深渊传令官）必须真的进前 4 层（2026-11-22 用户要求） ----------
// 以前 5 头里只有 4 头参与轮转，新 BOSS 要打到第 5 层才有 1/5 概率，常规 4 层局永远见不到。
assert.equal(HEX_BOSS_ORDER.length, 5, 'BOSS 池是 5 头（新 BOSS 追加在池尾 = 危险评级 5 星）');
assert.ok(HEX_BOSS_ORDER.includes('abyss_herald'), '深渊传令官在轮转池里，不只是无尽池');
assert.equal(HEX_BOSS_ORDER[HEX_BOSS_ORDER.length - 1], 'abyss_herald',
  '新 BOSS 必须留在池尾（originStage / danger 靠 index+1 推，插在中间会把别家的星级顶乱）');
assert.deepEqual(HEX_ENDLESS_BOSSES, HEX_BOSS_ORDER, '无尽池与轮转池同一份');
assert.equal(HEX_START_BOSS_SLOTS, 4, '开局轮转占前 4 层');
{
  const seenAtLayer1 = new Set();
  const all = new Set();
  let heraldFirst = 0;
  for (let seed = 1; seed <= 80; seed++) {
    const p = buildRunPlan(seed * 3571, 4);
    const ids = p.stages.map((s) => s.bossId);
    assert.equal(new Set(ids).size, 4, `seed=${seed} 前 4 层不许重复（实际 ${ids}）`);
    seenAtLayer1.add(ids[0]);
    ids.forEach((id) => all.add(id));
    if (ids[0] === 'abyss_herald') heraldFirst += 1;
    // 危险评级：传令官固定 5 星
    for (const s of p.stages) {
      if (s.bossId === 'abyss_herald') assert.equal(s.danger, 5, '传令官危险评级 5 星');
    }
  }
  assert.equal(all.size, 5, `80 局里 5 头 BOSS 都出现过（实际 ${[...all]}）`);
  assert.equal(seenAtLayer1.size, 5, `第 1 层也能轮到 5 头里的任何一头（实际 ${[...seenAtLayer1]}）`);
  assert.ok(heraldFirst > 0, '80 局里至少有一局第 1 层就是深渊传令官');
}
// 技能池够抽：每头 BOSS 至少 HEX_SKILL_COUNT 个技能，否则该层技能会少于 5 个
for (const id of HEX_BOSS_ORDER) {
  assert.ok((BOSSES[id]?.skills || []).length >= HEX_SKILL_COUNT,
    `${id} 的技能数 ≥ ${HEX_SKILL_COUNT}（实际 ${BOSSES[id]?.skills?.length}）`);
}
// 变体覆盖：5 头都要有深渊形态，否则新 BOSS 永远只是"普通版"
for (const id of HEX_BOSS_ORDER) {
  const v = HEX_VARIANTS[id];
  assert.ok(v, `${id} 有深渊变体`);
  assert.ok(v.borrowedSkill && BOSS_SKILLS[v.borrowedSkill],
    `${id} 的变体借的是真实技能（${v?.borrowedSkill}）`);
  assert.ok(!(BOSSES[id]?.skills || []).includes(v.borrowedSkill),
    `${id} 的变体借招不能和自己已有的技能重复（${v.borrowedSkill}）`);
}
// 闲置技能「狂怒」现在靠传令官变体的借招真正上场（kind='buff' 在 BossMode.#resolveSkill 里有分支）
assert.equal(HEX_VARIANTS.abyss_herald.borrowedSkill, 'rage', '传令官变体借来闲置的「狂怒」');
assert.equal(BOSS_SKILLS.rage.kind, 'buff', '狂怒是自增益技能，由 #resolveSkill 的 buff 分支消费');
assert.ok(/skill\.kind === 'buff'[\s\S]{0,160}rageMult/.test(bossSrc),
  'BossMode 真的会消费 buff 技能（否则借了也不会有反应）');
console.log('④e 新 BOSS 入池：5 头轮转覆盖前 4 层、深渊变体补齐 5/5、闲置技能「狂怒」接入借招');

// ---------- ⑤ 玩法层关键钩子（静态） ----------
const hooks = {
  boxShield: '寒霜补给', staggerWindow: '堡垒破甲窗口', conductZones: '雷云导电区',
  poisonBossDot: '瘟疫腐蚀 BOSS', vortexSlow: '霜涡拖拽减速', firstItemInvuln: '先遣补给',
  hazardPostInvuln: '礁场补偿', meteorWarnAdd: '盲陨预警', castRecovery: '狂潮硬直',
  hexRerollUsed: '每局一次重掷', hexNoGoldStreak: '金卡保底', useTimeAnchor: '主动时间锚',
  hexBounty: '每关悬赏', rewindSnap: '时间回溯快照',
};
for (const [token, label] of Object.entries(hooks)) {
  assert.ok(bossSrc.includes(token), `BossMode 里有 ${label} 的接入点（${token}）`);
}
// 规则表保持原有规模（联动依赖的具体规则 id 不能丢）
for (const id of ['greed', 'colossus', 'ironwall', 'fortune', 'trial', 'rage']) {
  assert.ok(HEX_RULES.some((r) => r.id === id), `联动依赖的规则 ${id} 仍在`);
}
console.log('⑤ BossMode 全部 14 个玩法钩子已落地');

// ---------- ⑥ 前 4 层难度缓冲 ----------
const ruleTier = Object.fromEntries(HEX_RULES.map((r) => [r.id, r.tier]));
for (let seed = 1; seed <= 40; seed++) {
  const p = buildRunPlan(seed * 104729, 8);
  for (const s of p.stages) {
    const highs = (s.hazards || []).filter((h) => HEX_HAZARDS.find((x) => x.id === h.id)?.high).length;
    if (s.stage < 5) {
      assert.ok((s.rules || []).every((id) => ruleTier[id] === 1), `seed=${seed} 第 ${s.stage} 层只能轻词缀`);
      assert.ok(highs <= 1, `seed=${seed} 第 ${s.stage} 层高风险危险物 ≤1（实际 ${highs}）`);
      assert.ok((s.hazards || []).length <= 6, `seed=${seed} 第 ${s.stage} 层危险物数量受控`);
      assert.ok(!s.prefix && !s.variant, `seed=${seed} 第 ${s.stage} 层无精英前缀/深渊变体`);
      assert.ok((s.events || []).length <= 1, `seed=${seed} 第 ${s.stage} 层事件 ≤1`);
      assert.ok((s.combos || []).length <= 1, `seed=${seed} 第 ${s.stage} 层连招 ≤1`);
    }
  }
}
for (const token of ['hexEarlyScale', 'freeReviveUsed', "variant === 'hex' ? 1 : 0"]) {
  assert.ok(bossSrc.includes(token), `BossMode 前置缓冲钩子 ${token} 存在`);
}
console.log('⑥ 40 种子 × 8 层：前 4 层轻词缀/少危险物/无前缀变体；BOSS 数值与免费复活已接入');

// ---------- ⑦ UI / 选卡倒计时 / 特效防护 ----------
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const uiSrc = fs.readFileSync(path.join(root, 'src/ui/ui.js'), 'utf8');
const fxSrc = fs.readFileSync(path.join(root, 'src/game/Effects.js'), 'utf8');
assert.ok(/boss-mode #hud-debuffs\s*\{[^}]*bottom:\s*116px/.test(html),
  'BOSS 模式玩家状态挪到协同合击栏上方');
assert.ok(bossSrc.includes('const picking ='), '选卡时冻结清关倒计时');
assert.ok(uiSrc.includes('关卡倒计时会等你选完再走'), '选卡面板文案说明倒计时顺序');
assert.ok(/继续 → 先挑一张卡[\s\S]{0,120}结束 → 直接升起回大厅的传送门/.test(uiSrc),
  '无尽面板文案按新顺序写（继续=先选卡再升门，结束=直接升门回大厅）');
assert.ok(fxSrc.includes('brokenFx') && fxSrc.includes('this.ctx.update(simDt'),
  'Effekseer 异常会被单点拉黑/收口，不再冒泡卡死');
assert.ok(!bossSrc.includes("fx.play('fxBenediction'"), '易崩的 fxBenediction 已从 BOSS 链路移除');
console.log('⑦ HUD 层级 / 选卡倒计时 / Effekseer 防护：均已接入');

// ---------- ⑧ 每关场景道具（2026-11-22 用户要求） ----------
const propDefs = Object.fromEntries(HEX_ARENA_PROP_DEFS.map((p) => [p.id, p]));
assert.ok(propDefs.ramp && propDefs.buoys, '主玩法道具：弹射跳台 + 浮标阵在表里');
for (const [id, def] of Object.entries(propDefs)) {
  assert.ok(def.name, `${id} 有中文名`);
  assert.ok(def.model?.startsWith('/models/') && def.model.endsWith('.glb'), `${id} 用现成 GLB（${def.model}）`);
  assert.ok(def.target > 0, `${id} 有归一化尺寸`);
}
for (const [theme, pool] of Object.entries(HEX_PROP_POOLS)) {
  for (const id of pool) assert.ok(propDefs[id], `主题 ${theme} 的掩体 ${id} 在道具表里`);
  assert.ok(!pool.includes('coral_reef'), '不碰用户否掉的 coral_reef');
}
for (let seed = 1; seed <= 60; seed++) {
  const p = buildRunPlan(seed * 7919, 8);
  for (const s of p.stages) {
    const props = s.props || [];
    assert.ok(props.length >= 3 && props.length <= 5,
      `seed=${seed} 第 ${s.stage} 层点缀道具 3~5 件（实际 ${props.length}）`);
    assert.equal(new Set(props.map((x) => x.id)).size, props.length,
      `seed=${seed} 第 ${s.stage} 层道具不重复`);
    assert.ok(props.some((x) => x.id === 'ramp' || x.id === 'buoys'),
      `seed=${seed} 第 ${s.stage} 层至少一件主玩法`);
    for (const x of props) assert.ok(propDefs[x.id], `seed=${seed} 第 ${s.stage} 层道具 ${x.id} 已知`);
    for (const x of props) {
      if (x.id === 'ramp' || x.id === 'buoys') continue;
      assert.ok((HEX_PROP_POOLS[s.themeStage] || []).includes(x.id),
        `seed=${seed} 第 ${s.stage} 层掩体 ${x.id} 符合场景主题 ${s.themeStage}`);
    }
  }
  // 续层重算：前 4 层的道具必须一件不变（种子不变、独立随机流）
  const short = buildRunPlan(seed * 7919, 4);
  const long = buildRunPlan(seed * 7919, 12);
  for (let i = 0; i < 4; i++) {
    assert.deepEqual(long.stages[i].props, short.stages[i].props,
      `seed=${seed} 第 ${i + 1} 层道具在续层后保持稳定`);
  }
}
const arenaSrc = fs.readFileSync(path.join(root, 'src/game/BossArena.js'), 'utf8');
for (const token of ['setHexProps', 'setWhirlpoolStyle', '#tryRamp', '#pushOut', 'get obstacles']) {
  assert.ok(arenaSrc.includes(token), `BossArena 里有场景道具接入点 ${token}`);
}
assert.ok(/arena\?\.setHexProps\?\.\([\s\S]{0,120}hexEntry\.props/.test(bossSrc),
  'BossMode 每关把计划里的道具交给场地');
assert.ok(/arena\?\.setWhirlpoolStyle\?\.\(true\)/.test(bossSrc),
  '海克斯里漩涡换成警戒圈 GLB');
// 无头落点验收：用一组与竞技场同量级的浮岩/漩涡，检查 60 种子 × 8 层
const testRocks = [];
for (let i = 0; i < 8; i++) {
  const a = (i / 8) * Math.PI * 2 + 0.35;
  const rad = 30 + (i % 3) * 7;
  testRocks.push({ x: Math.cos(a) * rad, z: Math.sin(a) * rad, r: 5.2 });
}
const testCtx = {
  rocks: testRocks,
  whirlpools: [{ x: -40, z: 20, r: 17 }, { x: 42, z: -14, r: 17 }],
  itemSpots: ARENA_ITEM_SPOTS,
  fenceRadius: 87,
  spawnZ: BOSS_SPAWN_DISTANCE,
};
const near = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);
for (let seed = 1; seed <= 60; seed++) {
  const p = buildRunPlan(seed * 7919, 8);
  for (const s of p.stages) {
    const propSeed = (seed * 7919) ^ Math.imul(s.stage, 0x51ed270b);
    const plan = planHexPropPlacements(s.props || [], propSeed, testCtx);
    // 场地很挤时允许少摆 1~2 件点缀，但不能少于 3 件（主玩法必留）
    assert.ok(plan.length >= Math.min(3, s.props.length) && plan.length <= s.props.length,
      `seed=${seed} 第 ${s.stage} 层道具至少落位 ${Math.min(3, s.props.length)} 件（实际 ${plan.length}）`);
    assert.deepEqual(planHexPropPlacements(s.props || [], propSeed, testCtx), plan,
      `seed=${seed} 第 ${s.stage} 层落点可复现（两端一致）`);
    const topperRocks = new Set();
    for (let i = 0; i < plan.length; i++) {
      const put = plan[i];
      if (put.kind === 'topper') {
        assert.ok(put.rock.r >= 3.2, '雕塑只摆在够大的浮岩上');
        assert.ok(!topperRocks.has(put.rock), '同一块浮岩不摆两座雕塑');
        topperRocks.add(put.rock);
        continue;
      }
      const d = Math.hypot(put.x, put.z);
      const [r0, r1] = put.spec.ring;
      assert.ok(d >= 20 + put.spec.r - 1e-6, `seed=${seed} 道具 ${put.spec.id} 不压 BOSS 中心`);
      assert.ok(d + put.spec.r + 6 <= testCtx.fenceRadius + 1e-6, `seed=${seed} 道具 ${put.spec.id} 不贴栅栏`);
      assert.ok(d >= r0 - 1e-6 && d <= r1 + 1e-6, `seed=${seed} 道具 ${put.spec.id} 在预设环带内`);
      for (const rock of testRocks) {
        assert.ok(near(put.x, put.z, rock.x, rock.z) >= rock.r + put.spec.r + 3 - 0.01,
          `seed=${seed} 道具 ${put.spec.id} 不压浮岩`);
      }
      for (const w of testCtx.whirlpools) {
        assert.ok(near(put.x, put.z, w.x, w.z) >= w.r + put.spec.r + 2 - 0.01,
          `seed=${seed} 道具 ${put.spec.id} 不进漩涡`);
      }
      for (const spot of ARENA_ITEM_SPOTS) {
        assert.ok(near(put.x, put.z, spot.x, spot.z) >= put.spec.r + 4 - 0.01,
          `seed=${seed} 道具 ${put.spec.id} 不压道具箱`);
      }
      for (let j = 0; j < plan.length; j++) {
        if (i === j || plan[j].kind === 'topper') continue;
        assert.ok(near(put.x, put.z, plan[j].x, plan[j].z) >= put.spec.r + plan[j].spec.r + 4 - 0.01,
          `seed=${seed} 道具 ${put.spec.id} 与 ${plan[j].spec.id} 不重叠`);
      }
      for (let sx = -22; sx <= 22; sx += 11) {
        assert.ok(near(put.x, put.z, sx, BOSS_SPAWN_DISTANCE) >= put.spec.r + 8 - 0.01,
          `seed=${seed} 道具 ${put.spec.id} 不堵出生线`);
      }
    }
  }
}

// 无头素材验收：每个道具都是可解析的 GLB，面数受控，不踩 spec-gloss 扩展
for (const [id, def] of Object.entries(propDefs)) {
  const file = path.join(root, 'public', def.model.replace(/^\//, ''));
  assert.ok(fs.existsSync(file), `${id} 的 GLB 存在（${def.model}）`);
  const buf = fs.readFileSync(file);
  assert.equal(buf.readUInt32LE(0), 0x46546c67, `${id} 是合法 GLB`);
  const jsonLen = buf.readUInt32LE(12);
  const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
  let tris = 0;
  for (const mesh of gltf.meshes || []) {
    for (const prim of mesh.primitives || []) {
      const acc = gltf.accessors?.[prim.indices];
      if (acc) tris += acc.count / 3;
      else tris += (gltf.accessors?.[prim.attributes?.POSITION]?.count || 0) / 3;
    }
  }
  assert.ok(tris > 20 && tris <= 30000, `${id} 面数在低配预算内（${Math.round(tris)} 面）`);
  assert.ok((gltf.materials || []).length > 0, `${id} 自带材质`);
  const ext = [...(gltf.extensionsUsed || []), ...(gltf.extensionsRequired || [])];
  assert.ok(!ext.includes('KHR_materials_pbrSpecularGlossiness'), `${id} 不使用 GLTFLoader 不认的 spec-gloss`);
}
console.log('⑧ 60 种子 × 8 层：每关 3~5 件点缀 GLB 道具；落点无重叠/不堵出生线/不压箱，素材面数与扩展全部通过');

// ---------- ⑨ 每关随机阵型（2026-11-23 用户要求 1~6 + 备选A） ----------
const FORMATION_IDS = ['reef', 'kelp', 'launcher', 'whirlpool', 'wreck', 'iceberg', 'volcano'];
const formationDefs = Object.fromEntries(HEX_FORMATIONS.map((f) => [f.id, f]));
assert.equal(HEX_FORMATIONS.length, 7, '7 个阵型全部建表（礁石/海草镇/弹射器/漩涡/沉船/冰山/火山柱）');
for (const id of FORMATION_IDS) {
  const def = formationDefs[id];
  assert.ok(def, `阵型 ${id} 存在`);
  assert.ok(def.name && def.desc, `阵型 ${id} 有中文名与玩法说明`);
  assert.ok(def.themes.length > 0, `阵型 ${id} 标了适配海域`);
}
// 部件：全部现成 GLB，kind 在白名单内，尺寸/半径为正
const PART_KINDS = new Set(['solid', 'kelp', 'spikes', 'launch']);
for (const part of HEX_FORMATION_PARTS) {
  assert.ok(PART_KINDS.has(part.kind), `部件 ${part.id} 的 kind=${part.kind} 在白名单内`);
  assert.ok(part.model.startsWith('/models/') && part.model.endsWith('.glb'),
    `部件 ${part.id} 用现成 GLB（${part.model}）`);
  assert.ok(part.target > 0 && part.r > 0, `部件 ${part.id} 有归一化尺寸与碰撞半径`);
  if (part.kind === 'kelp') assert.ok(part.blades >= 10, `海草堆每堆至少 10 株（${part.blades}）`);
  const file = path.join(root, 'public', part.model.replace(/^\//, ''));
  assert.ok(fs.existsSync(file), `部件 ${part.id} 的 GLB 存在（${part.model}）`);
  const buf = fs.readFileSync(file);
  assert.equal(buf.readUInt32LE(0), 0x46546c67, `部件 ${part.id} 是合法 GLB`);
  const jsonLen = buf.readUInt32LE(12);
  const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
  assert.ok((gltf.materials || []).length > 0, `部件 ${part.id} 自带材质贴图，不是纯色块`);
}
// 主题池：只放该海域允许的阵型，且池里的 id 都有定义
for (const [theme, pool] of Object.entries(HEX_FORMATION_POOLS)) {
  for (const id of pool) {
    assert.ok(formationDefs[id], `主题 ${theme} 池里的 ${id} 已定义`);
    assert.ok(formationDefs[id].themes.includes(Number(theme)),
      `主题 ${theme} 池里的 ${id} 标了该海域（避免冰海长珊瑚这类违和）`);
  }
}
// 抽取：每层都在池内、连续两层不重复、同 seed 结果稳定
const seenFormations = new Set();
for (let seed = 1; seed <= 80; seed++) {
  const p = buildRunPlan(seed * 7919, 12);
  const again = buildRunPlan(seed * 7919, 12);
  for (let i = 0; i < p.stages.length; i++) {
    const s = p.stages[i];
    assert.equal(s.formation, again.stages[i].formation,
      `seed=${seed} 第 ${s.stage} 层阵型可复现`);
    const pool = HEX_FORMATION_POOLS[s.themeStage];
    assert.ok(pool.includes(s.formation),
      `seed=${seed} 第 ${s.stage} 层阵型 ${s.formation} 属于主题 ${s.themeStage} 池`);
    if (i > 0) {
      assert.notEqual(s.formation, p.stages[i - 1].formation,
        `seed=${seed} 第 ${s.stage} 层不与上一层同阵型`);
    }
    seenFormations.add(s.formation);
    // 续层重算：前 4 层阵型不因层数变多而改变
    if (i < 4) {
      const short = buildRunPlan(seed * 7919, 4);
      assert.equal(short.stages[i].formation, s.formation,
        `seed=${seed} 第 ${i + 1} 层阵型在续层后保持稳定`);
    }
  }
}
assert.equal(seenFormations.size, 7, `80 局里 7 个阵型都抽到过（实际 ${[...seenFormations]}）`);

// 落点：7 种阵型 × 60 种子，部件不互压/不压箱/不堵出生线；漩涡阵固定 6~7 个
const formationCtx = {
  rocks: [],
  itemSpots: ARENA_ITEM_SPOTS,
  fenceRadius: 87,
  spawnZ: BOSS_SPAWN_DISTANCE,
};
const formationCounts = {};
for (let seed = 1; seed <= 60; seed++) {
  for (const id of FORMATION_IDS) {
    const plan = planHexFormation(id, seed * 104729, formationCtx);
    assert.ok(plan, `阵型 ${id} 能出落点`);
    assert.deepEqual(planHexFormation(id, seed * 104729, formationCtx), plan,
      `阵型 ${id} 落点可复现（两端一致）`);
    formationCounts[id] = (formationCounts[id] || 0) + 1;
    // 只有漩涡阵完全不摆实体；礁石阵补 3 块礁石，其它阵型至少 6 个
    if (id === 'whirlpool') {
      assert.equal(plan.parts.length, 0, '漩涡阵不额外摆实体部件');
    } else if (id === 'reef') {
      assert.equal(plan.parts.length, 3, `礁石阵补 3 块实体礁石（实际 ${plan.parts.length}）`);
    } else {
      assert.ok(plan.parts.length >= 6, `阵型 ${id} 至少 6 个部件（实际 ${plan.parts.length}）`);
    }
    // 海草堆：每堆必带 blades（宿主按 12 株拼），所有堆数量 ≥ 10
    if (id === 'kelp') {
      const clumps = plan.parts.filter((x) => x.partId === 'kelp_clump');
      assert.ok(clumps.length >= 10, `海草堆至少 10 堆（实际 ${clumps.length}）`);
    }
    // 只有漩涡阵产漩涡，数量 6~7，半径在 8~10.4
    if (id === 'whirlpool') {
      assert.ok(plan.whirlpools.length >= 6 && plan.whirlpools.length <= 7,
        `漩涡阵 6~7 个漩涡（实际 ${plan.whirlpools.length}）`);
      for (const w of plan.whirlpools) {
        assert.ok(w.r >= 7.9 && w.r <= 10.5, `漩涡半径 ${w.r.toFixed(2)}m 在可视范围内`);
        assert.ok([-1, 1].includes(w.spin), '漩涡旋向随机但只取 ±1');
      }
    } else {
      assert.equal(plan.whirlpools.length, 0, `阵型 ${id} 不产水面漩涡`);
    }
    for (let i = 0; i < plan.parts.length; i++) {
      const put = plan.parts[i];
      const d = Math.hypot(put.x, put.z);
      assert.ok(d >= 15 + put.r - 1e-6, `阵型 ${id} 部件 ${put.partId} 不压 BOSS 中心`);
      assert.ok(d + put.r + 6 <= formationCtx.fenceRadius + 1e-6, `阵型 ${id} 部件 ${put.partId} 不贴栅栏`);
      for (const spot of ARENA_ITEM_SPOTS) {
        assert.ok(near(put.x, put.z, spot.x, spot.z) >= put.r + 4 - 0.01,
          `阵型 ${id} 部件 ${put.partId} 不压道具箱`);
      }
      for (const other of plan.parts) {
        if (other === put) continue;
        assert.ok(near(put.x, put.z, other.x, other.z) >= put.r + other.r + 2 - 0.01,
          `阵型 ${id} 的 ${put.partId} 与 ${other.partId} 不重叠`);
      }
      for (let sx = -22; sx <= 22; sx += 11) {
        assert.ok(near(put.x, put.z, sx, BOSS_SPAWN_DISTANCE) >= put.r + 9 - 0.01,
          `阵型 ${id} 部件 ${put.partId} 不堵出生线`);
      }
      if (put.kind === 'launch') {
        assert.ok(put.r >= 3.5, '弹射台碰撞半径够大，船能压上去触发');
      }
    }
  }
}
for (const id of FORMATION_IDS) {
  assert.ok(formationCounts[id] > 0, `阵型 ${id} 60 种子都成功落位`);
}
// 静态接入：场地装配 / 水面着色器漩涡 / 腾空豁免 / 激光遮挡
for (const token of ['setFormation', '#buildFormationPart', '#clearFormation', 'launchPads', 'kelpZones', 'spikeZones']) {
  assert.ok(arenaSrc.includes(token), `BossArena 有阵型接入点 ${token}`);
}
const waterSrc = fs.readFileSync(path.join(root, 'src/game/Water.js'), 'utf8');
for (const token of ['uWhirlCount', 'uWhirls', 'setWhirlpools', 'MAX_WHIRLS']) {
  assert.ok(waterSrc.includes(token), `Water 有水面漩涡接口 ${token}`);
}
assert.ok(/formationId === 'whirlpool' \? \(this\.arena\?\.whirlpools \|\| \[\]\) : \[\]/.test(bossSrc),
  '只有漩涡阵把漩涡交给水面着色器，其它阵型保持 0 个');
assert.ok(/AIR_DODGE_KINDS = new Set\(\['slam', 'ground', 'geyser', 'wave', 'grid', 'rift'\]\)/.test(bossSrc),
  '腾空豁免的技能类型白名单与技能 kind 对齐');
for (const [fn, kind] of [['#updateGeyserWave', 'geyser'], ['#updateLavaWave', 'wave'],
  ['#resolveSlamSkill', 'slam'], ['#resolveSlamWave', 'slam']]) {
  // 定义在行首（2 空格缩进），调用点是 this.#xxx(...)，用 "\n  #" 精确定位定义
  const at = bossSrc.indexOf(`\n  ${fn}(`);
  assert.ok(at > 0, `${fn} 定义可定位`);
  assert.ok(bossSrc.slice(at, at + 2600).includes(`#airDodges(p.boat, '${kind}')`),
    `${fn} 已接入腾空豁免（${kind}）`);
}
const laserAt = bossSrc.indexOf('\n  #updateLaserSweep(dt) {');
assert.ok(laserAt > 0, '#updateLaserSweep 定义可定位');
const laserBody = bossSrc.slice(laserAt, laserAt + 2400);
assert.ok(laserBody.includes('rayHitDistance') && laserBody.includes('blocksLine'),
  '血月激光：视觉按掩体截断 + 掩体后不结算伤害');
assert.ok(bossSrc.includes('#dealBossDamage') && bossSrc.includes('bossVortexMul'),
  '漩涡伤 BOSS / 减速 BOSS 已接入');
console.log('⑨ 7 个阵型：80 局全部抽到、池匹配、连续层不重复；60 种子落点无重叠/不堵出生线；海草堆 10 堆 × 12 株、漩涡阵 6~7 个水面漩涡；素材与运行钩子全部通过');

console.log('\n海克斯随机玩法改造：全部通过');

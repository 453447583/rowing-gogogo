// 设置存档迁移 / 键位裁剪：老存档里已经落盘的键必须按新默认表处理
//
//   node tests/settings_migrate.test.mjs
//
// 2026-11-18 变更：幽灵车（影子）从「驾驶辅助设置」升级成大厅里的独立
// 「挑战模式」玩法，ghost / ghostAlways 两个键已从 SETTINGS_DEFAULTS 删除。
// 读档只遍历默认表，所以老存档里的这两个字段不会再被读进内存，
// 下次保存时会被自然抹掉 —— 这里锁住这个行为，避免以后有人把键加回来
// 又变成「设置页删了、底层还在生效」的幽灵开关。
import assert from 'node:assert/strict';

const KEY = 'rr-settings-v1';

/** 造一个假 localStorage，并把给定的存档塞进去 */
function withStore(blob) {
  const map = new Map();
  if (blob !== undefined) map.set(KEY, JSON.stringify(blob));
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
  return map;
}

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log('PASS  ' + name); } catch (e) { failed += 1; console.log('FAIL  ' + name + ' — ' + e.message); }
};

// 每个用例用不同的 query 让 node 重新求值整份模块（否则拿到的是同一个单例）
let n = 0;
const fresh = async () => import(`../src/settings.js?case=${++n}`);

// ---------- ① v1 老存档：幽灵开关被裁掉，版本推到 3，其它设置不动 ----------
{
  const map = withStore({ version: 1, ghost: true, ghostAlways: false, volMaster: 0.3, hudScale: 1.2 });
  const { settings } = await fresh();
  check('v1 存档里的 ghost / ghostAlways 不再进内存', () => {
    assert.equal(settings.get('ghost'), undefined);
    assert.equal(settings.get('ghostAlways'), undefined);
  });
  check('迁移不碰其它设置（音量 / HUD 缩放照旧）', () => {
    assert.equal(settings.get('volMaster'), 0.3);
    assert.equal(settings.get('hudScale'), 1.2);
  });
  check('迁移后版本号写回 3 并落盘', () => {
    assert.equal(JSON.parse(map.get(KEY)).version, 3);
  });
  check('落盘内容里已经没有幽灵键（下次保存彻底清掉）', () => {
    settings.save();
    const saved = JSON.parse(map.get(KEY));
    assert.equal('ghost' in saved, false);
    assert.equal('ghostAlways' in saved, false);
  });
}

// ---------- ② v2 → v3：渲染分辨率上限开放到 125%，旧默认 100% 抬上去 ----------
{
  const map = withStore({ version: 2, lapReview: false, ghost: true, renderScale: 1 });
  const { settings } = await fresh();
  check('v2 存档迁移到 v3 并落盘', () => {
    assert.equal(JSON.parse(map.get(KEY)).version, 3);
  });
  check('旧默认渲染分辨率 100% 被抬到 125%', () => {
    assert.equal(settings.get('renderScale'), 1.25);
  });
  check('玩家主动关掉的 lapReview 保持 false', () => {
    assert.equal(settings.get('lapReview'), false);
  });
  check('v2 存档里的残留 ghost 键也不读进来', () => {
    assert.equal(settings.get('ghost'), undefined);
  });
}

// ---------- ②b 玩家自己调过的渲染分辨率不被迁移覆盖 ----------
{
  withStore({ version: 2, renderScale: 0.85 });
  const { settings } = await fresh();
  check('自定义 85% 分辨率保留，不强行拉到 125%', () => {
    assert.equal(settings.get('renderScale'), 0.85);
  });
}

// ---------- ③ 全新玩家（没有存档）：走默认值 ----------
{
  withStore(undefined);
  const { settings, SETTINGS_DEFAULTS } = await fresh();
  check('默认表里没有幽灵开关', () => {
    assert.equal('ghost' in SETTINGS_DEFAULTS, false);
    assert.equal('ghostAlways' in SETTINGS_DEFAULTS, false);
  });
  check('辅助项默认开（每圈评价 / 失败归因）', () => {
    assert.equal(settings.get('lapReview'), true);
    assert.equal(settings.get('impactIcon'), true);
  });
  check('新玩家默认开 125% 超采样', () => {
    assert.equal(settings.get('renderScale'), SETTINGS_DEFAULTS.renderScale);
    assert.equal(settings.get('renderScale'), 1.25);
  });
  check('没有存档时不写 localStorage（不制造无意义存档）', () => {
    assert.equal(globalThis.localStorage.getItem(KEY), null);
  });
}

// ---------- ④ 存档被写坏：静默退回默认值，不抛 ----------
{
  withStore();
  globalThis.localStorage.setItem(KEY, '{not json');
  const { settings } = await fresh();
  check('坏存档静默退回默认值', () => {
    assert.equal(settings.get('lapReview'), true);
    assert.equal(settings.get('ghost'), undefined);
  });
}

console.log(failed === 0 ? 'settings migrate: PASS' : `settings migrate: ${failed} FAIL`);
process.exit(failed === 0 ? 0 : 1);

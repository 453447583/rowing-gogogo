// MySQL 存储验收（可选，需要真实数据库）：
//   MYSQL_HOST=127.0.0.1 MYSQL_USER=root MYSQL_PASSWORD=*** node tests/leaderboard_mysql_probe.mjs
//
// 只用临时库 / 临时表（默认 rapids_probe.leaderboard_probe），跑完删表删库，
// 不碰正式榜单。没设 MYSQL_HOST 就跳过（CI 里不依赖数据库）。
import { createStore } from '../server/lb-store.js';
import { createLeaderboard } from '../server/leaderboard.js';

const enabled = !!process.env.MYSQL_HOST;
if (!enabled) {
  console.log('跳过 MySQL 验收（没有设 MYSQL_HOST）');
  process.exit(0);
}

process.env.MYSQL_DATABASE = process.env.MYSQL_DATABASE || 'rapids_probe';
process.env.MYSQL_TABLE = process.env.MYSQL_TABLE || 'leaderboard_probe';
process.env.LB_STORE = 'mysql';

let failures = 0;
const ok = (cond, label, extra) => {
  if (cond) console.log('  ✓ ' + label);
  else { failures += 1; console.error('  ✗ ' + label, extra === undefined ? '' : JSON.stringify(extra)); }
};

let store = null;
try {
  store = await createStore({ force: 'mysql' });
  ok(store.kind === 'mysql', '连上 MySQL 并建好库表', store.info);

  const lb = await createLeaderboard({ store });

  lb.recordRace({
    mapId: 'canyon',
    laps: 3,
    results: [
      { name: '甲', boatId: 'falcon', avatar: '', time: 180.2, bestLap: 58.1 },
      { name: '乙', boatId: 'titan', avatar: '', time: 190.5, bestLap: 61.2 },
      { name: '电脑1', boatId: 'rower', avatar: '', time: 170.0, bestLap: 55.0, ai: true },
    ],
  });
  await lb.refresh(true);
  let snap = lb.snapshot('甲');
  const list = snap.boards['r:canyon:3'] || [];
  ok(list.length === 2 && list[0].n === '甲', 'MySQL 写入 + 读回（AI 被排除）', list.map((e) => [e.n, e.t]));

  lb.recordRace({ mapId: 'canyon', laps: 3, results: [{ name: '甲', boatId: 'falcon', time: 175.9, bestLap: 56.4 }] });
  await lb.refresh(true);
  ok(lb.snapshot('甲').boards['r:canyon:3'][0].t === 175.9, 'MySQL 同名更好成绩会覆盖');

  lb.recordRace({ mapId: 'canyon', laps: 3, results: [{ name: '甲', boatId: 'falcon', time: 199.9, bestLap: 66.4 }] });
  await lb.refresh(true);
  ok(lb.snapshot('甲').boards['r:canyon:3'][0].t === 175.9, 'MySQL 同名更慢成绩不会覆盖');

  lb.recordBoss({
    variant: 'classic', humans: 2, victory: true, totalTime: 260,
    stages: [{ stage: 1, elapsed: 60 }, { stage: 2, elapsed: 65 }, { stage: 3, elapsed: 70 }, { stage: 4, elapsed: 65 }],
    player: { name: '甲', boatId: 'falcon' },
  });
  await lb.refresh(true);
  snap = lb.snapshot('甲');
  ok(snap.boards['bt:2']?.[0]?.t === 260 && snap.boards['bs:2:3']?.[0]?.t === 70,
    'MySQL 怪物总时长 / 单关成绩落库', [snap.boards['bt:2'], snap.boards['bs:2:3']]);

  // 换一个实例读同一张表：模拟局域网 + 线上两台服务器共用一张榜
  const lb2 = await createLeaderboard({ store });
  await lb2.refresh(true);
  ok(lb2.snapshot('甲').boards['r:canyon:3']?.[0]?.t === 175.9,
    '第二个服务器实例能读到同一张榜（跨进程共用）');
  await lb2.close();

  await lb.close();
} catch (err) {
  failures += 1;
  console.error('  ✗ MySQL 验收中断：', err?.message || err);
} finally {
  // 清掉临时表与临时库，别在用户库里留垃圾
  try {
    const mysql = await import('mysql2/promise');
    const cfg = {
      host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT) || 3306,
      user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD || '',
    };
    const c = await mysql.default.createConnection(cfg);
    const db = String(process.env.MYSQL_DATABASE).replace(/[^A-Za-z0-9_]/g, '');
    await c.query(`DROP DATABASE IF EXISTS \`${db}\``);
    await c.end();
    console.log(`  · 已清理临时库 ${db}`);
  } catch (err) {
    console.warn('  · 清理临时库失败：', err?.message || err);
  }
}

if (failures) { console.error(`\n${failures} 项未通过`); process.exit(1); }
console.log('\nMySQL leaderboard PASS');

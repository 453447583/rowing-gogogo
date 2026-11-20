// 一次跑完 8 艘赛艇的漂移探针，并把各自的 JSON 落到 .tmp_build/drift_<id>.json
//
//   node tests/_run_drift_probes.mjs [baseUrl] [mapId]
//
// 报告生成器 tests/_gen_drift_report.mjs 直接读这些文件，不再手写常量 ——
// 以前报告表格是手抄的，调完参数忘了同步，就会出现"测试通过但数字是旧的"。
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const ids = ['rower', 'cow', 'skiff', 'falcon', 'titan', 'dolphin', 'vintage', 'longship'];
const base = process.argv[2] || 'http://127.0.0.1:5199/';
const mapId = process.argv[3] || 'ocean';
const tmp = path.resolve('.tmp_build');
await fs.mkdir(tmp, { recursive: true });

const run = (id) => new Promise((resolve) => {
  const c = spawn(process.execPath, ['tests/drift_probe.mjs', base, id, mapId], {
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, TMPDIR: tmp, TEMP: tmp, TMP: tmp },
  });
  let buf = '';
  c.stdout.on('data', (d) => { buf += d.toString(); });
  c.on('close', async () => {
    try {
      const j = JSON.parse(buf.split('\n')[0]);
      await fs.writeFile(path.join(tmp, `drift_${id}.json`), JSON.stringify(j));
      resolve({ id, ok: true, j });
    } catch (e) { resolve({ id, ok: false, err: e.message }); }
  });
});

// 每批 4 个：8 个 Edge 同时开会把 devtools 端口 / 系统资源挤爆
const all = [];
for (let i = 0; i < ids.length; i += 4) {
  all.push(...await Promise.all(ids.slice(i, i + 4).map(run)));
}
console.log('船\t峰值角\t到门槛\t入漂1s掉速\t单帧最大\t拖漂3s保速\t90°弯漂移(s/m)\t不漂(s/m)\t双喷');
for (const r of all) {
  if (!r.ok) { console.log(`${r.id}\tFAIL ${r.err}`); continue; }
  const j = r.j;
  console.log([
    j.boat, `${j.build.peak}°`, `${j.build.t30}s`, `${j.entry.drop1s}%`,
    `${(+j.entry.maxDrop).toFixed(2)}%`, `${j.drag.keep[2]}%`,
    `${j.cornerTest.drift.t}s / ${j.cornerTest.drift.radius}m`,
    `${j.cornerTest.plain.t}s / ${j.cornerTest.plain.radius}m`,
    `${j.exit.granted} 喷`,
  ].join('\t'));
}
console.log(`\nJSON -> .tmp_build/drift_<id>.json (${all.filter((x) => x.ok).length}/${ids.length})`);
if (all.some((x) => !x.ok)) process.exitCode = 1;

// 生成 before/after 对比联系表，并用无头 Edge 截图（file:// 直接可用）
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const DIR = 'D:/3Dgame - 副本/shots/verify/boats/fix';
const OUT = 'D:/3Dgame - 副本/shots/verify/boats/sheet';
const TAGS = [
  ['jetboat', '未来喷气艇'],
  ['redcar', '红色飞行汽车'],
  ['flycar', '未来飞行汽车'],
  ['speedboat', '快速艇'],
  ['ship', '未来船艇'],
  ['car6', '未来汽车'],
];
const VIEW = process.argv[2] || 'front';

fs.mkdirSync(OUT, { recursive: true });

const rows = TAGS.map(([tag, cn]) => {
  const b = path.join(DIR, `${tag}_v3before_${VIEW}.jpg`);
  const a = path.join(DIR, `${tag}_v3after_${VIEW}.jpg`);
  const ok = fs.existsSync(b) && fs.existsSync(a);
  if (!ok) return '';
  const url = (p) => 'file:///' + p.replace(/\\/g, '/');
  return `<div class="row">
    <div class="label">${cn}<br><span>${tag}</span></div>
    <figure><img src="${url(b)}"><figcaption>修复前</figcaption></figure>
    <figure><img src="${url(a)}"><figcaption>修复后</figcaption></figure>
  </div>`;
}).filter(Boolean).join('\n');

const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  body{margin:0;background:#111;color:#ddd;font:13px/1.4 "Microsoft YaHei",sans-serif;}
  .row{display:grid;grid-template-columns:120px 1fr 1fr;gap:6px;align-items:center;
       border-bottom:1px solid #2a2a2a;padding:6px;}
  .label{font-size:15px;font-weight:600;padding-left:8px;}
  .label span{font-size:11px;color:#777;font-weight:400;}
  figure{margin:0;position:relative;}
  img{width:100%;display:block;border-radius:4px;}
  figcaption{position:absolute;left:6px;top:6px;background:rgba(0,0,0,.62);
             padding:2px 7px;border-radius:3px;font-size:11px;color:#fff;}
</style></head><body>${rows}</body></html>`;

const htmlPath = path.join(OUT, `sheet_${VIEW}.html`);
fs.writeFileSync(htmlPath, html);
const shot = path.join(OUT, `sheet_${VIEW}.png`);

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/sheet-' + VIEW);
const args = [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
  '--force-device-scale-factor=1',
  `--user-data-dir=${profile}`,
  `--window-size=1500,${TAGS.length * 470 + 40}`,
  `--screenshot=${shot}`,
  'file:///' + htmlPath.replace(/\\/g, '/'),
];
const child = spawn(edge, args, { stdio: 'ignore' });
child.on('exit', () => {
  const ok = fs.existsSync(shot);
  console.log(JSON.stringify({ view: VIEW, shot, bytes: ok ? fs.statSync(shot).size : 0 }));
  if (ok) fs.rmSync(profile, { recursive: true, force: true });
});

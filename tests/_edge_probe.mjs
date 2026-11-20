// Minimal Edge/CDP probe: does headless Edge start and expose /json in this environment?
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = Date.now();
const profile = path.resolve(`D:/3dgame-tmp/browser/probe-${stamp}`);
const port = 9720 + (stamp % 30);
const child = spawn(edge, [
  '--headless', '--no-sandbox', '--disable-gpu',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  '--window-size=640x400',
  'about:blank',
], { stdio: 'inherit' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = false;
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`);
    if (r.ok) { console.log('CDP OK', (await r.json()).Browser); ok = true; break; }
  } catch {}
  await sleep(300);
}
if (!ok) console.log('CDP did not come up');
child.kill();
await sleep(400);
await fs.rm(profile, { recursive: true, force: true }).catch(() => {});

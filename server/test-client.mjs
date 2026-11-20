// 模拟第二玩家：加入、选艇、比赛时沿航点自动行驶
import WebSocket from 'ws';

const MAPS = (await import('../src/data/maps.js')).MAPS;

const NAME = process.argv[2] || '二号玩家';
const BOAT = process.argv[3] || 'titan';
const TAG = process.argv[4] || 'P2';

const ws = new WebSocket('ws://localhost:3001');
const send = (m) => ws.send(JSON.stringify(m));

let myId = null;
let racing = false;
let gates = null;
let gateW = 13;
let laps = 3;
let gate = 0, lap = 0;
let x = 0, z = 0, heading = 0;
let raceT = 0;
let lastState = 0;
const SPEED = 18; // m/s

function dist2(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }

ws.on('open', () => {
  console.log('[P2] 已连接');
  send({ t: 'hello', name: '二号玩家' });
});

ws.on('message', (raw) => {
  const msg = JSON.parse(raw);

  if (msg.t === 'welcome') {
    myId = msg.id;
    console.log('[P2] 我的 id:', myId);
    send({ t: 'pick', boatId: 'titan' });
  }
  if (msg.t === 'start') {
    console.log('[P2] 收到 start，等待倒计时(4s)... map=', msg.mapId, 'order=', msg.order.map((o) => o.name).join(','));
    const map = MAPS.find((m) => m.id === msg.mapId);
    gates = map.gates;
    gateW = map.gateWidth;
    laps = msg.laps;
    gate = 0; lap = 0; raceT = 0;
    // 发车位：起跑线后
    const g0 = gates[0], prev = gates[gates.length - 1];
    let bx = prev[0] - g0[0], bz = prev[1] - g0[1];
    const bl = Math.hypot(bx, bz); bx /= bl; bz /= bl;
    x = g0[0] + bx * 14; z = g0[1] + bz * 14;
    heading = Math.atan2(g0[0] - x, g0[1] - z);
    // 与真实客户端一致：倒计时 4 秒后才能动
    setTimeout(() => { racing = true; console.log('[P2] 倒计时结束，开跑!'); }, 4000);
  }
  if (msg.t === 'roundEnd' || msg.t === 'raceEnd') {
    console.log('[P2] 收到结算:', msg.t, JSON.stringify(msg.results?.map((r) => `${r.name}#${r.rank}`)));
    racing = false;
    setTimeout(() => process.exit(0), 500);
  }
});

// 模拟循环 20Hz
setInterval(() => {
  if (!racing || !gates) return;
  raceT += 0.05;
  const g = gates[gate];
  const dx = g[0] - x, dz = g[1] - z;
  const d = Math.hypot(dx, dz);
  if (d < gateW * 1.2) {
    // 过门（与修复后的真实客户端语义一致：过 0 号门即过起点线，圈数+1）
    const passedGate = gate;
    gate = (gate + 1) % gates.length;
    if (passedGate === 0) {
      lap += 1;
      if (lap > laps) {
        send({ t: 'gate', id: myId, gate: 0, lap, totalTime: raceT });
        console.log('[P2] 完赛! 用时', raceT.toFixed(1));
        racing = false;
        return;
      }
      send({ t: 'gate', id: myId, gate: 0, lap });
    } else {
      send({ t: 'gate', id: myId, gate, lap: Math.max(1, lap) });
    }
  } else {
    const step = Math.min(SPEED * 0.05, d);
    x += (dx / d) * step;
    z += (dz / d) * step;
    heading = Math.atan2(dx, dz);
  }
  send({ t: 'state', id: myId, x: +x.toFixed(2), z: +z.toFixed(2), h: +heading.toFixed(3), s: SPEED, b: 0 });
}, 50);

ws.on('error', (e) => console.log('[P2] error', e.message));
setTimeout(() => { console.log('[P2] 超时退出'); process.exit(0); }, 300000);

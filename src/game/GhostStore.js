// 幽灵车存档：把「一圈的轨迹」压成字节串塞进 localStorage。
//
// 为什么不是直接存 JSON
// --------------------
// 20Hz 采样的 3km 单圈约 2000~2600 个点。JSON 一个点要写
// `{"t":1234,"x":-88.42,"z":-1012.3,"h":1.2345}` ≈ 46 字节，一圈就 100KB+，
// 三四张图 × 四五条船很快顶到 5MB 配额（顶到之后 setItem 直接抛，
// 表现为「明明跑了新纪录，下次却没有幽灵」，还很难查）。
//
// 这里按二进制打包：每个点 12 字节
//   dt   Uint16  毫秒（上限 65.5s，采样间隔 50ms，够用）
//   x    Int32   厘米（±21474km；赛道最远也就 1km 级，1cm 精度远低于视觉分辨率）
//   z    Int32   厘米
//   head Uint16   0..65535 映射 0..2π（≈0.0055°，比船体抖动小两个数量级）
// 同样的圈 ≈ 28KB，base64 膨胀到 ≈ 38KB，一个 key 存一圈毫无压力。
//
// 兼容性：记录里带 `arcTotal`（赛道一圈弧长）。地图被改过（拉直/加弯）之后
// 弧长会变，旧幽灵会跑在护栏外——加载时比值差超过 2% 就直接当没有记录，
// 免得玩家看到一辆「穿墙幽灵」还以为游戏坏了。

const PREFIX = 'rr-ghost-v1';
const TAU = Math.PI * 2;
const POINT_BYTES = 12;
/** 单圈采样上限（20Hz × 300s）：防止某张环形图跑太久把 localStorage 写爆 */
const MAX_POINTS = 6000;

export function ghostKey(mapId, boatId) {
  return `${PREFIX}:${mapId || 'map'}:${boatId || 'boat'}`;
}

function toBase64(u8) {
  // String.fromCharCode(...u8) 在 3 万元素以上会爆调用栈（Chrome 实测），
  // 所以按 32KB 分块拼接。
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

function fromBase64(str) {
  const bin = atob(str);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

/**
 * 打包一圈轨迹。
 * @param {number[]} samples 扁平数组 [dtMs, x, z, headingRad, ...]
 * @param {object} meta { mapId, boatId, arcTotal, lapTime, hz }
 */
export function encodeGhost(samples, meta = {}) {
  const n = Math.min(MAX_POINTS, Math.floor(samples.length / 4));
  const buf = new ArrayBuffer(n * POINT_BYTES);
  const dv = new DataView(buf);
  let o = 0;
  for (let i = 0; i < n; i++) {
    const dt = Math.max(0, Math.min(65535, Math.round(samples[i * 4])));
    const x = Math.round(samples[i * 4 + 1] * 100);
    const z = Math.round(samples[i * 4 + 2] * 100);
    let h = samples[i * 4 + 3] % TAU;
    if (h < 0) h += TAU;
    dv.setUint16(o, dt); o += 2;
    dv.setInt32(o, Math.max(-2147483647, Math.min(2147483647, x))); o += 4;
    dv.setInt32(o, Math.max(-2147483647, Math.min(2147483647, z))); o += 4;
    dv.setUint16(o, Math.round((h / TAU) * 65535) & 0xffff); o += 2;
  }
  return {
    v: 1,
    mapId: meta.mapId || '',
    boatId: meta.boatId || '',
    arcTotal: Number(meta.arcTotal) || 0,
    lapTime: Number(meta.lapTime) || 0,
    hz: Number(meta.hz) || 20,
    n,
    data: toBase64(new Uint8Array(buf)),
  };
}

/**
 * 解包成可以直接插值的定长数组。
 * @returns {{t:Float32Array,x:Float32Array,z:Float32Array,h:Float32Array,lapTime:number,arcTotal:number}|null}
 */
export function decodeGhost(rec) {
  if (!rec || rec.v !== 1 || !rec.data || !(rec.n > 0)) return null;
  let u8;
  try {
    u8 = fromBase64(rec.data);
  } catch {
    return null;
  }
  if (u8.length < rec.n * POINT_BYTES) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const n = rec.n;
  const t = new Float32Array(n);
  const x = new Float32Array(n);
  const z = new Float32Array(n);
  const h = new Float32Array(n);
  let o = 0;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += dv.getUint16(o) / 1000; o += 2;
    t[i] = acc;
    x[i] = dv.getInt32(o) / 100; o += 4;
    z[i] = dv.getInt32(o) / 100; o += 4;
    h[i] = (dv.getUint16(o) / 65535) * TAU; o += 2;
  }
  return {
    t, x, z, h,
    lapTime: Number(rec.lapTime) || t[n - 1] || 0,
    arcTotal: Number(rec.arcTotal) || 0,
  };
}

/** 读一条记录（不解包）。存储被禁用时返回 null，绝不抛。 */
export function readGhost(mapId, boatId, arcTotal = 0) {
  let raw = null;
  try {
    raw = localStorage.getItem(ghostKey(mapId, boatId));
  } catch {
    return null;
  }
  if (!raw) return null;
  let rec = null;
  try {
    rec = JSON.parse(raw);
  } catch {
    return null;
  }
  // 赛道被改过：弧长差 2% 以上，旧幽灵会跑到护栏外面去，直接作废
  if (arcTotal > 0 && rec.arcTotal > 0) {
    const k = Math.abs(rec.arcTotal - arcTotal) / arcTotal;
    if (k > 0.02) return null;
  }
  return rec;
}

/**
 * 写一条记录。
 * @returns {boolean} true = 真的写进去了
 */
export function writeGhost(rec) {
  const raw = JSON.stringify(rec);
  try {
    localStorage.setItem(ghostKey(rec.mapId, rec.boatId), raw);
    return true;
  } catch {
    // 隐私模式 / 配额满：不给幽灵而已，不能打断这一局
    return false;
  }
}

/** 列出全部记录（meta，不含 data —— 列表只用来展示和清理） */
export function listGhosts() {
  const out = [];
  let keys = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX + ':')) keys.push(k);
    }
  } catch {
    return out;
  }
  for (const k of keys) {
    let rec = null;
    try {
      rec = JSON.parse(localStorage.getItem(k));
    } catch {
      continue;
    }
    if (!rec) continue;
    out.push({
      key: k,
      mapId: rec.mapId || '',
      boatId: rec.boatId || '',
      lapTime: Number(rec.lapTime) || 0,
      arcTotal: Number(rec.arcTotal) || 0,
      n: rec.n || 0,
    });
  }
  out.sort((a, b) => a.mapId.localeCompare(b.mapId) || a.boatId.localeCompare(b.boatId));
  return out;
}

/** 清空全部幽灵记录，返回清掉的条数 */
export function clearGhosts() {
  const keys = listGhosts().map((g) => g.key);
  for (const k of keys) {
    try { localStorage.removeItem(k); } catch { /* 忽略 */ }
  }
  return keys.length;
}

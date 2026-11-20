import { solveClosed, buildPath, segments } from '../canyon-seg-track.mjs';
import { buildTrackB, buildLoopTrack } from '../canyon-seg-track.mjs';
const L = solveClosed();
const e = buildPath(segments(L)).end;
console.log('L', JSON.stringify(Object.fromEntries(Object.entries(L).map(([k,v])=>[k,Math.round(v)]))), '残差', Math.hypot(e.x,e.z).toFixed(2));
const t = buildLoopTrack({ peak: 5, halfWidth: 7.5, maxExtent: 450 });
console.log('单圈', t.total.toFixed(0), '最急R', t.minR.toFixed(1), '净空', t.gap.toFixed(1), '覆盖', t.extent.toFixed(0), '桥高', t.maxY.toFixed(1));

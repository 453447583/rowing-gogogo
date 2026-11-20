import { solveClosed, buildPath, segments, buildTrackB } from '../canyon-seg-track.mjs';
const L = solveClosed();
console.log('解出的自由直道长度', JSON.stringify(Object.fromEntries(Object.entries(L).map(([k,v])=>[k, Math.round(v)]))));
const { end } = buildPath(segments(L));
console.log('闭环残差', Math.hypot(end.x, end.z).toFixed(3), 'm  末朝向', (end.phi*180/Math.PI).toFixed(1));
const t = buildTrackB({ peak: 5 });
console.log('单圈', t.total.toFixed(0), 'm  最急R', t.minR.toFixed(1), '  桥高', t.maxY.toFixed(1), '  点数', t.pts.length);
const ext = Math.max(...t.pts.map(p=>Math.hypot(p[0],p[1])));
console.log('覆盖半径', ext.toFixed(0), 'm');

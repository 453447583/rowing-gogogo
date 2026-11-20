import { buildLoopTrack } from '../canyon-seg-track.mjs';
const t = buildLoopTrack({ peak: 5, halfWidth: 7.5 });
console.log('单圈', t.total.toFixed(0), 'm  最急R', t.minR.toFixed(1), ' 净空', t.gap.toFixed(1), ' 覆盖', t.extent.toFixed(0), ' 桥高', t.maxY.toFixed(1), ' 门', t.pts.length);

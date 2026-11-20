import { buildLoopTrack } from '../canyon-seg-track.mjs';
for (const cap of [820, 900]) {
  const t = buildLoopTrack({ peak: 5, halfWidth: 7.5, maxExtent: cap });
  console.log('cap', cap, '单圈', t.total.toFixed(0), '最急R', t.minR.toFixed(1), '净空', t.gap.toFixed(1), '覆盖', t.extent.toFixed(0), '桥高', t.maxY.toFixed(1), '门', t.pts.length);
}

// Sketchfab 模型检索（匿名公开 API，不需要 token）。
//   node tests/sketchfab_search.mjs "navigation buoy" [--n 12] [--maxfaces 30000]
//
// 只做两件事：搜、筛、打印。
// **下载不了**：/v3/models/<uid>/download 需要 OAuth token（登录后才有），
// 匿名 API 只能拿到元数据 + 预览图。所以这里只负责出候选清单，
// 真正的 GLB 只能人工在网页上点 Download，或者自己建模。
const q = process.argv[2];
if (!q) {
  console.error('usage: node tests/sketchfab_search.mjs "query" [--n 12] [--maxfaces 30000]');
  process.exit(2);
}
const argOf = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? Number(process.argv[i + 1]) : dflt;
};
const N = argOf('--n', 12);
const MAXF = argOf('--maxfaces', 30000);

const url = `https://api.sketchfab.com/v3/search?type=models&q=${encodeURIComponent(q)}`
  + `&downloadable=true&sort_by=-likeCount&count=24`;

const res = await fetch(url, { headers: { accept: 'application/json' } });
if (!res.ok) {
  console.error('HTTP', res.status, await res.text().catch(() => ''));
  process.exit(1);
}
const data = await res.json();
const rows = (data.results || []).map((m) => {
  const lic = (m.license && (m.license.label || m.license.slug)) || '?';
  const faces = m.faceCount ?? 0;
  const size = m.archives?.glb?.size ?? m.archives?.source?.size ?? null;
  return {
    name: m.name,
    uid: m.uid,
    faces,
    verts: m.vertexCount ?? null,
    likes: m.likeCount ?? 0,
    views: m.viewCount ?? 0,
    lic,
    downloadable: !!m.isDownloadable,
    glbMB: size ? +(size / 1048576).toFixed(1) : null,
    animated: (m.animationCount || 0) > 0,
    url: `https://sketchfab.com/3d-models/${m.uid}`,
  };
});
// 太多面数的直接沉底：手机端一个道具几万面不值
rows.sort((a, b) => {
  const af = a.faces > MAXF ? 1 : 0, bf = b.faces > MAXF ? 1 : 0;
  return af - bf || b.likes - a.likes;
});
console.log(`query="${q}"  命中 ${rows.length} 条（downloadable=true）\n`);
for (const r of rows.slice(0, N)) {
  console.log(`· ${r.name}`);
  console.log(`  ${r.faces} faces${r.verts ? ` / ${r.verts} verts` : ''}${r.glbMB ? ` · glb ${r.glbMB}MB` : ''} · ♥${r.likes} · ${r.lic}${r.animated ? ' · 有动画' : ''}`);
  console.log(`  ${r.url}`);
}

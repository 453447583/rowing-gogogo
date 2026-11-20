// Effekseer 导出 efkefc 时，纹理路径是"相对工程文件"的，形如 ../../fx-projects/<组>/<名>/<hash>。
// 导出到 public/effects/<名>/ 后这个相对路径会解析成 /fx-projects/<组>/<名>/<hash> —— 自然 404。
// 这里把每个 efkefc 需要的目录在 public/fx-projects 下补齐（只复制，不删任何东西）。
import fs from 'node:fs/promises';
import path from 'node:path';

const PUB = path.resolve('public');
const FX_DIR = path.join(PUB, 'effects');
const MIRROR = path.join(PUB, 'fx-projects');

const dirs = (await fs.readdir(FX_DIR, { withFileTypes: true }))
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

let scanned = 0, patched = 0, copied = 0;
for (const name of dirs) {
  const dir = path.join(FX_DIR, name);
  const files = await fs.readdir(dir);
  const efk = files.find((f) => f.endsWith('.efkefc'));
  if (!efk) continue;
  scanned++;
  const buf = await fs.readFile(path.join(dir, efk));
  // 二进制里的字符串是 UTF-16（每个字符后跟一个 0 字节），先把 0 剥掉再扫
  const text = buf.toString('latin1').replace(/\0/g, '');
  const re = /\.\.\/\.\.\/fx-projects\/[A-Za-z0-9_]+\/[A-Za-z0-9_]+\//g;
  const refs = [...new Set(text.match(re) || [])];
  if (!refs.length) {
    console.log(`  ${efk}: 没有 ../../ 引用（可能已经是相对同名）`);
    continue;
  }
  for (const ref of refs) {
    // ../../fx-projects/<group>/<name>/  ->  <group>/<name>
    const rel = ref.replace(/^\.\.\/\.\.\/fx-projects\//, '');
    const dest = path.join(MIRROR, rel);
    await fs.mkdir(dest, { recursive: true });
    // 本特效目录里的哈希文件全部镜像过去（同名同大小才跳过）
    for (const f of files) {
      if (f.endsWith('.efkefc') || f.endsWith('.efkproj') || f === 'metafile.json') continue;
      const src = path.join(dir, f);
      const out = path.join(dest, f);
      try {
        const st = await fs.stat(out);
        const si = await fs.stat(src);
        if (st.size === si.size) continue;
      } catch { /* 不存在，复制 */ }
      await fs.copyFile(src, out);
      copied++;
    }
    console.log(`  ${efk} -> public/fx-projects/${rel.replace(/\\/g, '/')}`);
    patched++;
  }
}
console.log(`扫描 ${scanned} 个 efkefc，补了 ${patched} 条路径，复制 ${copied} 个纹理`);

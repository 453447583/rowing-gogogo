// 素材预览专用静态服务器：只读项目根，禁缓存。
// 为什么不用现成的 dev server：public 下新增/修改的文件会被静态中间件缓存住，
// 改了 html 刷新还是旧内容（表现为 typeof window.__play === 'undefined'）。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[3] || '.');
const port = Number(process.argv[2] || 3111);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.glb': 'model/gltf-binary',
  '.efkefc': 'application/octet-stream',
  '.efkmodel': 'application/octet-stream',
  '.efkmat': 'application/octet-stream',
  '.efkptcl': 'application/octet-stream',
  '.efkcurve': 'application/octet-stream',
};

http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(root, path.normalize(p).replace(/^([/\\])+/, ''));
  if (!file.startsWith(root)) { res.writeHead(403).end('forbidden'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end('not found: ' + p); return; }
    // Effekseer 素材包里的纹理是哈希名（没有扩展名），必须靠 Content-Type 让浏览器正确解码：
    // 返回 octet-stream 时 createImageBitmap 会失败，运行时表现为 texImage2D 报错、特效不显示
    let type = MIME[path.extname(file).toLowerCase()];
    if (!type) {
      if (buf[0] === 0x89 && buf[1] === 0x50) type = 'image/png';
      else if (buf[0] === 0xff && buf[1] === 0xd8) type = 'image/jpeg';
      else type = 'application/octet-stream';
    }
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(buf);
  });
}).listen(port, '127.0.0.1', () => console.log(`fx-preview server on http://127.0.0.1:${port}/  root=${root}`));

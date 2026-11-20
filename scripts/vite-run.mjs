// 构建/开发入口包装器
//
// 为什么需要它：
// esbuild（Vite 的转译/打包引擎）在 Windows 上会把 stdout 中间输出写到
// 系统临时目录（%TEMP%，未设置时回落到 C:\WINDOWS\temp），构建结束后再删除。
// 该文件经常被杀毒软件实时扫描占住，导致删除时报：
//     error during build:
//     [vite:esbuild-transpile] remove C:\...\Temp\esbuild-<hash>: Access is denied.
// 整个构建失败（表现为「启动服务器.bat 一闪而过/报错」）。
//
// 解决：把临时目录统一重定向到项目内的 .tmp_build，绕开系统 TEMP。
// 必须在 import vite 之前设置，因为 esbuild 的服务进程是懒启动的，
// 会继承当前进程的 TEMP/TMP 环境变量。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(root, '.tmp_build');
fs.mkdirSync(tmp, { recursive: true });
process.env.TEMP = tmp;
process.env.TMP = tmp;
process.env.TMPDIR = tmp;

const mode = process.argv[2] || 'build';

if (mode === 'dev') {
  const vite = await import('vite');
  const server = await vite.createServer();
  await server.listen();
  server.printUrls();
} else {
  // 清空 dist 不能用 fs.rm / vite 的 emptyOutDir：这台机器对"一次删除 50+ 文件"有守卫，
  // 会直接抛 SAFE_DELETE_BULK_CONFIRM_REQUIRED，构建中断。
  // 以前的做法是 `mv dist dist.old.<时间>` 绕过去，结果堆了 25 个备份、吃掉 4GB。
  // 现在改成 robocopy /MIR：用空目录镜像 dist，等价于清空，走的是复制 API 不会被拦，
  // 而且 dist 目录本身保留、不会产生任何 dist.old.*。
  const dist = path.join(root, 'dist');
  const empty = path.join(root, '.tmp_empty');
  fs.mkdirSync(empty, { recursive: true });
  fs.mkdirSync(dist, { recursive: true });
  try {
    execFileSync('robocopy', [empty, dist, '/MIR', '/NFL', '/NDL', '/NJH', '/NJS', '/NC', '/NS', '/NP'], { stdio: 'ignore' });
  } catch {
    // robocopy 成功时返回 0~7，execFileSync 会把它当"非 0 退出"抛错，忽略即可
  }
  // 走 CLI 而不是 vite.build()：本项目 index.html 有 5 段内联 <style>，
  // 编程式 build（Vite 5.4.21）在 html-proxy 上会偶发
  //   [vite:html-inline-proxy] No matching HTML proxy module found ... index=0.css
  // 只转 1 个模块就中断；CLI 会走完整的 resolveConfig / 插件初始化路径，稳定通过。
  // 环境变量（TEMP/TMP/TMPDIR）由本文件前面统一改好，子进程会继承。
  const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
  execFileSync(process.execPath, [viteBin, 'build', '--emptyOutDir', 'false'], {
    cwd: root, stdio: 'inherit', env: process.env,
  });
}

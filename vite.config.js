import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1500
  },
  server: {
    port: 5173,
    // 显式绑 IPv4：无头浏览器探针固定访问 127.0.0.1，
    // 只绑 localhost 时在 Windows 上可能只监听 ::1，导致测试页面打不开。
    host: '127.0.0.1',
    // 开发服务器把账号 / 桥接接口转给本机的游戏服务器（server.js 默认 3000），
    // 否则用 npm run dev 打开时 /auth/* 会 404，注册按钮点了没反应。
    // 前置条件：另开一个窗口 npm run server。
    proxy: {
      '/auth': { target: 'http://127.0.0.1:3000', changeOrigin: true },
      '/lb-api': { target: 'http://127.0.0.1:3000', changeOrigin: true },
    },
    // 无头浏览器配置目录**不再放在项目里**（2026-11-16 起统一写到 D:/3dgame-tmp/browser）：
    // Edge 不退出时会堆到几十 GB，还会让 vite 的文件监听崩掉。
    // 这条 ignored 保留只是为了兜底老脚本 / 手工残留的 .tmp_browser。
    watch: { ignored: ['**/.tmp_browser/**', '**/3dgame-tmp/**'] }
  }
});

// 玩家头像：内置 PNG（海洋主题，C 类第二批素材）+ 自定义图片（压缩成 128×128 dataURL）
//
// 头像字段在网络里就是一个字符串：
//   'wave' / 'whale' ...  内置头像 id
//   'data:image/jpeg;base64,...'  玩家自己上传的图片（客户端裁切压缩，长度很小）
//
// 2026-11-20：手绘 SVG 兜底整套删除（用户要求「不用留着兜底，直接换掉」）。
// 内置头像只认 public/icons/avatars/*.png，路径表在 icons.js 的 AVATAR_ART，
// 和其余图标同一处维护；AI 用 'bot' 那张，不再走 ART.bot。

import { AVATAR_ART, AI_AVATAR_ROTATION } from './icons.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

export const DEFAULT_AVATAR_ID = 'wave';

// 8 个默认头像（id → 名字），顺序即选择面板里的排列
export const AVATAR_DEFS = [
  { id: 'wave', name: '浪花' },
  { id: 'whale', name: '蓝鲸' },
  { id: 'shark', name: '鲨鱼' },
  { id: 'turtle', name: '海龟' },
  { id: 'sail', name: '帆船' },
  { id: 'anchor', name: '船锚' },
  { id: 'squid', name: '章鱼' },
  { id: 'diver', name: '潜客' },
];

export function isDefaultAvatar(v) {
  return AVATAR_DEFS.some((d) => d.id === v);
}

/** 自定义图片：只认 dataURL 形式的 png/jpeg/webp，并限制长度 */
export function isCustomAvatar(v) {
  return typeof v === 'string'
    && v.length > 24 && v.length <= 40000
    && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(v);
}

export function isValidAvatar(v) {
  return isDefaultAvatar(v) || isCustomAvatar(v);
}

/**
 * AI 头像：3 个配色变体按玩家 id 轮换（ai1/ai2/ai3），一屋子 AI 不会长同一张脸。
 * id 里没有数字（联机客机 id 是随机串那种）就回落到通用 bot，绝不抛错。
 */
function aiAvatarKey(seed) {
  const n = Number(String(seed ?? '').replace(/\D/g, ''));
  if (!Number.isFinite(n) || n <= 0) return 'bot';
  return AI_AVATAR_ROTATION[(n - 1) % AI_AVATAR_ROTATION.length] || 'bot';
}

/**
 * 渲染头像的 HTML（不带外层容器）。
 * AI 一律用机器人头像（按 id 轮换配色）；玩家优先用自定义图片，其次内置头像，最后回落到默认。
 * 全部是 <img>，圆形/圆角裁切交给外层容器（.av / .lp-av 等）。
 * seed 传玩家 id：只有 AI 会用到它，用来挑配色变体。
 */
export function avatarMarkup(avatar, isAi = false, seed = '') {
  if (!isAi && isCustomAvatar(avatar)) {
    return `<img src="${esc(avatar)}" alt="">`;
  }
  const id = isAi ? aiAvatarKey(seed) : (isDefaultAvatar(avatar) ? avatar : DEFAULT_AVATAR_ID);
  const src = AVATAR_ART[id] || AVATAR_ART[DEFAULT_AVATAR_ID];
  return `<img src="${src}" alt="" draggable="false">`;
}

/**
 * 把用户选的图片居中裁成正方形并压成 128×128 的 JPEG dataURL。
 * 不用 FileReader 转 base64 后传原图，避免网络里出现几 MB 的字符串。
 */
export function compressAvatarFile(file, size = 128) {
  return new Promise((resolve, reject) => {
    if (!file || !/^image\//.test(file.type || '')) {
      reject(new Error('请选择图片文件'));
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    let done = false;
    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      URL.revokeObjectURL(url);
      fn(arg);
    };
    img.onload = () => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      if (!w || !h) { finish(reject, new Error('图片读取失败')); return; }
      const side = Math.min(w, h);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext('2d');
      // 深色底：透明 PNG 压成 JPEG 后不会变成黑块
      ctx.fillStyle = '#0b2236';
      ctx.fillRect(0, 0, size, size);
      ctx.drawImage(img, (w - side) / 2, (h - side) / 2, side, side, 0, 0, size, size);
      finish(resolve, canvas.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => finish(reject, new Error('图片读取失败'));
    img.src = url;
  });
}

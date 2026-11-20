import * as THREE from 'three';

/**
 * 特效贴图统一载入：
 * public/effects 里的多数贴图是「黑底 RGB」，直接贴到 Sprite 上会露出一块方形底片；
 * 少数（如 Cloud01）还可能带灰色底。这里把亮度转成透明度、颜色归一为白色，
 * 再交给材质 color 着色，画面里就只剩特效本身，没有外层的透明方框。
 */
export function loadEffectTexture(loader, url) {
  const tex = loader.load(url, (t) => {
    const img = t.image;
    if (!img || !img.width) return;
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const data = g.getImageData(0, 0, c.width, c.height);
    const px = data.data;
    for (let i = 0; i < px.length; i += 4) {
      const lum = px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114;
      // 阈值 40 抠掉贴图自带的灰底，再保留原有的 alpha（火焰这类本来就有透明通道）
      const keyed = Math.max(0, Math.min(1, (lum - 40) / 215));
      px[i + 3] = px[i + 3] * keyed;
      px[i] = 255;
      px[i + 1] = 255;
      px[i + 2] = 255;
    }
    g.putImageData(data, 0, 0);
    // 直接换掉 Texture 的像素源，材质里已经引用这个对象，不用重新绑定
    t.image = c;
    t.needsUpdate = true;
  });
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

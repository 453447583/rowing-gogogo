// 统一的 GLTF 加载器工厂。
//
// 模型资源已改为 Meshopt 压缩几何（EXT_meshopt_compression）+ WebP 贴图
// （EXT_texture_webp）。WebP 由 GLTFLoader 原生支持，不需要额外解码器；
// Meshopt 则必须给每个 loader 实例注入解码器，否则模型解析直接失败。
//
// 这里用工厂函数而不是在每个文件里重复 setMeshoptDecoder()：
// 全项目有 30 多处 new GLTFLoader()，漏掉任何一处都会变成"某张图/某艘船
// 加载不出来"的隐蔽 bug。以后新增模型加载也一律走 createGLTFLoader()。
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

export function createGLTFLoader(manager) {
  const loader = new GLTFLoader(manager);
  loader.setMeshoptDecoder(MeshoptDecoder);
  return loader;
}

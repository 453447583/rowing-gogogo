// 四关 BOSS 战的主题美术配置。
// 只被怪物模式读取（Game 里 isBoss 分支），道具/竞速/弹射模式完全不受影响。
// weather 字段与 WEATHERS 同构，直接喂给 Environment/Water 的 setWeather()。

// 掩体布局：6 块，左右各 3，半圈包住 BOSS，中间留 ~72 度的正射通道。
// x/z 是相对 BOSS 的世界坐标；r 水平半径；h 纵向缩放（0.7 矮 / 0.85 高）；
// y 是入水深度（负数 = 半沉）。四关共用同一套走位，只换外观。
export const BOSS_COVER = [
  { x: -17.6, z: 27.0, r: 6.2, h: 0.84, y: 0 },
  { x: -32.4, z: 16.2, r: 4.6, h: 0.73, y: -0.4 },
  { x: -40.5, z: -2.7, r: 7.6, h: 0.80, y: -0.2 },
  { x: 17.6, z: 27.0, r: 4.3, h: 0.73, y: -0.4 },
  { x: 33.8, z: 14.9, r: 7.0, h: 0.85, y: 0 },
  { x: 41.9, z: -5.4, r: 5.1, h: 0.75, y: 0 },
];

export const BOSS_THEMES = {
  // 第一关：火山熔岩海
  1: {
    id: 'boss-volcano',
    name: '熔岩火山',
    props: 'volcano',
    weather: {
      id: 'boss-volcano',
      name: '熔岩火山',
      icon: '🌋',
      skyTop: 0x2a0f0c,
      skyBottom: 0x8c2f14,
      fogColor: 0x351a14,
      fogDensity: 0.0066,
      sunColor: 0xff6a28,
      sunIntensity: 1.15,
      sunPos: [160, 58, -180],
      sunDir: [0.4, 0.18, -0.5],
      hemiIntensity: 0.58,
      cloudColor: 0x3a1c18,
      waterColor: 0x3d1812,
      waterDeep: 0x120607,
      waterCrest: 0xffa055,
      waveScale: 1.25,
      rain: 0,
      // 2026-11-19：第一关天空用黄昏大气（暖橙厚云 + 低曝光）；
      // 只作用于天空，下面的水色/雾/光照/布景一律保持火山主题原样。
      skyPreset: 'dusk',
    },
    rocks: {
      style: {
        color: 0x2b2523, roughness: 1.0, metalness: 0.02,
        emissive: 0xff4a10, emissiveIntensity: 0.06,
        cap: 0x3a221a, capEmissive: 0xff4a10, capOpacity: 0.95,
      },
      layout: BOSS_COVER,
    },
  },

  // 第二关：绿松石浅海 + 珊瑚礁
  2: {
    id: 'boss-tropical',
    name: '珊瑚浅海',
    props: 'tropical',
    weather: {
      id: 'boss-tropical',
      name: '珊瑚浅海',
      icon: '🏝️',
      skyTop: 0x2f9be8,
      skyBottom: 0xd6f6ff,
      fogColor: 0xbfeaf7,
      fogDensity: 0.0021,
      sunColor: 0xfff7e2,
      sunIntensity: 1.9,
      sunPos: [200, 300, 140],
      sunDir: [0.45, 0.72, 0.3],
      hemiIntensity: 0.95,
      cloudColor: 0xffffff,
      waterColor: 0x39e2cf,
      waterDeep: 0x0a5f96,
      waterCrest: 0xffffff,
      waveScale: 0.9,
      rain: 0,
    },
    rocks: {
      style: {
        color: 0xbfd8cf, roughness: 0.92, metalness: 0.02,
        emissive: 0x1d6b63, emissiveIntensity: 0.1,
        cap: 0x7fe3c8, capEmissive: 0x2fd8b4, capOpacity: 0.9,
      },
      layout: BOSS_COVER,
    },
  },

  // 第三关：污染工业港
  3: {
    id: 'boss-harbor',
    name: '锈蚀港口',
    props: 'harbor',
    weather: {
      id: 'boss-harbor',
      name: '锈蚀港口',
      icon: '🏭',
      skyTop: 0x4f585c,
      skyBottom: 0x9aa4a6,
      fogColor: 0x707a7a,
      fogDensity: 0.0050,
      sunColor: 0xc6d2cc,
      sunIntensity: 0.95,
      sunPos: [100, 180, -60],
      sunDir: [0.3, 0.6, -0.2],
      hemiIntensity: 0.62,
      cloudColor: 0x6b7476,
      waterColor: 0x44543f,
      waterDeep: 0x141b14,
      waterCrest: 0x9ba89a,
      waveScale: 0.8,
      // 2026-11-19：第三关暴风雨天空太单薄，补上雨滴（与竞速暴风雨同一套 900 根雨丝）。
      // 只加雨，水色/雾/光照/布景不动。
      rain: 1,
      // 第三关天空用暴风雨大气（压黑天幕 + 密云），锈蚀港口的水色/雾/光照不动。
      skyPreset: 'storm',
    },
    rocks: {
      style: {
        color: 0x5a4a3a, roughness: 1.0, metalness: 0.18,
        emissive: 0x2a1a0c, emissiveIntensity: 0.08,
        cap: 0x655040, capEmissive: 0x1a1208, capOpacity: 1,
      },
      layout: BOSS_COVER,
    },
  },

  // 第四关：极夜冰海
  4: {
    id: 'boss-ice',
    name: '极夜冰海',
    props: 'ice',
    weather: {
      id: 'boss-ice',
      name: '极夜冰海',
      icon: '🌌',
      skyTop: 0x04070f,
      skyBottom: 0x0e2238,
      fogColor: 0x08131f,
      fogDensity: 0.0055,
      sunColor: 0x9fc4ff,
      sunIntensity: 0.5,
      sunPos: [-160, 120, 80],
      sunDir: [-0.4, 0.5, 0.2],
      hemiIntensity: 0.45,
      cloudColor: 0x14283c,
      waterColor: 0x0d3a5c,
      waterDeep: 0x020b16,
      waterCrest: 0xbfe8ff,
      waveScale: 0.7,
      rain: 0,
      snow: 1,   // 降雪量保持原样：换星空天空不影响雪
      // 第四关天空用璀璨星空大气（深蓝夜空 + 无太阳盘），星/银河/流星由 stars 打开；
      // 水色/雾/光照/雪量/布景都不动。
      skyPreset: 'starry',
      stars: 1,
    },
    rocks: {
      style: {
        color: 0xdaeef8, roughness: 0.32, metalness: 0.08,
        emissive: 0x2f7fae, emissiveIntensity: 0.28,
        cap: 0xe8f8ff, capEmissive: 0x4fa8d8, capOpacity: 0.8,
      },
      layout: BOSS_COVER,
    },
  },
  // 第五头 BOSS「深渊传令官」：直接沿用第四关的冰海雪原布景与岩石，
  // 只把光照/水色/岩石发光染成冷紫圣辉，避免换一套新资产。
  5: {
    id: 'boss-herald',
    name: '圣辉雪原',
    props: 'ice',
    weather: {
      id: 'boss-herald',
      name: '圣辉雪原',
      // 106 号图标：雪花中心嵌金色小十字 + 紫冰晶碎片，和第 3 关的普通暴雪区分。
      // 过场卡由 ui.js 的 chipIco 出图（路径不能拼进文案）。
      icon: '/icons/weather/106_weather_holy_snow.png',
      // 暴雪底子：冷白弥散天光 + 满量降雪；紫调只留在岩石/水色点缀上
      skyTop: 0x62718a,
      skyBottom: 0xd7e2ee,
      fogColor: 0xa9b8c9,
      fogDensity: 0.0062,
      sunColor: 0xe8f1ff,
      sunIntensity: 0.9,
      sunPos: [140, 130, -120],
      sunDir: [0.32, 0.52, -0.3],
      hemiIntensity: 0.85,
      cloudColor: 0xdfe8f2,
      waterColor: 0x274866,
      waterDeep: 0x071320,
      waterCrest: 0xe8f6ff,
      waveScale: 0.7,
      rain: 0,
      snow: 1,
      skyPreset: 'blizzard',
    },
    rocks: {
      style: {
        color: 0xcfc0e8, roughness: 0.4, metalness: 0.1,
        emissive: 0x5a42a0, emissiveIntensity: 0.3,
        cap: 0xe6dcff, capEmissive: 0x8f74e0, capOpacity: 0.8,
      },
      layout: BOSS_COVER,
    },
  },
};

export function getBossTheme(stage) {
  return BOSS_THEMES[stage] || BOSS_THEMES[1];
}

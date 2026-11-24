// 全量图标表（明亮赛博 Q 版，1024² 透明 PNG）
//
// 22 枚道具图标在 public/icons/items/，其余 67 枚按类别分在 mob_items / weapons /
// modes / weather / maps / boss / mobs / status / ui 下。
// 用法：
//   iconImg('modeRace', 'lp-icon')        → '<img class="lp-icon" src="...">'
//   iconImg('mapCanyon')                  → 同上，无 class
//   iconSrc('stWeak')                     → 只要路径
// 找不到就返回空字符串，调用方自行回退到原来的 emoji。

export const ICONS = {
  // ---------- 怪物模式专属道具 ----------
  armorHarpoon: '/icons/mob_items/23_armor_harpoon.png',
  deepHarpoon: '/icons/mob_items/24_deep_harpoon.png',
  tripleCharge: '/icons/mob_items/25_triple_charge.png',
  lightningRod: '/icons/mob_items/26_lightning_rod.png',
  ramCharm: '/icons/mob_items/27_ram_charm.png',

  // ---------- 船载主炮 ----------
  twinAutocannon: '/icons/weapons/28_twin_autocannon.png',
  twinTorpedo: '/icons/weapons/29_twin_torpedo.png',
  chargeLaser: '/icons/weapons/30_charge_laser.png',
  tripleCannon: '/icons/weapons/31_triple_cannon.png',
  waterBlade: '/icons/weapons/32_water_blade.png',
  singleCannon: '/icons/weapons/33_single_cannon.png',
  magnetBlade: '/icons/weapons/34_magnet_blade.png',
  hornCannon: '/icons/weapons/35_horn_cannon.png',

  // ---------- 游戏模式 ----------
  modeRace: '/icons/modes/36_mode_race.png',
  modeItem: '/icons/modes/37_mode_item.png',
  modeLaunch: '/icons/modes/38_mode_launch.png',
  modeMonster: '/icons/modes/39_mode_monster.png',
  modeArena: '/icons/modes/40_mode_arena.png',
  // 挑战模式（影子对战）：4 个玩法卡里最后一个没上图的
  modeChallenge: '/icons/modes/107_mode_challenge.png',

  // ---------- 天气 ----------
  weatherSunny: '/icons/weather/41_weather_sunny.png',
  weatherDusk: '/icons/weather/42_weather_dusk.png',
  weatherStorm: '/icons/weather/43_weather_storm.png',
  weatherSnow: '/icons/weather/44_weather_snow.png',
  weatherStarry: '/icons/weather/45_weather_starry.png',
  // 第五关主题「圣辉雪原」：雪花中心嵌金色小十字 + 紫冰晶，和普通暴雪区分
  weatherHolySnow: '/icons/weather/106_weather_holy_snow.png',

  // ---------- 地图 ----------
  mapCanyon: '/icons/maps/46_map_canyon.png',
  mapLake: '/icons/maps/47_map_lake.png',
  mapCanyonWave: '/icons/maps/48_map_canyon_wave.png',
  mapDragonPalace: '/icons/maps/49_map_dragon_palace.png',
  mapIceStrait: '/icons/maps/50_map_ice_strait.png',
  mapNeonStrait: '/icons/maps/51_map_neon_strait.png',
  mapMistyRiver: '/icons/maps/52_map_misty_river.png',
  mapLavaNight: '/icons/maps/53_map_lava_night.png',

  // ---------- BOSS 与难度 ----------
  bossAbyss: '/icons/boss/54_boss_abyss_dragon.png',
  bossInferno: '/icons/boss/55_boss_inferno_dragon.png',
  bossThunder: '/icons/boss/56_boss_thunder_knight.png',
  bossBlood: '/icons/boss/57_boss_blood_demon.png',
  // 第五关「深渊传令官」：六翼张开的徽记，30px 下只靠轮廓认（细节在缩略尺寸会糊成一团）
  bossHerald: '/icons/boss/104_boss_herald.png',
  diffNormal: '/icons/boss/58_diff_normal.png',
  diffElite: '/icons/boss/59_diff_elite.png',
  diffNightmare: '/icons/boss/60_diff_nightmare.png',

  // ---------- 小怪 ----------
  mobRockBeast: '/icons/mobs/61_mob_rock_beast.png',
  mobBloodDemon: '/icons/mobs/62_mob_blood_demon.png',
  mobWhaleShark: '/icons/mobs/63_mob_whale_shark.png',
  mobFrostPenguin: '/icons/mobs/64_mob_frost_penguin.png',
  mobShellCrab: '/icons/mobs/65_mob_shell_crab.png',
  mobElectricJelly: '/icons/mobs/66_mob_electric_jelly.png',

  // ---------- BOSS 状态 ----------
  stWeak: '/icons/status/67_st_weak.png',
  stSilence: '/icons/status/68_st_silence.png',
  stLoseControl: '/icons/status/69_st_lose_control.png',
  stBlind: '/icons/status/70_st_blind.png',
  stChaos: '/icons/status/71_st_chaos.png',
  stSlow: '/icons/status/72_st_slow.png',
  stSink: '/icons/status/73_st_sink.png',

  // ---------- 界面 ----------
  uiChampion: '/icons/ui/74_ui_champion.png',
  uiMedalGold: '/icons/ui/75_ui_medal_gold.png',
  uiMedalSilver: '/icons/ui/76_ui_medal_silver.png',
  uiMedalBronze: '/icons/ui/77_ui_medal_bronze.png',
  uiDead: '/icons/ui/78_ui_dead.png',
  uiConfirm: '/icons/ui/79_ui_confirm.png',
  uiSignal: '/icons/ui/80_ui_signal.png',
  uiRandom: '/icons/ui/81_ui_random.png',
  uiSettings: '/icons/ui/82_ui_settings.png',
  uiRename: '/icons/ui/83_ui_rename.png',
  uiWarning: '/icons/ui/84_ui_warning.png',
  uiHelp: '/icons/ui/85_ui_help.png',
  uiThemeVolcano: '/icons/ui/86_ui_theme_volcano.png',
  uiThemeIsland: '/icons/ui/87_ui_theme_island.png',
  uiThemeFactory: '/icons/ui/88_ui_theme_factory.png',
  uiThemeStarsea: '/icons/ui/89_ui_theme_starsea.png',
  // HUD 常驻符号（此前一直是 emoji：🏁 圈数 / ⏱️ 计时 / ⚠ 逆行 / 👻 影子 / ❔ 空槽）
  uiLap: '/icons/ui/109_ui_lap.png',
  uiTimer: '/icons/ui/110_ui_timer.png',
  uiWrongWay: '/icons/ui/111_ui_wrongway.png',
  uiGhost: '/icons/ui/108_ui_ghost.png',
  uiEmptySlot: '/icons/ui/112_ui_empty_slot.png',
};

/** 22 枚道具图标：按**道具名**索引（ITEM_DEFS / BOSS_ITEM_DEFS 共用一份） */
export const ITEM_ART = {
  '氮气瓶': '/icons/items/01_nitro.png',
  '深水炸弹': '/icons/items/02_depth_charge.png',
  '章鱼': '/icons/items/03_octopus.png',
  '护盾': '/icons/items/04_shield.png',
  '追踪导弹': '/icons/items/05_homing_missile.png',
  '漩涡': '/icons/items/06_vortex.png',
  '磁力吸盘': '/icons/items/07_magnet.png',
  '墨鱼喷墨': '/icons/items/08_ink_squid.png',
  '深海瀑布': '/icons/items/09_deep_waterfall.png',
  '天使庇佑': '/icons/items/10_angel.png',
  '飞鱼群': '/icons/items/11_flying_fish.png',
  '海洋之怒': '/icons/items/12_ocean_wrath.png',
  '减速艇': '/icons/items/13_turtle_boat.png',
  '方向转换器': '/icons/items/14_reverse_wheel.png',
  '泡泡蜻蜓': '/icons/items/15_bubble_dragonfly.png',
  '鱼雷齐射': '/icons/items/16_torpedo_salvo.png',
  '血枪狙击': '/icons/items/17_blood_railgun.png',
  '圣光沙暴': '/icons/items/18_holy_sandstorm.png',
  '逆流之门': '/icons/items/19_reverse_portal.png',
  '剑刃风暴': '/icons/items/20_blade_storm.png',
  '圣域': '/icons/items/21_sanctuary.png',
  '护盾墙': '/icons/items/22_shield_wall.png',
  // 怪物模式专属 5 件（23~27）
  '破甲标枪': '/icons/mob_items/23_armor_harpoon.png',
  '深海鱼叉': '/icons/mob_items/24_deep_harpoon.png',
  '三连深水弹': '/icons/mob_items/25_triple_charge.png',
  '引雷针': '/icons/mob_items/26_lightning_rod.png',
  '冲角护符': '/icons/mob_items/27_ram_charm.png',
};

// ---------- 游戏内 id → 图标 key 的对照（统一放这里，各处直接用） ----------
export const MODE_ICON = {
  race: 'modeRace', item: 'modeItem', launch: 'modeLaunch',
  boss: 'modeMonster', arena: 'modeArena', challenge: 'modeChallenge',
};
export const MAP_ICON = {
  canyon: 'mapCanyon', lake: 'mapLake', ocean: 'mapCanyonWave',
  palace: 'mapDragonPalace', tide: 'mapIceStrait', strait: 'mapNeonStrait',
  baked: 'mapMistyRiver', magma: 'mapLavaNight',
};
export const WEATHER_ICON = {
  day: 'weatherSunny', dusk: 'weatherDusk', storm: 'weatherStorm',
  blizzard: 'weatherSnow', starry: 'weatherStarry', random: 'uiRandom',
};
export const BOSS_ICON = {
  dragon_deep: 'bossAbyss', dragon_inferno: 'bossInferno',
  knight_thunder: 'bossThunder', blood_nightmare: 'bossBlood',
  // 第五关：以前缺这一条，HUD 徽记和经典模式过场卡一直回退成 emoji 😈
  abyss_herald: 'bossHerald',
};
export const DIFF_ICON = {
  normal: 'diffNormal', elite: 'diffElite', nightmare: 'diffNightmare',
};
export const STATUS_ICON = {
  vulnerable: 'stWeak', silence: 'stSilence', reverse: 'stLoseControl',
  blind: 'stBlind', confuse: 'stChaos', slow: 'stSlow', dive: 'stSink',
};
export const MOB_ICON = {
  beast: 'mobRockBeast', blood: 'mobBloodDemon', whale_shark: 'mobWhaleShark',
  penguin: 'mobFrostPenguin', crab: 'mobShellCrab', jelly: 'mobElectricJelly',
};
export const WEAPON_ICON = {
  rower: 'twinAutocannon', skiff: 'twinTorpedo', falcon: 'chargeLaser',
  titan: 'tripleCannon', dolphin: 'waterBlade', vintage: 'singleCannon',
  longship: 'magnetBlade', cow: 'hornCannon',
};

export function iconSrc(key) {
  return ICONS[key] || '';
}

/** 生成一个 <img>；key 不存在返回 ''，调用方回退 emoji */
export function iconImg(key, cls = '', extra = '') {
  const src = ICONS[key];
  if (!src) return '';
  return `<img src="${src}" alt="" draggable="false"${cls ? ` class="${cls}"` : ''}${extra}>`;
}

/** 把已存在的元素内容换成图标；key 不存在返回 false */
export function setIcon(el, key) {
  const src = ICONS[key];
  if (!el || !src) return false;
  // 幂等：HUD 每帧都会调 setIcon（血条刷新），若无脑重写 innerHTML，
  // <img> 每帧被销毁重建 → 图片反复重新解码、偶发闪一下空白。
  // src 没变就只补 class，不动 DOM。
  const cur = el.firstElementChild;
  if (cur && cur.tagName === 'IMG' && cur.getAttribute('src') === src) {
    el.classList.add('has-art');
    return true;
  }
  el.innerHTML = `<img src="${src}" alt="" draggable="false">`;
  el.classList.add('has-art');
  return true;
}

// ---------- C 类第二批（2026-11-20）：头像 / 皇冠 / 技能来源 / 战斗事件 ----------
// 这 23 枚是新生成素材，用途是把最后一批 emoji 换掉：
//   头像管"人是谁"，皇冠管"谁是房主"，技能管"这招什么属性"，事件管"场上发生了什么"。

/** 9 个默认头像（8 内置 + 1 个 AI 专用）+ 3 个 AI 配色变体。都是「圆角深蓝底 + 主体居中」。 */
export const AVATAR_ART = {
  wave: '/icons/avatars/av_wave.png',
  whale: '/icons/avatars/av_whale.png',
  shark: '/icons/avatars/av_shark.png',
  turtle: '/icons/avatars/av_turtle.png',
  sail: '/icons/avatars/av_sail.png',
  anchor: '/icons/avatars/av_anchor.png',
  squid: '/icons/avatars/av_squid.png',
  diver: '/icons/avatars/av_diver.png',
  bot: '/icons/avatars/av_bot.png',
  // 同一副机器人造型只换配色：一屋子 AI 不再长同一张脸（按 ai1/ai2/ai3 轮换）
  botA: '/icons/avatars/av_bot_A.png',
  botB: '/icons/avatars/av_bot_B.png',
  botC: '/icons/avatars/av_bot_C.png',
};

/** AI 玩家的头像轮换表：按 id 尾号取，取不到就回落到通用 bot */
export const AI_AVATAR_ROTATION = ['botA', 'botB', 'botC', 'bot'];

/** 大厅房间列表的房主标记 */
export const CROWN = '/icons/ui/90_ui_crown.png';

/** BOSS 技能属性（怪物模式技能预警 toast 的前缀图标） */
export const SKILL_SRC = {
  fire: '/icons/skills/91_sk_fire.png',
  ice: '/icons/skills/92_sk_ice.png',
  thunder: '/icons/skills/93_sk_thunder.png',
  water: '/icons/skills/94_sk_water.png',
  blood: '/icons/skills/95_sk_blood.png',
  // 第五关「深渊传令官」的 7 招是圣光系，不该再借用血滴图标
  holy: '/icons/skills/105_sk_holy.png',
};

/** 战斗事件（战斗提示 toast 的前缀图标） */
export const EVENT_ICON = {
  boom: '/icons/events/96_ev_boom.png',
  enrage: '/icons/events/97_ev_enrage.png',
  shield: '/icons/events/98_ev_shield.png',
  danger: '/icons/events/99_ev_danger.png',
  melee: '/icons/events/100_ev_melee.png',
  heal: '/icons/events/101_ev_heal.png',
  core: '/icons/events/102_ev_core.png',
  bind: '/icons/events/103_ev_bind.png',
};

/**
 * toast 开头 emoji → 图标路径。
 *
 * 为什么用映射而不是把几十处 `onToast('🔥 熔岩海啸！…')` 全改掉：
 * 那些调用散在 BossMode 的二十多个技能里，逐条改字符串既容易漏、又会把
 * 玩法代码和美术资源绑死。这里只做**开头一个字符**的替换，调用方零改动；
 * 以后想加新图标，往这张表里加一行即可。
 *
 * 注意 ❄️ / 🛡️ / ☠️ / 🗡️ / ⛓️ 带变体选择符 U+FE0F，比较前统一去掉（见 stripVs）。
 */
export const TOAST_ICON = {
  '🔥': SKILL_SRC.fire,
  '❄': SKILL_SRC.ice,
  '⚡': SKILL_SRC.thunder,
  '🌊': SKILL_SRC.water,
  '🩸': SKILL_SRC.blood,
  // 圣光：没有对应 emoji，用 ✦ 当占位符（skillSource 会把 holy 技能的来源标成 '✦ 技能名'）
  '✦': SKILL_SRC.holy,
  '💥': EVENT_ICON.boom,
  '👹': EVENT_ICON.enrage,
  '🛡': EVENT_ICON.shield,
  '☠': EVENT_ICON.danger,
  '🗡': EVENT_ICON.melee,
  '💚': EVENT_ICON.heal,
  '🔶': EVENT_ICON.core,
  '⛓': EVENT_ICON.bind,
  // 顺带把几个高频 UI 符号也接上（值来自第一批 89 枚）
  '💫': '/icons/status/67_st_weak.png',
  '💀': '/icons/ui/78_ui_dead.png',
  '🏆': '/icons/ui/74_ui_champion.png',
  '👑': CROWN,
  '🎲': '/icons/ui/81_ui_random.png',
  '📶': '/icons/ui/80_ui_signal.png',
  '✅': '/icons/ui/79_ui_confirm.png',
};

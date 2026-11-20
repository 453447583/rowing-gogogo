# 全量音效索引与代码集成说明

本批共 **47 个新音效**，全部统一规格：

- 48kHz 采样率、单声道、16bit PCM
- 峰值精确归一到 **-3.0dBFS**（音量一致，不会忽大忽小）
- 普通音效尾部 20ms 淡出，无爆音
- 3 个 loop 音效做了首尾交叉淡化，**无缝循环**，循环点听不到接缝
- 无音乐、无人声，明亮街机风，小喇叭也听得清

---

## 一、音效索引（key 就是文件名，也是代码里的调用名）

### A 组：BOSS 道具变体（7 个）

| key | 含义 | 时长 |
|---|---|---|
| boss_nitro | BOSS 氮气撞（金属冲击尾音） | 0.8s |
| boss_bomb | BOSS 深水炸弹（sub-bass 重压） | 1.0s |
| boss_missile | BOSS 导弹命中（装甲破裂） | 0.9s |
| boss_vortex | BOSS 漩涡水弹（低频冲击） | 1.0s |
| boss_fish | BOSS 飞鱼撕咬 | 0.88s |
| weakspot_javelin | 破甲标枪 | 0.6s |
| boss_control_hit | 控制命中巨兽（低吼共振） | 0.88s |

### B 组：BOSS 事件（20 个）

| key | 含义 | 时长 |
|---|---|---|
| ram_boss | 普通撞 BOSS | 0.5s |
| ram_boss_nitro | 氮气冲撞 BOSS | 0.6s |
| boss_damage_ranged | 远程命中 BOSS | 0.3s |
| weak_crit | 弱点暴击 | 0.45s |
| boss_stagger | 破韧跪地 | 1.0s |
| cores_break | 四核全破 | 1.2s |
| boss_warn | BOSS 技能预警 | 0.4s |
| boss_roar | BOSS 怒吼/出场 | 1.38s |
| boss_fire | BOSS 火焰技能 | 1.0s |
| boss_ice | BOSS 冰霜技能 | 0.88s |
| boss_thunder | BOSS 雷霆技能 | 1.0s |
| boss_water | BOSS 水系技能 | 1.0s |
| boss_magic | BOSS 通用魔法 | 0.88s |
| player_hit | 玩家被击中 | 0.4s |
| boss_death | BOSS 死亡 | 2.0s |
| transition | 阶段转换/换关 | 1.5s |
| item_box | 道具箱拾取 | 0.35s |
| respawn | 复活/救援 | 0.8s |
| synergy | 协同合击就绪 | 0.8s |
| fish_minion | 飞鱼撕咬小怪 | 0.5s |

### C 组：通用比赛事件（20 个，★ 为无缝循环）

| key | 含义 | 时长 |
|---|---|---|
| boat_collide | 船撞船 | 0.45s |
| hit_rock | 撞礁石/障碍 | 0.4s |
| hit_buoy | 撞护栏/浮桶 | 0.35s |
| fall_water | 冲出悬崖落水 | 1.0s |
| wave_launch | 巨浪腾空/起跳 | 0.68s |
| nitro_ignition | 氮气起手 | 0.5s |
| nitro_loop ★ | 氮气持续循环 | 1.0s |
| perfect_start | 完美起步 | 0.88s |
| drift_boost | 漂移小喷 | 0.3s |
| speed_portal | 加速传送门 | 0.68s |
| checkpoint | 过门/过圈 | 0.5s |
| finish | 冲线 | 1.5s |
| shield_break | 护盾破碎 | 0.6s |
| bomb_hit | 被深水炸弹命中 | 0.8s |
| missile_hit | 被导弹/鱼雷命中 | 0.6s |
| ink_loop ★ | 被墨汁糊住循环 | 4.0s |
| spin_loop ★ | 被漩涡缠住循环 | 3.0s |
| slow_hit | 被减速艇命中 | 0.68s |
| reverse_tide | 逆流/方向反转 | 0.68s |
| storm_thunder | 暴风雨闪电 | 1.2s |

---

## 二、代码集成（一个管理器统一管，复制即用）

把 47 个 wav 放进项目的 `sfx/` 目录，新建 `sfx.js`：

```js
// ===== sfx.js 音效管理器 =====
const SFX_FILES = {
  // A 组 BOSS 道具变体
  boss_nitro: 'sfx/boss_nitro.wav', boss_bomb: 'sfx/boss_bomb.wav',
  boss_missile: 'sfx/boss_missile.wav', boss_vortex: 'sfx/boss_vortex.wav',
  boss_fish: 'sfx/boss_fish.wav', weakspot_javelin: 'sfx/weakspot_javelin.wav',
  boss_control_hit: 'sfx/boss_control_hit.wav',
  // B 组 BOSS 事件
  ram_boss: 'sfx/ram_boss.wav', ram_boss_nitro: 'sfx/ram_boss_nitro.wav',
  boss_damage_ranged: 'sfx/boss_damage_ranged.wav', weak_crit: 'sfx/weak_crit.wav',
  boss_stagger: 'sfx/boss_stagger.wav', cores_break: 'sfx/cores_break.wav',
  boss_warn: 'sfx/boss_warn.wav', boss_roar: 'sfx/boss_roar.wav',
  boss_fire: 'sfx/boss_fire.wav', boss_ice: 'sfx/boss_ice.wav',
  boss_thunder: 'sfx/boss_thunder.wav', boss_water: 'sfx/boss_water.wav',
  boss_magic: 'sfx/boss_magic.wav', player_hit: 'sfx/player_hit.wav',
  boss_death: 'sfx/boss_death.wav', transition: 'sfx/transition.wav',
  item_box: 'sfx/item_box.wav', respawn: 'sfx/respawn.wav',
  synergy: 'sfx/synergy.wav', fish_minion: 'sfx/fish_minion.wav',
  // C 组 通用比赛事件
  boat_collide: 'sfx/boat_collide.wav', hit_rock: 'sfx/hit_rock.wav',
  hit_buoy: 'sfx/hit_buoy.wav', fall_water: 'sfx/fall_water.wav',
  wave_launch: 'sfx/wave_launch.wav', nitro_ignition: 'sfx/nitro_ignition.wav',
  nitro_loop: 'sfx/nitro_loop.wav', perfect_start: 'sfx/perfect_start.wav',
  drift_boost: 'sfx/drift_boost.wav', speed_portal: 'sfx/speed_portal.wav',
  checkpoint: 'sfx/checkpoint.wav', finish: 'sfx/finish.wav',
  shield_break: 'sfx/shield_break.wav', bomb_hit: 'sfx/bomb_hit.wav',
  missile_hit: 'sfx/missile_hit.wav', ink_loop: 'sfx/ink_loop.wav',
  spin_loop: 'sfx/spin_loop.wav', slow_hit: 'sfx/slow_hit.wav',
  reverse_tide: 'sfx/reverse_tide.wav', storm_thunder: 'sfx/storm_thunder.wav',
};
// 这 3 个是循环音效
const LOOP_KEYS = new Set(['nitro_loop', 'ink_loop', 'spin_loop']);

class SfxManager {
  constructor(camera) {
    this.listener = new THREE.AudioListener();
    camera.add(this.listener);
    this.loader = new THREE.AudioLoader();
    this.sounds = {};
  }
  // 进游戏前一次性预加载
  loadAll() {
    return Promise.all(Object.entries(SFX_FILES).map(([key, url]) =>
      new Promise(res => {
        this.loader.load(url, buf => {
          const s = new THREE.Audio(this.listener);
          s.setBuffer(buf);
          if (LOOP_KEYS.has(key)) s.setLoop(true);
          this.sounds[key] = s;
          res();
        });
      })
    ));
  }
  // 普通音效：可反复触发，先停再播避免叠加
  // 循环音效：没在放才放，不会重复开
  play(key) {
    const s = this.sounds[key];
    if (!s) return;
    if (LOOP_KEYS.has(key)) { if (!s.isPlaying) s.play(); }
    else { s.stop(); s.play(); }
  }
  stop(key) {
    const s = this.sounds[key];
    if (s && s.isPlaying) s.stop();
  }
}
```

### 用法

```js
// 初始化（相机就是你的追尾相机）
const sfx = new SfxManager(camera);
await sfx.loadAll();   // 等全部加载完再开始

// 普通事件，直接按 key 触发
sfx.play('item_box');        // 捡到道具箱
sfx.play('boss_warn');       // BOSS 放技能前预警
sfx.play('weak_crit');       // 打出弱点暴击

// 循环音效：开始时 play，结束时 stop
sfx.play('nitro_loop');      // 氮气持续期间一直响
// ...氮气结束
sfx.stop('nitro_loop');

sfx.play('spin_loop');       // 被漩涡缠住时
// ...挣脱后
sfx.stop('spin_loop');
```

---

## 三、和之前那批 16 个道具音效的关系

之前那 16 个（`01_nitro`～`16_torpedo`）是**玩家释放道具时**的音效，本批是 **BOSS 战变体、BOSS 事件、比赛碰撞事件**，触发场景不同，两套都保留：

- 玩家自己放氮气 → 用之前的 `01_nitro`
- 氮气撞在 BOSS 身上 → 用本批的 `boss_nitro`
- 氮气持续的引擎声 → 用本批的 `nitro_loop`

---

## 四、试听后想调整

某个音效不满意（比如 BOSS 怒吼不够凶、落水声不够大、雷声不够亮），直接告诉我 **key + 想要的感觉**，我单独重做那一个，不影响其他 46 个。

> （注：部分内容由豆包 AI 生成）
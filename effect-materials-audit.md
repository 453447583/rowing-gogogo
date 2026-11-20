# Effekseer 官方素材评估 · EffectMaterials 15 个（2026-11-02）

> 截图总览：`shots/fx_sheet.png`（每个特效 4 帧生长序列，自动取景）
> 单帧原图：`shots/fx_preview/ef_xxx_0..3.png`（60 张）
> 已落盘：`public/effects/EffectMaterials/`（8.5 MB / 139 文件）

---

## 一、来源与授权

| 项 | 值 |
|---|---|
| 仓库 | `github.com/effekseer/EffectMaterials`（官方组织，非第三方搬运） |
| 授权 | **CC0**（README 明确 "All data are under CC0"），商用/改色/二次分发都不需要署名 |
| 格式版本 | **Effekseer 1.7**，与本项目运行时 `effekseer 1.70e` 完全匹配 |
| 作者 | `ef_fire*` / `ef_ice*` / `ef_lightning*` / `ef_wind*` = KTK_kumamoto；`ef_holy01` / `ef_parts_hit*` = Effekseer 官方 |
| 体积 | 8.5 MB（纹理占 7.9 MB，`Meshes/*.efkmodel` 约 0.6 MB；`.fbx` 源文件已剔除） |

**获取方式**（GitHub release / codeload 在本机被重置，只有 jsDelivr 通）：

```bash
# 文件树
curl -sL "https://data.jsdelivr.com/v1/packages/gh/effekseer/EffectMaterials@main?structure=flat" -o tree.json
# 逐个文件（脚本已留在 .tmp_fx_src/fetch_gh.mjs）
node .tmp_fx_src/fetch_gh.mjs "effekseer/EffectMaterials@main" "/Effects/" "./EffectMaterials"
```

> ⚠️ 官方工具包（`Effekseer170Win.zip`，32 MB）从 GitHub release 和 sakura 镜像都下不来（连接被重置），
> 因此**拿不到工具包里那套 150+ 示例**（水和墨原本在那里面）。这是当前唯一遗憾。

---

## 二、逐个评估（实测数据来自覆盖率扫描，scale 0.75）

| # | 素材 | 形态 | 实测时长 | 观感 | 最合适用在哪 |
|---|---|---|---|---|---|
| 1 | `ef_fire01` | 火球爆燃 → 碎火四散 | 0.7s | ★★★☆ | 命中爆点（炸弹/导弹）、熔岩柱 |
| 2 | `ef_fire02` | 缓慢扩散的环形火墙 | 0.8s | ★★☆ | 范围预警圈、地面灼烧（偏淡） |
| 3 | `ef_fire03` | **横向火带 + 大火球** | 3.1s | ★★★★★ | **BOSS 喷吐、火焰喷射**（形态最完整） |
| 4 | `ef_holy01` | 极淡的竖向光纹 | 0.8s | ★☆ | 不推荐（几乎看不见，不如现有 Aura01） |
| 5 | `ef_ice01` | 冰花绽开（白色星芒） | 1.4s | ★★★★ | 冰系命中、护盾破碎 |
| 6 | `ef_ice02` | 冰雾膨胀 → 冰晶团 | 2.2s | ★★★ | **冰霜吐息、减速领域** |
| 7 | `ef_ice03` | 冰晶下坠 + 冲击 | 2.4s | ★★★★ | 冰柱落下、范围压制 |
| 8 | `ef_lightning01` | 紫色电弧球 | 0.4s | ★★★★ | 电磁球、磁力吸盘 |
| 9 | `ef_lightning02` | **竖向电流束** | 0.2s | ★★★★ | **落雷**（短促，适合连打） |
| 10 | `ef_lightning03` | **多束光柱 + 连锁闪** | 2.9s | ★★★★★ | **全屏大招、BOSS 落雷**（最有气势） |
| 11 | `ef_parts_hit01` | 白色星爆（小） | 0.1s | ★★★ | 轻命中（替代 toonHit） |
| 12 | `ef_parts_hit02` | **青色爪痕 / 斩击** | 0.1s | ★★★★★ | **水刃、横扫、近战斩** |
| 13 | `ef_wind01` | 绿色气旋球 | 0.7s | ★★ | 不推荐（绿色偏毒，与海洋主题不合） |
| 14 | `ef_wind02` | **上升气流柱** | 1.3s | ★★★★ | **水柱/涌泉**（改青蓝即可读作水） |
| 15 | `ef_wind03` | 龙卷 + 地裂 + 地面光环 | 1.5s | ★★★★ | 漩涡、传送门、领域 |

**结论**：15 个里真正值得接入的是 **9 个**：
`fire03`、`ice01`、`ice02`、`ice03`、`lightning02`、`lightning03`、`parts_hit02`、`wind02`、`wind03`
（`fire01` 作为爆点备选，`parts_hit01` 作为轻命中备选）

---

## 三、对照你要的六类

| 你要的 | 有没有原生 | 用哪个 | 备注 |
|---|---|---|---|
| **火** | ✅ 3 个 | `fire03`（主）/ `fire01`（爆点） | 形态很正，橙红色不用改 |
| **冰** | ✅ 3 个 | `ice01` / `ice02` / `ice03` | 三个形态区分明显，可分别给"命中/领域/坠落" |
| **雷** | ✅ 3 个 | `lightning02`（落雷）/ `lightning03`（大招） | 紫色，可直接用 |
| **电磁** | ⚠️ 半个 | `lightning01`（紫电弧球） | 没有"磁力线/电磁场"类，只能靠这张 + 现有 `Barrior02` |
| **水** | ❌ 没有 | `wind02` 改**青蓝**当水柱；`wind03` 改青蓝当漩涡 | 本项目已有 `ToonWater` / `Splash01` 打底，问题不大 |
| **墨** | ❌ 没有 | 沿用现有 `Simple_Distortion` + `ProceduralPudding` 压成黑紫 | 墨的"糊状 + 扭曲"本来就是这两张的强项 |

> 水/墨要"真的新素材"，只能等官方工具包能下载（150+ 示例里有 `Water`、`Ink` 系列），
> 或者你去 Effekseer 编辑器里自己拉一版——现有素材改色已经能覆盖 80% 需求。

---

## 四、建议怎么接（等你点头再改代码）

### 4.1 道具赛

```js
// src/game/Effects.js —— FX_DEFS 追加（scale 待实测微调，先按 0.3 起）
Object.assign(FX_DEFS, {
  fxFireBand:   { url: '/effects/EffectMaterials/ef_fire03.efkefc', scale: 0.32 },  // 火焰弹飞行/喷吐
  fxIceBurst:   { url: '/effects/EffectMaterials/ef_ice01.efkefc',  scale: 0.30 },  // 冰系命中
  fxIceField:   { url: '/effects/EffectMaterials/ef_ice02.efkefc',  scale: 0.28 },  // 冰霜领域
  fxSlashBlue:  { url: '/effects/EffectMaterials/ef_parts_hit02.efkefc', scale: 0.34 }, // 水刃/斩击
  fxGeyser:     { url: '/effects/EffectMaterials/ef_wind02.efkefc', scale: 0.26 },  // 水柱（改青蓝）
  fxVortexBig:  { url: '/effects/EffectMaterials/ef_wind03.efkefc', scale: 0.24 },  // 漩涡/传送门
  fxBolt:       { url: '/effects/EffectMaterials/ef_lightning02.efkefc', scale: 0.28 }, // 落雷
  fxBoltStorm:  { url: '/effects/EffectMaterials/ef_lightning03.efkefc', scale: 0.30 }, // 大招
  fxArcOrb:     { url: '/effects/EffectMaterials/ef_lightning01.efkefc', scale: 0.26 }, // 电磁球
});
```

对应道具：

| 道具 | 现在 | 换成 |
|---|---|---|
| 深海瀑布 `waterfall` | 程序化水柱 | `fxGeyser`（`wind02` 改青蓝） |
| 漩涡 `vortex` | `bubble` + `Simple_Ring` | `fxVortexBig` 破裂 + `bubblePop` |
| 海洋之怒 `rvortex` | `ForceFieldTornado` | `fxVortexBig`（更细的龙卷） |
| 追踪导弹 `missile` 命中 | `hanmadoHit` | `fxFireBand` 短放（0.35s 截断） |
| 鱼雷新道具 | —— | `fxSlashBlue` + `ToonWater` |
| 反射护盾 `reflect` | —— | `fxArcOrb` 起手 + `Barrior03` 护罩 |

### 4.2 怪物模式（你说也要改）

| BOSS 技能 | 现在 | 建议换成 | 理由 |
|---|---|---|---|
| 喷吐 `flame` | 自建粒子 | **`fire03`** | 横向火带，比程序化粒子"厚"得多 |
| 横扫 `slash` | 自建 | **`parts_hit02`** | 青色爪痕，一眼读作"被扫到" |
| 落雷 `thunder` | `skillFx.bolt` | **`lightning03`** | 多段连锁，气势碾压 |
| 冰霜吐息 `frostBreath` | 自建 | **`ice02`** | 冰雾膨胀，正好是吐息形态 |
| 涌泉/水柱 `geyser` | 程序化水柱 | **`wind02`** 改青蓝 | 上升到 2m 就够 |
| 全屏大招 `screen` | 混合 | **`lightning03`** + 现有震屏 | 最值钱的一张 |
| 熔岩柱 | 自建 | **`fire01`** | 爆燃 + 碎火，配熔岩语义 |

> 注意：这些是 1.7 格式、**未压缩纹理**，单张 256px PNG。8.5 MB 里 7.9 MB 是纹理，
> 正式接入前建议用 pngcrush / pngquant 压一遍（预计能压到 3 MB 以内），再决定是否全量进 `dist/`。

---

## 五、验收与回滚

- 接入后跑 `npm run build`，确认 `dist/assets` 体积增量（当前约 1 MB JS + 素材）。
- 单机 4 人局各道具用 3 次，检查 `Effects.transient` 不超过 48（命中特效叠太多会顶满，触发黑屏风险）。
- 回滚：删 `public/effects/EffectMaterials/` + 去掉 `FX_DEFS` 里的条目即可，不影响已有 26 个素材。
- 截图工具留在 `tests/shot_fx.mjs`（自动取景）与 `tests/gen_fx_sheet.mjs`（拼总览），
  预览服务 `scripts/fx_preview_server.mjs`（`node scripts/fx_preview_server.mjs 3112 public`）。
  **不要用 dev server 预览新素材**：public 下新增文件会被静态中间件缓存住，改了刷新还是旧版。

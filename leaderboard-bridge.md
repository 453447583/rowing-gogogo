# 排行榜共用一份 JSON（cpolar 桥接）

线上一台（Render）和家里一台（你的电脑）要看到同一张榜，最省事的办法不是上数据库，
而是**让家里那份 `server/data/leaderboard.json` 当唯一权威**，Render 通过隧道读写它。

```
玩家 ──► Render：发页面 / 房间 WS ──┐
                                   │ 每 3~10 秒读、结算时写（都是几十 KB）
                                   ▼
                        cpolar 隧道 (https://xxx.cpolar.top)
                                   ▼
局域网玩家 ──► 192.168.x.x:3001 ──► 你家的 server.js ──► server/data/leaderboard.json
```

好处：只有一份数据、没有 MySQL、Render 重启或免费实例休眠都不丢榜。
代价：家里电脑关机时，线上新成绩会先排队，等家里恢复后补发（最多攒 500 条）。

---

## 一次性配置

### 1. 家里这台：准备一个 token

随便生成一串，比如：

```
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

把结果和 Render 的登记地址写进两个文件（都在 `.gitignore` 里，不会进仓库）：

```
server/data/bridge-token.txt      ← 刚才那串 token，单独一行
server/data/bridge-register.txt   ← https://<你的 Render 域名>/lb-api/register
```

> 也可以不用文件，直接设环境变量 `LEADERBOARD_TOKEN` / `LB_REGISTER_URL`。

### 2. cpolar：建一条指向 3000 的 HTTP 隧道

打开 Web UI（http://127.0.0.1:9200）→ **隧道管理 → 创建隧道**：

| 项 | 填什么 |
| --- | --- |
| 隧道名称 | `rapids-lb`（随意） |
| 协议 | **http** |
| 本地地址 | **3000**（就是你 `npm run server` 的端口） |
| 地区 | `China VIP` / `cn_top`（默认即可） |

建好到「状态 → 在线隧道」复制 **https** 那条地址，形如 `https://34933039.r8.cpolar.top`。

> 免费版每次重启隧道域名都会变，不用手抄——家里那台会自动从 cpolar 日志里读最新地址并推给 Render。

### 3. Render：四个环境变量

在 Render 服务的 Environment 里加（按本项目的实际值填好了，直接抄）：

| 变量 | 值 |
| --- | --- |
| `LB_STORE` | `remote` |
| `LEADERBOARD_REMOTE_URL` | 先填当前隧道地址 `https://xxx.cpolar.top`（之后会自动更新） |
| `LEADERBOARD_TOKEN` | 和家里那台同一个 token |
| `LB_REGISTER_URL` | `https://rowing-gogogo.onrender.com/lb-api/register` |

家里那台再设一个同名 `LB_REGISTER_URL`（或用 `bridge-register.txt`），它就会每 60 秒把
**当前** cpolar 地址推过去，Render 收到后热切换，不用再改环境变量、也不用重部署。

> 顺序很重要：先 `git push` 让 Render 部署到带 `/lb-api/*` 的版本，再配环境变量、再建隧道。
> 旧版本的 Render 对 `/lb-api/boards` 只会回一个纯文本 `Not Found`。
> Render 免费实例每次重启都会丢掉"已登记的地址"，但它 60 秒内会从家里那台重新收到一次，
> 环境变量里的旧地址只是兜底。

---

## 日常启动（家里）

双击 `启动服务器-桥接.bat`，或者在项目里：

```bash
LEADERBOARD_TOKEN=<token> LB_REGISTER_URL=https://<render域名>/lb-api/register npm run server
```

看到这两行就对了：

```
[排行榜] 存储：json → .../server/data/leaderboard.json
  排行榜桥接:  /lb-api/boards · /lb-api/write（Bearer 鉴权，给线上读这份 JSON）
[桥接] 线上已登记本机地址：https://34933039.r8.cpolar.top
```

## 验证

```bash
# 家里：带 token 能读，不带 token 401
curl -H "Authorization: Bearer <token>" "http://127.0.0.1:3000/lb-api/boards?since=0"
curl -i "http://127.0.0.1:3000/lb-api/boards"          # 期望 401

# 通过隧道
curl -H "Authorization: Bearer <token>" "https://xxx.cpolar.top/lb-api/boards?since=0"
```

Render 后台日志里搜索 `家里服务器`，应能看到 `使用家里服务器：https://...`。

自动化验收：`npm run test:leaderboard:bridge`（27 项，含隧道断线补发、增量拉取、鉴权、换地址）。

---

## 限制与坑

- **隧道只传榜单，不要整站走隧道**：`public/` 有 451MB，免费版 1Mbps 首屏要按小时算。
- **免费版没有 IP 白名单**，所以 token 必须是长随机串；`/lb-api/*` 之外的路径（静态站、`/ws`）
  也会被隧道暴露，别把隧道地址发给别人。
- **家里关机 = 线上写不进榜**：成绩进待补发队列（上限 500 条），回家恢复后自动补；长期离线还是会丢。
- 要 7×24 稳定，最终方案是云数据库：把 `LB_STORE` 换成 `mysql` 并配 `MYSQL_*` 即可，
  上层逻辑完全不用改（见 `server/lb-store.js`）。
- 换隧道服务（cloudflared / ngrok）也不用改代码：`LEADERBOARD_REMOTE_URL` 指向那个 https 地址就行，
  自动检测只认 cpolar 的日志格式，其他服务手动填或写 `server/data/public-url.txt`。

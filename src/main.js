import { NetClient } from './net/NetClient.js';
import { isOnlineHost, ONLINE_HINT } from './net/onlineHost.js';
import { VoiceManager } from './net/VoiceManager.js';
import { Game } from './game/Game.js';
import { Input } from './game/Input.js';
import { audio } from './audio/AudioEngine.js';
import { settings } from './settings.js';
import { settingsPanel } from './ui/settingsPanel.js';
import { leaderboardPanel } from './ui/leaderboard.js';
import { walletPanel } from './ui/walletPanel.js';
import { accountPanel, getAccountToken } from './ui/accountPanel.js';
import { ticketAllowed } from './data/shop.js';
import * as UI from './ui/ui.js';
import { ChatUI } from './ui/Chat.js';
import { BoatShowcase } from './ui/BoatShowcase.js';
import { boatThumbUrl, ensureBoatThumbs } from './ui/boatThumbs.js';
import { BOATS } from './data/boats.js';
import { getBoat } from './data/boats.js';
import { MAPS, WEATHERS } from './data/maps.js';
import { BOSS_LEVELS } from './data/bosses.js';
import { iconImg, MAP_ICON, MODE_ICON, WEATHER_ICON, DIFF_ICON } from './ui/icons.js';
// 大厅「挑战模式」卡片要显示当前影子记录（这张图 × 这条船的最快一圈）
import { readGhost } from './game/GhostStore.js';
import {
  AVATAR_DEFS, DEFAULT_AVATAR_ID, avatarMarkup,
  compressAvatarFile, isCustomAvatar, isValidAvatar,
} from './ui/avatars.js';

const net = new NetClient();
const input = new Input();

// 聊天：大厅按 Enter 呼出世界频道，比赛中按 Enter 呼出无线电。
// 练习模式没有网络对端，只做本地回显（onSend 里直接返回）。
const chat = new ChatUI({
  input,
  getName: () => getMyName(),
  onSend: (text, channel) => {
    if (soloMode) {
      // 练习模式没有服务器：只做本地回显，并提示一次"别人看不到"
      if (!soloChatHinted) {
        soloChatHinted = true;
        chat.system('练习模式：消息只在本机显示');
      }
      return;
    }
    if (!net.connected) return;
    net.send({ t: 'chat', text, channel });
  },
});
let soloChatHinted = false;

// ---------- 右上角网络状态角标 ----------
// 以前掉线/重连时界面什么都不显示，玩家只会觉得"游戏卡了"，
// 分不清是自己网络的问题还是游戏的 bug。这里常驻一个很小的角标：
// 正常时显示实时延迟，掉线/重连时变颜色加文字。
const netBadge = document.createElement('div');
netBadge.id = 'net-badge';
netBadge.style.cssText = [
  // 比赛中右上角是「设置」按钮（right:124px），角标留在最右 12px 才不压住它；
  // 大厅里右上角换成抽屉的关闭按钮（× 在 right:24~58px），这里左移到 84px 让开。
  // 两种位置都由 refreshNetBadge 按当前屏幕切换。
  'position:fixed', 'right:12px', 'top:12px', 'z-index:80',
  'padding:3px 9px', 'border-radius:999px',
  'font:600 12px/1.6 system-ui,-apple-system,sans-serif',
  'background:rgba(8,16,26,.62)', 'color:#7fd4a0',
  'pointer-events:none', 'user-select:none', 'letter-spacing:.02em',
].join(';');
netBadge.style.display = 'none';
document.body.appendChild(netBadge);
// ok | reconnecting | lost
let netLink = 'ok';
function refreshNetBadge() {
  if (soloMode) { netBadge.style.display = 'none'; return; }
  netBadge.style.display = '';
  // 首页：左上角（右上角留给改名胶囊）；进房间/比赛后回到右上角原位置
  const atMainMenu = !UI.el('menu-main')?.classList.contains('hidden');
  if (atMainMenu) {
    netBadge.style.left = '12px';
    netBadge.style.right = 'auto';
  } else {
    netBadge.style.left = 'auto';
    // 大厅：避开右上角抽屉的 ×（左移到 84px）；比赛：留在最右，避开设置的 ⚙ 按钮
    const inLobby = !UI.el('lobby')?.classList.contains('hidden');
    netBadge.style.right = inLobby ? '84px' : '12px';
  }
  if (netLink === 'lost') {
    netBadge.textContent = '● 已断开';
    netBadge.style.color = '#ff6b7a';
    return;
  }
  if (netLink === 'reconnecting') {
    netBadge.textContent = '● 重连中…';
    netBadge.style.color = '#ffc266';
    return;
  }
  // 首页还没点「联机对战」时没有连接，如实显示未连接，不假装已连上
  if (!net.connected) {
    netBadge.textContent = '● 未连接';
    netBadge.style.color = '#9fb0c0';
    return;
  }
  const rtt = Math.round(Number(net.rtt) || 0);
  if (rtt <= 0) {
    netBadge.textContent = '● 测量中…';
    netBadge.style.color = '#9fb0c0';
    return;
  }
  // 最新一次实测 RTT（每 2 秒刷新，不做平滑），数字跳动就是真实波动
  netBadge.textContent = `● ${rtt}ms`;
  netBadge.style.color = rtt < 60 ? '#7fd4a0' : rtt < 130 ? '#ffc266' : '#ff6b7a';
}
setInterval(refreshNetBadge, 500);

// ---------- 线上语音图标（画在左下角每个选手名字后面） ----------
// 不再有独立语音按钮：只有联机大厅的选手行会出现小喇叭。
// 自己的喇叭：点一下开麦/关麦，开了就常亮绿色；
// 别人的喇叭：说话时按音量亮 1~4 格，点一下本地静音/取消静音。
function voiceBarLevel(v) {
  if (v > 0.66) return 4;
  if (v > 0.42) return 3;
  if (v > 0.20) return 2;
  if (v > 0.02) return 1;
  return 0;
}

function refreshVoiceIcons() {
  for (const el of document.querySelectorAll('#lobby-players [data-voice-id]')) {
    const id = el.dataset.voiceId;
    const mine = id === myId;
    const level = Number(voice.levels.get(id) || 0);
    const bars = voiceBarLevel(level);
    const muted = voice.mutedPeers.has(id);
    // 自己开麦后喇叭恒绿；别人只有真的在说话时才亮绿 + 音量格。
    const lit = mine ? voice.isEnabled : (voice.peerIds.has(id) && bars > 0);
    el.classList.toggle('on', lit && !muted);
    el.classList.toggle('muted', muted);
    for (let i = 0; i <= 4; i++) el.classList.toggle(`level-${i}`, i === bars);
    const name = el.parentElement?.querySelector('.pname')?.textContent?.trim() || '此玩家';
    el.title = mine
      ? (voice.isEnabled ? '点击关闭语音' : '点击开启语音')
      : (muted ? `取消静音 ${name}` : `静音 ${name}`);
  }
}

let voiceErrShown = '';
function updateVoiceUi(s) {
  refreshVoiceIcons();
  // 开麦失败（权限被拒 / 没设备 / 非安全环境）以前只在内部状态里，玩家完全看不到。
  // 现在直接把原因弹出来，省得以为是"游戏没声音"。
  if (s?.state === 'error' && s.detail && s.detail !== voiceErrShown) {
    voiceErrShown = s.detail;
    UI.toast(`语音：${s.detail}`);
  }
  if (s?.state === 'on') voiceErrShown = '';
}
function updateVoiceLevels() { refreshVoiceIcons(); }

let game = null;
// 海克斯无尽：只记录「通过的最高层」，4 层以内不算无尽成绩
const HEX_BEST_KEY = 'rr-hex-best';
function recordHexBestStage(stage) {
  const n = Math.floor(Number(stage) || 0);
  if (n <= 4) return;
  try {
    const prev = Number(localStorage.getItem(HEX_BEST_KEY) || 0);
    if (n > prev) localStorage.setItem(HEX_BEST_KEY, String(n));
  } catch { /* 隐私模式写不了 localStorage，忽略 */ }
}
let myId = null;
let hostId = null;
let lanIps = [];
let roster = { players: [], settings: { laps: 3, rounds: 1, aiCount: 0, difficulty: 'normal' }, mapId: 'strait', weather: 'day', mode: 'race' };
// 旧版服务端的 roster 里没有 format / teams：只提示一次，避免赛制看起来"自己跳回个人"
let staleServerWarned = false;
let myBoatId = null;
// 玩家头像（只有怪物模式的左上角玩家列表显示）
let myAvatar = loadAvatar();
let resultMode = null; // 'round' | 'final'
let currentResults = null;
let podium = null;
let podiumTimer = null;
// 颁奖台上「10 秒内按空格退出」：倒计时 + 即时退出
let podiumExitTimer = null;
let podiumExitKey = null;
let podiumExitUntil = 0;
let finishWindowUntil = 0;
let finishWindowTimer = null;
// 完赛观察界面：右侧实时成绩 + 顶部倒计时
let lastHudData = null;
let finishPanelActive = false;
let finishPanelWatch = null;
// 挑战模式完赛面板：不走 10 秒观察期/领奖台，面板常驻，按空格回大厅
let challengeFinishActive = false;
let challengeFinishKey = null;
// 联机：单局序号（服务器每开一局 +1）。用它挡掉重复的 start，
// 也用它识别"这是新的一局"还是重连补发的旧消息。
let lastRaceSeq = 0;
// 本地刚发的选艇：等服务器回执期间不要被其他玩家的 roster 冲掉
let pickPending = { id: null, at: 0 };
// 服务器最近一次确认的"我的赛艇"（只认 roster 回执，不用本地乐观值）
let confirmedBoatId = null;
// 选艇同步看护：服务器没确认就重发，避免"我这边显示选好了、主机却提示没选赛艇"
let pickCheckTimer = null;

// ---------- 单人练习模式 ----------
let soloMode = false;
let soloMapId = 'strait';
let soloWeatherId = 'day';
// 挑战模式（challenge）是单人专属：赛道/物理沿用竞速，只是场上有自己的影子。
// 传给 Game 后会被归一化成 mode='race' + challenge=true（见 Game 构造函数）。
let soloModeMode = 'race'; // race | item | launch | boss | arena | challenge
let soloBossDifficulty = 'normal';
// 怪物模式分支：classic = 闯关（现有玩法），hex = 海克斯（每关技能顺序随机）
let soloBossVariant = 'classic';
// 大厅里直接调的单人赛制（代替旧选艇屏上的输入框）
let soloLaps = 3;
let soloAi = 0;
// 单人练习的赛制：solo = 个人，team = 组队（本地玩家固定蓝队，AI 补红队）
let soloFormat = 'solo';
let soloTeamNames = { blue: '蓝队', red: '红队' };
// 比赛设置：single = 单场定胜负，bestOf3 = 三局两胜（打满 3 局），points3 = 三局积分制
let soloMatchFormat = 'single';
// 单人练习的整场状态（多局制时跨局累计）；null 表示还没开赛
let soloMatch = null;
// 单人练习的怪物模式可以直接选关（不用先打过前一关），方便测试
let soloBossStage = 1;
// 本地网络桩：单人模式无需服务器，所有网络调用变成空操作
const soloNet = {
  on: () => () => {},
  send: () => {},
};

// 线上联机语音：只把信令交给现有 WebSocket，音频不经过服务器。
// 局域网 / 练习模式不会调用 setAllowed(true)，选手行也不会画喇叭图标。
const voice = new VoiceManager({
  send: (msg) => net.send(msg),
  onState: (s) => updateVoiceUi(s),
  onLevels: (data) => updateVoiceLevels(data),
});

const screens = ['menu-main', 'menu-boat', 'menu-map', 'lobby', 'podium', 'results', 'connection-lost'];

// ---------- 音频生命周期 ----------
// 浏览器的自动播放策略要求 AudioContext 必须在**真实用户手势**里创建/恢复，
// 所以这里不主动起播，只挂一个"第一次碰键盘或鼠标"的引导。
// 注意不是 { once: true }：页面切后台时 Chrome 会把 ctx 挂起到 suspended，
// 回到前台再点一下必须能 resume，否则玩家会说"打了一局之后就没声音了"。

function audioMusicMode() {
  if (!game) return 'menu';
  const mode = soloMode ? soloModeMode : (roster.mode || 'race');
  if (mode === 'boss') return 'boss';
  if (mode === 'arena' || mode === 'skytower') return 'arena';
  // 上传的竞速 BGM 只用于竞速 / 道具；launch 继续走程序化音乐
  if (mode === 'launch') return 'launch';
  return 'race';
}

function applyAudioSettings() {
  audio.setVolume('master', settings.get('volMaster'));
  audio.setVolume('music', settings.get('volMusic'));
  audio.setVolume('sfx', settings.get('volSfx'));
  audio.setVolume('ambience', settings.get('volAmbience'));
  audio.setMuted(settings.get('mute'));
}

function unlockAudio() {
  audio.unlock();
  if (!audio.ready) return;
  // 已经在比赛里（比如客机收到开赛消息那一刻还没点过任何东西）：补上持续层
  if (game) {
    audio.startAmbience();
    audio.startMusic(audioMusicMode());
  } else {
    audio.startMusic('menu');
  }
}

applyAudioSettings();
settings.addEventListener('change', (e) => {
  const k = e.detail?.key;
  if (!k) return;
  if (k === '*' || k === 'mute' || k.startsWith('vol')) applyAudioSettings();
});
window.addEventListener('pointerdown', unlockAudio, { passive: true });
window.addEventListener('keydown', unlockAudio);

// ---------- 界面缩放 / 帧率角标 ----------
// HUD 用 #hud 上的 --hs，弹窗用 :root 上的 --ui-scale（见 index.html 的 CSS）。
// 都走独立的 scale 属性，不碰元素自己的 transform。
const fpsBadge = document.createElement('div');
fpsBadge.id = 'fps-badge';
fpsBadge.className = 'hidden';
fpsBadge.textContent = '— FPS';
document.body.appendChild(fpsBadge);

let fpsRaf = 0;
let fpsFrames = 0;
let fpsAt = 0;
function fpsLoop(now) {
  if (!settings.get('showFps')) { fpsRaf = 0; return; }
  fpsFrames++;
  if (!fpsAt) fpsAt = now;
  if (now - fpsAt >= 500) {
    fpsBadge.textContent = `${Math.round((fpsFrames * 1000) / (now - fpsAt))} FPS`;
    fpsFrames = 0;
    fpsAt = now;
  }
  fpsRaf = requestAnimationFrame(fpsLoop);
}
function applyUiSettings() {
  const hud = document.getElementById('hud');
  if (hud) hud.style.setProperty('--hs', String(settings.get('hudScale')));
  document.documentElement.style.setProperty('--ui-scale', String(settings.get('uiScale')));
  const show = !!settings.get('showFps');
  fpsBadge.classList.toggle('hidden', !show);
  if (show && !fpsRaf) { fpsFrames = 0; fpsAt = 0; fpsRaf = requestAnimationFrame(fpsLoop); }
}
applyUiSettings();
settings.addEventListener('change', (e) => {
  const k = e.detail?.key;
  if (!k || k === '*' || k === 'hudScale' || k === 'uiScale' || k === 'showFps') applyUiSettings();
});

// 调试句柄：无头验收要确认"是不是真的在响 / 是不是真的连上语音"，
// 没有声卡也听不到声音，只能读 ctx.state / peer connection 状态。
// 跟 window.__game 一个性质。
if (typeof window !== 'undefined') {
  window.__audio = audio;
  window.__voice = voice;
  // 排行榜面板：无头验收要能把面板打开、塞测试数据核对排版（同 __game 性质）
  window.__leaderboard = leaderboardPanel;
}

// ---------- 设置面板 ----------
// 面板本身在 src/ui/settingsPanel.js（schema 驱动），这里只负责三件事：
//   ① 告诉它怎么冻结驾驶输入、怎么退赛；② 挂到 HUD 右上角的按钮上；③ 接管 Esc。
settingsPanel.init({
  input,
  voice,
  canExitRace: () => !!game,
  onExitRace: () => {
    // 只要连着服务器就一定回房间：即使 soloMode 因历史状态残留为 true，
    // 也不能把联机玩家丢回主界面（用户实测的核心问题）。
    if (soloMode && !net.connected) { exitSoloToMenu(); return; }
    // 联机中途退赛：留在房间里，不再断线退回主界面。
    // 房主先广播 backLobby（其余人一起回大厅），客机回大厅等房主开下一局。
    endRace();
    if (myId === hostId && net.connected) net.send({ t: 'backLobby' });
    enterLobby();
  },
});

// 「设置 → 关卡」页签已撤掉：选关回到大厅「游戏设置」抽屉里（见 renderLobbyStagePick）。

// ---------- 排行榜（只联机） ----------
// 数据全部来自服务器（竞速由服务器结算时记账，怪物 / 海克斯由房主上报），
// 面板只负责展示。练习模式没有服务器，下面的按钮整行会被隐藏。
leaderboardPanel.init({
  net,
  getName: () => getMyName(),
  getMapId: () => (soloMode ? soloMapId : roster.mapId) || MAPS[0]?.id,
});
UI.el('btn-lobby-leaderboard')?.addEventListener('click', () => {
  if (soloMode) { UI.toast('排行榜只在联机模式开放'); return; }
  leaderboardPanel.toggle();
});

// 玩家面板：积分 / 商店 / 明细。单人只读上次联机的缓存，不会误发商店消息。
walletPanel.init({
  net,
  getSolo: () => soloMode,
  getName: getMyName,
  onRename: () => openDialog('dlg-name'),
  onLuckyItem: () => {
    const granted = game?.items?.grantRandomItem?.(myId);
    if (granted) UI.toast('幸运券：获得一件随机道具');
  },
});

// 账号：强制登录。登录成功后账号从零开始，本机旧 uid 钱包缓存不再显示。
accountPanel.init({
  onSuccess: (acc) => {
    // 进房间 / 右上角只显示昵称；用户名只是登录令牌，不带到游戏里
    localStorage.setItem('rr-name', acc.nick || acc.user || getMyName());
    localStorage.removeItem('rr-wallet-cache');
    walletPanel.data = null;
    walletPanel.updateChip();
    syncNamePlate();
  },
});
// 有 token 时先悄悄校验一次；失效就清掉，下一次进游戏会重新弹登录。
// 只有服务端明确回 400（token 不认）才清：5xx / 隧道抖动留着，不然一次网络抽风就把人踢下线。
if (getAccountToken()) {
  fetch('/auth/session', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: getAccountToken() }),
  }).then((r) => r.json().then((out) => ({ status: r.status, out })))
    .then(({ status, out }) => {
      if (out?.ok) {
        // 昵称以账号为准：换设备后房间 / 右上角显示的是昵称，不是用户名
        const nick = String(out.nick || '').trim();
        if (nick && localStorage.getItem('rr-name') !== nick) {
          localStorage.setItem('rr-name', nick);
          syncNamePlate();
        }
        return;
      }
      if (status === 400) localStorage.removeItem('rr-account-token');
    })
    .catch(() => {});
}

/** 所有入口都先过账号关；没登录就记住玩家原本要点什么，登录成功后自动继续 */
function withAccount(fn) {
  if (getAccountToken()) { fn(); return; }
  accountPanel.show(fn);
}

UI.el('quality-btn').onclick = (e) => {
  e.stopPropagation();
  settingsPanel.toggle();
};

/** 木牌弹窗 / 头像弹窗开着时，Esc 归它们自己处理 */
function anyMenuOverlayOpen() {
  return !!document.querySelector('.wood-dialog:not(.hidden), .av-dialog:not(.hidden)');
}

window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  // 竞技场开场（5s 标题卡 + 7s 镜头飞行）期间直接屏蔽：
  // 此时整套 HUD 都收着，设置面板会盖在模糊遮罩下面，又暗又点不利索。
  if (document.body.classList.contains('intro-on')) return;
  // Esc 的优先级：先关排行榜 / 设置面板 → 收聊天/比赛输入条 → 再让弹窗自己关 → 最后才是打开设置
  if (accountPanel.isOpen) { accountPanel.hide(); return; }
  if (walletPanel.isOpen) { walletPanel.close(); return; }
  if (leaderboardPanel.isOpen) { leaderboardPanel.close(); return; }
  if (settingsPanel.isOpen) { settingsPanel.close(); return; }
  // 聊天开着时 Esc 是在收聊天，别顺手把设置面板也弹出来
  if (chat?.lobbyOpen || chat?.gameOpen) return;
  if (anyMenuOverlayOpen()) return;
  settingsPanel.open();
});

function showScreen(id) {
  for (const s of screens) UI.hide(s);
  if (id !== 'lobby') {
    disposeLobbyShowcase();
    UI.el('lobby-pick-drawer')?.classList.remove('open');
    UI.el('lobby-settings-drawer')?.classList.remove('open');
    leaderboardPanel.close();
    walletPanel.close();
    hideLobbyNotice();
  }
  if (id) UI.show(id);
  if (id !== 'hud') UI.hide('hud');
  // 离开大厅 / 比赛（结算、领奖台、返回菜单）时收起聊天输入
  if (id && id !== 'lobby') chat.close();
  // 只有大厅和比赛内才可能用队伍频道；其它界面一律回落到「世界 / 全部」
  if (id !== 'lobby' && id !== 'hud') chat.setTeamInfo({ available: false });
  refreshVoiceIcons();
}

/** 按当前大厅 / 开赛信息刷新聊天的队伍频道；startMsg 是开赛消息（可选） */
function syncChatTeam(startMsg = null) {
  const format = startMsg?.format ?? (soloMode ? soloFormat : roster.format);
  const names = startMsg?.teamNames || (soloMode ? soloTeamNames : (roster.teamNames || {}));
  const teamMode = format === 'team';
  let myTeam = '';
  if (teamMode) {
    myTeam = startMsg?.order?.find?.((e) => e.id === myId)?.team || '';
    if (!myTeam) myTeam = roster.players?.find((p) => p.id === myId)?.team || '';
    if (!myTeam && soloMode) myTeam = 'blue';
  }
  chat.setTeamInfo({
    available: teamMode,
    teamName: names[myTeam] || (myTeam === 'red' ? '红队' : '蓝队'),
  });
}

function getMyName() {
  const v = UI.el('input-name').value.trim();
  if (v) return v;
  // 没有昵称时生成一个并**存下来**：以前每次调用都随机，导致同一个玩家
  // 在"连接"和"开赛"两处拿到的名字不一样
  let n = localStorage.getItem('rr-name');
  if (!n) {
    n = '玩家' + Math.floor(Math.random() * 90 + 10);
    localStorage.setItem('rr-name', n);
  }
  return n;
}

// ---------- 木牌菜单：名牌 / 弹窗 ----------
const MENU_DIALOGS = ['dlg-name', 'dlg-join', 'dlg-help'];

function closeDialogs() {
  for (const d of MENU_DIALOGS) UI.hide(d);
}

function openDialog(id) {
  closeDialogs();
  UI.show(id);
  const input = UI.el(id)?.querySelector('input');
  if (input) setTimeout(() => { input.focus(); input.select?.(); }, 60);
}

function syncNamePlate() {
  const logged = !!getAccountToken();
  const stored = localStorage.getItem('rr-name') || '';
  UI.el('input-name').value = stored;
  // 没登录时不能显示任何玩家信息：旧版这里直接读 localStorage，
  // 退出登录后仍然挂着上一个账号的昵称和积分，看起来像没退成功。
  UI.el('name-plate-text').textContent = logged ? (stored || '未命名船长') : '请登录';
  UI.el('name-plate')?.classList.toggle('guest', !logged);
  walletPanel.updateChip();
}

syncNamePlate();
UI.el('input-host').value = localStorage.getItem('rr-host') || '';

// 右上角整条改成玩家面板入口；改名是面板里的一个按钮，旧木牌弹窗保持不变。
// 没登录时先过账号这一关（和联机入口一致），登录成功后自动打开面板。
UI.el('name-plate').onclick = () => withAccount(() => walletPanel.toggle());
UI.el('btn-help').onclick = () => openDialog('dlg-help');
UI.el('btn-join').onclick = () => openDialog('dlg-join');

UI.el('btn-name-ok').onclick = async () => {
  const v = UI.el('input-name').value.trim().slice(0, 10);
  if (!v) { UI.toast('昵称不能是空的'); return; }
  if (!/^[\u4e00-\u9fa5A-Za-z0-9_]{2,10}$/.test(v)) {
    UI.toast('昵称要 2~10 位，只能用中文 / 字母 / 数字 / 下划线');
    return;
  }
  localStorage.setItem('rr-name', v);
  UI.el('input-name').value = v;
  syncNamePlate();
  closeDialogs();
  // 登录状态下把昵称写进账号：换设备、房间贵宾横幅、排行榜都显示昵称而不是用户名
  const token = getAccountToken();
  if (!token) { UI.toast('昵称已设为「' + v + '」'); return; }
  try {
    const r = await fetch('/auth/nick', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, nick: v }),
    });
    const out = await r.json();
    UI.toast(out?.ok ? `昵称已设为「${v}」，换设备也会显示` : (out?.error || '昵称只保存在本机'));
  } catch {
    UI.toast('昵称已保存在本机，联网后再改一次即可同步');
  }
};

UI.el('btn-join-go').onclick = () => {
  const host = UI.el('input-host').value.trim();
  if (!host) { UI.toast('请填写主机的局域网 IP'); return; }
  localStorage.setItem('rr-host', host);
  closeDialogs();
  withAccount(() => connectAndEnter(host, 'lan', 'btn-join'));
};

for (const el of document.querySelectorAll('[data-close]')) {
  el.onclick = () => UI.hide(el.dataset.close);
}
for (const id of MENU_DIALOGS) {
  const box = UI.el(id);
  box.addEventListener('click', (e) => { if (e.target === box) UI.hide(id); });
}
for (const [input, btn] of [['input-name', 'btn-name-ok'], ['input-host', 'btn-join-go']]) {
  UI.el(input).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); UI.el(btn).click(); }
    if (e.key === 'Escape') closeDialogs();
  });
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && MENU_DIALOGS.some((d) => !UI.el(d).classList.contains('hidden'))) {
    closeDialogs();
  }
});

async function connectAndEnter(host = '', mode = 'lan', btnId = '') {
  const btn = UI.el(btnId) || UI.el(host ? 'btn-host' : 'btn-join');
  const labelEl = btn.querySelector('span') || btn;
  const label = labelEl.textContent;
  btn.disabled = true;
  labelEl.textContent = '连接中…';
  try {
    // 联机必须显式清掉单人状态：从练习模式直接切到联机会继承 soloMode=true，
    // 之后对局里点设置「退出比赛」会走 exitSoloToMenu() → 直接回主界面（用户实测）。
    soloMode = false;
    soloMatch = null;
    await net.connect(host, getMyName(), myAvatar, mode);
    // 语音：线上入口本身就是 https；本机双开调试（局域网入口 + localhost）同样是
    // 安全上下文，浏览器允许拿麦克风。跨机的 http://内网IP 拿不到麦克风，
    // 这里直接禁用，避免玩家点开后只看到一条"麦克风不可用"。
    voice.setAllowed(mode === 'online'
      || (typeof window !== 'undefined' && window.isSecureContext === true));
    localStorage.setItem('rr-name', getMyName());
    // 已经进房了就别再让「返回选择玩法」把人带回半连接状态
    UI.hide('btn-back-entry');
    // 联机也统一进大厅：赛艇 / 地图 / 天气 / 模式都在大厅里直接选
    enterLobby();
  } catch (e) {
    voice.setAllowed(false);
    // 线上没连上就退回入口页，玩家还能改选局域网或练习
    if (mode === 'online') UI.show('menu-entry');
    UI.toast('连接失败：' + e.message + (mode === 'online' ? '（请确认线上服务已启动）' : '（请确认主机已运行）'));
  } finally {
    btn.disabled = false;
    labelEl.textContent = label;
  }
}

UI.el('btn-host').onclick = () => { closeDialogs(); withAccount(() => connectAndEnter('', 'lan', 'btn-host')); };

// 单人练习：无需联机，直接本地开赛。
// 首页的「练习模式」和隐藏的 #btn-solo（测试钩子）都走这一个函数，返回逻辑完全一致。
function startSoloPractice() {
  closeDialogs();
  voice.setAllowed(false);
  soloMode = true;
  myId = 'me';
  hostId = 'me';
  localStorage.setItem('rr-name', getMyName());
  // 随机分配到两个 GLB 赛艇之一（破浪划艇 / 竞速轻艇）
  myBoatId = Math.random() < 0.5 ? 'rower' : 'skiff';
  // 单人练习也进大厅：同一套版式里选艇 / 地图 / 天气 / 模式，再发车
  enterLobby();
}
UI.el('btn-solo').onclick = () => withAccount(startSoloPractice);

// ---------- 入口页：局域网 / 线上 / 练习 ----------
// 入口页和旧木牌菜单互斥显示：没选玩法前，旧「创建/加入/练习」整块必须藏掉，
// 否则透明盖层底下会透出两排按钮。点局域网才把旧菜单整块放出来。
UI.el('btn-entry-lan').onclick = () => {
  closeDialogs();
  voice.setAllowed(false);
  UI.hide('menu-entry');
  UI.show('menu-lan-view');
  UI.show('btn-back-entry');
};
UI.el('btn-back-entry').onclick = () => {
  closeDialogs();
  UI.show('menu-entry');
  UI.hide('menu-lan-view');
  UI.hide('btn-back-entry');
};
UI.el('btn-entry-online').onclick = () => {
  closeDialogs();
  // 线上联机 = 同源 /ws；本地 node server/server.js 也挂同一路径，所以要按域名拦，
  // 否则 localhost:3000 点进来连的是本地服务器（2026-11-24 修复）。
  if (!isOnlineHost()) {
    UI.toast(ONLINE_HINT);
    return;
  }
  UI.hide('menu-entry');
  UI.hide('menu-lan-view');
  withAccount(() => connectAndEnter('', 'online', 'btn-entry-online'));
};

// 入口页「联机对战」在本地地址下置灰：不是隐藏按钮，是为了让玩家点一下就知道
// 该走哪条路（局域网 / 练习），而不是像以前那样卡在"连接失败"上猜。
function syncOnlineEntryGate() {
  const btn = UI.el('btn-entry-online');
  if (!btn) return;
  const ok = isOnlineHost();
  btn.classList.toggle('is-locked', !ok);
  btn.setAttribute('aria-disabled', ok ? 'false' : 'true');
  const note = btn.parentElement && btn.parentElement.querySelector('.entry-note');
  if (note) {
    note.textContent = ok ? '线上网址 · 直接进入网络大厅' : '本地不可用 · 需从线上网址打开';
  }
}
syncOnlineEntryGate();
UI.el('btn-entry-solo').onclick = () => {
  closeDialogs();
  UI.hide('menu-entry');
  UI.hide('menu-lan-view');
  // 和旧「局域网对战 → 练习模式」共用同一条返回逻辑
  startSoloPractice();
};

// 大厅顶部红色横幅左侧的「返回主界面」：清掉对局/连接，回三按钮入口页
UI.el('btn-lobby-back').onclick = () => {
  closeDialogs();
  endRace();
  voice.reset();
  if (soloMode) {
    soloMode = false;
    soloMatch = null;
  } else {
    // 房主先通知服务器回大厅，其他人才不会卡在 racing
    if (myId === hostId && net.connected) net.send({ t: 'backLobby' });
    net.close?.();
  }
  myId = null;
  hostId = null;
  myBoatId = null;
  showEntryMenu();
};

// ---------- 玩家头像 ----------
const AVATAR_KEY = 'rr-avatar';

function loadAvatar() {
  try {
    const v = localStorage.getItem(AVATAR_KEY);
    return isValidAvatar(v) ? v : DEFAULT_AVATAR_ID;
  } catch {
    return DEFAULT_AVATAR_ID;
  }
}

function saveAvatar(v) {
  if (!isValidAvatar(v)) return;
  myAvatar = v;
  try { localStorage.setItem(AVATAR_KEY, v); } catch { /* 隐私模式读不到 localStorage */ }
  refreshAvatarChip();
  renderAvatarGrid();
  // 大厅里「参赛选手」自己那一行的头像就是入口本身，改完立刻重画名单
  const lobbyEl = UI.el('lobby');
  if (lobbyEl && !lobbyEl.classList.contains('hidden')) renderLobbyNow();
  // 已经在房间里：把新头像同步给服务器（只在本次会话内保留）
  if (!soloMode && net.connected) net.send({ t: 'avatar', avatar: v });
}

// 头像入口只剩两处：选艇界面左上角的小圆章 + 大厅名单里自己那一行的头像。
// 比赛中头像显示在名次栏，所以改完要顺手刷新所有已存在的挂点。
function refreshAvatarChip() {
  const chip = UI.el('avatar-chip');
  if (chip) {
    chip.classList.remove('hidden');
    const hold = UI.el('avatar-chip-hold');
    if (hold) hold.innerHTML = avatarMarkup(myAvatar, false);
  }
}

function renderAvatarGrid() {
  const grid = UI.el('avatar-grid');
  if (!grid) return;
  const custom = isCustomAvatar(myAvatar)
    ? `<button class="av-cell selected" type="button" data-avatar="custom">`
      + `${avatarMarkup(myAvatar)}<i>我的图片</i></button>`
    : '';
  grid.innerHTML = custom + AVATAR_DEFS.map((d) => (
    `<button class="av-cell${myAvatar === d.id ? ' selected' : ''}" type="button" `
    + `data-avatar="${d.id}">${avatarMarkup(d.id)}<i>${d.name}</i></button>`
  )).join('');
}

const AVATAR_DIALOG = 'dlg-avatar';
function openAvatarDialog() {
  renderAvatarGrid();
  UI.show(AVATAR_DIALOG);
}
function closeAvatarDialog() {
  UI.hide(AVATAR_DIALOG);
}

UI.el('avatar-chip').onclick = openAvatarDialog;
// 大厅「参赛选手」名单：点自己那一行的头像 = 换头像（事件委托，名单每帧重画也不用重绑）
UI.el('lobby-players')?.addEventListener('click', (e) => {
  const voiceIcon = e.target.closest?.('[data-voice-id]');
  if (voiceIcon && !voiceIcon.disabled) {
    e.stopPropagation();
    const id = voiceIcon.dataset.voiceId;
    // 自己的喇叭 = 开/关麦；别人的喇叭 = 本地静音/取消静音（网游常见做法）。
    if (id === myId) voice.toggle();
    else voice.togglePeerMute(id);
    return;
  }
  if (e.target.closest?.('[data-avatar-me]')) openAvatarDialog();
});
UI.el('btn-avatar-ok').onclick = closeAvatarDialog;
UI.el(AVATAR_DIALOG).addEventListener('click', (e) => {
  if (e.target === UI.el(AVATAR_DIALOG)) closeAvatarDialog();
});
UI.el('avatar-grid').addEventListener('click', (e) => {
  const cell = e.target.closest?.('.av-cell');
  if (!cell) return;
  const id = cell.dataset.avatar;
  if (id && id !== 'custom') saveAvatar(id);
});
UI.el('btn-avatar-upload').onclick = () => UI.el('avatar-file').click();
UI.el('avatar-file').onchange = async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) {
    UI.toast('图片太大，请选 5MB 以内的图片');
    return;
  }
  try {
    saveAvatar(await compressAvatarFile(file, 128));
    UI.toast('头像已更新');
  } catch (err) {
    UI.toast(err.message || '头像处理失败，换张图试试');
  }
};
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !UI.el(AVATAR_DIALOG).classList.contains('hidden')) closeAvatarDialog();
});

// ---------- 选艇 ----------
let boatShowcase = null;

// 选艇 + 选图合并成一屏：进这一屏时把赛道条、设置栏、按钮文案一起准备好
function enterBoatSelect() {
  showScreen('menu-boat');
  // 联机以服务器名单为准：上一局打完服务器会清空所有人的选艇，
  // 以前这里只把本地 myBoatId 置空却不看服务器，导致"本地以为有船 / 服务器以为没船"
  if (!soloMode) {
    const me = roster.players?.find((p) => p.id === myId);
    myBoatId = me?.boatId || null;
  }
  const previewId = myBoatId || BOATS[0].id;
  if (!boatShowcase) boatShowcase = new BoatShowcase(UI.el('boat-stage-canvas'), previewId);
  else boatShowcase.setBoat(previewId);
  refreshBoatList();
  refreshVesselScreen();
  refreshAvatarChip();
}

/** 只有单人 / 主机能选图；客人看得到但不能点 */
function canPickMap() {
  return soloMode || myId === hostId;
}

/**
 * 怪物 / 竞技场固定在竞技场海面开打，地图与天气都不会生效。
 * 这两类模式下把地图、天气入口变淡并禁用（房主也一样），避免"选了没反应"。
 */
function modeLocksTrackPicker() {
  const mode = soloMode ? soloModeMode : (roster.mode || 'race');
  return mode === 'boss' || mode === 'arena' || mode === 'skytower';
}

/** 赛道条 + 比赛设置 + 出战按钮的文案与可用状态（不再切屏） */
function refreshVesselScreen() {
  const canPick = canPickMap();
  const rail = document.querySelector('.vs-right');
  if (rail) {
    rail.classList.toggle('locked', !canPick);
    rail.classList.remove('hidden');
  }
  const go = UI.el('btn-map-ok');
  if (go) go.textContent = soloMode || myId === hostId ? '确认出战' : '进入大厅';
  renderVesselMapPanel();
}

function takenBoats() {
  if (soloMode) return new Set();
  return new Set(
    roster.players.filter((p) => p.id !== myId && p.boatId).map((p) => p.boatId),
  );
}

/**
 * 选艇同步看护：服务器迟迟没确认时自动重发；仍然失败就清掉本地选择让玩家重选。
 * 修的就是"我已经选好赛艇，主机那边却一直提示还没选赛艇"——
 * 本地是乐观显示，丢了那一包 pick 时两边就会各说各话。
 */
function watchPickSync(boatId) {
  if (soloMode) return;
  clearTimeout(pickCheckTimer);
  let ticks = 0;
  const check = () => {
    pickCheckTimer = setTimeout(() => {
      if (!myId) return;
      if (confirmedBoatId === boatId) return; // 服务器已确认
      ticks += 1;
      if (ticks > 4) {
        // 连发几轮都没同步上：多半是被别人抢走了，收回本地乐观值让玩家重选
        pickPending = { id: null, at: 0 };
        myBoatId = confirmedBoatId;
        if (lobbyPickKind === 'boat') renderLobbyPick();
        renderLobbyNow();
        UI.toast('赛艇选择没有同步成功，请重新选择');
        return;
      }
      if (net.connected) net.send({ t: 'pick', boatId });
      check();
    }, 1200);
  };
  check();
}

function refreshBoatList() {
  boatShowcase?.setBoat(myBoatId || BOATS[0].id);
  UI.renderBoatList(myBoatId, takenBoats(), (boatId) => {
    myBoatId = boatId;
    pickPending = { id: boatId, at: Date.now() };
    boatShowcase?.setBoat(boatId);
    if (!soloMode) {
      net.send({ t: 'pick', boatId });
      watchPickSync(boatId);
    }
    UI.el('btn-boat-ok').disabled = false;
  });
}

// 历史按钮（界面已隐藏）：只做一次原地刷新，保留给老脚本点
UI.el('btn-boat-ok').onclick = () => {
  if (!myBoatId) return;
  enterMapSelect();
};

// ---------- 选图（主机 / 单人）——已并入选艇屏，这里只负责原地刷新 ----------
function enterMapSelect() {
  renderVesselMapPanel();
}

function renderVesselMapPanel() {
  // 单人模式才显示圈数 / AI 陪练；联机由大厅统一设置
  UI.el('solo-laps-wrap').classList.toggle('hidden', !soloMode);
  UI.el('solo-ai-wrap').classList.toggle('hidden', !soloMode);
  const initialId = soloMode ? soloMapId : (roster.mapId || MAPS[0].id);
  if (soloMode) {
    // 圈数默认跟随地图作者配置（3km 的霓虹海峡是单圈），只填下拉里存在的档位
    const syncLaps = (mapId) => {
      const def = MAPS.find((m) => m.id === mapId);
      const sel = UI.el('solo-laps');
      if (!def?.laps || !sel) return;
      const value = String(def.laps);
      if ([...sel.options].some((o) => o.value === value)) sel.value = value;
    };
    syncLaps(initialId);
    UI.renderMapList(initialId, (mapId) => { soloMapId = mapId; syncLaps(mapId); });
    UI.renderModeList(
      soloModeMode === 'boss' && soloBossVariant === 'hex' ? 'boss:hex' : soloModeMode,
      (value) => {
        // 'boss:hex' 是下拉里的复合值：实际模式仍是 boss，只切分支
        if (value === 'boss:hex') {
          soloModeMode = 'boss';
          soloBossVariant = 'hex';
        } else {
          soloModeMode = value;
          if (value === 'boss') soloBossVariant = 'classic';
        }
        applyBossMapUI();
      },
    );
    UI.renderWeatherList(soloWeatherId, (id) => { soloWeatherId = id; });
  } else {
    UI.renderMapList(initialId, (mapId) => {
      net.send({ t: 'map', mapId });
    });
    UI.renderModeList(
      roster.mode === 'boss' && roster.settings?.variant === 'hex' ? 'boss:hex' : (roster.mode || 'race'),
      (value) => {
        // 挑战模式是单人专属：联机房间里下拉只做展示，选了直接弹回原值
        if (value === 'challenge') {
          UI.toast('挑战模式只支持单人练习');
          renderVesselMapPanel();
          return;
        }
        if (value === 'boss:hex') {
          net.send({ t: 'mode', modeId: 'boss' });
          net.send({ t: 'settings', settings: { variant: 'hex' } });
          roster.mode = 'boss';
        } else if (value === 'boss') {
          net.send({ t: 'mode', modeId: 'boss' });
          net.send({ t: 'settings', settings: { variant: 'classic' } });
          roster.mode = 'boss';
        } else {
          net.send({ t: 'mode', modeId: value });
          roster.mode = value;
        }
        applyBossMapUI();
      },
    );
    UI.renderWeatherList(roster.weather || 'day', (weatherId) => {
      net.send({ t: 'weather', weatherId });
    });
  }
  const diffSel = UI.el('boss-difficulty');
  if (diffSel) {
    diffSel.value = soloMode ? soloBossDifficulty : (roster.settings?.difficulty || 'normal');
    // 选项文字里的 emoji 已去掉，难度改由标签旁的图标表示（⚔️🔥💀 → 58~60 PNG）
    UI.paintFilterIcon(diffSel, DIFF_ICON[diffSel.value] || DIFF_ICON.normal);
    diffSel.onchange = () => {
      UI.paintFilterIcon(diffSel, DIFF_ICON[diffSel.value] || DIFF_ICON.normal);
      if (soloMode) {
        soloBossDifficulty = diffSel.value;
      } else {
        net.send({ t: 'settings', settings: { difficulty: diffSel.value } });
      }
    };
  }
  // 关卡下拉：单人练习的怪物模式可以直选任意关（联机模式不提供，仍从第一关打起）
  const stageSel = UI.el('boss-stage');
  if (stageSel) {
    stageSel.innerHTML = BOSS_LEVELS
      .map((lv) => `<option value="${lv.stage}">${lv.name}</option>`)
      .join('');
    stageSel.value = String(soloBossStage);
    stageSel.onchange = () => { soloBossStage = +stageSel.value || 1; };
  }
  applyBossMapUI();
  UI.renderMapFilters();
  UI.renderMapPreview(initialId);
  // 合并屏左上角：返回主菜单（单人直接退，联机顺带断开连接）
  UI.el('btn-map-back').onclick = () => {
    if (!soloMode) net.close?.();
    exitSoloToMenu();
  };
}

// 怪物模式 / 竞技场：隐藏天气选择、置灰赛道列表（两者都用固定的圆形海面），
// 怪物模式额外给难度三档（单人还会多出选关 / AI 陪练）
function applyBossMapUI() {
  const mode = soloMode ? soloModeMode : (roster.mode || 'race');
  const boss = mode === 'boss';
  // 竞技场同样不选地图，但不需要难度和选关面板
  const closed = boss || mode === 'arena' || mode === 'skytower';
  // 天气在怪物 / 竞技场下不生效：保留在版面上但变淡禁用（用户要求"变淡、无法选择"，
  // 直接隐藏会让底部设置栏突然缺一块，反而像界面坏了）
  const weatherWrap = UI.el('weather-select')?.closest('.map-filter');
  if (weatherWrap) {
    weatherWrap.classList.remove('hidden');
    weatherWrap.classList.toggle('is-locked', closed);
    const ws = UI.el('weather-select');
    if (ws) ws.disabled = closed;
  }
  UI.el('solo-laps-wrap')?.classList.toggle('hidden', !soloMode || closed);
  // AI 陪练在怪物模式里也要能选（单人测试时和 AI 一起打 BOSS）
  UI.el('solo-ai-wrap')?.classList.toggle('hidden', !soloMode);
  UI.el('boss-diff-wrap')?.classList.toggle('hidden', !boss);
  UI.el('boss-stage-wrap')?.classList.toggle('hidden', !soloMode || !boss);
  // 怪物模式 / 竞技场：左半屏换成火力面板，展示台上的船循环演示自己的主炮
  const panelChanged = UI.setBoatPanelBossMode(closed);
  boatShowcase?.setBossMode(closed);
  if (panelChanged && !UI.el('menu-boat').classList.contains('hidden')) refreshBoatList();
  refreshAvatarChip();
  const list = UI.el('map-list');
  if (list) {
    list.style.opacity = closed ? '0.35' : '';
    list.style.pointerEvents = closed ? 'none' : '';
  }
}

UI.el('btn-map-ok').onclick = () => {
  if (!myBoatId) {
    UI.toast('先选一艘赛艇');
    return;
  }
  if (soloMode) startSoloRace();
  else enterLobby();
};

// 选图界面 ↑/↓ 键切换赛道
window.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  const screen = UI.el('menu-boat');
  if (!screen || screen.classList.contains('hidden')) return;
  // 下拉框获得焦点时让原生上下键生效
  if (e.target instanceof HTMLSelectElement) return;
  e.preventDefault();
  const cards = Array.from(document.querySelectorAll('#map-list .map-card'));
  if (!cards.length) return;
  const currentIdx = cards.findIndex((c) => c.classList.contains('selected'));
  const step = e.key === 'ArrowDown' ? 1 : -1;
  const nextIdx = ((currentIdx < 0 ? 0 : currentIdx) + step + cards.length) % cards.length;
  cards[nextIdx].click();
  cards[nextIdx].scrollIntoView({ block: 'nearest' });
});

// ---------- 单人开赛 ----------
function startSoloRace(opts = {}) {
  const laps = soloLaps || 3;
  // 挑战模式只跟影子跑：强制单人名次、强制 0 AI（大厅里的 AI 设置对它无效）
  const challenge = soloModeMode === 'challenge';
  // 组队赛制只对竞速 / 道具 / 弹射开放；怪物、竞技场、挑战都不参与
  const teamPlayable = !challenge && soloFormat === 'team'
    && soloModeMode !== 'boss' && soloModeMode !== 'arena' && soloModeMode !== 'skytower';
  const rounds = teamPlayable ? (soloMatchFormat === 'single' ? 1 : 3) : 1;
  if (!opts.continueMatch || !soloMatch) {
    soloMatch = {
      round: 1,
      rounds,
      format: teamPlayable ? 'team' : 'solo',
      matchFormat: teamPlayable ? soloMatchFormat : 'single',
      teamNames: { ...soloTeamNames },
      teamScores: { blue: 0, red: 0 },
      roundWins: { blue: 0, red: 0 },
      scores: new Map(),
    };
  } else {
    soloMatch.round += 1;
    soloMatch.rounds = rounds;
  }
  const round = soloMatch.round;
  // 怪物模式也能带 AI 陪练（一起打 BOSS），方便单测配合
  let aiCount = challenge ? 0 : Math.min(3, soloAi || 0);
  // 组队练习至少 1 个 AI 对手，否则红队没人
  if (teamPlayable) aiCount = Math.max(1, aiCount);
  // 解析天气：随机 = 现场抽一个
  let weatherId = soloWeatherId;
  if (weatherId === 'random') {
    const ids = WEATHERS.map((w) => w.id);
    weatherId = ids[Math.floor(Math.random() * ids.length)];
  }
  // 海克斯：赛艇开局随机分配（忽略大厅里的手动选艇），AI 从剩余艇里抽，互不重复
  const hexRandomBoat = soloModeMode === 'boss' && soloBossVariant === 'hex';
  const runBoats = hexRandomBoat ? shuffledBoatIds() : null;
  const myRunBoatId = hexRandomBoat ? runBoats[0] : myBoatId;
  // 本地玩家 + AI 陪练；组队练习里本地玩家固定蓝队，AI 优先补红队
  const order = [{
    id: 'me', name: getMyName(), boatId: myRunBoatId, ai: false, avatar: myAvatar,
    team: teamPlayable ? 'blue' : null,
  }];
  const used = new Set([myRunBoatId]);
  // 单人组队练习的 AI 按人数均衡自动分队（联机组队由房主在名单里逐个分配）
  for (let i = 0; i < aiCount; i++) {
    const free = BOATS.filter((b) => !used.has(b.id));
    if (!free.length) break;
    const pick = free[Math.floor(Math.random() * free.length)];
    used.add(pick.id);
    let team = null;
    if (teamPlayable) {
      const sizeOf = (tm) => order.filter((o) => o.team === tm).length;
      team = sizeOf('blue') <= sizeOf('red') ? 'blue' : 'red';
      if (sizeOf(team) >= 3) team = team === 'blue' ? 'red' : 'blue';
      if (sizeOf(team) >= 3) team = null;
      if (!team) break; // 两队都满员，不再生成
    }
    order.push({ id: 'ai' + (i + 1), name: `电脑${i + 1}`, boatId: pick.id, ai: true, team });
  }
  startRace({
    mapId: soloMapId,
    laps,
    round,
    rounds,
    weather: weatherId,
    order,
    mode: soloModeMode,
    format: soloMatch.format,
    teamNames: soloMatch.teamNames,
    matchFormat: soloMatch.matchFormat,
    difficulty: soloBossDifficulty,
    variant: soloBossVariant,
    // 单人怪物模式：直接进选中的关卡（联机模式不带这个字段，仍从第一关开始）
    stage: soloModeMode === 'boss' ? soloBossStage : undefined,
  }, soloNet);
  UI.toast(soloModeMode === 'item'
    ? '单人练习：Esc 打开设置 · ↑/↓ 油门 · Q/W/E 使用道具'
    : soloModeMode === 'boss'
      ? `怪物模式：↑/W 油门 · Q/E/1 使用道具 · R 提前复活 · Esc 设置${
        hexRandomBoat ? ` · 本局随机赛艇：${getBoat(myRunBoatId)?.name || ''}` : ''}`
      : soloModeMode === 'arena'
        ? '竞技场：↑ 油门 · ←/→ 转向 · J 开火（炮口只修正 ±8°，靠船头瞄准）'
        : soloModeMode === 'skytower'
          ? '云端天梯：前 60 秒只捡货，之后升降光柱开启 · K 冲刺撞人掉货还能推人下塔 · 顶层中央入账'
          : challenge
          ? '挑战模式：只有你和影子 · 跑出更快的一圈影子立刻升级 · R 复位 · Esc 设置'
          : '单人练习：Esc 打开设置（里面可以退出比赛）· R 复位');
}

// 回到主界面必须把三按钮入口放回来，否则 menu-main 只是个空背景。
function showEntryMenu() {
  voice.reset();
  voice.setAllowed(false);
  showScreen('menu-main');
  UI.show('menu-entry');
  UI.hide('menu-lan-view');
  UI.hide('btn-back-entry');
}

function exitSoloToMenu() {
  endRace();
  soloMode = false;
  soloMatch = null;
  myId = null;
  hostId = null;
  myBoatId = null;
  showEntryMenu();
}

// 旧版这里是「Esc 直接退赛」。现在 Esc 先开设置面板（玩家要求），
// 「退出比赛」挪进面板底部 —— 见上方 settingsPanel.init 的 onExitRace。

// 选艇界面 ←/→ 切换赛艇
window.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const screen = UI.el('menu-boat');
  if (screen && !screen.classList.contains('hidden')) {
    UI.el(e.key === 'ArrowLeft' ? 'boat-prev' : 'boat-next')?.click();
  }
});

// ---------- 大厅 ----------
// 大厅左侧的 3D 赛艇展示台：与选艇台同一套 BoatShowcase，离开大厅时销毁，
// 避免同时存在多个 WebGL 上下文。
let lobbyShowcase = null;
let lobbyStageHost = null;

function syncLobbyShowcase() {
  const stage = UI.el('lobby-stage');
  if (!stage) return;
  if (!lobbyStageHost || !stage.contains(lobbyStageHost)) {
    lobbyStageHost = document.createElement('div');
    lobbyStageHost.className = 'lobby-stage-canvas';
    stage.insertBefore(lobbyStageHost, stage.firstChild);
  }
  const id = myBoatId
    || roster.players?.find((p) => p.id === myId)?.boatId
    || BOATS[0].id;
  if (!lobbyShowcase) lobbyShowcase = new BoatShowcase(lobbyStageHost, id);
  else lobbyShowcase.setBoat(id);
  lobbyShowcase.setBossMode(roster.mode === 'boss' || roster.mode === 'arena');
  // 调试句柄（跟 window.__game / window.__audio 同性质）：无头验收要量展示台里
  // 模型的实际包围盒，确认 fitTo:'height' 有没有被动画或克隆覆盖掉
  if (typeof window !== 'undefined') window.__showcase = lobbyShowcase;
}

function disposeLobbyShowcase() {
  if (lobbyShowcase) {
    lobbyShowcase.dispose();
    lobbyShowcase = null;
  }
  if (lobbyStageHost) {
    lobbyStageHost.remove();
    lobbyStageHost = null;
  }
}

// ---------- 大厅中心化 ----------
// 创建比赛 / 加入比赛 / 练习模式 三个入口都进这张大厅：
//   · 赛艇、地图、天气、模式全部在右侧按钮里直接选；
//   · 地图 / 天气 / 模式只有房主能改，客人点了只提示、不下发；
//   · 单人练习用本地名单（Host = 自己），同样可以改全部项。
const LOBBY_PICK_TITLES = {
  boat: '选择赛艇',
  map: '选择地图',
  weather: '选择天气',
  mode: '选择模式',
};

// 玩法芯片。挑战模式（单人影子对战）与怪物模式都放在抽屉底部的独立卡片里：
// 它们不是"赛制"的一部分（挑战只支持单人、怪物不支持个人/组队），
// 混进这一排芯片会让人以为可以随便组合。
const LOBBY_MODES = [
  { id: 'race', name: '竞速', icon: '🏁', note: '纯速度比拼 · 海啸级大浪' },
  { id: 'item', name: '道具', icon: '🎁', note: '道具互攻 · 海啸级大浪' },
  { id: 'launch', name: '弹射', icon: '🚀', note: '跳台弹射 · 平静海面' },
  { id: 'arena', name: '竞技场', icon: '⚔️', note: '炮战对决 · 平静海面' },
  { id: 'skytower', name: '云端天梯', icon: '🗼', note: '运货爬塔 · 撞击抢夺 · 坠落出局' },
];

const MATCH_FORMATS = [
  { id: 'single', name: '单场定胜负', note: '只跑 1 局' },
  { id: 'bestOf3', name: '三局两胜', note: '打满 3 局，按局胜点判胜负' },
  { id: 'points3', name: '三局积分制', note: '打满 3 局，按总积分排名' },
];

let lobbyPickKind = null;

/** 单人模式没有服务器名单，本地拼一份，host = 自己 */
function soloRosterNow() {
  // 挑战模式没有队友：即使残留在组队赛制下，也不能给玩家挂队伍色
  const team = soloFormat === 'team' && soloModeMode !== 'boss'
    && soloModeMode !== 'arena' && soloModeMode !== 'challenge' && soloModeMode !== 'skytower';
  // 海克斯：大厅不显示"已选艇"，统一标成本局随机
  const hexRandomBoat = soloModeMode === 'boss' && soloBossVariant === 'hex';
  return {
    players: [{
      id: 'me', name: getMyName(), boatId: hexRandomBoat ? null : myBoatId, ai: false, avatar: myAvatar,
      team: team ? 'blue' : null,
    }],
    settings: {
      laps: soloLaps,
      rounds: soloMatchFormat === 'single' ? 1 : 3,
      aiCount: soloAi,
      difficulty: soloBossDifficulty,
      variant: soloBossVariant,
      matchFormat: soloMatchFormat,
    },
    format: team ? 'team' : 'solo',
    teams: team ? { me: 'blue' } : {},
    teamNames: soloTeamNames,
    mapId: soloMapId,
    weather: soloWeatherId,
    mode: soloModeMode,
  };
}

function lobbyBoatId() {
  return myBoatId || roster.players?.find((p) => p.id === myId)?.boatId || null;
}

// 当前大厅模式 / 怪物分支：单人读本地变量，联机读服务器同步的设置
function currentLobbyMode() {
  return soloMode ? soloModeMode : (roster.mode || 'race');
}
function currentBossVariant() {
  return soloMode ? soloBossVariant : (roster.settings?.variant === 'hex' ? 'hex' : 'classic');
}
/** 海克斯模式：赛艇由开局随机分配，选艇界面只展示、不允许手动改 */
function isHexRandomBoatMode() {
  return currentLobbyMode() === 'boss' && currentBossVariant() === 'hex';
}

/** 洗一遍 8 艘赛艇的 id：海克斯每局给每人发一艘不重复的 */
function shuffledBoatIds() {
  const ids = BOATS.map((b) => b.id);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return ids;
}

// 大厅顶部中央提示：缺人 / 没选艇 / 没准备等拒绝原因现在由服务器 toast 说明，
// 这里只保留"进入大厅时清掉上一次残留提示"的能力
let lobbyNoticeTimer = null;
function hideLobbyNotice() {
  clearTimeout(lobbyNoticeTimer);
  UI.el('lobby-notice')?.classList.remove('show');
}

/**
 * 大厅「游戏设置」抽屉底部的「起始关卡」按钮组。
 * 只服务单人练习的怪物模式：联机关卡进度由服务器从第一关推，选关没有意义。
 * 值仍存在 soloBossStage，和选艇屏底部那个「关卡」下拉双向对齐。
 */
function renderLobbyStagePick() {
  const box = UI.el('lobby-stage-pick');
  const grid = UI.el('lobby-stage-grid');
  if (!box || !grid) return;
  const mode = soloMode ? soloModeMode : (roster.mode || 'race');
  const show = soloMode && mode === 'boss';
  box.classList.toggle('hidden', !show);
  if (!show) {
    grid.innerHTML = '';
    grid.onclick = null;
    return;
  }
  grid.innerHTML = BOSS_LEVELS.map((lv) => (
    `<button class="lsp-btn${lv.stage === soloBossStage ? ' on' : ''}" type="button" `
    + `data-stage="${lv.stage}">${lv.name}</button>`
  )).join('');
  grid.onclick = (e) => {
    const btn = e.target.closest?.('[data-stage]');
    if (!btn) return;
    const stage = +btn.dataset.stage || 1;
    if (stage === soloBossStage) return;
    soloBossStage = stage;
    const sel = UI.el('boss-stage');
    if (sel) sel.value = String(stage);
    audio.play('uiClick', { gap: 0 });
    renderLobbyNow();
  };
}

function enterLobby() {
  lobbyPickKind = null;
  UI.el('lobby-pick-drawer')?.classList.remove('open');
  hideLobbyNotice();
  chat.reset(); // 每局结束后清空，避免上一局的消息串进来
  showScreen('lobby');
  // 回到大厅：温柔大厅 BGM 渐入（同一首不会重新开始）
  audio.startMusic('menu');
  renderLobbyNow();
}

function renderLobbyNow() {
  if (soloMode) {
    roster = soloRosterNow();
    myId = 'me';
    hostId = 'me';
  }
  syncChatTeam();
  // 第 7 个参数：只有线上联机才在选手名后画语音喇叭。
  UI.renderLobby(roster, myId, hostId, lanIps, !soloMode, !soloMode, voice.allowed && !soloMode);
  refreshVoiceIcons();
  refreshAvatarChip();
  renderLobbyStagePick();
  // 排行榜只在联机大厅出现：练习模式没有服务器，连入口都不给
  UI.el('btn-lobby-leaderboard')?.classList.toggle('hidden', !!soloMode);
  const lobbyEl = UI.el('lobby');
  if (lobbyEl && !lobbyEl.classList.contains('hidden')) {
    syncLobbyShowcase();
    // 玩家列表高度随人数变化，聊天面板要跟着挪到列表上沿
    chat.placeLobby();
    // 自己刚进房（welcome 已到、大厅刚显示）时补一条欢迎横幅
    flushSelfWelcome();
  }

  // 怪物 / 竞技场：地图与天气不参与本局 —— 两个入口变淡且点不动。
  // 非房主同样一律禁用（以前这里只按模式判断，把 renderLobby 里给客人
  // 加上的 locked 又拆掉了，客人看起来能点地图 / 天气）。
  const isHostNow = soloMode || myId === hostId;
  const trackLocked = modeLocksTrackPicker();
  for (const id of ['btn-lobby-map', 'btn-lobby-weather', 'btn-lobby-mode']) {
    const btn = UI.el(id);
    if (!btn) continue;
    const byMode = trackLocked && id !== 'btn-lobby-mode';
    const locked = !isHostNow || byMode;
    btn.classList.toggle('locked', locked);
    btn.disabled = locked;
    btn.title = !isHostNow
      ? '只有房主可以更改地图 / 天气 / 模式'
      : byMode ? '怪物 / 竞技场模式使用固定竞技场海面，地图与天气不参与' : '';
  }
  // 抽屉里正开着地图 / 天气时切到了怪物模式：直接收起来，别留一个点不动的面板
  if (trackLocked && (lobbyPickKind === 'map' || lobbyPickKind === 'weather')) closeLobbyPick();
  // 海克斯：赛艇按钮仍可点开（只展示），用 title 提前说明不能手选
  const boatPickBtn = UI.el('btn-lobby-boat');
  if (boatPickBtn) boatPickBtn.title = isHexRandomBoatMode() ? '海克斯模式：本局赛艇开局随机分配' : '';
  // 游戏设置（圈数 / 局数 / AI / 难度）同样是房主专属，客人只读不行且打不开
  const settingsBtn = UI.el('btn-lobby-settings');
  if (settingsBtn) {
    settingsBtn.classList.toggle('locked', !isHostNow);
    settingsBtn.disabled = !isHostNow;
    settingsBtn.title = isHostNow ? '' : '只有房主可以更改比赛设置';
  }
  if (!isHostNow) UI.el('lobby-settings-drawer')?.classList.remove('open');

  // 抽屉开着时跟着数据一起刷新（比如房主切了地图、别人抢了赛艇）
  if (lobbyPickKind) renderLobbyPick();

  // 绑定主机设置
  const selLaps = document.getElementById('sel-laps');
  const selRounds = document.getElementById('sel-rounds');
  const selAi = document.getElementById('sel-ai');
  const selDifficulty = document.getElementById('sel-difficulty');
  const selMatchFormat = document.getElementById('sel-match-format');
  if (soloMode) {
    // 单人模式：这些控件直接改本地赛制，不走服务器
    if (selDifficulty) {
      selDifficulty.onchange = () => {
        soloBossDifficulty = selDifficulty.value;
        renderLobbyNow();
      };
    }
    if (selLaps) {
      selLaps.onchange = () => {
        soloLaps = +selLaps.value || 3;
        renderLobbyNow();
      };
      if (selRounds) {
        selRounds.onchange = () => {
          soloMatchFormat = +selRounds.value === 1 ? 'single' : 'points3';
          soloMatch = null;
          renderLobbyNow();
        };
      }
    }
    // AI 数量在单人怪物模式里也有（设置抽屉里只有难度 + AI，没有圈数），
    // 所以这条绑定不能再挂在 selLaps 里面，否则选 AI 完全没反应
    if (selAi) {
      selAi.onchange = () => {
        soloAi = Math.min(3, +selAi.value || 0);
        if (soloFormat === 'team') soloAi = Math.max(1, soloAi);
        renderLobbyNow();
      };
    }
    if (selMatchFormat) {
      selMatchFormat.onchange = () => {
        soloMatchFormat = selMatchFormat.value;
        soloMatch = null;
        renderLobbyNow();
      };
    }
    return;
  }
  if (selDifficulty) {
    selDifficulty.onchange = () => net.send({
      t: 'settings',
      settings: { difficulty: selDifficulty.value },
    });
  }
  if (selMatchFormat) {
    selMatchFormat.onchange = () => net.send({
      t: 'settings',
      settings: { matchFormat: selMatchFormat.value },
    });
  }
  if (selLaps) {
    const send = () => net.send({
      t: 'settings',
      settings: {
        laps: +selLaps.value,
        // 新版界面用 sel-match-format 控制局数；保留旧 sel-rounds 兼容
        ...(selRounds ? { rounds: +selRounds.value } : {}),
      },
    });
    selLaps.onchange = send;
    if (selRounds) selRounds.onchange = send;
  }
  // AI 数量单独绑定：怪物模式的设置抽屉里没有圈数（selLaps），
  // 以前挪到里面会导致房间加 AI 完全发不出去
  if (selAi) {
    selAi.onchange = () => net.send({
      t: 'settings',
      settings: { aiCount: +selAi.value },
    });
  }
}

function openLobbyPick(kind) {
  // 选艇所有人都能看；地图 / 天气 / 模式只有房主能改
  if (kind !== 'boat' && !canPickMap()) {
    UI.toast('只有房主可以更改地图 / 天气 / 模式');
    return;
  }
  if ((kind === 'map' || kind === 'weather') && modeLocksTrackPicker()) {
    UI.toast('怪物 / 竞技场模式使用固定竞技场海面，地图和天气不生效');
    return;
  }
  const drawer = UI.el('lobby-pick-drawer');
  if (!drawer) return;
  // 两个抽屉互斥，避免叠在一起看不到内容
  UI.el('lobby-settings-drawer')?.classList.remove('open');
  lobbyPickKind = kind;
  UI.el('lobby-pick-title').textContent = kind === 'boat' && isHexRandomBoatMode()
    ? '赛艇 · 本局随机'
    : (LOBBY_PICK_TITLES[kind] || '选择');
  // 先展开再渲染：地图路线画布需要拿到抽屉的真实宽度
  drawer.classList.add('open');
  renderLobbyPick();
}

function closeLobbyPick() {
  lobbyPickKind = null;
  UI.el('lobby-pick-drawer')?.classList.remove('open');
}

function chooseLobbyBoat(id) {
  if (isHexRandomBoatMode()) {
    UI.toast('海克斯模式：赛艇在开局随机分配，不能手动选择');
    return;
  }
  if (takenBoats().has(id)) {
    UI.toast('这艘赛艇已经被其他玩家选走了');
    return;
  }
  myBoatId = id;
  pickPending = { id, at: Date.now() };
  const me = roster.players?.find((p) => p.id === myId);
  if (me) me.boatId = id;
  if (!soloMode) {
    net.send({ t: 'pick', boatId: id });
    watchPickSync(id);
  }
  lobbyShowcase?.setBoat(id);
  renderLobbyNow();
}

function chooseLobbyMap(id) {
  if (!canPickMap() || modeLocksTrackPicker()) return;
  if (soloMode) soloMapId = id;
  else net.send({ t: 'map', mapId: id });
  roster.mapId = id;
  renderLobbyNow();
}

function chooseLobbyWeather(id) {
  if (!canPickMap() || modeLocksTrackPicker()) return;
  if (soloMode) soloWeatherId = id;
  else net.send({ t: 'weather', weatherId: id });
  roster.weather = id;
  renderLobbyNow();
}

function chooseLobbyMode(id) {
  if (!canPickMap()) return;
  // 挑战模式是单人玩法（影子只属于你自己的存档）：联机房间一律拦掉，
  // 房主也不行 —— 服务器 MODE_IDS 里没有 challenge，硬发也会被整包丢弃。
  if (id === 'challenge' && !soloMode) {
    UI.toast('挑战模式只支持单人练习：回到主菜单选「单人」再进');
    return;
  }
  // 竞技场 3v3 暂缓：客户端先拦一道，避免本地先把模式改成 arena 造成显示错位
  const teamFormat = soloMode ? soloFormat === 'team' : roster.format === 'team';
  if ((id === 'arena' || id === 'skytower') && teamFormat) {
    UI.toast(`${id === 'arena' ? '竞技场' : '云端天梯'} 组队赛制还在开发中，先切回个人赛制`);
    return;
  }
  // 挑战模式没有队友也没有 AI，只跟影子比 —— 组队赛制下切它会让"名次/计分"两套口径打架
  if (id === 'challenge' && teamFormat) {
    UI.toast('挑战模式只支持个人赛制，先把赛制切回「个人」');
    return;
  }
  if (soloMode) soloModeMode = id;
  // 字段名必须是 modeId（服务器按它校验）；历史上这里发的是 mode，
  // 会被服务器整包丢掉，表现就是"房主换了模式，但客户端和服务器都没变"
  else net.send({ t: 'mode', modeId: id });
  roster.mode = id;
  // 点「怪物模式 · 闯关」= 回到现有玩法，分支重置为 classic
  if (id === 'boss') {
    if (soloMode) soloBossVariant = 'classic';
    else net.send({ t: 'settings', settings: { variant: 'classic' } });
    roster.settings = { ...(roster.settings || {}), variant: 'classic' };
  }
  lobbyShowcase?.setBossMode(id === 'boss' || id === 'arena');
  renderLobbyNow();
}

/** 怪物模式分支：classic = 闯关（现有玩法），hex = 海克斯（每关技能顺序洗牌） */
function chooseLobbyVariant(variant) {
  if (!canPickMap()) return;
  const v = variant === 'hex' ? 'hex' : 'classic';
  if (soloMode) {
    soloBossVariant = v;
    soloModeMode = 'boss';
    roster.mode = 'boss';
  } else {
    if (roster.mode !== 'boss') net.send({ t: 'mode', modeId: 'boss' });
    net.send({ t: 'settings', settings: { variant: v } });
    roster.mode = 'boss';
  }
  roster.settings = { ...(roster.settings || {}), variant: v };
  lobbyShowcase?.setBossMode(true);
  renderLobbyNow();
}

/** 赛制切换：个人 / 组队（单人在本地切，联机交给服务器） */
function chooseLobbyFormat(format) {
  if (!canPickMap()) {
    UI.toast('只有房主可以更改赛制');
    return;
  }
  // 怪物 / 挑战都是独立玩法，赛制不参与；直接置灰并说明，而不是点了没反应
  const currentMode = soloMode ? soloModeMode : roster.mode;
  if (currentMode === 'boss') {
    UI.toast('怪物模式是独立玩法，先切回竞速 / 道具 / 弹射再选赛制');
    return;
  }
  if (currentMode === 'challenge') {
    UI.toast('挑战模式只跟影子跑，先切回竞速 / 道具 / 弹射再选赛制');
    return;
  }
  const next = format === 'team' ? 'team' : 'solo';
  if (next === 'team' && (roster.mode === 'arena' || roster.mode === 'skytower')) {
    UI.toast('该模式组队赛制还在开发中，先切到竞速 / 道具 / 弹射再开组队');
    return;
  }
  if (soloMode) {
    if (soloFormat === next) return;
    soloFormat = next;
    if (next === 'team') {
      if (soloMatchFormat === 'single') soloMatchFormat = 'bestOf3';
      soloAi = Math.max(1, soloAi); // 组队练习至少 1 个 AI 对手
    }
    soloMatch = null;
  } else {
    net.send({ t: 'format', format: next });
  }
  roster.format = next;
  renderLobbyNow();
}

/** 比赛设置：单场定胜负 / 三局两胜 / 三局积分制 */
function chooseLobbyMatchFormat(id) {
  if (!canPickMap()) {
    UI.toast('只有房主可以更改比赛设置');
    return;
  }
  const fmt = MATCH_FORMATS.some((f) => f.id === id) ? id : 'single';
  if (soloMode) {
    soloMatchFormat = fmt;
    soloMatch = null;
  } else {
    net.send({ t: 'settings', settings: { matchFormat: fmt } });
  }
  if (roster.settings) roster.settings.matchFormat = fmt;
  renderLobbyNow();
}

/** 左下角选手行换队：自己随时可换，房主可以帮所有人换 */
function chooseLobbySwitchTeam(id, team) {
  if (soloMode) return; // 单人练习的队伍固定为"我 + AI"
  if (roster.format !== 'team' || roster.mode === 'boss') return;
  if (team !== 'blue' && team !== 'red') return;
  if (id !== myId && myId !== hostId) {
    UI.toast('只能给自己换队，房主可以帮所有人换队');
    return;
  }
  net.send({ t: 'teamSwitch', id, team });
}

function renderLobbyPick() {
  const body = UI.el('lobby-pick-body');
  if (!body || !lobbyPickKind) return;

  if (lobbyPickKind === 'boat') {
    // 缩略图是离屏渲染出来的真实模型图：这里先把生成任务挂起来，画好一张补一张
    ensureBoatThumbs();
    // 海克斯：赛艇开局随机分配 —— 抽屉只展示全部艇，卡片置灰、不可点
    const hexRandom = isHexRandomBoatMode();
    const current = hexRandom ? null : lobbyBoatId();
    const taken = takenBoats();
    const detailBoat = BOATS.find((b) => b.id === current) || BOATS[0];
    body.innerHTML = `
      ${hexRandom ? '' : UI.lobbyBoatStatsHtml(detailBoat, roster.mode)}
      <div class="lp-grid${BOATS.length % 2 ? ' odd' : ''}">${BOATS.map((b) => {
        const isMe = b.id === current;
        const used = !isMe && taken.has(b.id);
        const thumb = boatThumbUrl(b.id);
        return `<button class="lp-card${isMe ? ' selected' : ''}${used || hexRandom ? ' locked' : ''}" data-boat="${b.id}" type="button"${hexRandom ? ' disabled' : ''}>
          <span class="lp-thumb${thumb ? ' ready' : ''}" data-boat-thumb="${b.id}">${
            thumb ? `<img src="${thumb}" alt="">` : '<i class="lp-thumb-ph"></i>'
          }</span>
          <b>${b.name}</b>
          <small>${hexRandom ? '本局随机' : used ? '已被选走' : isMe ? '当前选择' : '点击选用'}</small>
        </button>`;
      }).join('')}</div>
      <p class="lp-note">${hexRandom
        ? '海克斯模式：本局赛艇开局随机分配，不能手动选择（每人一艘，不重复）。'
        : '赛艇所有人都能换；地图 / 天气 / 模式只有房主能改。'}</p>`;
    body.querySelectorAll('[data-boat]').forEach((btn) => {
      btn.onclick = () => chooseLobbyBoat(btn.dataset.boat);
    });
    return;
  }

  if (lobbyPickKind === 'map') {
    const current = roster.mapId;
    const map = MAPS.find((m) => m.id === current) || MAPS[0];
    const meta = UI.lobbyMapMeta(map);
    body.innerHTML = `
      <div class="lp-detail lp-detail-map">
        <div class="lp-route"><canvas></canvas></div>
        <div class="lp-detail-head">
          <b>${map.icon || '🏁'} ${map.name}</b>
          <span>${'★'.repeat(meta.stars)}${'☆'.repeat(3 - meta.stars)} 难度</span>
        </div>
        <p class="lp-desc">${map.desc || ''}</p>
        <div class="lp-map-meta">
          <span>主圈 <em>${meta.lapLength}</em> m</span>
          <span><em>${meta.gates}</em> 个门</span>
          <span><em>${meta.shortcuts}</em> 条近道</span>
          <span>默认 <em>${map.laps || 3}</em> 圈</span>
        </div>
      </div>
      <div class="lp-grid lp-grid-map">${MAPS.map((m) => `
        <button class="lp-card lp-card-map${m.id === current ? ' selected' : ''}" data-map="${m.id}" type="button">
          ${iconImg(MAP_ICON[m.id], 'lp-map-icon') || `<span class="lp-map-emoji">${m.icon || '🏁'}</span>`}
          <span class="lp-map-txt">
            <b>${m.name}</b>
            <small>${m.laps || 3} 圈 · ${m.desc || ''}</small>
          </span>
        </button>`).join('')}</div>
      <p class="lp-note">${roster.mode === 'boss' ? '怪物模式的地图固定为怪物竞技场，这里的选择不会生效。' : '房主选定的地图会同步给房间里所有玩家。'}</p>`;
    body.querySelectorAll('[data-map]').forEach((btn) => {
      btn.onclick = () => chooseLobbyMap(btn.dataset.map);
    });
    // 等抽屉完成布局后再画路线（宽度为 0 时 drawTrackView 会直接返回）
    const routeCanvas = body.querySelector('.lp-route canvas');
    if (routeCanvas) {
      requestAnimationFrame(() => UI.drawMapRoute(routeCanvas, current, { pad: 18 }));
    }
    return;
  }

  if (lobbyPickKind === 'weather') {
    const current = roster.weather;
    const list = soloMode ? [...WEATHERS, { id: 'random', name: '随机天气', icon: '🎲' }] : WEATHERS;
    body.innerHTML = `
      <div class="lp-pills">${list.map((w) => `
        <button class="lp-pill lp-pill-icon${w.id === current ? ' selected' : ''}" data-weather="${w.id}" type="button">
          ${iconImg(WEATHER_ICON[w.id], 'lp-ico') || `<span class="lp-pill-emoji">${w.icon || ''}</span>`}
          <span>${w.name}</span>
        </button>`).join('')}</div>
      <p class="lp-note">竞速 / 道具模式：晴天浪高约 3 米，暴风雨可达 7 米，注意浪尖会把船抛起来。</p>`;
    body.querySelectorAll('[data-weather]').forEach((btn) => {
      btn.onclick = () => chooseLobbyWeather(btn.dataset.weather);
    });
    return;
  }

  if (lobbyPickKind === 'mode') {
    const current = roster.mode;
    const teamFormat = roster.format === 'team';
    const bossMode = current === 'boss';
    const challengeMode = current === 'challenge';
    const bossVariant = roster.settings?.variant === 'hex' ? 'hex' : 'classic';
    // 挑战模式：单人专属，跟自己的影子跑。卡片上直接给出当前影子成绩 ——
    // 「有没有记录、要不要去破它」是玩家点这个模式前最想知道的一件事。
    const shadowRec = (() => {
      try {
        const boatId = myBoatId || roster.players?.find((p) => p.id === myId)?.boatId || '';
        return readGhost(soloMapId || roster.mapId, boatId, 0);
      } catch { return null; }
    })();
    const shadowNote = shadowRec?.lapTime
      ? `影子 ${UI.fmtTime(shadowRec.lapTime)} · 跑得更快就换新影子`
      : '还没有影子 · 跑完第一圈自动生成';
    // 海克斯无尽：大厅卡片直接显示本地最佳层数（4 层以内不算）
    const hexBest = (() => {
      try { return Number(localStorage.getItem(HEX_BEST_KEY) || 0); } catch { return 0; }
    })();
    const note = challengeMode
      ? '挑战模式只有你和影子：没有 AI、不计队伍名次，每跑出更快的一圈，影子立刻换成那一圈。'
      : bossMode
        ? '怪物模式是独立玩法，合作打 BOSS，不属于个人 / 组队赛制；切回竞速 / 道具 / 弹射后会恢复之前的赛制设置。'
        : teamFormat
          ? '组队 3v3：每队最多 3 人，队友之间不吃攻击道具；竞技场 3v3 还在开发中。'
          : '个人赛制：按个人名次计分，不显示队伍色圆点。';
    // 挑战模式不支持组队：切到它之前先让人把赛制切回个人（toast 里说明原因）
    const formatLocked = bossMode || challengeMode;
    body.innerHTML = `
      <div class="lp-format-row">
        <span class="lp-format-label">赛制</span>
        <div class="lp-pills">
          <button class="lp-pill${!teamFormat ? ' selected' : ''}" data-format="solo" type="button"${!canPickMap() || formatLocked ? ' disabled' : ''}${bossMode ? ' title="怪物模式不支持个人 / 组队赛制"' : challengeMode ? ' title="挑战模式只支持个人赛制"' : ''}>个人</button>
          <button class="lp-pill${teamFormat ? ' selected' : ''}" data-format="team" type="button"${!canPickMap() || formatLocked ? ' disabled' : ''}${bossMode ? ' title="怪物模式不支持个人 / 组队赛制"' : challengeMode ? ' title="挑战模式只支持个人赛制"' : ''}>组队 3v3</button>
        </div>
      </div>
      <div class="lp-pills">${LOBBY_MODES.map((m) => `
        <button class="lp-pill lp-pill-icon${m.id === current ? ' selected' : ''}" data-mode="${m.id}" type="button">
          ${iconImg(MODE_ICON[m.id], 'lp-ico') || `<span class="lp-pill-emoji">${m.icon}</span>`}
          <span>${m.name}${m.id === 'arena' && teamFormat ? ' 3v3' : ''}</span>
        </button>`).join('')}</div>
      ${teamFormat && !formatLocked ? `
        <div class="lp-format-row">
          <span class="lp-format-label">比赛</span>
          <div class="lp-pills">${MATCH_FORMATS.map((f) => `
            <button class="lp-pill${f.id === (roster.settings?.matchFormat || 'single') ? ' selected' : ''}" data-match="${f.id}" type="button"${!canPickMap() ? ' disabled' : ''}>
              ${f.name}
            </button>`).join('')}</div>
        </div>
        <p class="lp-note">${MATCH_FORMATS.find((f) => f.id === (roster.settings?.matchFormat || 'single'))?.note || ''}</p>` : ''}
      <div class="lp-divider"><span>单人玩法</span></div>
      <button class="lp-boss-card${challengeMode ? ' selected' : ''}" data-mode="challenge" type="button"${soloMode ? '' : ' disabled title="挑战模式只支持单人练习"'}${soloMode ? '' : ' style="opacity:.5;cursor:not-allowed"'}>
        ${iconImg('modeChallenge', 'lp-boss-art') || '<span class="lp-boss-icon">👻</span>'}
        <span class="lp-boss-text"><b>挑战模式 · 影子对战</b><small>${shadowNote}</small></span>
      </button>
      <p class="lp-note" style="margin:6px 0 2px">单人计时玩法：赛道上会放一辆你在这张图 × 这条船上最快的「影子」，没有 AI 对手，破纪录后影子当场升级。</p>
      <div class="lp-divider"><span>独立玩法</span></div>
      <button class="lp-boss-card${bossMode && bossVariant === 'classic' ? ' selected' : ''}" data-mode="boss" type="button"${!canPickMap() ? ' disabled' : ''}>
        ${iconImg('modeMonster', 'lp-boss-art') || '<span class="lp-boss-icon">🐉</span>'}
        <span class="lp-boss-text"><b>怪物模式 · 闯关</b><small>合作共斗 · 关卡技能顺序固定</small></span>
      </button>
      <button class="lp-boss-card${bossMode && bossVariant === 'hex' ? ' selected' : ''}" data-mode="boss" data-variant="hex" type="button" style="margin-top:8px"${!canPickMap() ? ' disabled' : ''}>
        ${iconImg('uiRandom', 'lp-boss-art') || '<span class="lp-boss-icon">🎲</span>'}
        <span class="lp-boss-text"><b>怪物模式 · 海克斯</b><small>每关洗牌技能顺序 · 赛艇开局随机${hexBest > 0 ? ` · 最佳：第 ${hexBest} 层` : ''}</small></span>
      </button>
      <p class="lp-note">${note}</p>`;
    body.querySelectorAll('[data-format]').forEach((btn) => {
      btn.onclick = () => chooseLobbyFormat(btn.dataset.format);
    });
    body.querySelectorAll('[data-mode]').forEach((btn) => {
      btn.onclick = () => (btn.dataset.variant
        ? chooseLobbyVariant(btn.dataset.variant)
        : chooseLobbyMode(btn.dataset.mode));
    });
    body.querySelectorAll('[data-match]').forEach((btn) => {
      btn.onclick = () => chooseLobbyMatchFormat(btn.dataset.match);
    });
    return;
  }
}

UI.el('btn-start-race').onclick = () => {
  if (soloMode) {
    startSoloRace();
    return;
  }
  // 本地名单可能落后于服务器（别人刚选完艇的广播还没到），所以这里不做本地拦截：
  // 缺人 / 没选艇 / 没准备 / 掉线一律交给服务器判断并回 toast，
  // 否则会出现"服务器早就收到了选艇，房主却点不动开始"的假故障。
  net.send({ t: 'start' });
};

// 大厅右侧：四个选择入口 + 设置
UI.el('btn-lobby-boat')?.addEventListener('click', () => openLobbyPick('boat'));
UI.el('btn-lobby-map')?.addEventListener('click', () => openLobbyPick('map'));
UI.el('btn-lobby-weather')?.addEventListener('click', () => openLobbyPick('weather'));
UI.el('btn-lobby-mode')?.addEventListener('click', () => openLobbyPick('mode'));
// 组队换队：直接点左下角选手行里的「蓝 / 红」，不再走独立的队伍抽屉
UI.el('lobby-players')?.addEventListener('click', (e) => {
  const btn = e.target.closest?.('[data-team-switch]');
  if (!btn || btn.disabled) return;
  chooseLobbySwitchTeam(btn.dataset.teamSwitch, btn.dataset.team);
});
UI.el('btn-lobby-pick-close')?.addEventListener('click', closeLobbyPick);
UI.el('lobby-pick-drawer')?.addEventListener('click', (e) => {
  if (e.target === UI.el('lobby-pick-drawer')) closeLobbyPick();
});
UI.el('btn-lobby-settings')?.addEventListener('click', () => {
  // 大厅里的「游戏设置」= 右边那条主机设置抽屉（单人 / 联机都是同一个），
  // 打开后不再跳去比赛内的设置面板 —— 两套界面的信息结构不一样，混着用玩家会迷路。
  UI.el('lobby-settings-drawer')?.classList.toggle('open');
});
UI.el('btn-lobby-settings-close')?.addEventListener('click', () => {
  UI.el('lobby-settings-drawer')?.classList.remove('open');
});
// 准备 / 取消准备：房主不需要点（点开始就是表态）；没选艇先拉去选艇
UI.el('btn-lobby-ready')?.addEventListener('click', () => {
  if (soloMode || myId === hostId) return;
  const me = roster.players?.find((p) => p.id === myId);
  const want = !me?.ready;
  // 海克斯赛艇由开局随机分配，不需要先选艇
  if (want && !lobbyBoatId() && !isHexRandomBoatMode()) {
    UI.toast('先选一艘赛艇，再点准备');
    openLobbyPick('boat');
    return;
  }
  if (me) me.ready = want; // 乐观更新，服务器回执后以 roster 为准
  net.send({ t: 'ready', ready: want });
  renderLobbyNow();
});

// ---------- 比赛 ----------
/**
 * 怪物 / 海克斯成绩上报（联机专属）。
 * 竞速由服务器在结算时自己记账，不需要客户端插嘴；但怪物模式没有"冲线结算"
 * 这回事，只能由房主在这一局结束时一次性上报。服务器只收房主、每局只收一次，
 * 分桶人数也用开赛时统计的真人数量，不信任消息里自报的值。
 */
function submitBossLeaderboard(data) {
  if (soloMode || !net.connected) return;   // 练习模式不进榜
  if (myId !== hostId) return;              // 只让房主报，避免每台机器各报一份
  if (roster.mode !== 'boss') return;
  const variant = roster.settings?.variant === 'hex' ? 'hex' : 'classic';
  const stages = (data?.stages || []).map((s) => ({
    stage: Number(s.stage) || 0,
    elapsed: Number(s.elapsed) || 0,
  }));
  net.send({
    t: 'lbSubmit',
    variant,
    victory: data?.victory === true,
    totalTime: Number(data?.totalTime) || 0,
    cleared: stages.length,
    stages,
  });
  // 下次打开面板重新拉一次，别让玩家看到自己刚打完那局之前的旧榜
  leaderboardPanel.data = null;
}

function startRace(msg, netImpl = null) {
  chat.reset(); // 进比赛清空大厅聊天记录
  syncChatTeam(msg);
  // 兜底：任何情况下都不允许两个 Game 同时活着（重复的 start 会让旧场景
  // 的 net 监听继续收快照，表现为船体抖动、HUD 双份刷新）
  if (game) {
    try { game.dispose(); } catch {}
    game = null;
  }
  if (msg.raceSeq) lastRaceSeq = Math.max(lastRaceSeq, msg.raceSeq);
  // 向服务器表态"我真的进比赛了"：服务器靠它区分活人局和刷新后留下的僵尸局
  if (!soloMode) net.send({ t: 'inGame', on: true });
  // 开赛前必须收掉设置面板：面板开着时 input 是冻结的，
  // 万一从面板里开赛（或客机收到开赛消息时面板正开着），玩家会完全动不了。
  settingsPanel.close();
  showScreen(null);
  UI.show('hud');
  refreshVoiceIcons();
  UI.setRaceMsg(null);
  resultMode = null;
  lastHudData = null;
  stopFinishPanel();

  game = new Game(document.getElementById('game-container'), {
    net: netImpl || net,
    myId,
    hostId,
    isHost: myId === hostId,
    solo: soloMode,
    startMsg: msg,
    input,
    onHud: (d) => { lastHudData = d; UI.updateHud(d); },
    onToast: (m, opts) => UI.toast(m, opts),
    onBossCutscene: (info) => UI.showBossCutscene(info),
    // 海克斯三选一：点卡后交给当前对局处理（核心由房主选，卡牌各选各的）
    onHexCards: (info) => UI.showHexCards(info,
      (id) => game?.pickHexPick?.(id),
      (act) => game?.hexPickAction?.(act)),
    onBossCutsceneEnd: () => UI.showBossCutscene(null),
    onBossStageResult: (data) => UI.showBossStageResult(data),
    // 海克斯无尽：第 4 层通关后由房主/单人选择继续或领奖
    onHexEndless: (info) => UI.showHexEndless(info),
    onBossVictory: (data) => {
      audio.play('win');
      UI.showHexEndless(null);
      recordHexBestStage(data.endlessStage);
      submitBossLeaderboard(data);
      UI.showBossEnd({ victory: true, ...data });
      UI.setRaceMsg(null);
    },
    // 海克斯无尽「结束领奖」：开进传送门后记账，然后直接回大厅（不弹终局面板）。
    // 复用「返回大厅」那条已经接好的链路：单人回主菜单、联机由房主广播 backLobby。
    onHexExit: (data) => {
      audio.play('win');
      UI.showHexEndless(null);
      recordHexBestStage(data.endlessStage);
      submitBossLeaderboard(data);
      UI.toast(`🏆 本次通过第 ${data.endlessStage ?? 0} 层，成绩已记录`);
      // 延到下一帧再拆对局：这里还在 BossMode.update 里，立刻 dispose 会把当前帧拆掉
      setTimeout(() => {
        try { UI.el('btn-boss-lobby').click(); } catch (err) { console.error('[hex-exit] 回大厅失败', err); }
      }, 60);
    },
    onBossDefeat: (data) => {
      audio.play('lose');
      UI.showHexEndless(null);
      // 海克斯失败也记（按"通过到第几关"排名）；经典闯关服务器会自行忽略
      submitBossLeaderboard(data);
      UI.showBossEnd({ victory: false, ...data });
      UI.setRaceMsg(null);
    },
    // 竞技场整场打完：弹自己的结算（胜负 + 比分），「返回大厅」复用 #btn-boss-lobby 那条
    // 已经接好"房主广播 backLobby → 所有人 lobbyReset 回选艇屏"的链路
    onArenaEnd: (data) => {
      audio.play(data?.won ? 'win' : 'lose');
      UI.showArenaEnd(data);
      UI.setRaceMsg(null);
    },
    // 云端天梯整局结束：弹累计入账分榜单，「返回大厅」复用 boss-lobby 那条回大厅链路
    onSkyTowerEnd: (data) => {
      audio.play(data?.won ? 'win' : 'lose');
      UI.showSkyTowerEnd({ ...data, myId });
      UI.setRaceMsg(null);
    },
    onFinish: (info) => {
      if (soloMode) {
        // 已经进过领奖台/结算：此后再冲线也不再重开观察期，否则倒计时会被反复重置
        if (resultMode) return;
        // 挑战模式统一走自己的完成面板，任何来源的完赛都不进领奖台
        if (soloModeMode === 'challenge') {
          if (challengeFinishActive) return;
          armChallengeFinishPanel();
          return;
        }
        if (info.ai) {
          // AI 先冲线：玩家继续驾驶完全不受影响，但观察期照样从这一刻开始算。
          // 10 秒后不管玩家有没有冲线，都必须进领奖台 + 结算（未完赛按 DNF 显示）。
          // 已经有人开启过观察期时直接返回，避免每有一台 AI 冲线就把倒计时重置。
          if (finishWindowUntil > performance.now()) return;
          finishWindowUntil = 0;
          armFinishUi(10);
          clearTimeout(podiumTimer);
          podiumTimer = setTimeout(() => {
            const payload = buildSoloResults(info);
            showPodium(payload, payload.final ? 'final' : 'round');
          }, 10000);
          const name = game?.entryById?.get(info.winnerId)?.name || '电脑';
          UI.setRaceMsg(`🏁 ${name} 已完赛 · 你仍可继续完成比赛`, 5000);
          return;
        }
        // 本地冲线：即使 AI 更早完赛，也从这一刻重新开始 10 秒观察期
        finishWindowUntil = 0;
        clearInterval(finishWindowTimer);
        armFinishUi(10);
        clearTimeout(podiumTimer);
        // Build the table when the window closes so AI finishers that arrive
        // during the ten seconds keep their real finish order.
        podiumTimer = setTimeout(() => {
          const payload = buildSoloResults(info);
          showPodium(payload, payload.final ? 'final' : 'round');
        }, 10000);
        return;
      }
      UI.setRaceMsg(`完赛！第 ${info.rank} 名 · ${UI.fmtTime(info.time)}`, 6000);
    },
  });

  // 海克斯幸运券：只在联机非排位生效，服务器校验余额 / 每局一次；
  // 收到 luckyItem 回包后由 walletPanel 调 ItemManager.grantRandomItem()
  if (!soloMode && net.connected && ticketAllowed({
    mode: roster.mode || msg.mode,
    format: roster.format || msg.format,
  })) {
    net.send({ t: 'shopUseTicket' });
  }

  // 海克斯联机：赛艇由服务器开局随机分配（order 里下发），进场播报一次自己的艇
  if (!soloMode && msg.mode === 'boss' && msg.variant === 'hex') {
    const mine = msg.order?.find((o) => o.id === myId);
    const boat = mine?.boatId ? getBoat(mine.boatId) : null;
    if (boat) setTimeout(() => UI.toast(`本局随机赛艇：${boat.name}`, 4000), 800);
  }

  input.onReset = () => game && game.respawnLocal();

  // 进比赛：引擎/水声的持续层 + 对应模式的 BGM。
  // 这里不调 unlock() —— startRace 也可能由服务器消息触发（客机开赛），
  // 用户手势那条链路由 window 上的 pointerdown/keydown 兜住。
  audio.startAmbience();
  audio.startMusic(audioMusicMode());
}

function buildSoloResults(info) {
  const rows = (game?.order || []).map((entry, index) => {
    const progress = game?.progressMap?.get(entry.id);
    const finished = Boolean(progress?.finished && progress.finishTime != null);
    return {
      id: entry.id,
      name: entry.name,
      boatId: entry.boatId,
      ai: entry.ai,
      avatar: entry.avatar || '',
      team: entry.team || null,
      rank: 0,
      time: finished ? progress.finishTime : null,
      bestLap: entry.id === myId ? (game?.bestLap ?? info.bestLap) : null,
      points: 0,
      totalScore: 0,
      dnf: !finished,
      _progress: progress?.prog ?? -1,
      _order: index,
    };
  });
  rows.sort((a, b) => {
    if (!a.dnf && !b.dnf) return a.time - b.time || a._order - b._order;
    if (!a.dnf) return -1;
    if (!b.dnf) return 1;
    return b._progress - a._progress || a._order - b._order;
  });
  rows.forEach((row, index) => {
    row.rank = index + 1;
    row.points = rows.length - index;
    row.totalScore = row.points;
    delete row._progress;
    delete row._order;
  });

  const match = soloMatch;
  // 终局成绩页用的是 standings 字段；单人练习没有服务器汇总，这里就地生成
  const standings = rows.map((r) => ({
    id: r.id,
    name: r.name,
    ai: r.ai,
    avatar: r.avatar,
    boatId: r.boatId,
    team: r.team,
    score: r.totalScore ?? r.points,
  }));
  if (!match || match.format !== 'team') return { results: rows, standings, format: 'solo' };

  // ---- 组队练习：单局队伍分 + 局胜点 ----
  const blue = rows.filter((r) => r.team === 'blue');
  const red = rows.filter((r) => r.team === 'red');
  const blueScore = blue.reduce((n, r) => n + r.points, 0);
  const redScore = red.reduce((n, r) => n + r.points, 0);
  match.teamScores.blue += blueScore;
  match.teamScores.red += redScore;
  let roundWinner;
  if (blueScore !== redScore) roundWinner = blueScore > redScore ? 'blue' : 'red';
  else {
    const bestBlue = blue.length ? Math.min(...blue.map((r) => r.rank)) : Infinity;
    const bestRed = red.length ? Math.min(...red.map((r) => r.rank)) : Infinity;
    roundWinner = bestBlue < bestRed ? 'blue' : 'red';
  }
  match.roundWins[roundWinner] += 1;
  const final = match.round >= match.rounds;
  let winnerTeam = null;
  if (final) {
    if (match.matchFormat === 'points3') {
      winnerTeam = match.teamScores.blue === match.teamScores.red
        ? (match.roundWins.blue >= match.roundWins.red ? 'blue' : 'red')
        : (match.teamScores.blue > match.teamScores.red ? 'blue' : 'red');
    } else if (match.matchFormat === 'bestOf3') {
      winnerTeam = match.roundWins.blue === match.roundWins.red
        ? (match.teamScores.blue >= match.teamScores.red ? 'blue' : 'red')
        : (match.roundWins.blue > match.roundWins.red ? 'blue' : 'red');
    } else {
      winnerTeam = roundWinner;
    }
  }
  return {
    format: 'team',
    results: rows,
    standings,
    round: match.round,
    rounds: match.rounds,
    final,
    teamNames: match.teamNames,
    matchFormat: match.matchFormat,
    teamRoundScores: { blue: blueScore, red: redScore },
    teamScores: { ...match.teamScores },
    roundWins: { ...match.roundWins },
    roundWinner,
    winnerTeam,
    teamStats: {
      blue: { hit: 0, taken: 0, rescue: 0 },
      red: { hit: 0, taken: 0, rescue: 0 },
    },
  };
}

function endRace() {
  // 离开比赛要立刻告诉服务器，否则服务器会以为这局还在跑，
  // 房间卡在 racing，所有人再点开始都只会收到"比赛正在进行中"
  if (!soloMode && net.connected) net.send({ t: 'inGame', on: false });
  if (game) {
    // 先摘引用再释放：dispose 中途抛异常时也不能留下一个半死的 game，
    // 否则后续 enterLobby / 再来一局都会卡在“空气 BOSS 还在放技能”的残局里。
    const dying = game;
    game = null;
    try {
      dying.dispose();
    } catch (err) {
      console.error('[race] 释放对局资源失败，已继续收尾', err);
    }
  }
  // 对局结束时面板一律收掉并解冻：从面板里点「退出比赛」也是走这条路径
  settingsPanel.close();
  // 持续层必须跟着对局一起收：否则退回菜单后引擎声还在响（而且没人再喂速度，
  // 会永远停在上一次的速度上）
  audio.stopDrift();
  audio.stopAmbience();
  audio.stopLoop('wave_loop', 0.6); // 大浪环境声跟着对局一起收
  audio.startMusic('menu');
  UI.hide('hud');
  refreshVoiceIcons();
  UI.setRaceMsg(null);
  UI.showBossCutscene(null);
  UI.showBossStageResult(null);
  UI.showBossEnd(null);
  clearInterval(finishWindowTimer);
  finishWindowTimer = null;
  finishWindowUntil = 0;
  stopFinishPanel();
  challengeFinishActive = false;
  if (challengeFinishKey) {
    window.removeEventListener('keydown', challengeFinishKey, true);
    challengeFinishKey = null;
  }
  clearTimeout(podiumTimer);
  podiumTimer = null;
  clearPodiumExit();
  lastHudData = null;
  UI.renderPodiumBoard(null);
  const finishEl = UI.el('finish-window-countdown');
  finishEl?.classList.remove('show');
}

function startFinishWindowCountdown(seconds = 10) {
  if (finishWindowUntil > performance.now()) return;
  finishWindowUntil = performance.now() + seconds * 1000;
  const finishEl = UI.el('finish-window-countdown');
  if (!finishEl) return;
  finishEl.classList.add('show');
  const tick = () => {
    const left = Math.max(0, finishWindowUntil - performance.now());
    finishEl.querySelector('.seconds').textContent = Math.ceil(left / 1000);
    if (left <= 0) {
      clearInterval(finishWindowTimer);
      finishWindowTimer = null;
      finishEl.classList.remove('show');
    }
  };
  clearInterval(finishWindowTimer);
  finishWindowTimer = setInterval(tick, 100);
  tick();
}

/**
 * 完赛观察期：倒计时 + 右侧成绩面板。
 * 单人/联机通用：第一个完赛者出现时启动倒计时；右侧成绩面板只给「自己已经冲线」的人看，
 * 还在跑的人只看到顶部倒计时，不摊开面板挡住赛道（以前第一个完赛者一出现所有人都被迫看成绩表）。
 * 期间只能油门/转向（Game 内已锁道具/漂移/氮气），倒计时结束进颁奖台。
 */
function armFinishUi(seconds = 10) {
  if (finishWindowUntil > performance.now()) return;
  UI.showFinishPanel(false, false);  // 普通观察期：确保不是挑战模式的面板样式
  startFinishWindowCountdown(seconds);
  clearInterval(finishPanelWatch);
  finishPanelWatch = setInterval(() => {
    if (!game) {
      stopFinishPanel();
      return;
    }
    // 只有本地玩家真的冲线了才展开右侧结算；还没跑完的人继续保持隐藏，
    // 否则成绩面板会盖住右侧赛道，直接影响他们跑完最后一段。
    if (game.finished) {
      if (!finishPanelActive) {
        finishPanelActive = true;
        UI.showFinishPanel(true);
      }
      refreshFinishPanel();
    } else if (finishPanelActive) {
      // 换局/重开导致本地又回到未完赛状态：先收面板，看护继续留着
      finishPanelActive = false;
      UI.showFinishPanel(false);
    }
    if (performance.now() >= finishWindowUntil + 250) stopFinishPanel();
  }, 160);
}

/**
 * 挑战模式完赛界面（2026-11-19）：跳过 10 秒观察期与颁奖台。
 * 保留左侧环绕镜头 + 右侧完成面板，但面板改成"本次成绩记录"（不再有排名表），
 * 面板常驻直到玩家按空格回大厅。
 */
function armChallengeFinishPanel() {
  if (challengeFinishActive) return;
  challengeFinishActive = true;
  // 不启动 finish-window 倒计时；确保普通观察期的看护/定时器都清掉
  clearInterval(finishWindowTimer);
  finishWindowTimer = null;
  clearTimeout(podiumTimer);
  podiumTimer = null;
  finishWindowUntil = 0;
  UI.el('finish-window-countdown')?.classList.remove('show');
  UI.el('hud')?.classList.remove('finish-window');

  finishPanelActive = true;
  UI.showFinishPanel(true, true);
  const paint = () => refreshChallengeFinishPanel();
  paint();
  // 成绩（影子/圈速）在完赛瞬间已定；面板内容一次写好即可，不用逐帧刷
  clearInterval(finishPanelWatch);
  finishPanelWatch = null;

  const exitToLobby = () => {
    if (!challengeFinishActive) return;
    challengeFinishActive = false;
    if (challengeFinishKey) {
      window.removeEventListener('keydown', challengeFinishKey, true);
      challengeFinishKey = null;
    }
    endRace();
    enterLobby();
  };
  challengeFinishKey = (e) => {
    if (e.repeat) return;
    if (e.code !== 'Space' && e.key !== ' ' && e.key !== 'Spacebar') return;
    e.preventDefault();
    e.stopPropagation();
    exitToLobby();
  };
  window.addEventListener('keydown', challengeFinishKey, true);
}

/** 挑战模式完成面板：只放与"自己这次跑得怎样"有关的信息 */
function refreshChallengeFinishPanel() {
  if (!game) return;
  const best = game.bestLap ?? null;
  const ghostBest = game.ghostBest0 ?? null;
  const laps = game.lapTimes || [];
  const total = game.finishTime;
  // 与影子的差值（负 = 比影子快）
  const delta = best != null && ghostBest != null ? best - ghostBest : null;
  UI.updateFinishPanel({
    rank: 1,
    name: game.myEntry?.name || '玩家',
    finished: true,
    total,
    bestLap: best,
    ghostBest,
    laps,
    standings: [],
    challenge: true,
    challengeDelta: delta,
    challengeImproved: delta != null && delta < -0.02,
  });
}

function refreshFinishPanel() {
  if (!game || !finishPanelActive) return;
  const hud = lastHudData;
  const rows = (hud?.standings || []).map((s) => {
    const p = game.progressMap?.get(s.id);
    return {
      rank: s.rank,
      name: s.name,
      isMe: s.isMe,
      finished: !!p?.finished,
      time: p?.finishTime ?? null,
      lap: Math.min(game.laps || 99, Math.max(1, p?.lap || 1)),
    };
  });
  const myRow = rows.find((r) => r.isMe);
  UI.updateFinishPanel({
    rank: myRow?.rank ?? 1,
    name: game.myEntry?.name || myRow?.name || '玩家',
    finished: !!game.finished,
    total: game.finishTime,
    bestLap: game.bestLap,
    // 幽灵最佳：结算页那一格「你比自己的最快圈快/慢多少」。
    // 用 ghostBest0（进本局之前的记录）：本局破了纪录的话 ghostRecord 已经是本局成绩，
    // 拿来对比会永远显示"打平"。
    ghostBest: game.ghostBest0 ?? null,
    laps: game.lapTimes || [],
    standings: rows,
  });
}

function stopFinishPanel() {
  clearInterval(finishPanelWatch);
  finishPanelWatch = null;
  finishPanelActive = false;
  UI.showFinishPanel(false);
}

// ---------- 结果 ----------
/**
 * 领奖台上的半透明结算板内容（竞速 / 道具模式通用）：
 * 单局 = 名次/选手/赛艇/成绩/最快圈/积分，终局 = 名次/选手/赛艇/总积分
 */
function podiumBoardData(msg, mode) {
  const medal = (i) => iconImg(['uiMedalGold', 'uiMedalSilver', 'uiMedalBronze'][i], 'medal-ico')
    || ['🥇', '🥈', '🥉'][i] || String(i + 1);
  const mapId = soloMode ? soloMapId : roster.mapId;
  const mapName = MAPS.find((m) => m.id === mapId)?.name || '';
  const laps = soloMode ? (soloLaps || 3) : (roster.settings?.laps || 3);
  const boatName = (id) => getBoat(id)?.name || '—';
  const teamMode = msg.format === 'team';
  const teamName = (t) => msg.teamNames?.[t] || (t === 'blue' ? '蓝队' : '红队');
  const matchName = MATCH_FORMATS.find((f) => f.id === (msg.matchFormat || 'single'))?.name || '单场定胜负';
  const dot = (team) => (teamMode && team
    ? `<span class="pb-team-dot" style="--c:${team === 'blue' ? '#3aa0ff' : '#ff5a5a'}"></span>`
    : '');
  if (mode === 'round') {
    const rows = (msg.results || []).map((r, i) => ({
      me: r.id === myId,
      cells: [
        medal(i),
        `<span class="pb-name">${dot(r.team)}${r.name || '玩家'}${r.ai ? '<i>AI</i>' : ''}</span>`,
        boatName(r.boatId),
        r.dnf ? '<span class="pb-dnf">未完赛</span>' : `<span class="pb-time">${UI.fmtTime(r.time)}</span>`,
        `<span class="pb-time">${r.bestLap != null ? UI.fmtTime(r.bestLap) : '—'}</span>`,
        `<span class="pb-pts">${r.points != null ? '+' + r.points : '—'}</span>`,
      ],
    }));
    const sub = teamMode
      ? `${mapName} · ${laps} 圈 · ${teamName('blue')} ${msg.teamRoundScores?.blue ?? 0} : ${msg.teamRoundScores?.red ?? 0} ${teamName('red')} · ${teamName(msg.roundWinner)} 本局胜`
      : `${mapName} · ${laps} 圈 · 前 3 名登上领奖台`;
    return {
      title: `第 ${msg.round || roster.round || 1} 局结果`,
      sub,
      grid: '46px 1fr 108px 96px 84px 62px',
      columns: ['名次', '选手', '赛艇', '成绩', '最快圈', '积分'],
      rows,
    };
  }
  // 组队终局：只按队伍排名，个人名次留在详细结算里
  if (teamMode) {
    const order = ['blue', 'red'].sort((a, b) => {
      if (msg.winnerTeam === a) return -1;
      if (msg.winnerTeam === b) return 1;
      return (msg.teamScores?.[b] || 0) - (msg.teamScores?.[a] || 0);
    });
    const rows = order.map((t, i) => ({
      me: false,
      cells: [
        medal(i),
        `<span class="pb-name">${dot(t)}${teamName(t)}</span>`,
        `${msg.roundWins?.[t] || 0} 局`,
        `<span class="pb-pts">${msg.teamScores?.[t] || 0} 分</span>`,
      ],
    }));
    const stats = msg.teamStats;
    const statsLine = stats
      ? `<br>命中 / 被击 / 救援　${teamName('blue')} ${stats.blue?.hit || 0} / ${stats.blue?.taken || 0} / ${stats.blue?.rescue || 0}　·　${teamName('red')} ${stats.red?.hit || 0} / ${stats.red?.taken || 0} / ${stats.red?.rescue || 0}`
      : '';
    return {
      title: '比赛结束 · 队伍总排名',
      sub: `${matchName} · ${teamName(msg.winnerTeam)} 获胜${statsLine}`,
      subHtml: `${matchName} · <b>${teamName(msg.winnerTeam)}</b> 获胜${statsLine}`,
      grid: '46px 1fr 84px 92px',
      columns: ['名次', '队伍', '局胜点', '总积分'],
      rows,
    };
  }
  const rows = (msg.standings || []).map((s, i) => ({
    me: s.id === myId,
    cells: [
      medal(i),
      `<span class="pb-name">${s.name || '玩家'}${s.ai ? '<i>AI</i>' : ''}</span>`,
      boatName(s.boatId),
      `<span class="pb-pts">${s.score} 分</span>`,
    ],
  }));
  return {
    title: '比赛结束 · 总排名',
    sub: `${mapName} · ${soloMode ? 1 : (roster.settings?.rounds || 1)} 局积分制`,
    grid: '46px 1fr 128px 92px',
    columns: ['名次', '选手', '赛艇', '总积分'],
    rows,
  };
}

function showPodium(msg, mode) {
  resultMode = mode;
  currentResults = msg;
  clearInterval(finishWindowTimer);
  finishWindowTimer = null;
  finishWindowUntil = 0;
  UI.el('finish-window-countdown')?.classList.remove('show');
  stopFinishPanel();
  showScreen('podium');
  const entries = getPodiumEntries(msg, mode);
  const teamMode = msg.format === 'team';
  const winTeam = mode === 'final' ? msg.winnerTeam : (msg.roundWinner || msg.winnerTeam);
  const teamLabel = msg.teamNames?.[winTeam] || (winTeam === 'blue' ? '蓝队' : '红队');
  // 结算音：站上领奖台就算赢（3 名以内），没上就是输
  audio.play(entries.some((r) => r.id === myId) ? 'win' : 'lose');
  UI.el('podium-players').innerHTML = entries.slice(0, 3).map((r, i) => (
    `<div class="podium-player">`
    + `<div class="podium-avatar">${avatarMarkup(r.avatar, r.ai, r.id)}</div>`
    + `<div class="rank">${teamMode ? (i === 0 ? `${iconImg('uiChampion', 'medal-ico') || '🏆'} ${teamLabel}` : '队员') : ['冠军', '亚军', '季军'][i]}</div>`
    + `<div class="name">${r.name || '玩家'}</div></div>`
  )).join('');
  // 领奖台上就把完整结算摊在天空里，不用等 6 秒后的结果页
  UI.renderPodiumBoard(podiumBoardData(msg, mode));
  game?.showPodium(entries, { team: teamMode });
  clearTimeout(podiumTimer);
  podiumTimer = null;
  // 右上角 10 秒倒计时：到 0 自动离开颁奖台，期间按空格立即离开
  startPodiumExit(msg, mode, 10);
}

/** 收起颁奖台的退出倒计时与空格监听（可重复调用） */
function clearPodiumExit() {
  if (podiumExitTimer) {
    clearInterval(podiumExitTimer);
    podiumExitTimer = null;
  }
  if (podiumExitKey) {
    window.removeEventListener('keydown', podiumExitKey, true);
    podiumExitKey = null;
  }
  podiumExitUntil = 0;
  UI.el('podium-exit')?.classList.remove('show');
}

/**
 * 颁奖台退出倒计时：右上角数字每秒递减，到 0 自动进入成绩页；
 * 期间按空格键立即退出（capture + stopPropagation，避免再触发驾驶键）。
 */
function startPodiumExit(msg, mode, seconds = 10) {
  clearPodiumExit();
  const box = UI.el('podium-exit');
  const count = UI.el('podium-exit-count');
  if (!box || !count) {
    podiumTimer = setTimeout(() => showDetailedResults(msg, mode), seconds * 1000);
    return;
  }
  box.classList.add('show');
  count.textContent = String(seconds);
  podiumExitUntil = performance.now() + seconds * 1000;
  const exit = () => {
    if (!podiumExitUntil) return; // 已经退出过，避免定时器与空格重复触发
    clearPodiumExit();
    showDetailedResults(msg, mode);
  };
  podiumExitTimer = setInterval(() => {
    if (!podiumExitUntil) return;
    const left = Math.max(0, podiumExitUntil - performance.now());
    count.textContent = String(Math.ceil(left / 1000));
    if (left <= 0) exit();
  }, 100);
  podiumExitKey = (e) => {
    if (e.repeat) return;
    if (e.code !== 'Space' && e.key !== ' ' && e.key !== 'Spacebar') return;
    e.preventDefault();
    e.stopPropagation();
    exit();
  };
  window.addEventListener('keydown', podiumExitKey, true);
}

function getPodiumEntries(msg, mode) {
  // 组队模式只有一个冠军台：把获胜队伍（最多 3 艘）一起放上去
  if (msg.format === 'team') {
    const winTeam = mode === 'final' ? msg.winnerTeam : (msg.roundWinner || msg.winnerTeam);
    return (msg.results || [])
      .filter((r) => r.team === winTeam)
      .slice(0, 3)
      .map((r) => ({ ...r, dnf: false }));
  }
  if (mode === 'round') {
    return (msg.results || []).filter((r) => !r.dnf && r.time != null).slice(0, 3);
  }
  // Final standings are cumulative, so use the final round's completed
  // racers as the eligibility gate while preserving total-score order.
  const completed = new Set((msg.results || [])
    .filter((r) => !r.dnf && r.time != null)
    .map((r) => r.id));
  return (msg.standings || [])
    .filter((r) => completed.has(r.id))
    .slice(0, 3)
    .map((r) => ({ ...r, dnf: false }));
}

function showDetailedResults(msg, mode) {
  clearTimeout(podiumTimer);
  podium?.dispose(); podium = null;
  endRace();
  showScreen('results');
  if (mode === 'round') {
    UI.el('results').querySelector('h2').textContent = `第 ${msg.round || roster.round || 1} 局结果`;
    setResultsHeader(true);
    UI.renderResults('results-body', msg.results || [], myId, { showPoints: true });
  } else {
    UI.el('results').querySelector('h2').textContent = '比赛结束 · 总排名';
    setResultsHeader(false, true);
    // 总排名：名次 / 选手 / 赛艇 / 总积分。奖牌用图标而不是 emoji，
    // 金底蓝绶带那枚在深紫面板上比 emoji 干净得多。
    const MEDALS = ['uiMedalGold', 'uiMedalSilver', 'uiMedalBronze'];
    UI.el('results-body').innerHTML = (msg.standings || []).map((s, i) => {
      const boat = getBoat(s.boatId);
      const medal = i < 3
        ? (iconImg(MEDALS[i], 'medal-ico') || ['🥇', '🥈', '🥉'][i])
        : `<b class="nr-num">${i + 1}</b>`;
      return `<div class="nr-row${s.id === myId ? ' me' : ''}">`
        + `<span class="nr-medal">${medal}</span>`
        + `<span class="nr-name">${escapeHtml(s.name || '玩家')}${s.ai ? '<i class="nr-ai">AI</i>' : ''}</span>`
        + `<span class="nr-boat">${escapeHtml(boat ? boat.name : '—')}</span>`
        + `<span class="nr-score">${s.score ?? 0} 分</span>`
        + '</div>';
    }).join('');
  }
  const btn = UI.el('btn-back-lobby');
  btn.classList.toggle('hidden', false);
  const canNextSolo = soloMode && mode === 'round'
    && soloMatch?.format === 'team' && soloMatch.round < soloMatch.rounds;
  // 挑战模式结算：直接给「再挑战一次」，不用回大厅再点两次 —— 这个模式的心智
  // 就是"一圈一圈刷影子"，结算页挡在中间会打断节奏。
  const challengeResult = soloMode && soloModeMode === 'challenge';
  // 单人练习没有服务器可以发 nextRound：多局制就本地开下一局，否则回大厅
  btn.textContent = canNextSolo
    ? '开始下一局'
    : challengeResult
      ? '再挑战一次 · 刷新影子'
      : soloMode
        ? '返回大厅'
        : mode === 'round'
          ? (myId === hostId ? '开始下一局' : '等待房主开始下一局')
          : (myId === hostId ? '再来一局' : '等待房主选择地图');
  btn.disabled = soloMode ? false : myId !== hostId;
  // 「退出」现在是面板里的固定小按钮（见 index.html），不用再动态插
  UI.el('btn-exit-results')?.classList.remove('hidden');
}

function showRoundResults(msg) {
  showPodium(msg, 'round'); return;
  endRace();
  resultMode = 'round';
  currentResults = msg;
  showScreen('results');
  UI.el('results').querySelector('h2').textContent = `第 ${msg.round || 1} 局结果`;
  setResultsHeader(true);
  UI.renderResults('results-body', msg.results, myId, { showPoints: true });
  const isHostNow = myId === hostId;
  const btn = UI.el('btn-back-lobby');
  btn.classList.toggle('hidden', !isHostNow);
  btn.textContent = isHostNow ? '开始下一局' : '等待主机开始下一局…';
  btn.disabled = !isHostNow;
}

function showFinalResults(msg) {
  showPodium(msg, 'final'); return;
  endRace();
  resultMode = 'final';
  currentResults = msg;
  showScreen('results');
  UI.el('results').querySelector('h2').textContent = '比赛结束 · 总排名';
  setResultsHeader(false, true);
  // 总积分榜
  const body = UI.el('results-body');
  body.innerHTML = '';
  const MEDALS = [
    iconImg('uiMedalGold', 'medal-ico') || '🥇',
    iconImg('uiMedalSilver', 'medal-ico') || '🥈',
    iconImg('uiMedalBronze', 'medal-ico') || '🥉',
  ];
  msg.standings.forEach((s, i) => {
    const tr = document.createElement('tr');
    if (s.id === myId) tr.className = 'me';
    const boat = getBoat(s.boatId);
    tr.innerHTML = `
      <td class="medal">${i < 3 ? MEDALS[i] : i + 1}</td>
      <td>${s.name}${s.ai ? ' <span style="font-size:11px;color:#8fb6d4">AI</span>' : ''}</td>
      <td>${boat ? boat.name : '—'}</td>
      <td colspan="2" style="color:#ffd97a;font-weight:bold">${s.score} 分</td>
    `;
    body.appendChild(tr);
  });
  const btn = UI.el('btn-back-lobby');
  btn.classList.toggle('hidden', false);
  btn.textContent = myId === hostId ? '返回大厅' : '等待主机返回大厅…';
  btn.disabled = myId !== hostId;
}

/**
 * 结算面板列头 + 列宽。
 * 面板已经是 CSS Grid 不是 table，列宽写在 --nr-grid 上，表头和数据行共用同一条轨道，
 * 所以这里必须和数据行成对出现（单局 6 列 / 总排名 4 列）。
 */
function setResultsHeader(showPoints, scoreOnly = false) {
  const panel = UI.el('results');
  const cols = UI.el('results-cols');
  if (!panel || !cols) return;
  const columns = scoreOnly
    ? ['', '选手', '赛艇', '总积分']
    : ['名次', '选手', '赛艇', '成绩', '最快圈'].concat(showPoints ? ['积分'] : []);
  const grid = scoreOnly
    ? '48px minmax(110px, 1fr) 148px 104px'
    : (showPoints
      ? '48px minmax(110px, 1fr) 116px 92px 84px 72px'
      : '48px minmax(110px, 1fr) 116px 92px 84px');
  panel.style.setProperty('--nr-grid', grid);
  // 列多（单局 6 列）就不摆斜杠分隔了，不然字会挤成一团
  cols.classList.toggle('many', columns.length > 4);
  cols.innerHTML = columns.map((c, i) => {
    const cls = [i === 0 ? 'c-first' : i === 1 ? 'c-name' : i === columns.length - 1 ? 'c-last' : 'c-mid'];
    // 上一个是空列（总排名的「名次」）时，别再补一个斜杠到它左边
    if (i > 0 && !columns[i - 1]) cls.push('no-sep');
    return `<span class="${cls.join(' ')}">${c}</span>`;
  }).join('');
}

UI.el('btn-boss-lobby').onclick = () => {
  // 先收起结算面板：即使后面释放对局出错，点击也必须有可见反馈
  UI.hide('boss-end');
  UI.showHexEndless(null);
  try {
    endRace();
  } catch (err) {
    console.error('[boss-end] 释放对局失败，继续返回大厅', err);
  }
  if (soloMode) {
    exitSoloToMenu();
  } else {
    // 和竞速的"返回大厅"一致：房主先回大厅，服务器 lobbyReset 再带所有人回来
    if (myId === hostId) net.send({ t: 'backLobby' });
    enterLobby();
  }
};

// 海克斯无尽：继续挑战 / 结束领奖（联机只有房主的点击会生效，客机按钮已置灰）
UI.el('he-go').onclick = () => game?.chooseEndless?.(true);
UI.el('he-stop').onclick = () => game?.chooseEndless?.(false);

// 结算页「退出」：单人回主菜单，联机回到房间（不再断线退到主界面）
UI.el('btn-exit-results').onclick = () => {
  endRace();
  if (soloMode && !net.connected) { voice.reset(); exitSoloToMenu(); return; }
  if (myId === hostId && net.connected) net.send({ t: 'backLobby' });
  enterLobby();
};

UI.el('btn-back-lobby').onclick = () => {
  if (soloMode) {
    // 挑战模式：直接重开同一张图 / 同一条船，影子用最新存档（刚破的纪录）
    if (soloModeMode === 'challenge') {
      soloMatch = null;
      UI.hide('results');
      startSoloRace();
      return;
    }
    const canNext = resultMode === 'round'
      && soloMatch?.format === 'team' && soloMatch.round < soloMatch.rounds;
    if (canNext) {
      // 本地多局制：不经过服务器，直接用同一份 soloMatch 累计分数
      UI.hide('results');
      startSoloRace({ continueMatch: true });
      return;
    }
    // 单人练习：本地桩网络没人处理 nextRound，直接回大厅重新配下一局
    soloMatch = null;
    UI.hide('results');
    enterLobby();
    return;
  }
  if (resultMode === 'round') {
    net.send({ t: 'nextRound' });
    UI.hide('results');
  } else {
    if (myId !== hostId) return;
    // 房主本地立刻回大厅；服务器收到 backLobby 后会广播 lobbyReset，
    // 把所有客人也一起带回大厅（并释放上一局的选艇 / 清掉 AI）
    endRace();
    enterLobby();
    net.send({ t: 'backLobby' });
  }
};

// ---------- 网络事件 ----------
net.on('welcome', (e) => {
  const msg = e.detail;
  myId = msg.id;
  hostId = msg.hostId;
  voice.handleWelcome(msg);
  // 重连后服务端已把 voiceOn 清掉，重新宣告并重建语音连接
  voice.resume();
  lanIps = msg.lanIps || [];
  roster = {
    players: msg.players || [],
    settings: msg.settings || roster.settings,
    format: msg.format || 'solo',
    teams: msg.teams || {},
    teamNames: msg.teamNames || { blue: '蓝队', red: '红队' },
    mapId: msg.mapId,
    weather: msg.weather || 'day',
    mode: msg.mode || 'race',
    phase: msg.phase || 'lobby',
    round: msg.round || 0,
    raceSeq: msg.raceSeq || 0,
  };
  lastRaceSeq = Math.max(lastRaceSeq, msg.raceSeq || 0);
  // welcome 自组名单、不走 roster 处理器：这里同步播种「上一份名单」，
  // 否则迎宾 diff 永远拿不到前值、后来的人进房不会弹欢迎
  prevRosterPlayers = roster.players;
  // 自己加入房间时也弹一次欢迎（主机 / 客机 / 贵宾本人一视同仁）
  if (!soloMode && !game) pendingSelfWelcome = true;
  // 重连续座：先把服务器已经确认的选艇记下来，选艇看护就不会误判成"没同步上"
  confirmedBoatId = (msg.players || []).find((p) => p.id === msg.id)?.boatId || null;
  // 刷新出来的新页面没有比赛实例：明确上报"我不在比赛里"，
  // 服务器据此把刷新前遗留的 racing 僵尸局作废回大厅（这就是反复刷新后
  // 再点开始提示"比赛正在进行中"的根因）。
  // 断线重连但比赛实例还在时反过来上报 true，避免刚连回来的瞬间
  // 被服务器/房主当成"已退赛"而把整局拆掉。
  if (!soloMode && net.connected) net.send({ t: 'inGame', on: !!game });
});

// ---- 大厅迎宾横幅：欢迎 / 离开 ----
// 挂在展示台上沿（.lobby-stage 里的 #lobby-welcome），4 秒淡出。
// 欢迎金色、离开灰木色；一次只显示一条，新的顶掉旧的。
let prevRosterPlayers = [];
let stageNoticeTimer = 0;
// 自己刚进房时也要看到欢迎横幅（以前只 diff 别人的名单，贵宾本人永远看不到）
let pendingSelfWelcome = false;
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ESC_MAP[c]);
}
// 名字单独渲染成炫彩加粗，其余文字保持普通欢迎语
function welcomeNoticeHtml(name) {
  return `欢迎「<b class="vip-name">${escapeHtml(name)}</b>」贵宾进入房间`;
}
function flushSelfWelcome() {
  if (!pendingSelfWelcome) return;
  const lobby = UI.el('lobby');
  if (!lobby || lobby.classList.contains('hidden')) return;
  pendingSelfWelcome = false;
  const me = roster.players?.find((p) => p.id === myId);
  showStageNotice(welcomeNoticeHtml(me?.name || getMyName()));
}
function showStageNotice(text, bye = false) {
  const el = UI.el('lobby-welcome');
  const lobby = UI.el('lobby');
  if (!el || !lobby || lobby.classList.contains('hidden')) return;
  el.innerHTML = text;
  el.classList.toggle('bye', bye);
  el.classList.remove('hidden');
  // 重启动画：先摘掉 show，强制回流后再加回去
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
  clearTimeout(stageNoticeTimer);
  stageNoticeTimer = setTimeout(() => el.classList.remove('show'), 4000);
}

net.on('roster', (e) => {
  const msg = e.detail;
  // 迎宾：对比上一份名单找出新进来的真人（AI 和自己不欢迎；
  // 首份名单 prev 为空 → 自己刚进房那一次天然不弹）。
  // 断线重连的玩家一直在名单里（只挂 offline 标记），不会被误欢迎。
  if (prevRosterPlayers.length) {
    const prevIds = new Set(prevRosterPlayers.map((p) => p.id));
    const newbie = msg.players.find((p) => !prevIds.has(p.id) && !p.ai && p.id !== myId);
    if (newbie) showStageNotice(welcomeNoticeHtml(newbie.name || newbie.id));
  }
  prevRosterPlayers = msg.players;
  roster = msg;
  hostId = msg.hostId;
  voice.handleRoster(msg.players || []);
  // P0 之后的服务端才会下发 format / teams。旧进程没重启时，客户端先乐观显示组队，
  // 下一条 roster 一到就会"跳回个人"——这里明确提示，避免被误判成赛制自己乱改。
  if (msg.format === undefined && !staleServerWarned) {
    staleServerWarned = true;
    UI.toast('服务端版本过旧：组队数据没同步，请重启服务器（node server/server.js）');
  }
  // 屏幕刷新
  const visible = (id) => !UI.el(id).classList.contains('hidden');
  // 选艇状态以服务器为准：服务器清了（上一局结束）本地也必须清，
  // 只有"刚点完还在等回执"的那 1.5s 例外，免得自己的点击被别人的名单冲掉
  const me = roster.players.find((p) => p.id === myId);
  if (me) {
    const serverBoat = me.boatId || null;
    // 只认服务器下发的选艇结果，供选艇看护判断"到底同步上没有"
    confirmedBoatId = serverBoat;
    const pendingFresh = pickPending.id && Date.now() - pickPending.at < 1500
      && serverBoat !== pickPending.id;
    if (!pendingFresh && serverBoat !== myBoatId) {
      myBoatId = serverBoat;
      if (visible('menu-boat')) refreshBoatList();
    }
    if (serverBoat === pickPending.id) pickPending = { id: null, at: 0 };
  }
  if (visible('menu-boat')) {
    // 合并屏：客人跟着主机的地图走（不重渲染整条列表，免得滚动位置被重置）
    const rail = document.querySelector('.vs-right');
    if (rail) rail.classList.toggle('locked', !canPickMap());
    const go = UI.el('btn-map-ok');
    if (go) go.textContent = soloMode || myId === hostId ? '确认出战' : '进入大厅';
    if (!canPickMap() && roster.mapId) UI.renderMapList(roster.mapId, () => {});
    // 主机把模式切到怪物模式时，客人这边也要出现头像入口
    refreshAvatarChip();
  }
  if (visible('lobby')) renderLobbyNow();
});

// 选艇回执：服务器明确答复"这一艘能不能用"。
// 被否决时必须立刻收回本地乐观选择，不能等看护计时器——
// 否则本地一直显示已选、服务器却认为没选，房主点开始就反复提示"还没选赛艇"，
// 客人看到的就是"我明明选好了 / 准备了，主机却说我得重新选"。
net.on('pickResult', (e) => {
  const msg = e.detail;
  const inLobby = !soloMode && !UI.el('lobby').classList.contains('hidden');
  if (msg.boatId == null) {
    // 服务器在"开赛被没选艇挡下"时补发的无条件否决
    clearTimeout(pickCheckTimer);
    pickPending = { id: null, at: 0 };
    myBoatId = confirmedBoatId;
    if (lobbyPickKind === 'boat') renderLobbyPick();
    if (inLobby) renderLobbyNow();
    return;
  }
  if (msg.ok) {
    confirmedBoatId = msg.boatId;
    if (pickPending.id === msg.boatId) pickPending = { id: null, at: 0 };
    clearTimeout(pickCheckTimer);
    return;
  }
  if (pickPending.id !== msg.boatId) return;
  clearTimeout(pickCheckTimer);
  pickPending = { id: null, at: 0 };
  myBoatId = confirmedBoatId;
  if (lobbyPickKind === 'boat') renderLobbyPick();
  if (inLobby) renderLobbyNow();
});

net.on('start', (e) => {
  const msg = e.detail;
  // 重复 / 过期的 start 一律忽略：否则会开出第二把、旧的一把还在跑
  if (msg.raceSeq && msg.raceSeq <= lastRaceSeq && game) return;
  startRace(msg);
});

// 房主回大厅：所有人一起回到大厅（以前只有房主自己换屏，其他人干瞪着结果页）
net.on('lobbyReset', () => {
  if (soloMode) return;
  clearTimeout(podiumTimer);
  endRace();
  podium?.dispose(); podium = null;
  resultMode = null;
  currentResults = null;
  myBoatId = null;
  pickPending = { id: null, at: 0 };
  confirmedBoatId = null;
  clearTimeout(pickCheckTimer);
  enterLobby();
  UI.toast('已回到大厅 · 重新选艇并准备下一局');
});

net.on('roundEnd', (e) => {
  const msg = e.detail;
  // 局号以服务器下发的为准：roster 在开赛时不会重发，里面的 round 还停在 0，
  // 以前用它拼标题会变成"第  局结果"
  const roundNo = msg.round ?? roster.round ?? 1;
  showRoundResults({ ...msg, round: roundNo });
  UI.el('results').querySelector('h2').textContent = `第 ${roundNo} 局结果`;
});

net.on('raceEnd', (e) => showFinalResults(e.detail));

net.on('finish', (e) => {
  const msg = e.detail;
  if (game) armFinishUi(msg.finishWindowSeconds || 10);
  if (msg.id !== myId && game) {
    const entry = game.order ? game.order.find((o) => o.id === msg.id) : null;
    if (entry) UI.setRaceMsg(`${entry.name} 完赛！`, 2000);
  }
});

net.on('toast', (e) => UI.toast(e.detail.msg));

// 聊天：服务器转发其他玩家的消息，按当前界面落到大厅列表或比赛内气泡
net.on('chat', (e) => chat.receive(e.detail));

// 线上语音信令：服务器只按 id 定向转发，WebRTC 连接由 VoiceManager 自己维护
net.on('voiceState', (e) => voice.handleState(e.detail));
net.on('voiceSignal', (e) => voice.handleSignal(e.detail));

net.on('left', (e) => {
  voice.handleLeft(e.detail?.id);
  // 大厅里有人退房：灰色横幅提示（此刻名单还没更新，还能查到他的名字）
  const gone = roster.players?.find((p) => p.id === e.detail.id);
  if (gone && !gone.ai) showStageNotice(`${escapeHtml(gone.name || gone.id)} 离开了房间`, true);
  if (game) {
    const entry = game.order ? game.order.find((o) => o.id === e.detail.id) : null;
    if (entry) UI.setRaceMsg(`${entry.name} 掉线了`, 2000);
  }
});

// 短暂抖动：先自动重连，别急着把玩家从比赛里踢出去
net.on('reconnecting', () => {
  netLink = 'reconnecting';
  refreshNetBadge();
  // 语音连接绑定在旧 WebSocket 上，重连后必须重新建；麦克风先关掉最干净。
  voice.reset();
  if (soloMode) return;
  UI.toast('网络波动，正在自动重连…');
});

net.on('reconnected', () => {
  netLink = 'ok';
  refreshNetBadge();
  if (soloMode) return;
  UI.toast('已重新连接');
  if (game) {
    // 断线那几秒漏发的过门/冲线补报一次，否则名次和结算会永久停在断线点
    game.resyncProgress();
    return; // 比赛中重连：画面继续，快照会自动续上
  }
  const lost = !UI.el('connection-lost').classList.contains('hidden');
  const atMenu = !UI.el('menu-main').classList.contains('hidden');
  if (lost || atMenu) enterLobby();
  else if (!UI.el('lobby').classList.contains('hidden')) renderLobbyNow();
});

// 重试到底仍连不上才算真掉线
net.on('disconnect', (e) => {
  if (!e.detail?.lost) return;
  netLink = 'lost';
  refreshNetBadge();
  voice.reset();
  voice.setAllowed(false);
  endRace();
  showScreen('connection-lost');
});

UI.el('btn-reconnect').onclick = () => {
  location.reload();
};

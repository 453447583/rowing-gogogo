// 线上联机语音（WebRTC MVP）
//
// 设计边界：
//   1. 只服务 NetClient.mode === 'online' 的 Render 同源 /ws 连接；局域网入口不启用。
//   2. 服务器只帮忙递 offer / answer / ICE candidate，不碰音频流，所以 Render 不付语音流量费。
//   3. 小房间用 Mesh P2P：两个人直连；4 人也够。人数多起来要换 SFU（LiveKit 那类）。
//   4. 当前只用公共 STUN。少数对称 NAT / 企业网络会连不上，那时再加 TURN。
//
// 「谁先打电话」用玩家 id 字典序决定，避免双方同时发 offer 的 glare：
// id 小的那方发 offer，id 大的那方等着 answer。

const DEFAULT_ICE_SERVERS = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
];

function iceServers() {
  // 预留给后续 TURN：部署时不改源码，只要在页面加载前塞 window.__VOICE_ICE_SERVERS__。
  if (typeof window !== 'undefined' && Array.isArray(window.__VOICE_ICE_SERVERS__)) {
    return window.__VOICE_ICE_SERVERS__;
  }
  return DEFAULT_ICE_SERVERS;
}

function voiceError(err) {
  const msg = String(err?.message || err || '未知错误');
  if (/NotAllowed|Permission/i.test(msg)) return '麦克风权限被拒绝，请在浏览器地址栏允许麦克风';
  if (/NotFound|Devices/i.test(msg)) return '没找到麦克风设备';
  if (/NotReadable/i.test(msg)) return '麦克风被其它程序占用';
  return msg;
}

export class VoiceManager {
  constructor({ send = () => {}, onState = () => {}, onLevels = () => {} } = {}) {
    this.send = send;
    this.onState = onState;
    this.onLevels = onLevels;
    this.allowed = false;      // 只有线上联机才允许开麦
    this.enabled = false;      // 本地麦克风是否已打开
    this.busy = false;
    this.myId = null;
    this.state = 'off';        // off | connecting | on | error
    this.detail = '';
    this.localStream = null;
    this.peerIds = new Set();  // 房间里已开麦的其他玩家
    this.pcs = new Map();      // id -> { pc, initiator, makingOffer }
    this.audios = new Map();   // id -> HTMLAudioElement
    this.pendingCandidates = new Map(); // id -> RTCIceCandidateInit[]
    // 网游式语音 UI：每个人一个音量等级 + 本地静音开关
    this.levels = new Map();   // id -> 0..1 的说话音量
    this.mutedPeers = new Set(); // 本地静音了谁（点别人的喇叭用）
    this.audioCtx = null;
    this.meters = new Map();   // id -> { source, analyser, gain, data }
    this.levelTimer = null;
  }

  setAllowed(allowed) {
    this.allowed = !!allowed;
    if (!this.allowed && this.enabled) this.#hardStop(false);
    this.#emitState();
  }

  setMyId(id) {
    this.myId = id || null;
  }

  handleWelcome(msg) {
    this.setMyId(msg?.id);
    this.handleRoster(msg?.players || []);
  }

  /** roster 里的 voiceOn 由服务端按「线上 + 已开麦」生成，LAN 玩家永远是 false */
  handleRoster(players) {
    const next = new Set();
    for (const p of players || []) {
      if (!p || p.ai || p.offline || p.id === this.myId) continue;
      if (p.voiceOn) next.add(p.id);
    }
    this.peerIds = next;
    for (const id of [...this.pcs.keys()]) {
      if (!next.has(id)) this.#closePeer(id);
    }
    this.#syncConnections();
  }

  handleState(msg) {
    const id = msg?.id;
    if (!id || id === this.myId) return;
    if (msg.on) {
      if (!this.allowed) return;
      this.peerIds.add(id);
    } else {
      this.peerIds.delete(id);
      this.#closePeer(id);
    }
    this.#syncConnections();
  }

  handleLeft(id) {
    if (!id) return;
    this.peerIds.delete(id);
    this.#closePeer(id);
  }

  async handleSignal(msg) {
    const from = msg?.from;
    const data = msg?.data;
    if (!from || from === this.myId || !data || !this.enabled) return;
    const kind = String(data.kind || '');
    try {
      if (kind === 'offer') {
        const { pc } = this.#ensurePc(from, false);
        await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
        await this.#flushCandidates(from, pc);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.#sendSignal(from, { kind: 'answer', sdp: pc.localDescription.sdp });
      } else if (kind === 'answer') {
        const { pc } = this.#ensurePc(from, false);
        // answer 是回给"已经发过 offer"那一方的：此时 signalingState 必须是 have-local-offer。
        // 旧判断写成 remoteDescription?.type === 'offer'，那是接offer方的状态，
        // 结果发起方永远收不到 answer，ICE 一直卡在 checking。
        if (pc.signalingState === 'have-local-offer') {
          await pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
        }
        await this.#flushCandidates(from, pc);
      } else if (kind === 'candidate' && data.candidate) {
        const { pc } = this.#ensurePc(from, false);
        const cand = data.candidate;
        if (!pc.remoteDescription) {
          const list = this.pendingCandidates.get(from) || [];
          list.push(cand);
          this.pendingCandidates.set(from, list);
          return;
        }
        await pc.addIceCandidate(cand);
      }
    } catch (err) {
      console.warn('[voice] 处理信令失败', kind, from, err);
    }
  }

  async toggle() {
    if (this.enabled) { this.disable(); return; }
    try { await this.enable(); }
    catch (err) { this.#setState('error', voiceError(err)); }
  }

  async enable() {
    if (!this.allowed) throw new Error('语音只在联机对战里可用');
    if (this.enabled || this.busy) return;
    const Ctor = typeof window !== 'undefined' ? window.RTCPeerConnection : null;
    if (!Ctor || !navigator.mediaDevices?.getUserMedia) throw new Error('当前浏览器不支持语音');
    if (typeof window !== 'undefined' && window.isSecureContext === false) {
      throw new Error('当前页面不是安全环境，麦克风不可用');
    }
    this.busy = true;
    this.#setState('connecting', '正在获取麦克风');
    let stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      if (!this.allowed) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      this.localStream = stream;
      this.enabled = true;
      this.#attachMeter(this.myId, stream);
      this.send({ t: 'voiceState', on: true });
      this.#setState('on', '');
      this.#syncConnections();
    } catch (err) {
      if (stream) stream.getTracks().forEach((t) => t.stop());
      this.#hardStop(false);
      throw err;
    } finally {
      this.busy = false;
    }
  }

  /** 主动关麦：先通知服务器，再拆本地资源 */
  disable() {
    if (!this.enabled) { this.#hardStop(false); return; }
    this.send({ t: 'voiceState', on: false });
    this.#hardStop(false);
  }

  /** 断线 / 回主页 / 切模式：服务器可能已经收不到消息，直接本地清理 */
  reset() {
    this.#hardStop(false);
  }

  get isEnabled() { return this.enabled; }

  /** 点别人的喇叭 = 本地静音 / 取消静音；点自己的由 toggle() 负责开麦关麦 */
  togglePeerMute(id) {
    if (!id || id === this.myId) return;
    if (this.mutedPeers.has(id)) this.mutedPeers.delete(id);
    else this.mutedPeers.add(id);
    const audio = this.audios.get(id);
    if (audio) audio.muted = this.mutedPeers.has(id);
    this.#emitLevels();
  }

  // ---------- 内部 ----------

  #emitLevels() {
    this.onLevels?.({
      levels: new Map(this.levels),
      muted: new Set(this.mutedPeers),
    });
  }

  #ensureAudioCtx() {
    if (typeof window === 'undefined') return null;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    if (!this.audioCtx) this.audioCtx = new Ctx();
    if (this.audioCtx.state === 'suspended') this.audioCtx.resume().catch(() => {});
    return this.audioCtx;
  }

  /** 用 AnalyserNode 量音量：只接到 0 音量的 gain，不会把声音重复播一遍 */
  #attachMeter(id, stream) {
    if (!id || !stream || !stream.getAudioTracks?.().length || this.meters.has(id)) return;
    const ctx = this.#ensureAudioCtx();
    if (!ctx) return;
    try {
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.45;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      source.connect(analyser);
      analyser.connect(gain);
      gain.connect(ctx.destination);
      this.meters.set(id, {
        source, analyser, gain,
        data: new Uint8Array(analyser.frequencyBinCount),
      });
      this.#startLevelLoop();
    } catch { /* 某些浏览器不支持 MediaStreamAudioSourceNode，忽略音量格即可 */ }
  }

  #stopMeter(id) {
    const m = this.meters.get(id);
    if (!m) return;
    try { m.source.disconnect(); m.analyser.disconnect(); m.gain.disconnect(); } catch { /* 已断 */ }
    this.meters.delete(id);
    this.levels.delete(id);
  }

  #startLevelLoop() {
    if (this.levelTimer) return;
    this.levelTimer = setInterval(() => {
      for (const [id, m] of this.meters) {
        m.analyser.getByteTimeDomainData(m.data);
        let sum = 0;
        for (let i = 0; i < m.data.length; i++) {
          const x = (m.data[i] - 128) / 128;
          sum += x * x;
        }
        const rms = Math.sqrt(sum / m.data.length);
        // 说话声通常 rms 0.02~0.2；乘 6 后映射到 0..1，安静时保持 0 不亮格。
        this.levels.set(id, Math.min(1, rms * 6));
      }
      for (const id of [...this.levels.keys()]) {
        if (!this.meters.has(id)) this.levels.delete(id);
      }
      this.#emitLevels();
    }, 100);
  }

  #stopLevelLoop() {
    if (this.levelTimer) {
      clearInterval(this.levelTimer);
      this.levelTimer = null;
    }
    this.levels.clear();
    this.#emitLevels();
  }

  #emitState() {
    this.onState?.({ state: this.state, detail: this.detail, enabled: this.enabled });
  }

  #setState(state, detail = '') {
    this.state = state;
    this.detail = detail;
    this.#emitState();
  }

  #hardStop(notifyServer) {
    const wasEnabled = this.enabled;
    this.enabled = false;
    this.busy = false;
    if (notifyServer && wasEnabled) this.send({ t: 'voiceState', on: false });
    this.#stopLevelLoop();
    for (const id of [...this.pcs.keys()]) this.#closePeer(id);
    this.#stopMeter(this.myId);
    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => t.stop());
      this.localStream = null;
    }
    this.peerIds.clear();
    this.pendingCandidates.clear();
    this.mutedPeers.clear();
    this.#emitLevels();
    this.#setState('off', '');
  }

  #sendSignal(to, data) {
    if (!this.enabled || !to) return;
    this.send({ t: 'voiceSignal', to, data });
  }

  #ensurePc(id, initiator) {
    const found = this.pcs.get(id);
    if (found) return found;
    const pc = new window.RTCPeerConnection({ iceServers: iceServers(), bundlePolicy: 'max-bundle' });
    const rec = { pc, initiator, makingOffer: false };
    this.pcs.set(id, rec);

    for (const track of this.localStream?.getTracks() || []) {
      pc.addTrack(track, this.localStream);
    }

    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      const c = e.candidate;
      this.#sendSignal(id, {
        kind: 'candidate',
        candidate: {
          candidate: c.candidate,
          sdpMid: c.sdpMid,
          sdpMLineIndex: c.sdpMLineIndex,
        },
      });
    };

    pc.ontrack = (e) => {
      let audio = this.audios.get(id);
      if (!audio) {
        audio = document.createElement('audio');
        audio.autoplay = true;
        audio.playsInline = true;
        audio.dataset.voicePeer = id;
        document.body.appendChild(audio);
        this.audios.set(id, audio);
      }
      const stream = e.streams?.[0] || new MediaStream([e.track]);
      audio.srcObject = stream;
      audio.muted = this.mutedPeers.has(id);
      audio.play().catch(() => { /* 浏览器可能拦自动播放；用户点过开麦后通常会放行 */ });
      this.#attachMeter(id, stream);
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' && typeof pc.restartIce === 'function') {
        try { pc.restartIce(); } catch { /* 下一次 roster 变化会重建 */ }
      }
    };

    if (initiator) this.#makeOffer(id, rec);
    return rec;
  }

  async #makeOffer(id, rec) {
    if (rec.makingOffer || rec.pc.signalingState !== 'stable') return;
    rec.makingOffer = true;
    try {
      const offer = await rec.pc.createOffer();
      await rec.pc.setLocalDescription(offer);
      this.#sendSignal(id, { kind: 'offer', sdp: rec.pc.localDescription.sdp });
    } catch (err) {
      console.warn('[voice] 创建 offer 失败', id, err);
    } finally {
      rec.makingOffer = false;
    }
  }

  async #flushCandidates(id, pc) {
    const list = this.pendingCandidates.get(id);
    if (!list?.length) return;
    this.pendingCandidates.delete(id);
    for (const c of list) {
      try { await pc.addIceCandidate(c); } catch { /* 过期候选直接丢 */ }
    }
  }

  #closePeer(id) {
    const rec = this.pcs.get(id);
    if (rec) {
      try { rec.pc.close(); } catch { /* 已关 */ }
      this.pcs.delete(id);
    }
    const audio = this.audios.get(id);
    if (audio) {
      try { audio.pause(); audio.srcObject = null; audio.remove(); } catch { /* 已移除 */ }
      this.audios.delete(id);
    }
    this.pendingCandidates.delete(id);
    this.#stopMeter(id);
    this.mutedPeers.delete(id);
    this.levels.delete(id);
    this.#emitLevels();
  }

  #syncConnections() {
    if (!this.enabled || !this.localStream) return;
    for (const id of this.peerIds) {
      // 字典序小的发起 offer；大的也建一个被动连接，等对方来电。
      const initiator = !!this.myId && this.myId < id;
      this.#ensurePc(id, initiator);
    }
    for (const id of [...this.pcs.keys()]) {
      if (!this.peerIds.has(id)) this.#closePeer(id);
    }
  }
}

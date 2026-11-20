// 音频引擎：BGM 与音效（SFX）使用 wav 采样，持续层（引擎/水声/漂移）仍走 WebAudio 合成。
//
// 音效策略：
//   ① `music/` 里提供的 63 个 wav 复制到 `public/audio/sfx/`，按 key 对应（文件名即 key）；
//   ② 首个用户手势 unlock() 后异步预加载，播放时优先用采样；
//   ③ 采样缺失/解码失败的名字回落到下面的合成表（UI 点击、倒计时、胜负等仍为合成）；
//   ④ 氮气 / 墨汁 / 漩涡三个持续音走 startLoop / stopLoop。
//
// 持续层（引擎/水声/漂移）继续用合成，因为要跟速度、集气量连续变化。
//
// 结构：
//   master ─┬─ music    （程序化 BGM，按模式换和弦与鼓点）
//           ├─ sfx      （道具 / 技能 / UI 一次性音效）
//           └─ ambience （水声、引擎、漂移的持续层）
//
// 所有一次性音效走的都是"临时节点 + 自动 disconnect"，没有对象池也不会泄漏。
// 持续层（引擎/水声/漂移）常驻 4~6 个节点，每帧只改 gain/filter，不新建节点。

const AC = () => window.AudioContext || window.webkitAudioContext;

/** 简谱式音高：semitones 相对 A4=440 */
const hz = (semi) => 440 * Math.pow(2, semi / 12);

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.buses = null;
    this.noiseBuf = null;
    this.vol = { master: 0.8, music: 0.5, sfx: 0.9, ambience: 0.6 };
    this.muted = false;
    this.music = null;
    this.musicToken = 0;
    this.sampleBuffers = new Map(); // 采样 BGM 解码缓存（url → AudioBuffer）
    this.sfxBuffers = new Map();    // 采样音效解码缓存（key → AudioBuffer）
    this.sfxLoading = null;
    this.sfxLoops = new Map();      // 正在播放的循环音效（key → { src, g }）
    this.loops = { engine: null, water: null, drift: null };
    this.lastPlay = new Map(); // 同名音效节流（同一帧被多个来源触发时不要叠成噪音）
    // 单次播放的音量倍率 / 左右声道，由 play(name,{vol,pan}) 临时设置、同步恢复。
    // 道具赛的「来袭预警 / 受击音」靠它做听声辨位；不带 pan 的音效仍是全屏均匀音量。
    this._sfxMod = { vol: 1, pan: 0 };

    // 音效表写在模块顶层（不在类体里），而 #private 只能类内访问，
    // 所以在这里把三个合成基元包成实例上的公开函数，音效表就能写成 a.tone(...)。
    // 用构造函数里建一次箭头函数，避免每次播放都 new 一个门面对象。
    this.tone = (o) => this.#tone(o);
    this.noise = (o) => this.#noiseBurst(o);
    this.arp = (s, o) => this.#arp(s, o);
  }

  /** 首次用户手势后调用；重复调用安全 */
  unlock() {
    if (this.ready) {
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return;
    }
    const Ctor = AC();
    if (!Ctor) return; // 老浏览器/被禁用：整个引擎静默降级
    try {
      this.ctx = new Ctor();
    } catch {
      return;
    }
    const ctx = this.ctx;
    const master = ctx.createGain();
    master.gain.value = this.muted ? 0 : this.vol.master;
    master.connect(ctx.destination);

    const mk = (v) => {
      const g = ctx.createGain();
      g.gain.value = v;
      g.connect(master);
      return g;
    };
    this.buses = {
      master,
      music: mk(this.vol.music),
      sfx: mk(this.vol.sfx),
      ambience: mk(this.vol.ambience),
    };
    this.noiseBuf = this.#makeNoise(2.0);
    this.ready = true;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    // 采样音效异步预加载：不阻塞首个手势，加载完成前播放会回落到合成
    this.loadSfx();
  }

  get t() {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  /** 有没有为这个名字配过音效（采样或合成任一有即可）。验收脚本用。 */
  hasSfx(name) {
    return !!this.sfxBuffers.get(name)
      || Object.prototype.hasOwnProperty.call(SFX, name)
      || Object.prototype.hasOwnProperty.call(SFX_SAMPLES, name);
  }

  setVolume(name, v) {
    const x = Math.max(0, Math.min(1, Number(v) || 0));
    this.vol[name] = x;
    if (!this.ready) return;
    const bus = this.buses[name];
    if (!bus) return;
    // 用 setTargetAtTime 平滑：直接给 value 会"啪"一声
    const target = name === 'master' && this.muted ? 0 : x;
    bus.gain.setTargetAtTime(target, this.ctx.currentTime, 0.03);
  }

  setMuted(m) {
    this.muted = !!m;
    if (!this.ready) return;
    this.buses.master.gain.setTargetAtTime(
      this.muted ? 0 : this.vol.master, this.ctx.currentTime, 0.05,
    );
  }

  // ---------- 合成基元 ----------

  #makeNoise(seconds) {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    // 简单的白噪 + 轻微粉化（一阶低通），听起来更"水"而不是"电视雪花"
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      last = last * 0.86 + w * 0.14;
      d[i] = w * 0.6 + last * 1.8;
    }
    return buf;
  }

  #noiseSource() {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    return src;
  }

  /**
   * 一个音：f0→f1 滑音 + ADSR 包络 + 可选滤波。返回 gain 便于串联。
   * 短音（<0.6s）自动回收；长音由调用方停止。
   */
  #tone({
    f0, f1 = f0, dur = 0.2, type = 'sine', vol = 0.3,
    attack = 0.006, release = null, filter = null, detune = 0, bus = 'sfx', at = 0, pan = 0,
  }) {
    const ctx = this.ctx;
    const t0 = ctx.currentTime + at;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t0);
    if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    if (detune) osc.detune.value = detune;
    const g = ctx.createGain();
    const rel = release == null ? Math.max(0.04, dur * 0.5) : release;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol * this._sfxMod.vol), t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + Math.max(attack + 0.01, dur));
    let node = osc;
    if (filter) {
      const bq = ctx.createBiquadFilter();
      bq.type = filter.type || 'lowpass';
      bq.frequency.setValueAtTime(filter.freq || 1200, t0);
      if (filter.freq1) bq.frequency.exponentialRampToValueAtTime(filter.freq1, t0 + dur);
      bq.Q.value = filter.q ?? 1;
      node.connect(bq);
      node = bq;
    }
    node.connect(g);
    const disconnect = this.#out(g, bus, pan + this._sfxMod.pan);
    osc.start(t0);
    osc.stop(t0 + Math.max(dur, rel) + 0.05);
    osc.onended = () => { disconnect(); };
    return g;
  }

  /** 噪声爆发：打击/水花/爆炸的骨架 */
  #noiseBurst({
    dur = 0.3, vol = 0.3, type = 'bandpass', freq = 900, freq1 = null,
    q = 1.2, attack = 0.004, bus = 'sfx', at = 0, rate = 1, pan = 0,
  }) {
    const ctx = this.ctx;
    const t0 = ctx.currentTime + at;
    const src = this.#noiseSource();
    src.playbackRate.value = rate;
    const bq = ctx.createBiquadFilter();
    bq.type = type;
    bq.frequency.setValueAtTime(freq, t0);
    if (freq1) bq.frequency.exponentialRampToValueAtTime(Math.max(60, freq1), t0 + dur);
    bq.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol * this._sfxMod.vol), t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(bq);
    bq.connect(g);
    const disconnect = this.#out(g, bus, pan + this._sfxMod.pan);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
    src.onended = () => { disconnect(); try { bq.disconnect(); } catch { /* 已断 */ } };
  }

  /**
   * 把一次性音源接到总线，可选左右声道（听声辨位用）。
   * 返回一个"断开函数"，在 src.onended 里调用，避免 PannerNode 泄漏。
   * 没传 pan（或浏览器不支持）时直接接总线，行为和以前完全一样。
   */
  #out(node, bus, pan = 0) {
    const dest = this.buses[bus] || this.buses.sfx;
    if (!pan || !this.ctx.createStereoPanner) {
      node.connect(dest);
      return () => { try { node.disconnect(); } catch { /* 已断 */ } };
    }
    const panner = this.ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    node.connect(panner);
    panner.connect(dest);
    return () => {
      try { node.disconnect(); } catch { /* 已断 */ }
      try { panner.disconnect(); } catch { /* 已断 */ }
    };
  }

  /** 若干音高上的快速琶音，用来做"闪光/神圣/魔法"这类音色 */
  #arp(semis, { step = 0.045, dur = 0.22, vol = 0.16, type = 'triangle', bus = 'sfx', at = 0 } = {}) {
    semis.forEach((s, i) => {
      this.#tone({ f0: hz(s), dur, type, vol, bus, at: at + i * step, attack: 0.004 });
    });
  }

  /**
   * 播一个具名音效。name 见下方 SFX_SAMPLES / SFX 表；同一名字 60ms 内只响一次，
   * 避免多目标同时命中时把 8 个同样的声音叠成一团噪音。
   * 优先播采样；采样没加载好或没有对应文件时回落到合成。
   */
  play(name, opts = {}) {
    if (!this.ready) return;
    const now = performance.now();
    const last = this.lastPlay.get(name) || 0;
    if (now - last < (opts.gap ?? 60)) return;
    const buf = this.sfxBuffers.get(name);
    const fn = SFX[name];
    if (!buf && !fn) return;
    this.lastPlay.set(name, now);
    if (buf) {
      try {
        // vol 是"这次播放的倍率"，不是替换素材本身的响度基准（uiClick 等单独标定过）
        this.#playSample(buf, {
          ...opts,
          vol: (SAMPLE_VOL[name] ?? 0.75) * (opts.vol ?? 1),
          pan: opts.pan ?? 0,
          // 远处的队友要"隔着距离"听：低通把高频嘶鸣削掉，临场感才不假
          lowpass: opts.lowpass ?? 0,
        });
      } catch { /* 单个音效失败不影响游戏 */ }
      return;
    }
    // 合成音效把音量倍率/声道放进临时修饰里：各条 SFX 写死的 vol 不用改，
    // 由 #tone / #noiseBurst 统一乘上去。播放是同步的，finally 一定恢复。
    const prev = this._sfxMod;
    this._sfxMod = { vol: opts.vol ?? 1, pan: opts.pan ?? 0 };
    try { fn(this, opts); } catch { /* 单个音效失败不影响游戏 */ }
    finally { this._sfxMod = prev; }
  }

  /** 调整正在播放的循环音效音量（大浪浪声这类需要随浪高连续变化） */
  setLoopVolume(name, vol) {
    const L = this.sfxLoops.get(name);
    if (!L || !this.ctx) return;
    L.g.gain.setTargetAtTime(Math.max(0.0001, vol), this.ctx.currentTime, 0.25);
  }

  /**
   * 采样音效一次性播放；vol/rate/at 与合成音效的调用参数保持同名。
   * lowpass（Hz）>0 时串一个低通 —— 给"远处的队友"用，高频被空气吃掉一部分。
   */
  #playSample(buf, { vol = 0.75, rate = 1, at = 0, pan = 0, lowpass = 0 } = {}) {
    const ctx = this.ctx;
    const t0 = ctx.currentTime + at;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = Math.max(0, Math.min(2, vol));
    if (lowpass > 0) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = lowpass;
      lp.Q.value = 0.7;
      src.connect(lp);
      lp.connect(g);
    } else {
      src.connect(g);
    }
    const disconnect = this.#out(g, 'sfx', pan);
    src.start(t0);
    src.onended = () => { disconnect(); };
  }

  /** 预加载全部采样音效（无文件/解码失败的名字继续用合成兜底） */
  loadSfx() {
    if (this.sfxLoading) return this.sfxLoading;
    this.sfxLoading = Promise.all(
      Object.entries(SFX_SAMPLES).map(async ([key, url]) => {
        const buf = await this.#loadSample(url, '音效');
        if (buf) this.sfxBuffers.set(key, buf);
      }),
    );
    return this.sfxLoading;
  }

  /**
   * 循环音效（氮气持续 / 墨汁糊眼 / 漩涡缠住）。重复调用安全，已经在响就忽略。
   */
  startLoop(name, { vol = 0.6, fade = 0.15 } = {}) {
    if (!this.ready || this.sfxLoops.has(name)) return;
    const buf = this.sfxBuffers.get(name);
    if (!buf) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), ctx.currentTime + fade);
    src.connect(g);
    g.connect(this.buses.sfx);
    src.start();
    this.sfxLoops.set(name, { src, g });
  }

  /** 停止循环音效（带淡出，避免硬切爆音） */
  stopLoop(name, fade = 0.25) {
    const L = this.sfxLoops.get(name);
    if (!L) return;
    this.sfxLoops.delete(name);
    const now = this.ctx.currentTime;
    try {
      L.g.gain.cancelScheduledValues(now);
      L.g.gain.setValueAtTime(Math.max(0.0001, L.g.gain.value), now);
      L.g.gain.exponentialRampToValueAtTime(0.0001, now + fade);
      L.src.stop(now + fade + 0.05);
      L.src.onended = () => { try { L.g.disconnect(); } catch { /* 已断 */ } };
    } catch { /* 已停 */ }
  }

  // ---------- 持续层：引擎 / 水声 / 漂移 ----------

  /**
   * 引擎 + 水声常驻层。速度 0~1 连续驱动音高与滤波，
   * 这样"加速"听起来是推上去的而不是切一段素材。
   */
  startAmbience() {
    if (!this.ready || this.loops.engine) return;
    const ctx = this.ctx;
    const bus = this.buses.ambience;

    // 引擎：两个锯齿波（低频主体 + 高八度泛音），过低通
    const eg = ctx.createGain();
    eg.gain.value = 0.0001;
    const elp = ctx.createBiquadFilter();
    elp.type = 'lowpass';
    elp.frequency.value = 420;
    elp.Q.value = 0.9;
    elp.connect(eg);
    eg.connect(bus);
    // 引擎：三角波 + 正弦泛音，过低通做成"软软的噗噗声"，
    // 不用锯齿/方波，避免刺耳毛躁的马达味
    const o1 = ctx.createOscillator();
    o1.type = 'triangle';
    o1.frequency.value = 54;
    const o2 = ctx.createOscillator();
    o2.type = 'sine';
    o2.frequency.value = 108;
    const o2g = ctx.createGain();
    o2g.gain.value = 0.18;
    o1.connect(elp);
    o2.connect(o2g);
    o2g.connect(elp);
    o1.start();
    o2.start();

    // 水声：带通噪声，速度越高越亮越响
    const wsrc = this.#noiseSource();
    const wbp = ctx.createBiquadFilter();
    wbp.type = 'bandpass';
    wbp.frequency.value = 620;
    wbp.Q.value = 0.6;
    const wg = ctx.createGain();
    wg.gain.value = 0.0001;
    wsrc.connect(wbp);
    wbp.connect(wg);
    wg.connect(bus);
    wsrc.start();

    this.loops.engine = { o1, o2, eg, elp, wg, wbp, wsrc };
  }

  /** speed01: 0~1；boost: 是否在氮气中 */
  setEngine(speed01, boost = false) {
    const L = this.loops.engine;
    if (!L) return;
    const t = this.ctx.currentTime;
    const s = Math.max(0, Math.min(1, speed01));
    // 转速 → 音高只做温和抬升，并把滤波压低：听起来像小艇"噗噗噗"，
    // 高速也不会变成尖啸的电机
    const f = 50 + s * 70 + (boost ? 18 : 0);
    L.o1.frequency.setTargetAtTime(f, t, 0.09);
    L.o2.frequency.setTargetAtTime(f * 2.01, t, 0.09);
    L.elp.frequency.setTargetAtTime(300 + s * 620 + (boost ? 300 : 0), t, 0.1);
    L.eg.gain.setTargetAtTime(0.04 + s * 0.075, t, 0.12);
    L.wbp.frequency.setTargetAtTime(560 + s * 900, t, 0.12);
    L.wg.gain.setTargetAtTime(0.022 + s * 0.1, t, 0.12);
  }

  stopAmbience() {
    const L = this.loops.engine;
    if (!L) return;
    try {
      L.o1.stop(); L.o2.stop(); L.wsrc.stop();
      L.eg.disconnect(); L.wg.disconnect(); L.wbp.disconnect();
    } catch { /* 已停 */ }
    this.loops.engine = null;
  }

  /** 漂移层：带通噪声 + 高频啸叫，level 0~1 表示集气强度 */
  startDrift() {
    if (!this.ready || this.loops.drift) return;
    const ctx = this.ctx;
    const bus = this.buses.ambience;
    const src = this.#noiseSource();
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1500;
    bp.Q.value = 1.4;
    const g = ctx.createGain();
    g.gain.value = 0.0001;
    src.connect(bp);
    bp.connect(g);
    g.connect(bus);
    src.start();
    const whine = ctx.createOscillator();
    whine.type = 'triangle';
    whine.frequency.value = 520;
    const wg = ctx.createGain();
    wg.gain.value = 0.0001;
    whine.connect(wg);
    wg.connect(bus);
    whine.start();
    this.loops.drift = { src, bp, g, whine, wg };
  }

  setDrift(level) {
    const L = this.loops.drift;
    if (!L) return;
    const t = this.ctx.currentTime;
    const k = Math.max(0, Math.min(1, level));
    L.g.gain.setTargetAtTime(0.04 + k * 0.1, t, 0.05);
    L.bp.frequency.setTargetAtTime(1300 + k * 1300, t, 0.08);
    L.whine.frequency.setTargetAtTime(480 + k * 520, t, 0.08);
    L.wg.gain.setTargetAtTime(0.008 + k * 0.03, t, 0.06);
  }

  stopDrift() {
    const L = this.loops.drift;
    if (!L) return;
    try {
      L.src.stop(); L.whine.stop();
      L.g.disconnect(); L.wg.disconnect(); L.bp.disconnect();
    } catch { /* 已停 */ }
    this.loops.drift = null;
  }

  // ---------- BGM ----------

  /**
   * 大厅 / 竞速用上传的采样音乐（循环 + 渐入），其余模式保留程序化 BGM。
   * 切换时旧音乐会淡出，不会硬切。
   */
  startMusic(mode = 'race') {
    if (!this.ready) return;
    if (this.music && this.music.mode === mode) return;
    this.stopMusic();
    const sample = MUSIC_SAMPLES[mode];
    if (sample) {
      this.#startSampleMusic(mode, sample);
      return;
    }
    this.#startProceduralMusic(mode);
  }

  async #loadSample(url, label = 'BGM') {
    if (this.sampleBuffers.has(url)) return this.sampleBuffers.get(url);
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const buf = await this.ctx.decodeAudioData(await res.arrayBuffer());
      this.sampleBuffers.set(url, buf);
      return buf;
    } catch (err) {
      console.warn(`[audio] ${label}采样加载失败，回落到合成：`, url, err);
      return null; // 文件缺失 / 解码失败：退回程序化 BGM 或合成音效
    }
  }

  async #startSampleMusic(mode, { url, fadeIn = 1.2, gain = 0.85, loopStart = 0 }) {
    const token = ++this.musicToken;
    this.music = { mode, pending: true };
    const buf = await this.#loadSample(url);
    // 加载期间玩家可能已经切走了：token 变了就丢弃这次结果
    if (token !== this.musicToken || !this.music?.pending) return;
    if (!buf) {
      this.music = null;
      this.#startProceduralMusic(mode);
      return;
    }
    const now = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.loopStart = Math.min(loopStart, Math.max(0, buf.duration - 0.1));
    src.loopEnd = buf.duration;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(gain, now + fadeIn);
    src.connect(g);
    g.connect(this.buses.music);
    src.start(now);
    this.music = { mode, sample: true, src, gain: g, token };
  }

  /** 旧的程序化三层 BGM（boss / arena / launch 使用） */
  #startProceduralMusic(mode) {
    const P = MUSIC[mode] || MUSIC.race;
    const st = {
      mode, step: 0, next: this.ctx.currentTime + 0.1,
      timer: null, ...P,
    };
    const tick = () => {
      if (!this.ctx) return;
      const ahead = this.ctx.currentTime + 0.25;
      while (st.next < ahead) {
        const bar = Math.floor(st.step / st.perBar) % st.chords.length;
        const chord = st.chords[bar];
        const beat = st.step % st.perBar;
        // 低音：每小节第 1 拍
        if (beat === 0) {
          this.#tone({
            f0: hz(chord[0] - 24), dur: st.beat * 3.2, type: 'sine',
            vol: 0.16, bus: 'music', at: st.next - this.ctx.currentTime, attack: 0.05,
          });
        }
        // 铺底：整小节
        if (beat === 0) {
          for (const n of chord) {
            this.#tone({
              f0: hz(n - 12), dur: st.beat * 3.6, type: 'triangle',
              vol: 0.035, bus: 'music', at: st.next - this.ctx.currentTime,
              attack: 0.4, release: 0.6, detune: 6,
            });
          }
        }
        // 琶音：八分音符，按小节内顺序轮转和弦音
        if (st.arp) {
          const n = chord[beat % chord.length] + (beat % 4 === 3 ? 12 : 0);
          this.#tone({
            f0: hz(n), dur: st.beat * 0.7, type: 'triangle',
            vol: 0.05, bus: 'music', at: st.next - this.ctx.currentTime, attack: 0.003,
          });
        }
        // 鼓：底鼓 + 军鼓（boss/race 才有）
        if (st.drums && beat % 4 === 0) {
          this.#tone({
            f0: 110, f1: 44, dur: 0.16, type: 'sine', vol: 0.2,
            bus: 'music', at: st.next - this.ctx.currentTime,
          });
        }
        if (st.drums && beat % 4 === 2) {
          this.#noiseBurst({
            dur: 0.11, vol: 0.09, type: 'highpass', freq: 1800, q: 0.7,
            bus: 'music', at: st.next - this.ctx.currentTime,
          });
        }
        st.step++;
        st.next += st.beat;
      }
    };
    st.timer = setInterval(tick, 100);
    tick();
    this.music = st;
  }

  /** 停止 BGM：采样的旧音乐会淡出（程序化的直接停排程） */
  stopMusic(fade = 0.7) {
    this.musicToken++;
    const m = this.music;
    this.music = null;
    if (!m) return;
    if (m.timer) clearInterval(m.timer);
    if (!m.src || !this.ctx) return;
    const now = this.ctx.currentTime;
    try {
      m.gain.gain.cancelScheduledValues(now);
      m.gain.gain.setValueAtTime(Math.max(0.0001, m.gain.gain.value), now);
      m.gain.gain.exponentialRampToValueAtTime(0.0001, now + fade);
      m.src.onended = () => { try { m.gain.disconnect(); } catch { /* 已断 */ } };
      m.src.stop(now + fade + 0.05);
    } catch { /* 已停 */ }
  }
}

// ---------- BGM 数据 ----------
// 大厅 / 竞速 / BOSS 战使用上传的采样音乐；arena/launch 仍走下面的程序化音乐。
const MUSIC_SAMPLES = {
  // loopStart：素材开头有约 0.8~0.9s 静音，循环时跳过它，接缝更自然
  menu: { url: '/audio/lobby-theme.wav', fadeIn: 1.8, gain: 0.8, loopStart: 0.9 },
  race: { url: '/audio/race-theme.wav', fadeIn: 1.0, gain: 0.85, loopStart: 0.75 },
  // 怪物模式 BOSS 战：整段循环播放；素材自带前奏，从 0 开始接
  boss: { url: '/audio/sfx/boss_battle_long.mp3', fadeIn: 1.4, gain: 0.8 },
};

// chords：每个和弦是 semitone 数组（相对 A4）。beat：每拍秒数。perBar：每小节拍数。
const MUSIC = {
  menu: {
    beat: 0.52, perBar: 8, drums: false, arp: true,
    chords: [[0, 4, 7], [-3, 0, 4], [-5, -1, 2], [-3, 0, 4]],
  },
  race: {
    beat: 0.36, perBar: 8, drums: true, arp: true,
    chords: [[0, 4, 7], [5, 9, 12], [-3, 0, 4], [7, 11, 14]],
  },
  boss: {
    beat: 0.42, perBar: 8, drums: true, arp: false,
    chords: [[-5, -1, 2], [-5, -1, 2], [-7, -3, 0], [-4, 0, 3]],
  },
  arena: {
    beat: 0.3, perBar: 8, drums: true, arp: true,
    chords: [[2, 5, 9], [-1, 2, 6], [0, 3, 7], [-3, 0, 4]],
  },
};

// ---------- 采样音效表 ----------
// key 就是文件名（见 music/SFX使用说明.md），文件放在 public/audio/sfx/<key>.wav。
// 播放时由 play() 优先取采样；没加载好或文件缺失则回落到下面 SFX 里的合成。
const SFX_SAMPLES = {
  // 16 个道具（原素材 01_nitro ~ 16_torpedo 重命名而来）
  item_nitro: '/audio/sfx/item_nitro.wav',
  item_bomb: '/audio/sfx/item_bomb.wav',
  item_octopus: '/audio/sfx/item_octopus.wav',
  item_shield: '/audio/sfx/item_shield.wav',
  item_missile: '/audio/sfx/item_missile.wav',
  item_vortex: '/audio/sfx/item_vortex.wav',
  item_magnet: '/audio/sfx/item_magnet.wav',
  item_ink: '/audio/sfx/item_ink.wav',
  item_waterfall: '/audio/sfx/item_waterfall.wav',
  item_angel: '/audio/sfx/item_angel.wav',
  item_fish: '/audio/sfx/item_fish.wav',
  item_rvortex: '/audio/sfx/item_rvortex.wav',
  item_slowboat: '/audio/sfx/item_slowboat.wav',
  item_tide: '/audio/sfx/item_tide.wav',
  item_bubblefly: '/audio/sfx/item_bubblefly.wav',
  item_torpedo: '/audio/sfx/item_torpedo.wav',
  // BOSS 道具变体
  boss_nitro: '/audio/sfx/boss_nitro.wav',
  boss_bomb: '/audio/sfx/boss_bomb.wav',
  boss_missile: '/audio/sfx/boss_missile.wav',
  boss_vortex: '/audio/sfx/boss_vortex.wav',
  boss_fish: '/audio/sfx/boss_fish.wav',
  weakspot_javelin: '/audio/sfx/weakspot_javelin.wav',
  boss_control_hit: '/audio/sfx/boss_control_hit.wav',
  // BOSS 事件
  ram_boss: '/audio/sfx/ram_boss.wav',
  ram_boss_nitro: '/audio/sfx/ram_boss_nitro.wav',
  boss_damage_ranged: '/audio/sfx/boss_damage_ranged.wav',
  weak_crit: '/audio/sfx/weak_crit.wav',
  boss_stagger: '/audio/sfx/boss_stagger.wav',
  cores_break: '/audio/sfx/cores_break.wav',
  boss_warn: '/audio/sfx/boss_warn.wav',
  boss_roar: '/audio/sfx/boss_roar.wav',
  boss_fire: '/audio/sfx/boss_fire.wav',
  boss_ice: '/audio/sfx/boss_ice.wav',
  boss_thunder: '/audio/sfx/boss_thunder.wav',
  boss_water: '/audio/sfx/boss_water.wav',
  boss_magic: '/audio/sfx/boss_magic.wav',
  player_hit: '/audio/sfx/player_hit.wav',
  boss_death: '/audio/sfx/boss_death.wav',
  transition: '/audio/sfx/transition.wav',
  item_box: '/audio/sfx/item_box.wav',
  respawn: '/audio/sfx/respawn.wav',
  synergy: '/audio/sfx/synergy.wav',
  fish_minion: '/audio/sfx/fish_minion.wav',
  // 通用比赛事件（船撞船 / 撞礁 / 撞浮标的撞击音统一换成新上传的 impact_old.wav）
  boat_collide: '/audio/sfx/impact_old.wav',
  hit_rock: '/audio/sfx/impact_old.wav',
  hit_buoy: '/audio/sfx/impact_old.wav',
  fall_water: '/audio/sfx/fall_water.wav',
  wave_launch: '/audio/sfx/wave_launch.wav',
  // 弹射器接触即弹（marine.platforms，非大浪腾空）：2026-11-20 加入玩家提供的弹射音（1.35s / 44.1k / 16bit / 立体声）。
  launcher_launch: '/audio/sfx/launcher_launch.wav',
  // 氮气冲刺：2026-11-19 换成玩家提供的「氮气冲刺.wav」（3.0s / 44.1k / 16bit / 立体声）。
  // 旧的 nitro_ignition + nitro_loop 已下线：loop 那段循环播放就是"刺耳、像老鼠叫"的来源。
  // 新素材自带完整结构（叮 → 气阀嗤 → 喷射嘶鸣 → 收束），所以只播一次、不循环。
  nitro_dash: '/audio/sfx/nitro_dash.wav',
  perfect_start: '/audio/sfx/perfect_start.wav',
  speed_portal: '/audio/sfx/speed_portal.wav',
  finish: '/audio/sfx/finish.wav',
  shield_break: '/audio/sfx/shield_break.wav',
  bomb_hit: '/audio/sfx/bomb_hit.wav',
  missile_hit: '/audio/sfx/missile_hit.wav',
  ink_loop: '/audio/sfx/ink_loop.wav',
  spin_loop: '/audio/sfx/spin_loop.wav',
  slow_hit: '/audio/sfx/slow_hit.wav',
  reverse_tide: '/audio/sfx/reverse_tide.wav',
  storm_thunder: '/audio/sfx/storm_thunder.wav',
  // UI / 拾取 / 大浪环境音（新一轮上传的素材）
  uiClick: '/audio/sfx/ui_click.wav',
  pickup: '/audio/sfx/pickup.wav',
  wave_loop: '/audio/sfx/wave_loop.wav',
};

// 个别采样素材自带响度和合成音效差得远，这里单独给单次播放音量（未列的用 0.75）
const SAMPLE_VOL = {
  uiClick: 0.45,   // 大厅按钮：只要"哒"一下，不能盖过界面
  pickup: 0.85,    // 拾取道具：清楚的"叮"，但不至于盖过道具音
  // 氮气冲刺：素材峰值 −1.4dB 已归一化，这里留 0.86 的余量防止和其它音效叠加削波
  nitro_dash: 0.86,
};

// ---------- 一次性音效表 ----------
// 每个道具一种"性格"：靠波形/包络/滤波区分，而不是靠不同素材。
const SFX = {
  // ===== UI =====
  uiClick: (a) => a.tone({ f0: 980, f1: 1360, dur: 0.06, type: 'sine', vol: 0.1, release: 0.05 }),
  uiOpen: (a) => {
    a.tone({ f0: 660, f1: 990, dur: 0.1, type: 'sine', vol: 0.12 });
    a.tone({ f0: 990, f1: 1320, dur: 0.12, type: 'triangle', vol: 0.06, at: 0.06 });
  },
  uiClose: (a) => a.tone({ f0: 880, f1: 540, dur: 0.1, type: 'sine', vol: 0.11 }),

  // ===== 比赛节奏 =====
  countdown: (a) => a.tone({ f0: 740, dur: 0.12, type: 'sine', vol: 0.13 }),
  countdownGo: (a) => {
    [0, 4, 7, 12].forEach((s, i) => a.tone({ f0: hz(s + 12), dur: 0.26, type: 'triangle', vol: 0.11, at: i * 0.06 }));
    a.noise({ dur: 0.16, vol: 0.04, type: 'highpass', freq: 3200, q: 0.6 });
  },
  lap: (a) => {
    a.tone({ f0: 1047, dur: 0.1, type: 'sine', vol: 0.14 });
    a.tone({ f0: 1568, dur: 0.16, type: 'sine', vol: 0.1, at: 0.08 });
  },
  // 漂移出弯小喷：单喷一记上冲，双喷两记叠成"哒—哒"（比氮气轻，不能盖过引擎）
  drift_boost: (a) => {
    a.tone({ f0: 520, f1: 980, dur: 0.16, type: 'triangle', vol: 0.1 });
    a.noise({ dur: 0.12, vol: 0.035, type: 'highpass', freq: 2400, q: 0.7 });
  },
  drift_boost2: (a) => {
    a.tone({ f0: 470, f1: 900, dur: 0.15, type: 'triangle', vol: 0.1 });
    a.tone({ f0: 700, f1: 1320, dur: 0.18, type: 'triangle', vol: 0.085, at: 0.11 });
    a.noise({ dur: 0.2, vol: 0.04, type: 'highpass', freq: 2600, q: 0.7 });
  },
  finish: (a) => {
    [0, 4, 7, 12, 16].forEach((s, i) => a.tone({ f0: hz(s + 12), dur: 0.5, type: 'triangle', vol: 0.1, at: i * 0.075 }));
  },
  // 卡通"咚"：音高快速下滑，再补一点橡胶回弹，不打低频轰鸣
  hit: (a) => {
    a.tone({ f0: 640, f1: 190, dur: 0.16, type: 'sine', vol: 0.17 });
    a.tone({ f0: 300, f1: 470, dur: 0.09, type: 'triangle', vol: 0.07, at: 0.11 });
  },
  splash: (a) => a.noise({ dur: 0.38, vol: 0.12, type: 'highpass', freq: 900, freq1: 2400, q: 0.7 }),

  // ===== 道具（16 种，Q 版卡通性格：boing / pop / 泡泡 / 叮咚）=====
  item_nitro: (a) => {
    a.tone({ f0: 320, f1: 1180, dur: 0.26, type: 'triangle', vol: 0.14 });
    a.tone({ f0: 900, f1: 1560, dur: 0.16, type: 'sine', vol: 0.07, at: 0.09 });
    a.noise({ dur: 0.26, vol: 0.05, type: 'highpass', freq: 2600, q: 0.7 });
  },
  item_bomb: (a) => {
    // 卡通水弹：一声"咕咚"下沉 + 几个泡泡，不做爆炸轰鸣
    a.tone({ f0: 400, f1: 100, dur: 0.26, type: 'sine', vol: 0.18 });
    for (let i = 0; i < 4; i++) {
      a.tone({ f0: 720 + i * 150, f1: 560 + i * 120, dur: 0.06, type: 'sine', vol: 0.045, at: 0.1 + i * 0.05 });
    }
  },
  item_octopus: (a) => {
    // 黏糊糊：往上冒的小泡泡
    for (let i = 0; i < 5; i++) {
      a.tone({ f0: 300 + i * 120, f1: 220 + i * 90, dur: 0.085, type: 'sine', vol: 0.075, at: i * 0.055 });
    }
    a.noise({ dur: 0.22, vol: 0.04, type: 'bandpass', freq: 1100, freq1: 500, q: 2, at: 0.03 });
  },
  item_shield: (a) => {
    a.arp([12, 16, 19, 24], { step: 0.05, dur: 0.34, vol: 0.075, type: 'sine' });
    a.noise({ dur: 0.28, vol: 0.025, type: 'highpass', freq: 4600, q: 0.5 });
  },
  item_missile: (a) => {
    // Q 版"咻—哔哔"：先上扬再两声锁定
    a.tone({ f0: 700, f1: 1700, dur: 0.15, type: 'triangle', vol: 0.11 });
    a.tone({ f0: 1900, dur: 0.05, type: 'sine', vol: 0.06, at: 0.17 });
    a.tone({ f0: 1900, dur: 0.05, type: 'sine', vol: 0.05, at: 0.25 });
  },
  item_vortex: (a) => {
    // 一串气泡往上卷
    for (let i = 0; i < 7; i++) {
      a.tone({ f0: 420 + i * 90, f1: 300 + i * 60, dur: 0.09, type: 'sine', vol: 0.065, at: i * 0.065 });
    }
    a.tone({ f0: 260, f1: 560, dur: 0.45, type: 'sine', vol: 0.045 });
  },
  item_magnet: (a) => {
    // 弹簧"嘣" + 小电流
    a.tone({ f0: 220, f1: 900, dur: 0.18, type: 'triangle', vol: 0.11 });
    a.tone({ f0: 1320, f1: 990, dur: 0.1, type: 'sine', vol: 0.05, at: 0.13 });
  },
  item_ink: (a) => {
    a.noise({ dur: 0.3, vol: 0.12, type: 'bandpass', freq: 1400, freq1: 650, q: 1.2 });
    for (let i = 0; i < 3; i++) {
      a.tone({ f0: 250 + i * 80, f1: 170, dur: 0.1, type: 'sine', vol: 0.06, at: 0.05 + i * 0.06 });
    }
  },
  item_waterfall: (a) => {
    a.noise({ dur: 0.55, vol: 0.12, type: 'highpass', freq: 800, freq1: 2800, q: 0.6 });
    for (let i = 0; i < 5; i++) {
      a.tone({ f0: 520 + i * 140, f1: 940 + i * 160, dur: 0.07, type: 'sine', vol: 0.05, at: i * 0.06 });
    }
  },
  item_angel: (a) => {
    a.arp([12, 16, 19, 24, 28], { step: 0.06, dur: 0.42, vol: 0.075, type: 'sine' });
    a.noise({ dur: 0.38, vol: 0.025, type: 'highpass', freq: 5400, q: 0.4 });
  },
  item_fish: (a) => {
    // 飞鱼群：一串快速"啵啵"甩尾
    for (let i = 0; i < 6; i++) {
      a.tone({ f0: 1100 + Math.random() * 500, f1: 1500 + Math.random() * 400, dur: 0.05, type: 'sine', vol: 0.055, at: i * 0.04 });
    }
  },
  item_rvortex: (a) => {
    a.tone({ f0: 320, f1: 120, dur: 0.5, type: 'triangle', vol: 0.11 });
    for (let i = 0; i < 6; i++) {
      a.tone({ f0: 500 + i * 80, dur: 0.07, type: 'sine', vol: 0.055, at: i * 0.06 });
    }
  },
  item_slowboat: (a) => {
    // 经典卡通"往下溜"的滑音
    a.tone({ f0: 760, f1: 220, dur: 0.42, type: 'triangle', vol: 0.11 });
    a.tone({ f0: 520, f1: 170, dur: 0.3, type: 'sine', vol: 0.06, at: 0.17 });
  },
  item_tide: (a) => {
    // 左右晃的"晕眩"三连音
    a.tone({ f0: 520, f1: 900, dur: 0.14, type: 'sine', vol: 0.09 });
    a.tone({ f0: 900, f1: 520, dur: 0.14, type: 'sine', vol: 0.09, at: 0.15 });
    a.tone({ f0: 520, f1: 900, dur: 0.14, type: 'sine', vol: 0.07, at: 0.3 });
  },
  item_bubblefly: (a) => {
    for (let i = 0; i < 6; i++) {
      a.tone({ f0: 900 + i * 180, f1: 1500 + i * 200, dur: 0.06, type: 'sine', vol: 0.055, at: i * 0.045 });
    }
  },
  item_torpedo: (a) => {
    // 三声水面"噗通"发射
    for (let i = 0; i < 3; i++) {
      a.tone({ f0: 330, f1: 130, dur: 0.09, type: 'sine', vol: 0.12, at: i * 0.09 });
      a.noise({ dur: 0.07, vol: 0.045, type: 'highpass', freq: 1400, q: 0.8, at: i * 0.09 });
    }
  },
  item_weakspot: (a) => {
    // 清脆"叮" + 玻璃碎响，不刺耳
    a.tone({ f0: 1800, dur: 0.16, type: 'sine', vol: 0.09 });
    a.tone({ f0: 2450, dur: 0.2, type: 'sine', vol: 0.06, at: 0.04 });
    a.noise({ dur: 0.07, vol: 0.04, type: 'highpass', freq: 4200, q: 0.8 });
  },
  // ===== 后加的 6 件道具（此前没有采样也没有合成，出手时完全静音）=====
  item_bloodlance: (a) => {
    // 蓄力 → 尖啸穿刺：和追踪弹的"呼——"区分开
    a.tone({ f0: 180, f1: 720, dur: 0.22, type: 'sawtooth', vol: 0.07, filter: { type: 'lowpass', freq: 900, freq1: 2600 } });
    a.tone({ f0: 1500, f1: 420, dur: 0.16, type: 'triangle', vol: 0.09, at: 0.18 });
    a.noise({ dur: 0.12, vol: 0.05, type: 'highpass', freq: 2600, q: 0.7, at: 0.18 });
  },
  item_holystorm: (a) => {
    // 圣光 + 沙暴：琶音在后、噪声在前，听感像"风里带光"
    a.noise({ dur: 0.5, vol: 0.07, type: 'bandpass', freq: 700, freq1: 1900, q: 0.7 });
    a.arp([12, 16, 19, 24], { step: 0.055, dur: 0.34, vol: 0.075, type: 'sine' });
  },
  item_gate: (a) => {
    // 空间门：一高一低两个音反向滑，像门被拉开
    a.tone({ f0: 300, f1: 1100, dur: 0.3, type: 'sine', vol: 0.085 });
    a.tone({ f0: 900, f1: 240, dur: 0.34, type: 'triangle', vol: 0.06, at: 0.04 });
    a.noise({ dur: 0.24, vol: 0.035, type: 'bandpass', freq: 1800, q: 0.9, at: 0.08 });
  },
  item_bladestorm: (a) => {
    // 刀刃风暴：快速颤音 + 高频风声
    for (let i = 0; i < 5; i++) {
      a.tone({ f0: 620 + i * 140, f1: 420 + i * 90, dur: 0.14, type: 'triangle', vol: 0.05, at: i * 0.055 });
    }
    a.noise({ dur: 0.38, vol: 0.06, type: 'highpass', freq: 2200, q: 0.6 });
  },
  item_sanctuary: (a) => {
    // 圣域：稳定的大三和弦，柔和、不像攻击
    [0, 4, 7, 12].forEach((s, i) => a.tone({ f0: hz(s + 9), dur: 0.5, type: 'sine', vol: 0.055, at: i * 0.035 }));
  },
  item_barrier: (a) => {
    // 护盾墙：低沉的能量落定声
    a.tone({ f0: 520, f1: 150, dur: 0.3, type: 'triangle', vol: 0.1 });
    a.noise({ dur: 0.26, vol: 0.05, type: 'lowpass', freq: 700, q: 0.8 });
  },

  // ===== 道具赛的"听觉防守"提示音 =====
  // 被锁定 / 攻击逼近时给受害者听的两声短提示。刻意不用采样素材：
  // 采样要走网络加载，首次进房间可能还没解码完，而预警音必须每次都响。
  incoming_alert: (a) => {
    a.tone({ f0: 760, f1: 1080, dur: 0.1, type: 'sine', vol: 0.13 });
    a.tone({ f0: 900, f1: 1320, dur: 0.11, type: 'sine', vol: 0.11, at: 0.13 });
  },
  item_blocked: (a) => {
    // 护盾挡下：金属"铛"，和受击音明显不同，能听出是防住了
    a.tone({ f0: 1450, f1: 900, dur: 0.18, type: 'triangle', vol: 0.1 });
    a.tone({ f0: 2300, dur: 0.09, type: 'sine', vol: 0.05, at: 0.02 });
  },

  // 兜底：任何没单独配的道具
  item_default: (a) => {
    a.tone({ f0: 620, f1: 980, dur: 0.12, type: 'sine', vol: 0.11 });
    a.tone({ f0: 980, f1: 1320, dur: 0.1, type: 'triangle', vol: 0.05, at: 0.08 });
  },

  // ===== BOSS 技能（Q 版：像大玩偶的法术，不吓人）=====
  bossFire: (a) => {
    a.noise({ dur: 0.42, vol: 0.1, type: 'bandpass', freq: 900, freq1: 2100, q: 0.8 });
    a.tone({ f0: 260, f1: 520, dur: 0.32, type: 'triangle', vol: 0.08 });
  },
  bossIce: (a) => {
    a.arp([24, 28, 31, 36], { step: 0.04, dur: 0.28, vol: 0.065, type: 'sine' });
    for (let i = 0; i < 4; i++) {
      a.tone({ f0: 2400 + i * 320, dur: 0.05, type: 'sine', vol: 0.035, at: 0.05 + i * 0.05 });
    }
  },
  bossThunder: (a) => {
    // 卡通"啪—咚"：不拉长雷鸣，避免压抑
    a.tone({ f0: 1700, f1: 560, dur: 0.14, type: 'triangle', vol: 0.09 });
    a.noise({ dur: 0.24, vol: 0.08, type: 'highpass', freq: 1800, freq1: 900, q: 0.5 });
    a.tone({ f0: 300, f1: 150, dur: 0.2, type: 'sine', vol: 0.07, at: 0.1 });
  },
  bossWater: (a) => {
    a.noise({ dur: 0.45, vol: 0.11, type: 'highpass', freq: 700, freq1: 2100, q: 0.6 });
    a.tone({ f0: 220, f1: 540, dur: 0.36, type: 'sine', vol: 0.07 });
  },
  bossMagic: (a) => {
    a.arp([7, 11, 14, 19], { step: 0.05, dur: 0.32, vol: 0.065, type: 'sine' });
    a.tone({ f0: 300, f1: 900, dur: 0.26, type: 'triangle', vol: 0.07 });
  },
  bossWarn: (a) => {
    // 两声清脆提示音，不刺耳
    a.tone({ f0: 1320, dur: 0.08, type: 'sine', vol: 0.1 });
    a.tone({ f0: 1320, dur: 0.08, type: 'sine', vol: 0.08, at: 0.12 });
  },
  bossRoar: (a) => {
    // 憨憨的"嗷呜"：中音下滑 + 轻微抖动，不追低频恐怖感
    a.tone({ f0: 240, f1: 130, dur: 0.5, type: 'triangle', vol: 0.15 });
    a.tone({ f0: 190, f1: 110, dur: 0.45, type: 'sine', vol: 0.09, at: 0.1 });
    for (let i = 0; i < 5; i++) {
      a.tone({ f0: 330 + i * 18, f1: 250, dur: 0.08, type: 'triangle', vol: 0.04, at: 0.18 + i * 0.07 });
    }
  },
  bossHurt: (a) => {
    // 不被吓人的短促"哎哟"感
    a.tone({ f0: 560, f1: 280, dur: 0.11, type: 'triangle', vol: 0.11 });
    a.tone({ f0: 820, dur: 0.05, type: 'sine', vol: 0.045, at: 0.09 });
  },

  // ===== 竞技场 =====
  arenaDash: (a) => {
    a.tone({ f0: 520, f1: 1240, dur: 0.15, type: 'triangle', vol: 0.1 });
    a.noise({ dur: 0.15, vol: 0.05, type: 'highpass', freq: 2800, q: 0.8 });
  },
  arenaUlt: (a) => {
    a.arp([0, 4, 7, 12], { step: 0.05, dur: 0.36, vol: 0.085, type: 'sine' });
    a.noise({ dur: 0.36, vol: 0.06, type: 'highpass', freq: 1700, freq1: 3400, q: 0.6 });
  },

  // ===== 结算 =====
  win: (a) => {
    [0, 4, 7, 12, 16].forEach((s, i) => {
      a.tone({ f0: hz(s + 12), dur: 0.55, type: 'triangle', vol: 0.1, at: i * 0.09 });
    });
    a.noise({ dur: 0.4, vol: 0.03, type: 'highpass', freq: 5200, q: 0.4 });
  },
  lose: (a) => {
    // 卡通"唉—"：下滑但不阴沉
    [0, -2, -5].forEach((s, i) => {
      a.tone({ f0: hz(s + 4), dur: 0.6, type: 'triangle', vol: 0.09, at: i * 0.15 });
    });
  },
};

// 采样音效没加载好时的同义合成兜底：关键时刻不会完全没声音
Object.assign(SFX, {
  boss_fire: SFX.bossFire,
  boss_ice: SFX.bossIce,
  boss_thunder: SFX.bossThunder,
  boss_water: SFX.bossWater,
  boss_magic: SFX.bossMagic,
  boss_warn: SFX.bossWarn,
  boss_roar: SFX.bossRoar,
  player_hit: SFX.bossHurt,
  ram_boss: SFX.hit,
  hit_rock: SFX.hit,
  hit_buoy: SFX.hit,
  boat_collide: SFX.hit,
  fall_water: SFX.splash,
  pickup: SFX.item_default,
  // BOSS 的 4 件专属道具以前也没配音效（audio_probe 的"每个道具都有专属音效"一直挂在这里）
  item_harpoon: SFX.item_bloodlance,
  item_barrage: SFX.item_torpedo,
  item_thunderrod: SFX.item_holystorm,
  item_ramcrest: SFX.item_barrier,
});

/** 道具 id → 音效名（注释说会兜底，旧版却直接拼字符串，没配的道具就彻底静音） */
export function itemSfxName(item) {
  const n = `item_${item}`;
  return (SFX[n] || SFX_SAMPLES[n]) ? n : 'item_default';
}

/** BOSS 技能的元素 → 音效名（对应 public/audio/sfx/boss_*.wav） */
export function bossSkillSfx(visual) {
  switch (visual) {
    case 'fire': return 'boss_fire';
    case 'ice': return 'boss_ice';
    case 'thunder': return 'boss_thunder';
    case 'water': return 'boss_water';
    default: return 'boss_magic';
  }
}

export const audio = new AudioEngine();

/** 全部音效名（验收脚本逐条试播用） */
export const SFX_NAMES = Object.keys(SFX);

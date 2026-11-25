// 正式账号：用户名 + 密码（盐 + scrypt 哈希）+ 一次性备用码。
//
// 不存明文密码。家里 JSON / MySQL 是权威；线上 Render 的 remote store 会把
// 注册 / 登录 / 重置 / 会话校验统一转发到家里 /lb-api/auth，不在两端各存一份。
//
// 钱包主键用账号 uid，不再用浏览器本地 uid；玩家改名不影响积分。

import crypto from 'node:crypto';

const USER_RE = /^[\u4e00-\u9fa5A-Za-z0-9_]{3,16}$/;
// 昵称是进房间 / 右上角显示的名字，和游戏内改名输入框一样限制 2~10 位。
// 用户名和密码只当登录令牌用，不对外展示。
const NICK_RE = /^[\u4e00-\u9fa5A-Za-z0-9_]{2,10}$/;
const MAX_TOKENS = 3000;

function keyOf(user) {
  return String(user ?? '').trim().toLowerCase();
}

function hashSecret(secret, salt = crypto.randomBytes(16)) {
  return {
    salt: salt.toString('hex'),
    hash: crypto.scryptSync(String(secret), salt, 32).toString('hex'),
  };
}

function verifySecret(secret, rec) {
  try {
    const salt = Buffer.from(rec?.salt || '', 'hex');
    const want = Buffer.from(rec?.hash || '', 'hex');
    if (salt.length !== 16 || want.length !== 32) return false;
    const got = crypto.scryptSync(String(secret), salt, 32);
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  } catch { return false; }
}

function newBackupCode() {
  return crypto.randomBytes(8).toString('hex').toUpperCase();
}

export function createAccounts({ store, db }) {
  let accounts = db?.accounts || (db ? (db.accounts = {}) : {});
  let tokens = db?.tokens || (db ? (db.tokens = {}) : {});
  const proxy = typeof store?.authRequest === 'function';

  async function sync() {
    if (proxy || !store?.readAll) return;
    let data = null;
    try { data = await store.readAll(); } catch { return; }
    if (data?.accounts) { accounts = data.accounts; if (db) db.accounts = accounts; }
    if (data?.tokens) { tokens = data.tokens; if (db) db.tokens = tokens; }
  }

  function issueToken(acc) {
    const token = 't' + crypto.randomBytes(24).toString('base64url');
    tokens[token] = { uid: acc.uid, user: acc.user, at: Date.now() };
    const ids = Object.keys(tokens);
    for (let i = 0; i < ids.length - MAX_TOKENS; i++) delete tokens[ids[i]];
    store?.writeToken?.(token, tokens[token]);
    return token;
  }

  function publicAcc(acc) {
    // nick：进游戏展示的昵称；老账号没有这个字段就退回用户名，不会报错
    return { uid: acc.uid, user: acc.user, nick: acc.nick || acc.user };
  }

  return {
    async register(userRaw, pass, nickRaw) {
      if (proxy) return store.authRequest('register', { user: userRaw, pass, nick: nickRaw });
      const user = String(userRaw ?? '').trim();
      if (!USER_RE.test(user)) return { ok: false, error: '用户名需 3~16 位中文 / 字母 / 数字 / 下划线' };
      // 昵称必填（老客户端不传时退回用户名，保持兼容）
      const nick = String(nickRaw ?? '').trim() || user;
      if (!NICK_RE.test(nick)) return { ok: false, error: '昵称需 2~10 位中文 / 字母 / 数字 / 下划线' };
      const passStr = String(pass ?? '');
      if (passStr.length < 6 || passStr.length > 32) return { ok: false, error: '密码需 6~32 位' };
      const key = keyOf(user);
      await sync();
      if (accounts[key]) return { ok: false, error: '这个用户名已经有人用了' };
      const uid = 'u_' + crypto.randomBytes(10).toString('hex');
      const backup = newBackupCode();
      const acc = {
        uid, user, nick,
        ...hashSecret(passStr),
        backup: hashSecret(backup),
        backupUsed: false,
        createdAt: Date.now(),
        at: Date.now(),
      };
      accounts[key] = acc;
      store?.writeAccount?.(key, acc);
      return { ok: true, ...publicAcc(acc), token: issueToken(acc), backupCode: backup };
    },

    async login(userRaw, pass) {
      if (proxy) return store.authRequest('login', { user: userRaw, pass });
      const key = keyOf(userRaw);
      await sync();
      const acc = accounts[key];
      if (!acc || !verifySecret(pass, acc)) return { ok: false, error: '用户名或密码不对' };
      return { ok: true, ...publicAcc(acc), token: issueToken(acc) };
    },

    async reset(userRaw, code, pass) {
      if (proxy) return store.authRequest('reset', { user: userRaw, code, pass });
      const key = keyOf(userRaw);
      await sync();
      const acc = accounts[key];
      if (!acc || acc.backupUsed || !verifySecret(code, acc.backup)) {
        return { ok: false, error: '备用码不对或已经用过' };
      }
      const passStr = String(pass ?? '');
      if (passStr.length < 6 || passStr.length > 32) return { ok: false, error: '新密码需 6~32 位' };
      Object.assign(acc, hashSecret(passStr), { backupUsed: true, at: Date.now() });
      store?.writeAccount?.(key, acc);
      return { ok: true, ...publicAcc(acc), token: issueToken(acc) };
    },

    async session(token) {
      if (proxy) {
        const res = await store.authRequest('session', { token });
        return res?.ok ? { ok: true, uid: res.uid, user: res.user, nick: res.nick || res.user } : null;
      }
      const t = String(token ?? '');
      if (!t) return null;
      await sync();
      const rec = tokens[t];
      if (!rec) return null;
      const acc = Object.values(accounts).find((a) => a.uid === rec.uid);
      if (!acc) return null;
      // ok 必须带上：HTTP /auth/session 直接把返回值当响应体，客户端靠 ok 判断 token 是否有效，
      // 漏了它会被当成"会话失效"而在启动时把 token 删掉。
      return { ok: true, ...publicAcc(acc) };
    },

    raw() { return { accounts, tokens }; },
  };
}

// 浏览器 E2E 的账号抓手：入口强制登录后，探针必须先拿到一个真实 token。
//
// 为什么不能用占位串：页面加载时 main.js 会拿 localStorage 里的 token 去
// /auth/session 验一次，验不过就删掉 —— 占位 token 一定验不过，等于没登录。
//
// 注册重名就登录，两种情况都返回可用 token；失败返回 ''（调用方自己报错）。

const PASS = 'sail123456';

export async function ensureTestAccount(base, user = 'e2e探针', pass = PASS) {
  const url = String(base).replace(/\/+$/, '');
  const post = async (action, body) => {
    try {
      const r = await fetch(`${url}/auth/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return await r.json();
    } catch { return null; }
  };
  const reg = await post('register', { user, pass });
  if (reg?.ok && reg.token) return reg.token;
  const login = await post('login', { user, pass });
  return login?.ok ? login.token : '';
}

/** 拼一段直接塞进页面执行的 localStorage 初始化表达式 */
export function seedExpr({ name, token }) {
  const esc = (v) => String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return `localStorage.setItem('rr-name','${esc(name)}'); localStorage.setItem('rr-account-token','${esc(token)}'); 1`;
}

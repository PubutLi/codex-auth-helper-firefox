// inject.js — 在 chatgpt.com 标签页的同源 context 里执行
// Firefox 的 scripting.executeScript 只支持 files，不支持 func，所以必须独立文件
// 以 IIFE 形式运行，return 的对象作为 executeScript 的 result
(async () => {
  try {
    const r = await fetch('/api/auth/session', {
      method: 'GET',
      credentials: 'same-origin',
      headers: { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' }
    });
    if (r.status === 401 || r.status === 403) {
      return { ok: false, error: 'UNAUTHORIZED' };
    }
    if (!r.ok) {
      return { ok: false, error: 'HTTP 异常，状态码: ' + r.status };
    }
    const data = await r.json();
    if (!data || !data.accessToken) {
      return { ok: false, error: 'UNAUTHORIZED' };
    }
    return { ok: true, data: data };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
})();

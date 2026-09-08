// popup.js — Firefox / Chrome 双兼容
// 直接用 chrome.*（Firefox 临时加载扩展有完整兼容层）

let globalSession = null;
let countdownInterval = null;

document.addEventListener('DOMContentLoaded', () => {
  initSessionFetch();
  bindEvents();
});

async function initSessionFetch() {
  showState('loading');
  try {
    const response = await chrome.runtime.sendMessage({ action: 'fetch_session' });
    if (response && response.success) {
      globalSession = response.data;
      renderAuthorizedState(response.data);
      showState('authorized');
    } else {
      showState('unauthorized', response && response.error);
    }
  } catch (e) {
    console.error('[CodexHelper] 通信错误:', e);
    showState('unauthorized', e.message || String(e));
  }
}

function showState(state, errorMsg) {
  const ids = ['state-loading', 'state-unauthorized', 'state-authorized'];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el) el.classList.remove('active');
  }
  const map = { loading: 'state-loading', unauthorized: 'state-unauthorized', authorized: 'state-authorized' };
  if (map[state]) document.getElementById(map[state]).classList.add('active');

  if (state === 'unauthorized' && errorMsg) {
    const desc = document.querySelector('#state-unauthorized .state-desc');
    if (desc) {
      desc.innerHTML = '错误信息：<code style="color:#ff6b6b;font-size:11px;">' +
                       escapeHtml(errorMsg) + '</code>' +
                       '<br><br>请先登录 ChatGPT 账号。';
    }
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

function renderAuthorizedState(session) {
  const avatarEl = document.getElementById('user-avatar');
  const nameEl = document.getElementById('user-name');
  const emailEl = document.getElementById('user-email');
  const planEl = document.getElementById('badge-plan');
  const expiresEl = document.getElementById('token-expires');

  const user = session.user || {};
  if (avatarEl) avatarEl.src = user.image || 'https://lh3.googleusercontent.com/a/default-user=s96-c';
  if (nameEl) nameEl.textContent = user.name || 'ChatGPT 用户';
  if (emailEl) emailEl.textContent = user.email || '未绑定邮箱';

  const account = session.account || {};
  const planType = (account.planType || 'free').toUpperCase();
  if (planEl) {
    planEl.textContent = planType;
    planEl.className = (planType === 'PLUS' || planType === 'PRO') ? 'plan-badge plus' : 'plan-badge free';
  }

  const expiresTime = session.expires ? new Date(session.expires) : null;
  if (expiresTime && expiresEl) {
    expiresEl.textContent = formatLocalDate(expiresTime);
    startCountdown(expiresTime);
  } else if (expiresEl) {
    expiresEl.textContent = '长期有效';
    const cd = document.getElementById('token-countdown');
    if (cd) cd.textContent = '无限';
  }
}

function bindEvents() {
  const btnLogin = document.getElementById('btn-login');
  if (btnLogin) {
    btnLogin.addEventListener('click', () => {
      // 委托给 background 创建 tab（避免 popup 自身缺 tabs 权限问题）
      chrome.runtime.sendMessage({ action: 'open_tab', url: 'https://chatgpt.com/' });
      window.close();
    });
  }

  const btnDownload = document.getElementById('btn-download');
  if (btnDownload) {
    btnDownload.addEventListener('click', async () => {
      if (!globalSession) return;
      const authJsonString = generateCodexAuthJson(globalSession);

      // 用 anchor download 直接触发：blob URL 在 popup 的 document scope，
      // 比走 background 的 downloads.download(blob URL) 稳——后者跨 scope 读 blob 会失败
      try {
        const blob = new Blob([authJsonString], { type: 'application/json' });
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = 'auth.json';
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        // 延迟 revoke，等浏览器读完 blob
        setTimeout(() => { try { URL.revokeObjectURL(blobUrl); } catch (e) {} }, 5000);
        showToast('🎉 auth.json 已开始下载');
      } catch (e) {
        console.error('[CodexHelper] 下载异常:', e);
        showToast('❌ 下载失败：' + (e.message || String(e)));
      }
    });
  }
}

function startCountdown(expiresTime) {
  if (countdownInterval) clearInterval(countdownInterval);
  const countdownEl = document.getElementById('token-countdown');
  if (!countdownEl) return;
  function update() {
    const diff = expiresTime - new Date();
    if (diff <= 0) {
      countdownEl.textContent = '已过期';
      countdownEl.className = 'detail-value text-danger';
      clearInterval(countdownInterval);
      return;
    }
    const days = Math.floor(diff / 86400000);
    const hours = Math.floor((diff % 86400000) / 3600000);
    const minutes = Math.floor((diff % 3600000) / 60000);
    const seconds = Math.floor((diff % 60000) / 1000);
    let s = '';
    if (days > 0) s += `${days}天`;
    if (hours > 0 || days > 0) s += `${hours}时`;
    s += `${minutes}分${seconds}秒`;
    countdownEl.textContent = s;
  }
  update();
  countdownInterval = setInterval(update, 1000);
}

function formatLocalDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function generateCodexAuthJson(session) {
  const accountId = session.account?.id || '';
  const email = session.user?.email || '';
  const planType = session.account?.planType || 'free';
  const iat = Math.floor(Date.now() / 1000);
  const exp = session.expires ? Math.floor(new Date(session.expires).getTime() / 1000) : iat + 30 * 86400;

  const jwtHeader = { alg: 'none', typ: 'JWT', cpa_synthetic: true };
  const jwtPayload = {
    iat, exp,
    "https://api.openai.com/auth": {
      chatgpt_account_id: accountId,
      chatgpt_plan_type: planType,
      chatgpt_user_id: session.user?.id || '',
      user_id: session.user?.id || ''
    },
    email
  };
  const b64 = (o) => btoa(unescape(encodeURIComponent(JSON.stringify(o))))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const idToken = `${b64(jwtHeader)}.${b64(jwtPayload)}.synthetic`;

  return JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: idToken,
      access_token: session.accessToken,
      refresh_token: session.sessionToken || "placeholder",
      account_id: accountId
    },
    last_refresh: new Date().toISOString()
  }, null, 2);
}

function showToast(message) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  const toastMsg = document.getElementById('toast-message');
  if (toastMsg) toastMsg.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2000);
}

// background.js — Firefox / Chrome 双兼容
// Firefox 临时加载扩展的 background script 有完整的 chrome.* API 兼容层
// 直接用 chrome.* 是最稳的方式，不要再"探测 browser"了

const IS_FIREFOX = (typeof browser !== "undefined" && browser.runtime && browser.runtime.getBrowserInfo);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'fetch_session') {
    fetchChatGPTSession()
      .then(sessionData => sendResponse({ success: true, data: sessionData }))
      .catch(error => {
        const msg = (error && error.message) || String(error);
        console.error('[CodexHelper] fetch_session 失败:', msg, error);
        sendResponse({ success: false, error: msg });
      });
    return true; // 保持异步通道
  }

  if (message.action === 'download_auth_json') {
    const jsonText = message.jsonContent;
    // 关键：用 Blob + URL.createObjectURL 生成 blob URL，Chrome 和 Firefox 都接受
    // - data: URL 在 Firefox 被 downloads.download 拒绝
    // - body 字段是 POST 请求 body，不能替代 url
    // - blob URL 是唯一通用解
    const blob = new Blob([jsonText], { type: 'application/json' });
    const blobUrl = URL.createObjectURL(blob);
    const downloadOptions = {
      url: blobUrl,
      filename: 'auth.json',
      saveAs: false,
      conflictAction: 'overwrite'
    };
    const cleanup = (idOrErr) => {
      // 释放 blob URL
      try { URL.revokeObjectURL(blobUrl); } catch (e) { /* ignore */ }
      return idOrErr;
    };

    if (IS_FIREFOX) {
      browser.downloads.download(downloadOptions)
        .then(id => { sendResponse({ success: true, downloadId: cleanup(id) }); })
        .catch(err => {
          console.error('[CodexHelper] 下载异常:', err);
          cleanup(null);
          sendResponse({ success: false, error: err.message || String(err) });
        });
    } else {
      chrome.downloads.download(downloadOptions, (downloadId) => {
        if (chrome.runtime.lastError) {
          console.error('[CodexHelper] 下载异常:', chrome.runtime.lastError);
          cleanup(null);
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
          return;
        }
        sendResponse({ success: true, downloadId: cleanup(downloadId) });
      });
    }
    return true;
  }

  if (message.action === 'open_tab' && message.url) {
    chrome.tabs.create({ url: message.url, active: true });
    sendResponse({ success: true });
    return false; // 同步
  }
});

async function fetchChatGPTSession() {
  console.log('[CodexHelper] fetch_session 开始');

  const target = await ensureChatGPTTab();
  console.log('[CodexHelper] 目标 tab:', target.id, target.url, 'status:', target.status);

  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: target.id },
      files: ['inject.js']
    });
  } catch (e) {
    console.error('[CodexHelper] executeScript 抛错:', e);
    throw new Error('executeScript 失败: ' + e.message);
  }

  console.log('[CodexHelper] executeScript 返回:', JSON.stringify(results).slice(0, 300));

  if (!Array.isArray(results) || results.length === 0) {
    throw new Error('注入无结果（results 空数组）');
  }
  const ret = results[0];
  if (!ret || typeof ret !== 'object') {
    throw new Error('注入无结果（results[0] 不是对象）');
  }
  // executeScript 返回 [{frameId, result: <注入返回值>}]，真正的值在 .result
  const inner = ret.result;
  if (!inner || typeof inner !== 'object') {
    throw new Error('注入 result 字段不是对象');
  }
  if (!inner.ok) {
    throw new Error(inner.error || '注入返回失败');
  }
  return inner.data;
}

async function ensureChatGPTTab() {
  const found = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
  console.log('[CodexHelper] tabs.query 找到', found.length, '个 chatgpt.com 标签');
  if (found && found.length > 0) {
    const active = found.find(t => t.active) || found[0];
    // 如果是 complete，直接用；否则等加载完
    if (active.status === 'complete') return active;
    await waitForTabComplete(active.id);
    return active;
  }

  // 没有就后台开一个
  console.log('[CodexHelper] 没有 chatgpt.com 标签，新建一个');
  const created = await chrome.tabs.create({ url: 'https://chatgpt.com/', active: false });
  await waitForTabComplete(created.id);
  return created;
}

function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };

    chrome.tabs.get(tabId).then(tab => {
      if (tab && tab.status === 'complete') return finish();
      const listener = (updatedId, info) => {
        if (updatedId === tabId && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          finish();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); finish(); }, 30000);
    });
  });
}

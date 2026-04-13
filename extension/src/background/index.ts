function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function isTextJobBridgeURL(url: string): boolean {
  return /\/bridge\/(?:text-workers\/register|text-jobs\/(?:next|[^/]+\/(?:chunk|result)))(?:[?#]|$)/.test(url);
}

function shouldLogTextBridgeURL(url: string): boolean {
  return !/\/bridge\/text-jobs\/next(?:[?#]|$)/.test(url) && isTextJobBridgeURL(url);
}

function withOpenLinkTabHeaders(url: string, options: any, sender: chrome.runtime.MessageSender): any {
  if (!isTextJobBridgeURL(url)) return options;
  const headers = {
    ...((options && options.headers) || {}),
    ...(sender.tab?.id != null ? { 'X-OpenLink-Tab-Id': String(sender.tab.id) } : {}),
    ...(sender.tab?.windowId != null ? { 'X-OpenLink-Window-Id': String(sender.tab.windowId) } : {}),
    ...(sender.frameId != null ? { 'X-OpenLink-Frame-Id': String(sender.frameId) } : {}),
  };
  return { ...(options || {}), headers };
}

function logTextBridgeForward(url: string, sender: chrome.runtime.MessageSender, phase: string, extra: Record<string, unknown> = {}) {
  if (!shouldLogTextBridgeURL(url)) return;
  console.log('[OpenLink][Background][TextBridge]', phase, {
    tabId: sender.tab?.id ?? null,
    windowId: sender.tab?.windowId ?? null,
    frameId: sender.frameId ?? null,
    tabUrl: sender.tab?.url || '',
    requestUrl: url,
    ...extra,
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'FETCH') {
    const { url, options } = msg;
    const requestOptions = withOpenLinkTabHeaders(url, options, sender);
    logTextBridgeForward(url, sender, 'fetch start');
    fetch(url, requestOptions)
      .then(async r => ({ ok: r.ok, status: r.status, body: await r.text() }))
      .catch(e => ({ ok: false, status: 0, body: String(e) }))
      .then((resp) => {
        logTextBridgeForward(url, sender, 'fetch done', { ok: resp.ok, status: resp.status });
        sendResponse(resp);
      });
    return true;
  }
  if (msg.type === 'FETCH_BINARY') {
    const { url, options } = msg;
    const requestOptions = withOpenLinkTabHeaders(url, options, sender);
    fetch(url, requestOptions)
      .then(async (r) => ({
        ok: r.ok,
        status: r.status,
        bodyBase64: r.ok ? arrayBufferToBase64(await r.arrayBuffer()) : '',
        contentType: r.headers.get('content-type') || '',
        finalUrl: r.url || url,
      }))
      .catch((e) => ({ ok: false, status: 0, bodyBase64: '', contentType: '', finalUrl: url, error: String(e) }))
      .then(sendResponse);
    return true;
  }
  return false;
});

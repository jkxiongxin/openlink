function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'FETCH') {
    const { url, options } = msg;
    fetch(url, options)
      .then(async r => ({ ok: r.ok, status: r.status, body: await r.text() }))
      .catch(e => ({ ok: false, status: 0, body: String(e) }))
      .then(sendResponse);
    return true;
  }
  if (msg.type === 'FETCH_BINARY') {
    const { url, options } = msg;
    fetch(url, options)
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

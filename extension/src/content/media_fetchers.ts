import { debugLog } from './debug_log';
import { sleep } from './dom_actions';
import { bgFetchBinary } from './runtime_bridge';

export async function fetchQwenImageWithRetry(imageURL: string): Promise<{ bodyBase64: string; contentType: string; finalUrl: string }> {
  const strategies = [
    { name: 'omit', options: { credentials: 'omit', redirect: 'follow' } },
    { name: 'include', options: { credentials: 'include', redirect: 'follow' } },
    { name: 'default', options: { redirect: 'follow' } },
  ] as const;
  let lastError = 'unknown error';
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) await sleep(1000 * attempt);
    for (const strategy of strategies) {
      const resp = await bgFetchBinary(imageURL, strategy.options);
      if (resp.ok && resp.bodyBase64) {
        debugLog('qwen 图片抓取策略成功', {
          attempt,
          strategy: strategy.name,
          status: resp.status,
          contentType: resp.contentType,
          finalUrl: resp.finalUrl,
        });
        return {
          bodyBase64: resp.bodyBase64,
          contentType: resp.contentType || 'image/png',
          finalUrl: resp.finalUrl || imageURL,
        };
      }
      lastError = resp.error || `HTTP ${resp.status}`;
      debugLog('qwen 图片抓取策略失败', { attempt, strategy: strategy.name, error: lastError });
    }
  }
  throw new Error(`qwen image fetch failed: ${lastError}`);
}

export async function fetchGeminiOriginalImageWithRetry(originalURL: string): Promise<{ bodyBase64: string; contentType: string; finalUrl: string }> {
  const maxAttempts = 3;
  let lastError = 'unknown error';
  const strategies = [
    {
      name: 'omit',
      options: {
        credentials: 'omit',
        redirect: 'follow',
        referrer: 'https://gemini.google.com/',
        referrerPolicy: 'no-referrer-when-downgrade',
      },
    },
    {
      name: 'include',
      options: {
        credentials: 'include',
        redirect: 'follow',
        referrer: 'https://gemini.google.com/',
        referrerPolicy: 'no-referrer-when-downgrade',
      },
    },
  ] as const;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      const delayMs = 1200 * attempt;
      debugLog('gemini 无水印原图抓取重试等待', { attempt, delayMs, url: originalURL });
      await sleep(delayMs);
    }
    for (const strategy of strategies) {
      const mediaResp = await bgFetchBinary(originalURL, strategy.options);
      if (mediaResp.ok && mediaResp.bodyBase64) {
        debugLog('gemini 无水印原图抓取成功', {
          attempt,
          strategy: strategy.name,
          status: mediaResp.status,
          url: originalURL,
          finalUrl: mediaResp.finalUrl,
          contentType: mediaResp.contentType,
        });
        return mediaResp;
      }
      lastError = `HTTP ${mediaResp.status}${mediaResp.error ? ` ${mediaResp.error}` : ''}`;
      debugLog('gemini 无水印原图抓取失败', {
        attempt,
        strategy: strategy.name,
        url: originalURL,
        error: lastError,
      });
    }
  }
  throw new Error(`gemini original image fetch failed after retry: ${lastError}`);
}

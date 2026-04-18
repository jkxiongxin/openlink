import { debugLog } from './debug_log';
import { clickElementLikeUser, waitForElement } from './dom_actions';
import { fetchGeminiOriginalImageWithRetry } from './media_fetchers';
import { blobToBase64, guessMediaExtension } from './media_utils';
import type { BgFetchResponse } from './runtime_bridge';
import type { SiteConfig } from './site_adapters';
import { showToast } from './ui_feedback';

type Fetcher = (url: string, options?: any) => Promise<BgFetchResponse>;

interface GeminiWorkerDeps {
  bgFetch: Fetcher;
  getStoredConfig(keys: string[]): Promise<Record<string, any>>;
  isExtensionContextInvalidated(): boolean;
  handleExtensionContextError(error: unknown): void;
  getSiteConfig(): SiteConfig;
  getSendButtonForEditor(editor: HTMLElement, sendBtnSel: string): HTMLElement | null;
  getEditorText(editor: HTMLElement): string;
  resetGeminiMediaCapture(): void;
  getGeminiMediaSeq(): number;
  setGeminiPrompt(editor: HTMLElement, text: string): Promise<void>;
  clearGeminiReferenceImages(editor: HTMLElement): Promise<void>;
  getGeminiAttachmentCount(editor: HTMLElement): number;
  ensureGeminiImageMode(editor: HTMLElement): Promise<boolean>;
  attachGeminiReferenceImages(editor: HTMLElement, items: any[], apiUrl: string, authToken: string): Promise<void>;
  waitForGeminiAttachmentReady(editor: HTMLElement, count: number, timeoutMs: number): Promise<boolean>;
  getGeminiAttachmentState(editor: HTMLElement): Record<string, unknown>;
  getGeminiImageKeys(): string[];
  waitForGeminiOriginalMediaURL(seq: number, timeoutMs: number): Promise<string>;
  waitForNewGeminiImage(keys: string[] | Set<string>, timeoutMs: number): Promise<HTMLImageElement>;
}

export function createGeminiWorker(deps: GeminiWorkerDeps) {
  function startGeminiImageWorker(): void {
    let running = false;
    let stopped = false;
    debugLog('gemini 图片 worker 已启动');

    const tick = async () => {
      if (running || stopped || deps.isExtensionContextInvalidated()) return;
      running = true;
      try {
        const { authToken, apiUrl } = await deps.getStoredConfig(['authToken', 'apiUrl']);
        if (!authToken || !apiUrl) {
          debugLog('gemini 跳过轮询，缺少配置', { hasAuthToken: !!authToken, hasApiUrl: !!apiUrl });
          return;
        }
        const headers: Record<string, string> = { Authorization: `Bearer ${authToken}` };
        const resp = await deps.bgFetch(`${apiUrl}/bridge/image-jobs/next?site_id=gemini`, { headers });
        if (!resp.ok) {
          debugLog('gemini 拉取任务失败', { status: resp.status });
          return;
        }
        const payload = JSON.parse(resp.body || '{}');
        const job = payload.job;
        if (!job?.id || !job?.prompt) return;
        debugLog('gemini 收到媒体任务', {
          id: job.id,
          mediaKind: job.media_kind || 'image',
          prompt: String(job.prompt).slice(0, 120),
        });
        try {
          await runGeminiImageJob(job, apiUrl, authToken);
        } catch (err) {
          debugLog('gemini 任务执行失败，准备回传错误', { id: job.id, error: err instanceof Error ? err.message : String(err) });
          await deps.bgFetch(`${apiUrl}/bridge/image-jobs/${encodeURIComponent(job.id)}/result`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${authToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
          });
          throw err;
        }
      } catch (err) {
        deps.handleExtensionContextError(err);
        if (deps.isExtensionContextInvalidated()) {
          stopped = true;
          return;
        }
        console.warn('[OpenLink] gemini image worker error:', err);
        debugLog('gemini worker 异常', err instanceof Error ? err.message : String(err));
      } finally {
        running = false;
      }
    };

    void tick();
    const intervalId = window.setInterval(() => {
      if (stopped || deps.isExtensionContextInvalidated()) {
        window.clearInterval(intervalId);
        return;
      }
      void tick();
    }, 2500);
  }

  async function runGeminiImageJob(job: any, apiUrl: string, authToken: string): Promise<void> {
    window.postMessage({ type: 'OPENLINK_SET_GEMINI_MEDIA_CAPTURE', data: { active: true } }, '*');
    try {
      const referenceImages = Array.isArray(job.reference_images) ? job.reference_images : [];
      showToast(`Gemini 开始处理图片: ${job.id}`, 2500);
      debugLog('gemini 开始执行图片任务', { id: job.id, referenceCount: referenceImages.length });
      deps.resetGeminiMediaCapture();
      let editor = await waitForElement<HTMLElement>('div.ql-editor[contenteditable="true"]', 20000);
      debugLog('gemini 已定位输入框');
      await deps.clearGeminiReferenceImages(editor);
      debugLog('gemini 已清理旧参考图', { remaining: deps.getGeminiAttachmentCount(editor) });
      const imageModeReady = await deps.ensureGeminiImageMode(editor);
      debugLog('gemini 制作图片模式检查完成', { imageModeReady });
      editor = await waitForElement<HTMLElement>('div.ql-editor[contenteditable="true"]', 20000);
      if (referenceImages.length > 0) {
        await deps.attachGeminiReferenceImages(editor, referenceImages, apiUrl, authToken);
        const stabilized = await deps.waitForGeminiAttachmentReady(editor, referenceImages.length, 15000);
        debugLog('gemini 参考图附加完成', {
          stabilized,
          ...deps.getGeminiAttachmentState(editor),
        });
        if (!stabilized) throw new Error('gemini reference image did not stabilize before prompt');
      } else {
        debugLog('gemini 本次任务无参考图');
      }
      const beforeKeys = deps.getGeminiImageKeys();
      const beforeMediaSeq = deps.getGeminiMediaSeq();
      debugLog('gemini 提交前图片 key 集合', beforeKeys);
      await deps.setGeminiPrompt(editor, String(job.prompt));
      debugLog('gemini Prompt 已写入', { prompt: String(job.prompt).slice(0, 120), editorText: deps.getEditorText(editor).slice(0, 120) });
      const sendBtn = deps.getSendButtonForEditor(editor, deps.getSiteConfig().sendBtn);
      if (!sendBtn) throw new Error('gemini send button not found');
      debugLog('gemini 已定位发送按钮', { text: (sendBtn.textContent || '').trim().slice(0, 60) });
      await clickElementLikeUser(sendBtn);
      debugLog('gemini 已触发发送按钮点击');

      const imageEl = await deps.waitForNewGeminiImage(beforeKeys, 180000);
      const imageSrc = imageEl.getAttribute('src');
      if (!imageSrc) throw new Error('gemini generated image src missing');
      debugLog('gemini 检测到新图片', { src: imageSrc });

      debugLog('gemini 新图已出现，继续等待无水印原图 URL', { previousSeq: beforeMediaSeq, timeoutMs: 120000 });
      const originalURL = await deps.waitForGeminiOriginalMediaURL(beforeMediaSeq, 120000).catch(() => '');
      let base64: string;
      let mimeType: string;
      let sourceURL: string;
      if (originalURL) {
        debugLog('gemini 使用无水印原图 URL', { url: originalURL });
        const originalMediaResp = await fetchGeminiOriginalImageWithRetry(originalURL);
        sourceURL = originalMediaResp.finalUrl || originalURL;
        base64 = originalMediaResp.bodyBase64;
        mimeType = originalMediaResp.contentType || 'image/png';
      } else {
        debugLog('gemini 等待无水印原图 URL 超时，回退页面 blob 图片', { src: imageSrc });
        sourceURL = new URL(imageSrc, location.href).toString();
        const blob = await fetch(sourceURL).then(async (response) => {
          if (!response.ok) throw new Error(`gemini image fetch failed: HTTP ${response.status}`);
          return response.blob();
        });
        base64 = await blobToBase64(blob);
        mimeType = blob.type || 'image/png';
      }
      const fileName = `${job.id}${guessMediaExtension(mimeType, sourceURL)}`;

      const resultResp = await deps.bgFetch(`${apiUrl}/bridge/image-jobs/${encodeURIComponent(job.id)}/result`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          file_name: fileName,
          mime_type: mimeType,
          data: base64,
        }),
      });
      if (!resultResp.ok) throw new Error(`gemini image result upload failed: HTTP ${resultResp.status}`);
      debugLog('gemini 图片结果回传成功', { fileName, status: resultResp.status });
      showToast(`Gemini 图片已保存: ${fileName}`, 3500);
    } finally {
      window.postMessage({ type: 'OPENLINK_SET_GEMINI_MEDIA_CAPTURE', data: { active: false } }, '*');
    }
  }

  return { startGeminiImageWorker };
}

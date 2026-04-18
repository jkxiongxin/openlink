import { debugLog } from './debug_log';
import { clickElementLikeUser, sleep, waitForElement } from './dom_actions';
import { fetchQwenImageWithRetry } from './media_fetchers';
import { guessMediaExtension } from './media_utils';
import type { BgFetchResponse } from './runtime_bridge';
import { showToast } from './ui_feedback';

type Fetcher = (url: string, options?: any) => Promise<BgFetchResponse>;

interface QwenWorkerDeps {
  bgFetch: Fetcher;
  getStoredConfig(keys: string[]): Promise<Record<string, any>>;
  isExtensionContextInvalidated(): boolean;
  handleExtensionContextError(error: unknown): void;
  clearQwenComposerAttachments(editor: HTMLElement): Promise<void>;
  getQwenComposerAttachmentCount(editor: HTMLElement): number;
  attachQwenReferenceImages(editor: HTMLElement, items: any[], apiUrl: string, authToken: string): Promise<void>;
  setQwenPrompt(editor: HTMLTextAreaElement, text: string): void;
  waitForQwenSendButton(editor: HTMLElement, timeoutMs: number): Promise<HTMLElement | null>;
  getQwenImageKeys(): string[];
  waitForNewQwenImage(keys: string[] | Set<string>, timeoutMs: number): Promise<HTMLImageElement>;
}

export function createQwenWorker(deps: QwenWorkerDeps) {
  function startQwenImageWorker(): void {
    let running = false;
    let stopped = false;
    debugLog('qwen 图片 worker 已启动');

    const tick = async () => {
      if (running || stopped || deps.isExtensionContextInvalidated()) return;
      running = true;
      try {
        const { authToken, apiUrl } = await deps.getStoredConfig(['authToken', 'apiUrl']);
        if (!authToken || !apiUrl) {
          debugLog('qwen 跳过轮询，缺少配置', { hasAuthToken: !!authToken, hasApiUrl: !!apiUrl });
          return;
        }
        const headers: Record<string, string> = { Authorization: `Bearer ${authToken}` };
        const resp = await deps.bgFetch(`${apiUrl}/bridge/image-jobs/next?site_id=qwen`, { headers });
        if (!resp.ok) {
          debugLog('qwen 拉取任务失败', { status: resp.status });
          return;
        }
        const payload = JSON.parse(resp.body || '{}');
        const job = payload.job;
        if (!job?.id || !job?.prompt) return;
        debugLog('qwen 收到媒体任务', {
          id: job.id,
          mediaKind: job.media_kind || 'image',
          prompt: String(job.prompt).slice(0, 120),
        });
        try {
          await runQwenImageJob(job, apiUrl, authToken);
        } catch (err) {
          debugLog('qwen 任务执行失败，准备回传错误', { id: job.id, error: err instanceof Error ? err.message : String(err) });
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
        console.warn('[OpenLink] qwen image worker error:', err);
        debugLog('qwen worker 异常', err instanceof Error ? err.message : String(err));
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

  async function runQwenImageJob(job: any, apiUrl: string, authToken: string): Promise<void> {
    const mediaKind = String(job.media_kind || 'image');
    if (mediaKind !== 'image') throw new Error(`qwen unsupported media kind: ${mediaKind}`);

    const referenceImages = Array.isArray(job.reference_images) ? job.reference_images : [];
    showToast(`Qwen 开始处理图片: ${job.id}`, 2500);
    debugLog('qwen 开始执行图片任务', { id: job.id, referenceCount: referenceImages.length });

    const editor = await waitForElement<HTMLTextAreaElement>('textarea.message-input-textarea, .message-input-container textarea', 20000);
    debugLog('qwen 已定位输入框');
    await deps.clearQwenComposerAttachments(editor);
    debugLog('qwen 已清理旧参考图', { remaining: deps.getQwenComposerAttachmentCount(editor) });

    if (referenceImages.length > 0) {
      await deps.attachQwenReferenceImages(editor, referenceImages, apiUrl, authToken);
    } else {
      debugLog('qwen 本次任务无参考图');
    }

    const beforeKeys = deps.getQwenImageKeys();
    debugLog('qwen 提交前图片 key 集合', beforeKeys);

    deps.setQwenPrompt(editor, String(job.prompt));
    await sleep(250);
    debugLog('qwen Prompt 已写入', { prompt: String(job.prompt).slice(0, 120), editorText: editor.value.slice(0, 120) });

    const sendBtn = await deps.waitForQwenSendButton(editor, 90000);
    if (!sendBtn) throw new Error('qwen send button not found');
    debugLog('qwen 已定位发送按钮', {
      disabled: (sendBtn as HTMLButtonElement).disabled,
      className: sendBtn.className,
      text: (sendBtn.textContent || '').trim().slice(0, 60),
    });
    await clickElementLikeUser(sendBtn);
    debugLog('qwen 已触发发送按钮点击');

    const imageEl = await deps.waitForNewQwenImage(beforeKeys, 300000);
    const imageSrc = imageEl.currentSrc || imageEl.getAttribute('src') || '';
    if (!imageSrc) throw new Error('qwen generated image src missing');
    debugLog('qwen 检测到新图片', { src: imageSrc, alt: imageEl.getAttribute('alt') || '' });

    const absoluteURL = new URL(imageSrc, location.href).toString();
    const imageResp = await fetchQwenImageWithRetry(absoluteURL);
    const mimeType = imageResp.contentType || 'image/png';
    const finalUrl = imageResp.finalUrl || absoluteURL;
    const fileName = `${job.id}${guessMediaExtension(mimeType, finalUrl)}`;
    debugLog('qwen 图片抓取成功', { contentType: mimeType, finalUrl });

    const resultResp = await deps.bgFetch(`${apiUrl}/bridge/image-jobs/${encodeURIComponent(job.id)}/result`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        file_name: fileName,
        mime_type: mimeType,
        data: imageResp.bodyBase64,
      }),
    });
    if (!resultResp.ok) throw new Error(`qwen image result upload failed: HTTP ${resultResp.status}`);
    debugLog('qwen 图片结果回传成功', { fileName, status: resultResp.status });
    showToast(`Qwen 图片已保存: ${fileName}`, 3500);
  }

  return { startQwenImageWorker };
}

import { debugLog } from './debug_log';
import { clickElementLikeUser, waitForElement } from './dom_actions';
import { guessMediaExtension } from './media_utils';
import type { BgFetchBinaryResponse, BgFetchResponse } from './runtime_bridge';
import { showToast } from './ui_feedback';

type Fetcher = (url: string, options?: any) => Promise<BgFetchResponse>;
type FetchBinary = (url: string, options?: any) => Promise<BgFetchBinaryResponse>;

interface ChatGPTWorkerDeps {
  bgFetch: Fetcher;
  bgFetchBinary: FetchBinary;
  getStoredConfig(keys: string[]): Promise<Record<string, any>>;
  isExtensionContextInvalidated(): boolean;
  handleExtensionContextError(error: unknown): void;
  getEditorText(editor: HTMLElement): string;
  clearChatGPTComposerAttachments(editor: HTMLElement): Promise<void>;
  getChatGPTComposerAttachmentCount(editor: HTMLElement): number;
  attachChatGPTReferenceImages(editor: HTMLElement, items: any[], apiUrl: string, authToken: string): Promise<void>;
  setChatGPTPrompt(editor: HTMLElement, text: string): Promise<void>;
  waitForChatGPTSendButton(editor: HTMLElement, timeoutMs: number): Promise<HTMLElement | null>;
  getChatGPTImageKeys(): string[];
  waitForNewChatGPTImage(keys: string[] | Set<string>, timeoutMs: number): Promise<HTMLImageElement>;
}

export function createChatGPTWorker(deps: ChatGPTWorkerDeps) {
  function startChatGPTImageWorker(): void {
    let running = false;
    let stopped = false;
    debugLog('chatgpt 图片 worker 已启动');

    const tick = async () => {
      if (running || stopped || deps.isExtensionContextInvalidated()) return;
      running = true;
      try {
        const { authToken, apiUrl } = await deps.getStoredConfig(['authToken', 'apiUrl']);
        if (!authToken || !apiUrl) {
          debugLog('chatgpt 跳过轮询，缺少配置', { hasAuthToken: !!authToken, hasApiUrl: !!apiUrl });
          return;
        }
        const headers: Record<string, string> = { Authorization: `Bearer ${authToken}` };
        const resp = await deps.bgFetch(`${apiUrl}/bridge/image-jobs/next?site_id=chatgpt`, { headers });
        if (!resp.ok) {
          debugLog('chatgpt 拉取任务失败', { status: resp.status });
          return;
        }
        const payload = JSON.parse(resp.body || '{}');
        const job = payload.job;
        if (!job?.id || !job?.prompt) return;
        debugLog('chatgpt 收到媒体任务', {
          id: job.id,
          mediaKind: job.media_kind || 'image',
          prompt: String(job.prompt).slice(0, 120),
        });
        try {
          await runChatGPTImageJob(job, apiUrl, authToken);
        } catch (err) {
          debugLog('chatgpt 任务执行失败，准备回传错误', { id: job.id, error: err instanceof Error ? err.message : String(err) });
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
        console.warn('[OpenLink] chatgpt image worker error:', err);
        debugLog('chatgpt worker 异常', err instanceof Error ? err.message : String(err));
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

  async function runChatGPTImageJob(job: any, apiUrl: string, authToken: string): Promise<void> {
    const mediaKind = String(job.media_kind || 'image');
    if (mediaKind !== 'image') throw new Error(`chatgpt unsupported media kind: ${mediaKind}`);

    const referenceImages = Array.isArray(job.reference_images) ? job.reference_images : [];
    showToast(`ChatGPT 开始处理图片: ${job.id}`, 2500);
    debugLog('chatgpt 开始执行图片任务', { id: job.id, referenceCount: referenceImages.length });

    const editor = await waitForElement<HTMLElement>('#prompt-textarea.ProseMirror[contenteditable="true"], div.ProseMirror[contenteditable="true"][role="textbox"], #prompt-textarea', 20000);
    debugLog('chatgpt 已定位输入框');
    await deps.clearChatGPTComposerAttachments(editor);
    debugLog('chatgpt 已清理旧参考图', { remaining: deps.getChatGPTComposerAttachmentCount(editor) });

    if (referenceImages.length > 0) {
      await deps.attachChatGPTReferenceImages(editor, referenceImages, apiUrl, authToken);
    } else {
      debugLog('chatgpt 本次任务无参考图');
    }

    const beforeKeys = deps.getChatGPTImageKeys();
    debugLog('chatgpt 提交前图片 key 集合', beforeKeys);

    await deps.setChatGPTPrompt(editor, String(job.prompt));
    debugLog('chatgpt Prompt 已写入', { prompt: String(job.prompt).slice(0, 120), editorText: deps.getEditorText(editor).slice(0, 120) });

    const sendBtn = await deps.waitForChatGPTSendButton(editor, 90000);
    if (!sendBtn) throw new Error('chatgpt send button not found');
    debugLog('chatgpt 已定位发送按钮', {
      ariaLabel: sendBtn.getAttribute('aria-label') || '',
      text: (sendBtn.textContent || '').trim().slice(0, 60),
    });
    await clickElementLikeUser(sendBtn);
    debugLog('chatgpt 已触发发送按钮点击');

    const imageEl = await deps.waitForNewChatGPTImage(beforeKeys, 240000);
    const imageSrc = imageEl.currentSrc || imageEl.getAttribute('src') || '';
    if (!imageSrc) throw new Error('chatgpt generated image src missing');
    debugLog('chatgpt 检测到新图片', { src: imageSrc, alt: imageEl.getAttribute('alt') || '' });

    const absoluteURL = new URL(imageSrc, location.href).toString();
    const imageResp = await deps.bgFetchBinary(absoluteURL, {
      credentials: 'include',
      redirect: 'follow',
      referrer: 'https://chatgpt.com/',
    });
    if (!imageResp.ok || !imageResp.bodyBase64) {
      throw new Error(`chatgpt image fetch failed: ${imageResp.error || `HTTP ${imageResp.status}`}`);
    }
    const mimeType = imageResp.contentType || 'image/png';
    const finalUrl = imageResp.finalUrl || absoluteURL;
    const fileName = `${job.id}${guessMediaExtension(mimeType, finalUrl)}`;
    debugLog('chatgpt 图片抓取成功', { status: imageResp.status, contentType: mimeType, finalUrl });

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
    if (!resultResp.ok) throw new Error(`chatgpt image result upload failed: HTTP ${resultResp.status}`);
    debugLog('chatgpt 图片结果回传成功', { fileName, status: resultResp.status });
    showToast(`ChatGPT 图片已保存: ${fileName}`, 3500);
  }

  return { startChatGPTImageWorker };
}

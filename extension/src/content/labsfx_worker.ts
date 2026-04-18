import { countLabsFxReferenceCards, findLabsFxComposerRegion } from './labsfx_dom';
import {
  ensureLabsFxMode,
  getLabsFxTileKeys,
  getLabsFxTileMediaKey,
  getLabsFxVisibleResourceTiles,
  waitForNewLabsFxGeneratedMedia,
} from './labsfx_media_dom';
import { debugLog } from './debug_log';
import { clickElementLikeUser, sleep, waitForElement } from './dom_actions';
import { isVisibleElement, setContentEditableText } from './editor_dom';
import {
  canvasImageToMediaResponse,
  guessImageExtension,
  guessMediaExtension,
  type MediaBinaryResponse,
} from './media_utils';
import { referenceImageJobToFile, setFileInputFiles } from './reference_images';
import type { BgFetchBinaryResponse, BgFetchResponse } from './runtime_bridge';
import { defaultEditorRegion, type SiteConfig } from './site_adapters';
import { shortenHtml } from './text_utils';
import { showToast } from './ui_feedback';

type Fetcher = (url: string, options?: any) => Promise<BgFetchResponse>;
type FetchBinary = (url: string, options?: any) => Promise<BgFetchBinaryResponse>;
type LabsFxMediaKind = 'image' | 'video';
type LabsFxVideoMode = 'text' | 'reference' | 'start_end';

interface LabsFxWorkerDeps {
  bgFetch: Fetcher;
  bgFetchBinary: FetchBinary;
  getStoredConfig(keys: string[]): Promise<Record<string, any>>;
  isExtensionContextInvalidated(): boolean;
  handleExtensionContextError(error: unknown): void;
  getEditorText(editor: HTMLElement): string;
  getSiteConfig(): SiteConfig;
  getSendButtonForEditor(editor: HTMLElement, sendBtnSel: string): HTMLElement | null;
}

export function createLabsFxWorker(deps: LabsFxWorkerDeps) {
  let labsFxAPIHeaders: Record<string, string> = {};
  let labsFxProjectId = '';
  let labsFxReferencesInjectedReady = false;
  let labsFxGeneratePatchedSeq = 0;
  let labsFxVideoStatusSeq = 0;
  let labsFxLatestVideoStatus = '';
  let labsFxLatestVideoError = '';
  let labsFxWorkerStarted = false;

  function updateAPIHeaders(headers: Record<string, string>): void {
    labsFxAPIHeaders = {
      ...labsFxAPIHeaders,
      ...headers,
    };
  }

  function updateProjectId(projectId: string): void {
    labsFxProjectId = projectId;
  }

  function setReferencesInjectedReady(ready: boolean): void {
    labsFxReferencesInjectedReady = ready;
  }

  function incrementGeneratePatchedSeq(): number {
    labsFxGeneratePatchedSeq += 1;
    return labsFxGeneratePatchedSeq;
  }

  function updateVideoStatus(status: string, error: string): number {
    labsFxVideoStatusSeq += 1;
    labsFxLatestVideoStatus = status;
    labsFxLatestVideoError = error;
    return labsFxVideoStatusSeq;
  }

  function getDebugState(): { projectId: string; apiHeaderKeys: string[] } {
    return {
      projectId: labsFxProjectId,
      apiHeaderKeys: Object.keys(labsFxAPIHeaders),
    };
  }

  async function fetchLabsFxGeneratedMedia(
    mediaKind: LabsFxMediaKind,
    mediaEl: HTMLImageElement | HTMLVideoElement,
    absoluteUrl: string
  ): Promise<MediaBinaryResponse> {
    const mediaResp = await deps.bgFetchBinary(absoluteUrl, {
      credentials: 'omit',
      redirect: 'follow',
      referrer: location.origin,
      referrerPolicy: 'no-referrer-when-downgrade',
    });
    if (mediaResp.ok && mediaResp.bodyBase64) return mediaResp;

    if (mediaKind === 'image' && mediaEl instanceof HTMLImageElement) {
      debugLog('labsfx 图片 fetch 失败，回退 canvas 导出', {
        status: mediaResp.status,
        error: mediaResp.error || '',
        url: absoluteUrl,
      });
      return canvasImageToMediaResponse(mediaEl, absoluteUrl);
    }

    return mediaResp;
  }

  function startLabsFxImageWorker(): void {
    if (labsFxWorkerStarted) return;
    labsFxWorkerStarted = true;
    debugLog('labs.google/fx worker 已启动');
    let running = false;
    let stopped = false;

    const tick = async () => {
      if (running || stopped || deps.isExtensionContextInvalidated()) return;
      running = true;
      try {
        const { authToken, apiUrl } = await deps.getStoredConfig(['authToken', 'apiUrl']);
        if (!authToken || !apiUrl) {
          debugLog('labsfx 跳过轮询，缺少配置', { hasAuthToken: !!authToken, hasApiUrl: !!apiUrl });
          return;
        }
        const headers: Record<string, string> = { Authorization: `Bearer ${authToken}` };
        const resp = await deps.bgFetch(`${apiUrl}/bridge/image-jobs/next?site_id=labsfx`, { headers });
        if (!resp.ok) {
          debugLog('labsfx 拉取任务失败', { status: resp.status });
          return;
        }
        const payload = JSON.parse(resp.body || '{}');
        const job = payload.job;
        if (!job?.id || !job?.prompt) return;
        debugLog('labsfx 收到媒体任务', {
          id: job.id,
          mediaKind: job.media_kind || 'image',
          prompt: String(job.prompt).slice(0, 120),
        });
        try {
          await runLabsFxMediaJob(job, apiUrl, authToken);
        } catch (err) {
          debugLog('labsfx 任务执行失败，准备回传错误', { id: job.id, error: err instanceof Error ? err.message : String(err) });
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
        console.warn('[OpenLink] labs.google/fx media worker error:', err);
        debugLog('labsfx worker 异常', err instanceof Error ? err.message : String(err));
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

  async function runLabsFxMediaJob(job: any, apiUrl: string, authToken: string): Promise<void> {
    const mediaKind: LabsFxMediaKind = job?.media_kind === 'video' ? 'video' : 'image';
    const videoMode = mediaKind === 'video' ? resolveLabsFxVideoMode(job?.model) : 'text';
    showToast(`开始生成${mediaKind === 'video' ? '视频' : '图片'}: ${job.id}`, 2500);
    debugLog('labsfx 开始执行任务', { id: job.id, mediaKind, videoMode, model: job?.model || '' });
    const editor = await waitForElement<HTMLElement>('div[role="textbox"][data-slate-editor="true"][contenteditable="true"]', 20000);
    debugLog('labsfx 已定位输入框');
    await ensureLabsFxMode(editor, mediaKind);
    const referenceImages = Array.isArray(job.reference_images) ? job.reference_images : [];
    let uploadedReferenceMediaIds: string[] = [];
    await prepareLabsFxPromptArea(editor);
    if (referenceImages.length > 0) {
      debugLog('labsfx 开始附加参考图', { count: referenceImages.length });
      uploadedReferenceMediaIds = await attachLabsFxReferenceImages(editor, referenceImages, mediaKind, videoMode);
      debugLog('labsfx 参考图附加完成', { count: getLabsFxReferenceCardCount(editor) });
    } else {
      debugLog('labsfx 本次任务无参考图');
    }
    await setLabsFxPrompt(editor, String(job.prompt));
    debugLog('labsfx Prompt 已写入', { prompt: String(job.prompt).slice(0, 120), editorText: deps.getEditorText(editor).slice(0, 120) });
    if (referenceImages.length > 0) {
      refreshLabsFxComposerState(editor);
      debugLog('labsfx 已触发输入区刷新以同步参考图状态', { mediaKind });
      await sleep(180);
    }
    await sleep(300);
    const beforeKeys = getLabsFxTileKeys();
    const beforeVideoStatusSeq = labsFxVideoStatusSeq;
    debugLog(`labsfx 提交前${mediaKind === 'video' ? '媒体' : '图片'} key 集合`, beforeKeys);
    {
      const sendBtn = deps.getSendButtonForEditor(editor, deps.getSiteConfig().sendBtn);
      if (!sendBtn) throw new Error('labs.google/fx send button not found');
      debugLog('labsfx 已定位发送按钮', { text: (sendBtn.textContent || '').trim().slice(0, 60) });
      const patchedSeqBeforeSend = labsFxGeneratePatchedSeq;
      await clickElementLikeUser(sendBtn);
      debugLog('labsfx 已触发发送按钮点击');
      if (referenceImages.length > 0) {
        const patchTimeoutMs = mediaKind === 'video' ? 45000 : 8000;
        debugLog('labsfx 等待参考图注入后的生成请求', { mediaKind, timeoutMs: patchTimeoutMs });
        if (!await waitForLabsFxGeneratePatched(patchedSeqBeforeSend, patchTimeoutMs)) {
          throw new Error(`labs.google/fx ${mediaKind} generate request was not patched with reference images`);
        }
      }
    }

    const mediaEl = await waitForNewLabsFxGeneratedMedia(
      mediaKind,
      beforeKeys,
      mediaKind === 'video' ? 25 * 60 * 1000 : 180000,
      beforeVideoStatusSeq,
      () => ({
        seq: labsFxVideoStatusSeq,
        status: labsFxLatestVideoStatus,
        error: labsFxLatestVideoError,
      })
    );
    const src = mediaEl.getAttribute('src') || mediaEl.currentSrc;
    if (!src) throw new Error(`generated ${mediaKind} src missing`);
    debugLog(`labsfx 检测到新${mediaKind === 'video' ? '视频' : '图片'}`, { src });

    const absoluteUrl = new URL(src, location.href).toString();
    const mediaResp = await fetchLabsFxGeneratedMedia(mediaKind, mediaEl, absoluteUrl);
    if (!mediaResp.ok || !mediaResp.bodyBase64) throw new Error(`${mediaKind} fetch failed: HTTP ${mediaResp.status}${mediaResp.error ? ` ${mediaResp.error}` : ''}`);
    debugLog(`labsfx ${mediaKind === 'video' ? '视频' : '图片'}抓取成功`, {
      status: mediaResp.status,
      url: absoluteUrl,
      finalUrl: mediaResp.finalUrl,
      contentType: mediaResp.contentType,
    });
    const base64 = mediaResp.bodyBase64;
    const fileName = `${job.id}${guessMediaExtension(mediaResp.contentType || '', mediaResp.finalUrl || absoluteUrl)}`;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/json',
    };
    const resultResp = await deps.bgFetch(`${apiUrl}/bridge/image-jobs/${encodeURIComponent(job.id)}/result`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        file_name: fileName,
        mime_type: mediaResp.contentType || (mediaKind === 'video' ? 'video/mp4' : 'image/png'),
        data: base64,
      }),
    });
    if (!resultResp.ok) throw new Error(`${mediaKind} result upload failed: HTTP ${resultResp.status}`);
    debugLog(`labsfx ${mediaKind === 'video' ? '视频' : '图片'}结果回传成功`, { fileName, status: resultResp.status });
    showToast(`${mediaKind === 'video' ? '视频' : '图片'}已保存: ${fileName}`, 3500);
  }

  async function setLabsFxPrompt(editor: HTMLElement, text: string): Promise<void> {
    debugLog('labsfx 开始写入 Prompt', { text: text.slice(0, 120) });
    pasteIntoLabsFxEditor(editor, text);
    await sleep(150);
    debugLog('labsfx paste 后校验', {
      plain: deps.getEditorText(editor).replace(/\uFEFF/g, '').trim().slice(0, 120),
      hasStringNode: !!editor.querySelector('[data-slate-string="true"]'),
    });

    if (!isLabsFxPromptApplied(editor, text)) {
      clearLabsFxEditor(editor);
      await sleep(80);
      placeCaretInLabsFxEditor(editor);
      document.execCommand('insertText', false, text);
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      editor.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(150);
      debugLog('labsfx insertText 后校验', {
        plain: deps.getEditorText(editor).replace(/\uFEFF/g, '').trim().slice(0, 120),
        hasStringNode: !!editor.querySelector('[data-slate-string="true"]'),
      });
    }

    if (!isLabsFxPromptApplied(editor, text)) {
      clearLabsFxEditor(editor);
      await sleep(80);
      placeCaretInLabsFxEditor(editor);
      setContentEditableText(editor, text);
      await sleep(150);
      debugLog('labsfx contenteditable 回退后校验', {
        plain: deps.getEditorText(editor).replace(/\uFEFF/g, '').trim().slice(0, 120),
        hasStringNode: !!editor.querySelector('[data-slate-string="true"]'),
      });
    }

    if (!isLabsFxPromptApplied(editor, text)) {
      debugLog('labsfx Prompt 写入失败', shortenHtml(editor.innerHTML || '', 1000));
      throw new Error('labs.google/fx editor fill failed');
    }
    debugLog('labsfx Prompt 写入成功');
  }

  async function prepareLabsFxPromptArea(editor: HTMLElement): Promise<void> {
    const clearBtn = Array.from(editor.parentElement?.parentElement?.querySelectorAll('button') || []).find((btn) => {
      return (btn.textContent || '').includes('清除提示');
    }) as HTMLElement | undefined;
    if (clearBtn && isVisibleElement(clearBtn)) {
      debugLog('labsfx 点击清除提示');
      await clickElementLikeUser(clearBtn);
      await sleep(200);
    }

    await clearLabsFxReferenceImages(editor);
    clearLabsFxEditor(editor);
    debugLog('labsfx 已清空输入框');
    await sleep(100);
  }

  function clearLabsFxEditor(editor: HTMLElement): void {
    editor.focus();
    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(editor);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    document.execCommand('delete', false);
    editor.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'deleteContentBackward', data: null }));
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    editor.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function getLabsFxReferenceCardCount(editor: HTMLElement): number {
    const region = (findLabsFxComposerRegion(editor) ?? defaultEditorRegion(editor)) as Element | null;
    return countLabsFxReferenceCards(region);
  }

  function getLabsFxProjectId(): string {
    if (labsFxProjectId) return labsFxProjectId;
    const pathMatch = location.pathname.match(/\/project\/([^/]+)/);
    return pathMatch?.[1] || '';
  }

  function getLabsFxUploadHeaders(): Record<string, string> | null {
    if (!labsFxAPIHeaders.authorization) return null;
    return {
      ...labsFxAPIHeaders,
      'content-type': 'application/json',
    };
  }

  async function uploadLabsFxReferenceImageViaAPI(item: any, index: number): Promise<string | null> {
    const projectId = getLabsFxProjectId();
    const headers = getLabsFxUploadHeaders();
    if (!projectId || !headers) {
      debugLog('labsfx API 上传条件不足，回退 UI 上传', {
        hasProjectId: !!projectId,
        headerKeys: Object.keys(labsFxAPIHeaders),
      });
      return null;
    }

    const mimeType = typeof item?.mime_type === 'string' && item.mime_type ? item.mime_type : 'image/png';
    const fileName = typeof item?.file_name === 'string' && item.file_name ? item.file_name : `reference-${index + 1}${guessImageExtension(mimeType, '')}`;
    const data = typeof item?.data === 'string' ? item.data : '';
    if (!data) return null;

    const body = {
      clientContext: {
        tool: 'PINHOLE',
        projectId,
      },
      fileName,
      imageBytes: data,
      isHidden: false,
      isUserUploaded: true,
      mimeType,
    };

    debugLog('labsfx 开始 API 上传参考图', { index: index + 1, fileName, projectId });
    const resp = await deps.bgFetch('https://aisandbox-pa.googleapis.com/v1/flow/uploadImage', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      debugLog('labsfx API 上传失败', { index: index + 1, status: resp.status, body: resp.body.slice(0, 400) });
      return null;
    }

    let payload: any = {};
    try { payload = JSON.parse(resp.body || '{}'); } catch {}
    const mediaId = payload?.media?.name || payload?.mediaGenerationId?.mediaGenerationId || '';
    if (!mediaId) {
      debugLog('labsfx API 上传返回缺少 mediaId', { index: index + 1, body: resp.body.slice(0, 400) });
      return null;
    }
    debugLog('labsfx API 上传成功', { index: index + 1, mediaId });
    return mediaId;
  }

  function setPendingLabsFxReferenceInputs(
    mediaIds: string[],
    mediaKind: LabsFxMediaKind,
    videoMode: LabsFxVideoMode = 'text'
  ): void {
    labsFxReferencesInjectedReady = false;
    window.postMessage({
      type: 'OPENLINK_SET_PENDING_FLOW_REFERENCES',
      data: {
        mediaKind,
        videoMode,
        items: mediaIds.map((mediaId) => ({ mediaId })),
      },
    }, '*');
  }

  async function waitForLabsFxPendingReferencesReady(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (labsFxReferencesInjectedReady) return true;
      await sleep(100);
    }
    return false;
  }

  async function waitForLabsFxGeneratePatched(previousSeq: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (labsFxGeneratePatchedSeq > previousSeq) return true;
      await sleep(100);
    }
    return false;
  }

  async function triggerDirectLabsFxVideoGenerate(
    prompt: string,
    referenceMediaIds: string[],
    model: string
  ): Promise<{ operations: any[] }> {
    const projectId = getLabsFxProjectId();
    const headers = getLabsFxUploadHeaders();
    if (!projectId || !headers?.authorization) {
      throw new Error('labs.google/fx direct video generate missing projectId or authorization');
    }
    const requestId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random()}`;
    const videoModelKey = resolveLabsFxVideoModelKey(model);
    debugLog('labsfx 准备直连视频生成请求', {
      requestId,
      projectId,
      count: referenceMediaIds.length,
      videoModelKey,
    });

    return await new Promise<{ operations: any[] }>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(new Error('labs.google/fx direct video generate timeout'));
      }, 45000);
      const onMessage = (event: MessageEvent) => {
        if (event.source !== window) return;
        const data = event.data || {};
        if (data.type === 'OPENLINK_LABSFX_DIRECT_VIDEO_STARTED' && data.data?.requestId === requestId) {
          cleanup();
          const operations = Array.isArray(data.data?.result?.operations) ? data.data.result.operations : [];
          if (!operations.length) {
            reject(new Error('labs.google/fx direct video generate missing operations'));
            return;
          }
          resolve({ operations });
        } else if (data.type === 'OPENLINK_LABSFX_DIRECT_VIDEO_ERROR' && data.data?.requestId === requestId) {
          cleanup();
          reject(new Error(String(data.data?.error || 'labs.google/fx direct video generate failed')));
        }
      };
      const cleanup = () => {
        window.clearTimeout(timeout);
        window.removeEventListener('message', onMessage);
      };
      window.addEventListener('message', onMessage);
      window.postMessage({
        type: 'OPENLINK_LABSFX_DIRECT_VIDEO_START',
        data: {
          requestId,
          projectId,
          headers,
          prompt,
          referenceMediaIds,
          videoModelKey,
          aspectRatio: 'VIDEO_ASPECT_RATIO_LANDSCAPE',
        },
      }, '*');
    });
  }

  function resolveLabsFxVideoModelKey(model: string): string {
    const normalized = String(model || '').trim().toLowerCase();
    if (normalized.includes('reference')) return 'veo_3_1_r2v_fast_landscape';
    if (normalized.includes('veo')) return 'veo_3_1_i2v_s_fast_fl';
    return 'veo_3_1_i2v_s_fast_fl';
  }

  function resolveLabsFxVideoMode(model: string): LabsFxVideoMode {
    const normalized = String(model || '').trim().toLowerCase();
    if (normalized.includes('start-end') || normalized.includes('start_end')) return 'start_end';
    if (normalized.includes('reference')) return 'reference';
    return 'reference';
  }

  async function pollDirectLabsFxVideoResult(operations: any[]): Promise<string> {
    const headers = getLabsFxUploadHeaders();
    if (!headers?.authorization) {
      throw new Error('labs.google/fx video status polling missing authorization');
    }
    const url = 'https://aisandbox-pa.googleapis.com/v1/video:batchCheckAsyncVideoGenerationStatus';
    const timeoutMs = 25 * 60 * 1000;
    const pollIntervalMs = 5000;
    const deadline = Date.now() + timeoutMs;
    let attempt = 0;

    while (Date.now() < deadline) {
      attempt += 1;
      if (attempt > 1) await sleep(pollIntervalMs);
      const resp = await deps.bgFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ operations }),
      });
      if (!resp.ok) {
        debugLog('labsfx 视频状态轮询失败', { attempt, status: resp.status, body: resp.body.slice(0, 200) });
        continue;
      }

      let payload: any = {};
      try { payload = JSON.parse(resp.body || '{}'); } catch {}
      const checked = Array.isArray(payload?.operations) ? payload.operations : [];
      if (!checked.length) {
        debugLog('labsfx 视频状态轮询返回空 operations', { attempt });
        continue;
      }
      const operation = checked[0] || {};
      const status = String(operation?.status || '');
      debugLog('labsfx 视频状态轮询', { attempt, status });
      if (status === 'MEDIA_GENERATION_STATUS_SUCCESSFUL') {
        const metadata = operation?.operation?.metadata || {};
        const video = metadata?.video || {};
        const fifeUrl = String(video?.fifeUrl || '').trim();
        if (!fifeUrl) throw new Error('labs.google/fx video status successful but fifeUrl missing');
        return fifeUrl;
      }
      if (status === 'MEDIA_GENERATION_STATUS_FAILED') {
        const error = operation?.operation?.error || {};
        throw new Error(`labs.google/fx video generation failed: ${error.message || error.code || 'unknown error'}`);
      }
      operations = checked;
    }

    throw new Error('labs.google/fx video generation polling timeout');
  }

  function refreshLabsFxComposerState(editor: HTMLElement): void {
    editor.focus();
    placeCaretInLabsFxEditor(editor);
    editor.dispatchEvent(new Event('focus', { bubbles: true }));
    editor.dispatchEvent(new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: '',
    }));
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    editor.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function clearLabsFxReferenceImages(editor: HTMLElement): Promise<void> {
    const region = (findLabsFxComposerRegion(editor) ?? defaultEditorRegion(editor)) as Element | null;
    if (!region) return;

    for (let pass = 0; pass < 3; pass++) {
      const count = getLabsFxReferenceCardCount(editor);
      if (count === 0) return;
      debugLog('labsfx 清理参考图', { pass, count });
      const cancelIcons = Array.from(region.querySelectorAll<HTMLElement>('.google-symbols')).filter((el) => (el.textContent || '').trim() === 'cancel');
      if (cancelIcons.length === 0) break;
      for (const icon of cancelIcons) {
        const target = (icon.parentElement as HTMLElement | null) ?? icon;
        await clickElementLikeUser(target);
        await sleep(120);
      }
      await sleep(300);
    }

    const remaining = getLabsFxReferenceCardCount(editor);
    if (remaining > 0) debugLog('labsfx 参考图未完全清理', { remaining });
  }

  function findLabsFxFileInput(): HTMLInputElement | null {
    return Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"]')).find((input) => input.isConnected) ?? null;
  }

  function getLabsFxAddButton(editor: HTMLElement): HTMLElement | null {
    const region = (findLabsFxComposerRegion(editor) ?? defaultEditorRegion(editor)) as Element | null;
    if (!region) return null;
    return Array.from(region.querySelectorAll<HTMLElement>('button')).find((btn) => btn.querySelector('.google-symbols')?.textContent?.trim() === 'add_2') ?? null;
  }

  async function ensureLabsFxFileInput(editor: HTMLElement): Promise<HTMLInputElement | null> {
    const existing = findLabsFxFileInput();
    if (existing) return existing;
    const addBtn = getLabsFxAddButton(editor);
    if (!addBtn) return null;
    await clickElementLikeUser(addBtn);
    await sleep(250);
    return findLabsFxFileInput();
  }

  async function waitForLabsFxReferenceCount(editor: HTMLElement, expectedCount: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (getLabsFxReferenceCardCount(editor) >= expectedCount) return true;
      await sleep(200);
    }
    return false;
  }

  async function waitForLabsFxNewResourceTile(previousKeys: string[], timeoutMs: number): Promise<HTMLElement | null> {
    const before = new Set(previousKeys);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const tile of getLabsFxVisibleResourceTiles()) {
        const key = getLabsFxTileMediaKey(tile);
        if (key && !before.has(key)) return tile;
      }
      await sleep(250);
    }
    return null;
  }

  async function attachLabsFxUploadedResourceTile(editor: HTMLElement, tile: HTMLElement, expectedCount: number): Promise<boolean> {
    const key = tile.getAttribute('data-tile-id') || '';
    const clickTargets = [
      tile.querySelector<HTMLElement>('[role="button"]'),
      tile.querySelector<HTMLElement>('a'),
      tile,
    ].filter(Boolean) as HTMLElement[];

    for (const target of clickTargets) {
      debugLog('labsfx 尝试附着已上传资源卡片', {
        key,
        target: target.tagName.toLowerCase(),
        role: target.getAttribute('role') || '',
      });
      await clickElementLikeUser(target);
      if (await waitForLabsFxReferenceCount(editor, expectedCount, 2500)) return true;
    }
    return false;
  }

  function dispatchLabsFxPasteFile(target: HTMLElement, file: File): void {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    try {
      target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dataTransfer, bubbles: true, cancelable: true }));
    } catch {}
  }

  function dispatchLabsFxDropFile(target: HTMLElement, file: File): void {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    const eventInit = { bubbles: true, cancelable: true, dataTransfer } as DragEventInit;
    for (const type of ['dragenter', 'dragover', 'drop']) {
      try {
        target.dispatchEvent(new DragEvent(type, eventInit));
      } catch {}
    }
  }

  async function attachLabsFxReferenceImages(
    editor: HTMLElement,
    items: any[],
    mediaKind: LabsFxMediaKind = 'image',
    videoMode: LabsFxVideoMode = 'text'
  ): Promise<string[]> {
    const target = (findLabsFxComposerRegion(editor) as HTMLElement | null) ?? editor;
    const uploadedMediaIds: string[] = [];
    for (let i = 0; i < items.length; i++) {
      const file = await referenceImageJobToFile(items[i], i, deps.bgFetchBinary);
      const beforeCount = getLabsFxReferenceCardCount(editor);
      const beforeKeys = getLabsFxTileKeys();
      debugLog('labsfx 附加参考图', { index: i + 1, beforeCount, fileName: file.name, size: file.size, type: file.type });

      const mediaId = await uploadLabsFxReferenceImageViaAPI(items[i], i);
      if (mediaId) {
        uploadedMediaIds.push(mediaId);
        if (await waitForLabsFxReferenceCount(editor, beforeCount + 1, 1500)) continue;
        const newTile = await waitForLabsFxNewResourceTile(beforeKeys, 4000);
        if (newTile) {
          const key = newTile.getAttribute('data-tile-id') || '';
          debugLog('labsfx API 上传后发现新资源卡片', { index: i + 1, mediaId, key });
          if (await attachLabsFxUploadedResourceTile(editor, newTile, beforeCount + 1)) {
            debugLog('labsfx API 上传资源卡片已附着到输入区', { index: i + 1, mediaId, key });
            continue;
          }
        }
        continue;
      }

      const input = await ensureLabsFxFileInput(editor);
      if (input) {
        debugLog('labsfx 使用文件输入上传参考图', { index: i + 1 });
        setFileInputFiles(input, [file]);
        if (await waitForLabsFxReferenceCount(editor, beforeCount + 1, 15000)) continue;
        debugLog('labsfx 文件输入上传未生效，准备回退', { index: i + 1 });
      }

      debugLog('labsfx 使用 paste 上传参考图', { index: i + 1 });
      dispatchLabsFxPasteFile(editor, file);
      if (await waitForLabsFxReferenceCount(editor, beforeCount + 1, 15000)) continue;
      debugLog('labsfx paste 上传未生效，准备回退', { index: i + 1 });

      debugLog('labsfx 使用 drop 上传参考图', { index: i + 1 });
      dispatchLabsFxDropFile(target, file);
      if (await waitForLabsFxReferenceCount(editor, beforeCount + 1, 15000)) continue;

      debugLog('labsfx 参考图附加失败', { index: i + 1, fileName: file.name });
      throw new Error(`labs.google/fx reference image attach failed: ${file.name}`);
    }

    if (uploadedMediaIds.length > 0) {
      debugLog('labsfx 准备注入已上传参考图到生成请求', { count: uploadedMediaIds.length, mediaKind, videoMode });
      setPendingLabsFxReferenceInputs(uploadedMediaIds, mediaKind, videoMode);
      if (!await waitForLabsFxPendingReferencesReady(2000)) {
        throw new Error('labs.google/fx pending reference injection setup failed');
      }
      refreshLabsFxComposerState(editor);
      debugLog('labsfx 注入准备完成后已刷新输入区状态', { mediaKind });
      await sleep(120);
    }
    return uploadedMediaIds;
  }

  function pasteIntoLabsFxEditor(editor: HTMLElement, text: string): void {
    placeCaretInLabsFxEditor(editor);
    const dataTransfer = new DataTransfer();
    dataTransfer.setData('text/plain', text);
    editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dataTransfer, bubbles: true, cancelable: true }));
    editor.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertFromPaste', data: text }));
  }

  function isLabsFxPromptApplied(editor: HTMLElement, text: string): boolean {
    const plain = deps.getEditorText(editor).replace(/\uFEFF/g, '').trim();
    const hasStringNode = Array.from(editor.querySelectorAll('[data-slate-string="true"]')).some((node) => (node.textContent || '').includes(text));
    return plain === text.trim() && hasStringNode;
  }

  function placeCaretInLabsFxEditor(editor: HTMLElement): void {
    editor.focus();
    const selection = window.getSelection();
    if (!selection) return;

    const stringNode = editor.querySelector('[data-slate-string="true"]')?.firstChild;
    if (stringNode) {
      const range = document.createRange();
      range.setStart(stringNode, stringNode.textContent?.length ?? 0);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }

    const zeroWidthNode = editor.querySelector('[data-slate-zero-width]')?.firstChild;
    if (zeroWidthNode) {
      const offset = Math.min(1, zeroWidthNode.textContent?.length ?? 0);
      const range = document.createRange();
      range.setStart(zeroWidthNode, offset);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }

    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  return {
    startLabsFxImageWorker,
    updateAPIHeaders,
    updateProjectId,
    setReferencesInjectedReady,
    incrementGeneratePatchedSeq,
    updateVideoStatus,
    getDebugState,
    prepareLabsFxPromptArea,
    setLabsFxPrompt,
    triggerDirectLabsFxVideoGenerate,
    resolveLabsFxVideoModelKey,
    resolveLabsFxVideoMode,
    pollDirectLabsFxVideoResult,
  };
}

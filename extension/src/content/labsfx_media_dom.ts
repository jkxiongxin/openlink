import { debugLog } from './debug_log';
import { clickElementLikeUser, sleep } from './dom_actions';
import { isVisibleElement } from './editor_dom';
import { defaultEditorRegion } from './site_adapters';

export type LabsFxVideoStatusState = {
  seq: number;
  status: string;
  error: string;
};

type LabsFxMediaKind = 'image' | 'video';

const emptyVideoStatus = (): LabsFxVideoStatusState => ({ seq: 0, status: '', error: '' });

export function getLatestLabsFxImageKey(): string {
  const tile = getLatestLabsFxTile();
  if (!tile) return '';
  return getLabsFxTileMediaKey(tile);
}

export function getLatestLabsFxImage(): HTMLImageElement | null {
  const tile = getLatestLabsFxTile();
  return tile ? getLabsFxGeneratedImage(tile) : null;
}

export function getLatestLabsFxTile(): HTMLElement | null {
  return getLabsFxVisibleResourceTiles()[0] ?? null;
}

export function getLabsFxTileKeys(): string[] {
  return getLabsFxVisibleResourceTiles()
    .map((tile) => getLabsFxTileMediaKey(tile))
    .filter(Boolean);
}

function getLabsFxNewTile(previousKeys: Set<string>): { tile: HTMLElement; key: string; img: HTMLImageElement } | null {
  for (const tile of getLabsFxVisibleResourceTiles()) {
    const img = getLabsFxGeneratedImage(tile);
    if (!img) continue;
    const key = getLabsFxTileMediaKey(tile);
    if (!key || previousKeys.has(key)) continue;
    return { tile, key, img };
  }
  return null;
}

function getLabsFxNewMediaTile(previousKeys: Set<string>, mediaKind: LabsFxMediaKind): { tile: HTMLElement; key: string; media: HTMLImageElement | HTMLVideoElement } | null {
  for (const tile of getLabsFxVisibleResourceTiles()) {
    const media = mediaKind === 'video'
      ? tile.querySelector('video')
      : getLabsFxGeneratedImage(tile);
    if (!media) continue;
    const key = getLabsFxTileMediaKey(tile);
    if (!key || previousKeys.has(key)) continue;
    return { tile, key, media: media as HTMLImageElement | HTMLVideoElement };
  }
  return null;
}

function getLabsFxUnexpectedNewMediaKind(previousKeys: Set<string>, expectedKind: LabsFxMediaKind): LabsFxMediaKind | null {
  const otherKind = expectedKind === 'video' ? 'image' : 'video';
  for (const tile of getLabsFxVisibleResourceTiles()) {
    const media = otherKind === 'video'
      ? tile.querySelector('video')
      : getLabsFxGeneratedImage(tile);
    if (!media) continue;
    const key = getLabsFxTileMediaKey(tile);
    if (!key || previousKeys.has(key)) continue;
    return otherKind;
  }
  return null;
}

function getLabsFxVisibleTiles(): HTMLElement[] {
  const seen = new Set<string>();
  const tiles: HTMLElement[] = [];
  for (const tile of Array.from(document.querySelectorAll<HTMLElement>('[data-tile-id]'))) {
    if (!isVisibleElement(tile)) continue;
    const key = tile.getAttribute('data-tile-id') || '';
    if (!key || seen.has(key)) continue;
    seen.add(key);
    tiles.push(tile);
  }
  return tiles;
}

function getLabsFxNewFailedTile(previousKeys: Set<string>, handledFailureKeys: Set<string>): { tile: HTMLElement; key: string; retryBtn: HTMLElement | null; message: string } | null {
  for (const tile of getLabsFxVisibleTiles()) {
    const key = tile.getAttribute('data-tile-id') || '';
    if (!key || previousKeys.has(key) || handledFailureKeys.has(key)) continue;
    const text = (tile.textContent || '').trim();
    const retryBtn = Array.from(tile.querySelectorAll<HTMLElement>('button')).find((btn) => {
      const btnText = (btn.textContent || '').trim();
      return btnText.includes('重试') || btnText.includes('refresh');
    }) ?? null;
    const hasFailureText = text.includes('失败');
    const hasProgressPercent = /\b\d{1,3}%\b/.test(text);
    if (!retryBtn && !hasFailureText) continue;
    if (!retryBtn && hasProgressPercent) continue;
    return { tile, key, retryBtn, message: text.slice(0, 240) };
  }
  return null;
}

export function getLabsFxVisibleResourceTiles(): HTMLElement[] {
  const seen = new Set<string>();
  const tiles: HTMLElement[] = [];
  for (const tile of getLabsFxVisibleTiles()) {
    const media = getLabsFxGeneratedImage(tile) ?? tile.querySelector('video');
    if (!media) continue;
    const key = getLabsFxTileMediaKey(tile);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    tiles.push(tile);
  }
  return tiles;
}

export function getLabsFxGeneratedImage(root: ParentNode): HTMLImageElement | null {
  const images = Array.from(root.querySelectorAll<HTMLImageElement>('img'));
  return images.find((img) => {
    const src = img.getAttribute('src') || img.currentSrc || '';
    const alt = img.getAttribute('alt') || '';
    return src.includes('/fx/api/trpc/media.getMediaUrlRedirect') ||
      src.includes('media.getMediaUrlRedirect') ||
      alt === '生成的图片' ||
      alt === 'Hình ảnh được tạo' ||
      alt.toLowerCase().includes('generated');
  }) ?? null;
}

export function getLabsFxTileMediaKey(tile: HTMLElement): string {
  const media = getLabsFxGeneratedImage(tile) ?? tile.querySelector<HTMLVideoElement>('video');
  return tile.getAttribute('data-tile-id') || media?.getAttribute('src') || media?.currentSrc || '';
}

export async function waitForNewLabsFxImage(previousKeysInput: string[] | Set<string>, timeoutMs: number): Promise<HTMLImageElement> {
  const deadline = Date.now() + timeoutMs;
  const previousKeys = previousKeysInput instanceof Set ? previousKeysInput : new Set(previousKeysInput);
  debugLog('labsfx 等待新图片', { previousKeys: Array.from(previousKeys), timeoutMs });
  let lastSeenKeys = '';
  while (Date.now() < deadline) {
    const currentKeys = getLabsFxTileKeys();
    const currentKeySummary = currentKeys.join(',');
    if (currentKeySummary !== lastSeenKeys) {
      lastSeenKeys = currentKeySummary;
      debugLog('labsfx 当前资源列表 key', currentKeys);
    }
    const found = getLabsFxNewTile(previousKeys);
    if (found && found.img.complete && found.img.naturalWidth > 0) {
      debugLog('labsfx 新图片已就绪', { key: found.key, width: found.img.naturalWidth, height: found.img.naturalHeight });
      return found.img;
    }
    await sleep(1000);
  }
  debugLog('labsfx 等待新图片超时', { previousKeys: Array.from(previousKeys), timeoutMs, currentKeys: getLabsFxTileKeys() });
  throw new Error('wait for generated image timed out');
}

function isLabsFxMediaReady(mediaKind: LabsFxMediaKind, media: HTMLImageElement | HTMLVideoElement): boolean {
  if (mediaKind === 'video') {
    const video = media as HTMLVideoElement;
    return !!video.getAttribute('src') && video.readyState >= 2;
  }
  const image = media as HTMLImageElement;
  return image.complete && image.naturalWidth > 0;
}

export async function waitForNewLabsFxGeneratedMedia(
  mediaKind: LabsFxMediaKind,
  previousKeysInput: string[] | Set<string>,
  timeoutMs: number,
  previousVideoStatusSeq = 0,
  getVideoStatusState: () => LabsFxVideoStatusState = emptyVideoStatus
): Promise<HTMLImageElement | HTMLVideoElement> {
  const deadline = Date.now() + timeoutMs;
  const previousKeys = previousKeysInput instanceof Set ? previousKeysInput : new Set(previousKeysInput);
  debugLog(`labsfx 等待新${mediaKind === 'video' ? '视频' : '图片'}`, { previousKeys: Array.from(previousKeys), timeoutMs });
  let lastSeenKeys = '';
  let lastLoggedKeysAt = 0;
  const handledFailureKeys = new Set<string>();
  let retryAttempts = 0;
  const maxRetryAttempts = 2;
  const pollIntervalMs = mediaKind === 'video' ? 250 : 1000;
  const keyLogIntervalMs = mediaKind === 'video' ? 3000 : 0;
  while (Date.now() < deadline) {
    const currentKeys = getLabsFxTileKeys();
    const currentKeySummary = currentKeys.join(',');
    const now = Date.now();
    const shouldLogKeys = currentKeySummary !== lastSeenKeys && (keyLogIntervalMs === 0 || now - lastLoggedKeysAt >= keyLogIntervalMs);
    if (shouldLogKeys) {
      lastSeenKeys = currentKeySummary;
      lastLoggedKeysAt = now;
      debugLog('labsfx 当前资源列表 key', currentKeys);
    } else if (currentKeySummary !== lastSeenKeys) {
      lastSeenKeys = currentKeySummary;
    }
    const found = getLabsFxNewMediaTile(previousKeys, mediaKind);
    if (found && isLabsFxMediaReady(mediaKind, found.media)) {
      if (mediaKind === 'video') {
        const video = found.media as HTMLVideoElement;
        debugLog('labsfx 新视频已就绪', { key: found.key, width: video.videoWidth, height: video.videoHeight });
      } else {
        const image = found.media as HTMLImageElement;
        debugLog('labsfx 新图片已就绪', { key: found.key, width: image.naturalWidth, height: image.naturalHeight });
      }
      return found.media;
    }
    const unexpectedKind = getLabsFxUnexpectedNewMediaKind(previousKeys, mediaKind);
    if (unexpectedKind) {
      debugLog(`labsfx 检测到非预期新${unexpectedKind === 'video' ? '视频' : '图片'}`, {
        expected: mediaKind,
        actual: unexpectedKind,
      });
    }
    const videoStatus = getVideoStatusState();
    if (mediaKind === 'video' && videoStatus.seq > previousVideoStatusSeq) {
      previousVideoStatusSeq = videoStatus.seq;
      if (videoStatus.status === 'MEDIA_GENERATION_STATUS_FAILED') {
        const failedTile = getLabsFxNewFailedTile(previousKeys, handledFailureKeys);
        if (failedTile && failedTile.retryBtn && retryAttempts < maxRetryAttempts) {
          handledFailureKeys.add(failedTile.key);
          retryAttempts += 1;
          debugLog('labsfx 根据接口状态确认视频生成失败，触发重试', {
            key: failedTile.key,
            status: videoStatus.status,
            attempt: retryAttempts,
            error: videoStatus.error.slice(0, 240),
          });
          await clickElementLikeUser(failedTile.retryBtn);
          await sleep(800);
          continue;
        }
        throw new Error(`labs.google/fx video generation failed: ${videoStatus.error || videoStatus.status}`);
      }
    }
    await sleep(pollIntervalMs);
  }
  debugLog(`labsfx 等待新${mediaKind === 'video' ? '视频' : '图片'}超时`, { previousKeys: Array.from(previousKeys), timeoutMs, currentKeys: getLabsFxTileKeys() });
  throw new Error(`wait for generated ${mediaKind} timed out`);
}

function getLabsFxModeButton(editor: HTMLElement): HTMLElement | null {
  const region = (editor.closest('.sc-84e494b2-0') ?? defaultEditorRegion(editor)) as Element | null;
  if (!region) return null;
  return Array.from(region.querySelectorAll<HTMLElement>('button[aria-haspopup="menu"]')).find((btn) => {
    const text = (btn.textContent || '').trim();
    return text.includes('视频') || text.includes('Nano') || text.includes('Banana');
  }) ?? null;
}

export async function ensureLabsFxMode(editor: HTMLElement, mediaKind: LabsFxMediaKind) {
  const modeBtn = getLabsFxModeButton(editor);
  if (!modeBtn) return;
  const currentText = (modeBtn.textContent || '').trim();
  const isVideoMode = currentText.includes('视频');
  if (mediaKind === 'video' && isVideoMode) {
    debugLog('labsfx 当前已处于视频模式');
    return;
  }
  if (mediaKind === 'image' && !isVideoMode) {
    debugLog('labsfx 当前已处于图片模式', { currentText: currentText.slice(0, 80) });
    return;
  }

  debugLog(`labsfx 尝试切换到${mediaKind === 'video' ? '视频' : '图片'}模式`, { currentText: currentText.slice(0, 80) });
  await clickElementLikeUser(modeBtn);
  await sleep(300);

  const candidates = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"], [role="option"], button, div')).filter((el) => {
    if (!isVisibleElement(el)) return false;
    const text = (el.textContent || '').trim();
    if (mediaKind === 'video') return text === '视频' || text.startsWith('视频');
    return text === '图片' || text.startsWith('图片') || text.includes('Nano Banana');
  });
  if (candidates[0]) {
    await clickElementLikeUser(candidates[0]);
    await sleep(400);
    debugLog(`labsfx 已切换到${mediaKind === 'video' ? '视频' : '图片'}模式`);
    return;
  }
  debugLog(`labsfx 未找到${mediaKind === 'video' ? '视频' : '图片'}模式菜单项，继续使用当前模式`);
}

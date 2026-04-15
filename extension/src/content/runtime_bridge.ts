import { debugLog } from './debug_log';

export type BgFetchResponse = { ok: boolean; status: number; body: string };
export type BgFetchBinaryResponse = { ok: boolean; status: number; bodyBase64: string; contentType: string; finalUrl: string; error?: string };

let extensionContextInvalidated = false;
let extensionContextInvalidatedLogged = false;

function isExtensionContextInvalidatedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '');
  return message.includes('Extension context invalidated');
}

export function isExtensionContextInvalidated(): boolean {
  return extensionContextInvalidated;
}

export function handleExtensionContextError(error: unknown) {
  if (!isExtensionContextInvalidatedError(error)) return;
  extensionContextInvalidated = true;
  if (!extensionContextInvalidatedLogged) {
    extensionContextInvalidatedLogged = true;
    debugLog('扩展上下文已失效，停止后台轮询，刷新页面或重载扩展后恢复');
  }
}

function assertExtensionContextActive() {
  if (extensionContextInvalidated || !chrome?.runtime?.id) {
    const error = new Error('Extension context invalidated');
    handleExtensionContextError(error);
    throw error;
  }
}

export async function getStoredConfig(keys: string[]) {
  assertExtensionContextActive();
  try {
    return await chrome.storage.local.get(keys);
  } catch (error) {
    handleExtensionContextError(error);
    throw error;
  }
}

export async function bgFetch(url: string, options?: any): Promise<BgFetchResponse> {
  assertExtensionContextActive();
  try {
    return await chrome.runtime.sendMessage({ type: 'FETCH', url, options });
  } catch (error) {
    handleExtensionContextError(error);
    throw error;
  }
}

export async function bgFetchBinary(url: string, options?: any): Promise<BgFetchBinaryResponse> {
  assertExtensionContextActive();
  try {
    return await chrome.runtime.sendMessage({ type: 'FETCH_BINARY', url, options });
  } catch (error) {
    handleExtensionContextError(error);
    throw error;
  }
}

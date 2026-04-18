import type { BgFetchBinaryResponse } from './runtime_bridge';
import { base64ToBytes, guessImageExtension } from './media_utils';

type FetchBinary = (url: string, options?: any) => Promise<BgFetchBinaryResponse>;

export function setFileInputFiles(input: HTMLInputElement, files: File[]): void {
  const dataTransfer = new DataTransfer();
  for (const file of files) dataTransfer.items.add(file);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files')?.set;
  if (setter) setter.call(input, dataTransfer.files);
  else Object.defineProperty(input, 'files', { configurable: true, value: dataTransfer.files });
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

export function buildReferenceImageJobURL(item: any, apiUrl?: string, authToken?: string): string {
  const direct = typeof item?.url === 'string' && item.url ? item.url
    : typeof item?.image_url === 'string' && item.image_url ? item.image_url
      : typeof item?.image === 'string' && item.image ? item.image
        : typeof item?.src === 'string' && item.src ? item.src
          : '';
  if (direct) return direct;

  const rawPath = typeof item?.path === 'string' ? item.path.trim() : '';
  if (!rawPath || !apiUrl) return '';
  if (/^(https?:|data:)/i.test(rawPath)) return rawPath;

  const baseApiUrl = apiUrl.replace(/\/+$/, '');
  const normalizedPath = rawPath.replace(/^\.?\//, '');
  let url = '';
  if (rawPath.startsWith('/generated/')) {
    url = `${baseApiUrl}${rawPath}`;
  } else if (normalizedPath.startsWith('generated/')) {
    url = `${baseApiUrl}/${normalizedPath}`;
  } else if (normalizedPath.startsWith('.openlink/generated/')) {
    url = `${baseApiUrl}/generated/${normalizedPath.slice('.openlink/generated/'.length)}`;
  }
  if (!url) return '';
  if (authToken) {
    const joiner = url.includes('?') ? '&' : '?';
    url += `${joiner}token=${encodeURIComponent(authToken)}`;
  }
  return url;
}

export async function referenceImageJobToFile(
  item: any,
  index: number,
  fetchBinary: FetchBinary,
  apiUrl?: string,
  authToken?: string
): Promise<File> {
  const fallbackMimeType = typeof item?.mime_type === 'string' && item.mime_type ? item.mime_type : 'image/png';
  const sourceURL = buildReferenceImageJobURL(item, apiUrl, authToken);
  const fallbackName = typeof item?.file_name === 'string' && item.file_name
    ? item.file_name
    : `reference-${index + 1}${guessImageExtension(fallbackMimeType, sourceURL)}`;
  const data = typeof item?.data === 'string' ? item.data : '';
  if (data) {
    const bytes = base64ToBytes(data);
    return new File([bytes], fallbackName, { type: fallbackMimeType });
  }
  if (sourceURL) {
    const resp = await fetchBinary(sourceURL);
    if (!resp.ok || !resp.bodyBase64) {
      throw new Error(`reference image fetch failed: ${sourceURL} (${resp.error || `HTTP ${resp.status}`})`);
    }
    const mimeType = resp.contentType || fallbackMimeType;
    const fileName = typeof item?.file_name === 'string' && item.file_name
      ? item.file_name
      : `reference-${index + 1}${guessImageExtension(mimeType, resp.finalUrl || sourceURL)}`;
    const bytes = base64ToBytes(resp.bodyBase64);
    return new File([bytes], fileName, { type: mimeType });
  }
  throw new Error(`reference image missing data/url/path at index ${index + 1}`);
}

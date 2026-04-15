export type MediaBinaryResponse = {
  ok: boolean;
  status: number;
  bodyBase64: string;
  contentType: string;
  finalUrl: string;
  error?: string;
};

export async function canvasImageToMediaResponse(image: HTMLImageElement, sourceUrl: string): Promise<MediaBinaryResponse> {
  if (!image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) {
    throw new Error('image element is not ready for canvas export');
  }
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('canvas context unavailable');
  context.drawImage(image, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('canvas export returned empty blob');
  return {
    ok: true,
    status: 200,
    bodyBase64: await blobToBase64(blob),
    contentType: blob.type || 'image/png',
    finalUrl: sourceUrl,
  };
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function guessImageExtension(mimeType: string, src: string): string {
  const lowerMime = mimeType.toLowerCase();
  if (lowerMime.includes('png')) return '.png';
  if (lowerMime.includes('jpeg') || lowerMime.includes('jpg')) return '.jpg';
  if (lowerMime.includes('webp')) return '.webp';
  const match = src.match(/\.(png|jpe?g|webp|gif)(?:$|\?)/i);
  return match ? `.${match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase()}` : '.png';
}

export function guessMediaExtension(mimeType: string, src: string): string {
  const lowerMime = mimeType.toLowerCase();
  if (lowerMime.includes('video/mp4')) return '.mp4';
  if (lowerMime.includes('video/webm')) return '.webm';
  if (lowerMime.includes('video/quicktime')) return '.mov';
  const videoMatch = src.match(/\.(mp4|webm|mov|m4v)(?:$|\?)/i);
  if (videoMatch) return `.${videoMatch[1].toLowerCase()}`;
  return guessImageExtension(mimeType, src);
}

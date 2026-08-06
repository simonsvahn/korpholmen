const DEFAULT_MAX_DIMENSION = 2560;
const DEFAULT_QUALITY = 0.86;
const DEFAULT_MAX_FILE_BYTES = 40 * 1024 * 1024;

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export function fitImageDimensions(width, height, maxDimension = DEFAULT_MAX_DIMENSION) {
  const safeWidth = Number(width);
  const safeHeight = Number(height);
  if (!(safeWidth > 0) || !(safeHeight > 0)) throw new TypeError('Bilden saknar giltiga dimensioner');
  if (!(maxDimension > 0)) throw new TypeError('Ogiltig maxdimension');
  const scale = Math.min(1, maxDimension / Math.max(safeWidth, safeHeight));
  return {
    width: Math.max(1, Math.round(safeWidth * scale)),
    height: Math.max(1, Math.round(safeHeight * scale)),
    resized: scale < 1,
  };
}

function outputTypeFor(type) {
  return type === 'image/png' ? 'image/png' : 'image/jpeg';
}

export function imageExtension(type) {
  if (type === 'image/png') return 'png';
  if (type === 'image/webp') return 'webp';
  return 'jpg';
}

function browserCanvas(width, height) {
  if (!globalThis.document?.createElement) return null;
  const canvas = globalThis.document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

async function decodeBitmap(file, createImageBitmapImpl) {
  try {
    return await createImageBitmapImpl(file, { imageOrientation: 'from-image' });
  } catch {
    // Äldre webbläsare kan sakna options-argumentet. Ett verkligt avkodningsfel
    // ska fortfarande bubbla upp från det andra försöket.
    return createImageBitmapImpl(file);
  }
}

export async function prepareImageForStorage(file, {
  maxDimension = DEFAULT_MAX_DIMENSION,
  quality = DEFAULT_QUALITY,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  createImageBitmapImpl = globalThis.createImageBitmap,
  createCanvas = browserCanvas,
} = {}) {
  if (!(file instanceof Blob)) throw new TypeError('Välj en bildfil');
  if (!String(file.type || '').startsWith('image/')) throw new TypeError('Filen är inte en bild');
  if (file.size > maxFileBytes) throw new Error(`Bilden är större än ${Math.round(maxFileBytes / 1024 / 1024)} MB`);
  if (typeof createImageBitmapImpl !== 'function' || typeof createCanvas !== 'function') {
    return { blob: file, width: null, height: null, originalWidth: null, originalHeight: null, resized: false, extension: imageExtension(file.type) };
  }

  const bitmap = await decodeBitmap(file, createImageBitmapImpl);
  try {
    const dimensions = fitImageDimensions(bitmap.width, bitmap.height, maxDimension);
    const canKeepOriginal = ['image/jpeg', 'image/png', 'image/webp'].includes(file.type);
    if (!dimensions.resized && canKeepOriginal) {
      return {
        blob: file,
        width: bitmap.width,
        height: bitmap.height,
        originalWidth: bitmap.width,
        originalHeight: bitmap.height,
        resized: false,
        extension: imageExtension(file.type),
      };
    }
    const canvas = createCanvas(dimensions.width, dimensions.height);
    const context = canvas?.getContext?.('2d');
    if (!canvas || !context || typeof canvas.toBlob !== 'function') throw new Error('Webbläsaren kan inte skala ned bilden');
    const outputType = outputTypeFor(file.type);
    if (outputType === 'image/jpeg') {
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, dimensions.width, dimensions.height);
    }
    context.drawImage(bitmap, 0, 0, dimensions.width, dimensions.height);
    const blob = await new Promise((resolve, reject) => canvas.toBlob(
      value => value instanceof Blob ? resolve(value) : reject(new Error('Den nedskalade bilden kunde inte skapas')),
      outputType,
      quality,
    ));
    return {
      blob,
      ...dimensions,
      originalWidth: bitmap.width,
      originalHeight: bitmap.height,
      extension: imageExtension(blob.type || outputType),
    };
  } finally {
    bitmap.close?.();
  }
}

export function isRetryableImageError(error) {
  const status = Number(error?.status || 0);
  return error instanceof TypeError
    || error?.code === 'request_timeout'
    || status === 408
    || status === 429
    || status >= 500;
}

export async function uploadBlobWithRetry({
  transport,
  path,
  blob,
  maxAttempts = 3,
  sleep = wait,
  onRetry,
} = {}) {
  if (!transport || typeof transport.putBlobImmutable !== 'function') throw new TypeError('Bildtransport saknas');
  if (!path || !(blob instanceof Blob)) throw new TypeError('Bildköposten är ogiltig');
  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      await transport.putBlobImmutable(path, blob);
      return { path, attempts: attempt };
    } catch (error) {
      if (attempt >= maxAttempts || !isRetryableImageError(error)) throw error;
      await onRetry?.({ path, attempt, error });
      await sleep(Math.min(4000, 500 * (2 ** (attempt - 1))));
    }
  }
}

export async function uploadPendingImageBlobs({ store, transport, maxAttempts = 3, sleep, onProgress } = {}) {
  if (!store || typeof store.listPendingBlobs !== 'function' || typeof store.markBlobUploaded !== 'function') {
    throw new TypeError('Bildlagret saknas');
  }
  const pending = await store.listPendingBlobs();
  const failures = [];
  let uploaded = 0;
  for (const entry of pending) {
    try {
      const result = await uploadBlobWithRetry({ transport, path: entry.key, blob: entry.value, maxAttempts, sleep });
      await store.markBlobUploaded(entry.key);
      uploaded += 1;
      await onProgress?.({ path: entry.key, uploaded, total: pending.length, attempts: result.attempts });
    } catch (error) {
      failures.push({ path: entry.key, error, message: error?.message || String(error) });
      await onProgress?.({ path: entry.key, uploaded, total: pending.length, error });
    }
  }
  return { total: pending.length, uploaded, failures };
}

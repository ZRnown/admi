import path from "node:path";

const IMAGE_EXT_TO_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
};

const VIDEO_EXT_TO_MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
};

function detectContentTypeFromBuffer(buffer: Buffer): string | undefined {
  if (!buffer || buffer.length < 12) return undefined;

  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return "image/png";
  }

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }

  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return "image/gif";
  }

  if (buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return "image/bmp";
  }

  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return "image/webp";
  }

  if (
    buffer.length >= 12 &&
    buffer[4] === 0x66 &&
    buffer[5] === 0x74 &&
    buffer[6] === 0x79 &&
    buffer[7] === 0x70
  ) {
    return "video/mp4";
  }

  return undefined;
}

function contentTypeFromFilename(filename?: string): string | undefined {
  const ext = path.extname(filename || "").toLowerCase();
  return IMAGE_EXT_TO_MIME[ext] || VIDEO_EXT_TO_MIME[ext];
}

function extensionForContentType(contentType: string): string | undefined {
  const entry = Object.entries({ ...IMAGE_EXT_TO_MIME, ...VIDEO_EXT_TO_MIME }).find(
    ([, value]) => value === contentType,
  );
  return entry?.[0];
}

function renameWithExtension(filename: string, nextExt: string): string {
  const parsed = path.parse(filename || "upload");
  const base = parsed.name || "upload";
  return `${base}${nextExt}`;
}

export function filenameSuggestsImage(filename?: string): boolean {
  return Boolean(IMAGE_EXT_TO_MIME[path.extname(filename || "").toLowerCase()]);
}

export function filenameSuggestsVideo(filename?: string): boolean {
  return Boolean(VIDEO_EXT_TO_MIME[path.extname(filename || "").toLowerCase()]);
}

export function normalizeUploadFileDescriptor(
  filename: string,
  buffer: Buffer,
): { filename: string; contentType: string } {
  const detectedContentType =
    detectContentTypeFromBuffer(buffer) || contentTypeFromFilename(filename) || "application/octet-stream";
  const preferredExt = extensionForContentType(detectedContentType);

  if (!preferredExt) {
    return { filename, contentType: detectedContentType };
  }

  const currentExt = path.extname(filename || "").toLowerCase();
  const normalizedFilename =
    currentExt === preferredExt ? filename : renameWithExtension(filename || "upload", preferredExt);

  return {
    filename: normalizedFilename,
    contentType: detectedContentType,
  };
}

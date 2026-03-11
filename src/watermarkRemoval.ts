export type WatermarkRemovalMode = "ocr" | "always";

export interface WatermarkRemovalConfig {
  enabled?: boolean;
  mode?: WatermarkRemovalMode;
  apiKey?: string;
  triggerKeywords?: string[];
}

export interface OcrTextBlock {
  box?: number[][];
  score?: number;
  text?: string;
}

export interface OcrLikeResult {
  code?: number;
  msg?: string;
  data?: OcrTextBlock[];
}

export interface WatermarkDetectionResult {
  matched: boolean;
  reason?: string;
  texts: string[];
}

export type KeywordGroup = string[];
export interface WatermarkPostProcessOptions {
  hasWatermarks: boolean;
  isImage: boolean;
  removalAttempted: boolean;
  removalFailed: boolean;
}
export interface WatermarkRemovalRuntimeState {
  attempted: boolean;
  failed: boolean;
}
export interface PreparedImageForOcrAndForward {
  originalUrl: string;
  forwardUrl: string;
  ocrUrl: string;
  removalAttempted: boolean;
  removalFailed: boolean;
}
export interface PrepareImageForOcrOptions {
  shouldRemoveWatermark: boolean;
  config?: WatermarkRemovalConfig;
  removeWatermark?: (imageUrl: string, config?: WatermarkRemovalConfig) => Promise<string>;
}
interface WaveSpeedRateLimitOptions {
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  minIntervalMs?: number;
}

const WAVESPEED_ENDPOINT = "https://api.wavespeed.ai/api/v3/wavespeed-ai/image-watermark-remover";
const WAVESPEED_MIN_INTERVAL_MS = 2000;
const URL_RE = /^https?:\/\//i;
const WATERMARK_HINT_RE =
  /(?:watermark|logo|@|抖音|douyin|tiktok|小红书|xhs|快手|kuaishou|bilibili|b站|微博|weibo|视频号|公众号|微信|vx|wx|ins|instagram|telegram|tg|店铺|同款|关注|原创|搬运|出处)/i;
let waveSpeedQueue: Promise<void> = Promise.resolve();
let nextWaveSpeedStartAt = 0;

function firstNonEmptyString(...values: Array<unknown>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function normalizeTriggerKeywords(input?: unknown): string[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const result = input.map((item) => String(item || "").trim()).filter(Boolean);
  return result.length > 0 ? result : [];
}

function normalizeMatchText(value: string, caseInsensitive: boolean): string {
  let output = String(value ?? "");
  try {
    output = output.normalize("NFKC");
  } catch {}
  output = output.replace(/\p{Cf}/gu, "");
  return caseInsensitive ? output.toLowerCase() : output;
}

export function matchWatermarkRemovalTriggerKeywords(
  text: string,
  groups: KeywordGroup[],
  caseInsensitive = true,
): { matched: boolean; matchedGroups: KeywordGroup[]; matchedKeywords: string[] } {
  if (groups.length === 0) {
    return { matched: false, matchedGroups: [], matchedKeywords: [] };
  }
  const haystack = normalizeMatchText(text, caseInsensitive);
  const matchedGroups = groups.filter((group) =>
    group.every((keyword) => {
      const needle = normalizeMatchText(keyword, caseInsensitive);
      return haystack.includes(needle);
    }),
  );
  const matchedKeywords = Array.from(new Set(matchedGroups.flat()));
  return {
    matched: matchedGroups.length > 0,
    matchedGroups,
    matchedKeywords,
  };
}

export function resolveWatermarkRemovalConfig(
  globalConfig?: WatermarkRemovalConfig,
  ruleConfig?: WatermarkRemovalConfig,
): WatermarkRemovalConfig | undefined {
  if (ruleConfig?.enabled === false) {
    return undefined;
  }

  const merged: WatermarkRemovalConfig = {
    ...(globalConfig || {}),
    ...(ruleConfig || {}),
  };

  const apiKey = firstNonEmptyString(merged.apiKey);
  const enabled = merged.enabled === true ? true : merged.enabled === false ? false : Boolean(apiKey);
  if (!enabled || !apiKey) {
    return undefined;
  }

  return {
    enabled: true,
    mode: merged.mode === "ocr" ? "ocr" : "always",
    apiKey,
    triggerKeywords: normalizeTriggerKeywords(merged.triggerKeywords),
  };
}

export function shouldUseOcrWatermarkDetection(config?: WatermarkRemovalConfig): boolean {
  return config?.enabled === true && config.mode === "ocr" && typeof config.apiKey === "string" && config.apiKey.trim().length > 0;
}

export function shouldPersistWatermarkRemovalConfig(config?: WatermarkRemovalConfig): boolean {
  if (!config || typeof config !== "object") return false;
  if (config.enabled === true || config.enabled === false) return true;
  if (config.mode === "ocr" || config.mode === "always") return true;
  if (typeof config.apiKey === "string" && config.apiKey.trim().length > 0) return true;
  if (Array.isArray(config.triggerKeywords) && config.triggerKeywords.length > 0) return true;
  return false;
}

export function shouldApplyWatermarkAfterRemoval(options: WatermarkPostProcessOptions): boolean {
  if (!options.hasWatermarks || !options.isImage) {
    return false;
  }
  if (options.removalAttempted && options.removalFailed) {
    return false;
  }
  return true;
}

export async function prepareImageForOcrAndForward(
  imageUrl: string,
  options: PrepareImageForOcrOptions,
): Promise<PreparedImageForOcrAndForward> {
  const prepared: PreparedImageForOcrAndForward = {
    originalUrl: imageUrl,
    forwardUrl: imageUrl,
    ocrUrl: imageUrl,
    removalAttempted: false,
    removalFailed: false,
  };

  if (!imageUrl || !options.shouldRemoveWatermark) {
    return prepared;
  }

  prepared.removalAttempted = true;

  try {
    const removeWatermark = options.removeWatermark ?? removeWatermarkFromImageUrl;
    const resolvedUrl = await removeWatermark(imageUrl, options.config);
    if (typeof resolvedUrl === "string" && resolvedUrl.trim()) {
      prepared.forwardUrl = resolvedUrl;
      prepared.ocrUrl = resolvedUrl;
    }
    return prepared;
  } catch {
    prepared.removalFailed = true;
    return prepared;
  }
}

function extractBoxMetrics(block: OcrTextBlock) {
  const points = Array.isArray(block.box) ? block.box : [];
  const xs = points.map((point) => Number(point?.[0])).filter((value) => Number.isFinite(value));
  const ys = points.map((point) => Number(point?.[1])).filter((value) => Number.isFinite(value));
  if (xs.length === 0 || ys.length === 0) {
    return null;
  }
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return {
    minX,
    maxX,
    minY,
    maxY,
    width: Math.max(0, maxX - minX),
    height: Math.max(0, maxY - minY),
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
  };
}

export function detectTextWatermarkFromOCR(result: OcrLikeResult | null | undefined): WatermarkDetectionResult {
  const blocks = Array.isArray(result?.data) ? result.data : [];
  if (blocks.length === 0) {
    return { matched: false, texts: [] };
  }

  const metrics = blocks.map((block) => ({ block, metrics: extractBoxMetrics(block) })).filter((item) => item.metrics !== null);
  if (metrics.length === 0) {
    return { matched: false, texts: [] };
  }

  const imageWidth = Math.max(...metrics.map((item) => item.metrics!.maxX));
  const imageHeight = Math.max(...metrics.map((item) => item.metrics!.maxY));
  if (!Number.isFinite(imageWidth) || !Number.isFinite(imageHeight) || imageWidth <= 0 || imageHeight <= 0) {
    return { matched: false, texts: [] };
  }

  const counts = new Map<string, number>();
  for (const item of metrics) {
    const normalized = String(item.block.text || "")
      .replace(/\s+/g, "")
      .trim()
      .toLowerCase();
    if (!normalized) continue;
    counts.set(normalized, (counts.get(normalized) || 0) + 1);
  }

  for (const item of metrics) {
    const rawText = String(item.block.text || "").trim();
    const normalized = rawText.replace(/\s+/g, "").trim().toLowerCase();
    if (!normalized) continue;
    const box = item.metrics!;
    const shortText = normalized.length <= 22;
    const repeated = (counts.get(normalized) || 0) >= 2;
    const hintMatched = WATERMARK_HINT_RE.test(rawText);
    const nearEdge =
      box.centerX <= imageWidth * 0.22 ||
      box.centerX >= imageWidth * 0.78 ||
      box.centerY <= imageHeight * 0.22 ||
      box.centerY >= imageHeight * 0.78;
    const compactBox = box.width <= imageWidth * 0.45 && box.height <= imageHeight * 0.18;
    const confident = typeof item.block.score !== "number" || item.block.score >= 0.45;

    if (nearEdge && compactBox && confident && (hintMatched || shortText || repeated)) {
      const reasons = ["edge"];
      if (hintMatched) reasons.push("hint");
      if (shortText) reasons.push("short-text");
      if (repeated) reasons.push("repeated");
      return {
        matched: true,
        reason: reasons.join("+"),
        texts: [rawText],
      };
    }
  }

  return { matched: false, texts: [] };
}

function collectUrls(value: unknown, results: string[], depth = 0) {
  if (depth > 5 || results.length > 4 || value == null) {
    return;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (URL_RE.test(trimmed)) {
      results.push(trimmed);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectUrls(item, results, depth + 1);
      if (results.length > 0) return;
    }
    return;
  }
  if (typeof value === "object") {
    const objectValue = value as Record<string, unknown>;
    const preferredKeys = ["outputs", "output", "images", "image", "url", "result", "data"];
    for (const key of preferredKeys) {
      if (key in objectValue) {
        collectUrls(objectValue[key], results, depth + 1);
        if (results.length > 0) return;
      }
    }
    for (const nested of Object.values(objectValue)) {
      collectUrls(nested, results, depth + 1);
      if (results.length > 0) return;
    }
  }
}

export function extractWavespeedOutputUrl(payload: unknown): string | undefined {
  const results: string[] = [];
  collectUrls(payload, results);
  return results[0];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runWaveSpeedRateLimited<T>(
  task: () => Promise<T>,
  options: WaveSpeedRateLimitOptions = {},
): Promise<T> {
  const now = options.now ?? (() => Date.now());
  const wait = options.wait ?? sleep;
  const minIntervalMs =
    typeof options.minIntervalMs === "number" && options.minIntervalMs >= 0
      ? options.minIntervalMs
      : WAVESPEED_MIN_INTERVAL_MS;

  const previous = waveSpeedQueue.catch(() => {});
  let release!: () => void;
  waveSpeedQueue = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;

  const current = now();
  const startAt = Math.max(current, nextWaveSpeedStartAt);
  nextWaveSpeedStartAt = startAt + minIntervalMs;
  const delay = startAt - current;
  if (delay > 0) {
    await wait(delay);
  }

  try {
    return await task();
  } finally {
    release();
  }
}

export function __resetWaveSpeedRateLimiterForTests(): void {
  waveSpeedQueue = Promise.resolve();
  nextWaveSpeedStartAt = 0;
}

export function shouldRetryWaveSpeedStatus(status?: number): boolean {
  return typeof status === "number" && (status === 408 || status === 409 || status === 425 || status === 429 || status >= 500);
}

async function requestJson(url: string, init: RequestInit): Promise<any> {
  const response = await fetch(url, init);
  const raw = await response.text();
  let parsed: any = undefined;
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    parsed = { raw };
  }
  if (!response.ok) {
    const error = new Error(`WaveSpeed request failed ${response.status}: ${JSON.stringify(parsed).slice(0, 280)}`) as Error & { status?: number; payload?: any };
    error.status = response.status;
    error.payload = parsed;
    throw error;
  }
  return parsed;
}

export async function removeWatermarkFromImageUrl(
  imageUrl: string,
  config?: WatermarkRemovalConfig,
): Promise<string> {
  const effective = resolveWatermarkRemovalConfig(config);
  if (!effective || !imageUrl || !URL_RE.test(imageUrl)) {
    return imageUrl;
  }

  let response: any = undefined;
  let lastError: any = undefined;
  const attempts = 3;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      response = await runWaveSpeedRateLimited(() =>
        requestJson(WAVESPEED_ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${effective.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            enable_sync_mode: true,
            enable_base64_output: false,
            image: imageUrl,
          }),
        }),
      );
      lastError = undefined;
      break;
    } catch (error: any) {
      lastError = error;
      if (attempt >= attempts || !shouldRetryWaveSpeedStatus(error?.status)) {
        break;
      }
      await sleep(attempt * 1500);
    }
  }
  if (lastError) {
    throw lastError;
  }

  const outputUrl = extractWavespeedOutputUrl(response);
  if (!outputUrl) {
    throw new Error(`WaveSpeed response missing output URL: ${JSON.stringify(response).slice(0, 280)}`);
  }
  return outputUrl;
}

export async function downloadBufferFromUrl(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed ${response.status} for ${url}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

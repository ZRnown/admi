import { randomUUID } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Jimp from "jimp";

export type WatermarkRemovalMode = "ocr" | "always";
export type WatermarkRemovalProvider = "wavespeed" | "iopaint";
export type IOPaintModel = "lama" | "migan" | "mat";
export type IOPaintStrategy = "crop" | "resize" | "original";
export type IOPaintMaskMode = "protect-text" | "box";

export interface WatermarkRemovalConfig {
  enabled?: boolean;
  mode?: WatermarkRemovalMode;
  provider?: WatermarkRemovalProvider;
  apiKey?: string;
  triggerKeywords?: string[];
  iopaintModel?: IOPaintModel;
  iopaintStrategy?: IOPaintStrategy;
  iopaintMaskMode?: IOPaintMaskMode;
  iopaintMaskPadding?: number;
}

export interface OcrTextBlock {
  box?: number[][];
  score?: number;
  text?: string;
  maskRole?: "watermark" | "protect";
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
  blocks?: OcrTextBlock[];
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
  maskBlocks?: OcrTextBlock[];
  removeWatermark?: (imageUrl: string, config?: WatermarkRemovalConfig, maskBlocks?: OcrTextBlock[]) => Promise<string>;
}
interface WaveSpeedRateLimitOptions {
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  minIntervalMs?: number;
  windowMs?: number;
  maxRequestsPerWindow?: number;
}

const WAVESPEED_ENDPOINT = "https://api.wavespeed.ai/api/v3/wavespeed-ai/image-watermark-remover";
const WAVESPEED_MIN_INTERVAL_MS = parseNonNegativeInt(process.env.WAVESPEED_MIN_INTERVAL_MS, 2000);
const WAVESPEED_RATE_LIMIT_WINDOW_MS = parseNonNegativeInt(process.env.WAVESPEED_RATE_LIMIT_WINDOW_MS, 60_000);
const WAVESPEED_RATE_LIMIT_MAX_REQUESTS = parseNonNegativeInt(process.env.WAVESPEED_RATE_LIMIT_MAX_REQUESTS, 10);
const IOPAINT_BIN = process.env.IOPAINT_BIN || "/root/iopaint-test/bin/iopaint";
const IOPAINT_DEVICE = process.env.IOPAINT_DEVICE || "cpu";
const IOPAINT_MODEL_DIR = process.env.IOPAINT_MODEL_DIR || "/root/iopaint-model-cache";
const IOPAINT_TIMEOUT_MS = parseNonNegativeInt(process.env.IOPAINT_TIMEOUT_MS, 120_000);
const IOPAINT_MASK_PADDING = parseNonNegativeInt(process.env.IOPAINT_MASK_PADDING, 8);
const IOPAINT_WORK_DIR = process.env.IOPAINT_WORK_DIR || path.join(process.cwd(), ".data", "iopaint_jobs");
const IOPAINT_OUTPUT_DIR = process.env.IOPAINT_OUTPUT_DIR || path.join(process.cwd(), ".data", "watermark_removed");
const IOPAINT_TEXT_REPAIR_ENABLED = process.env.IOPAINT_TEXT_REPAIR_ENABLED !== "false";
const IOPAINT_TEXT_REPAIR_FONT_PATH = process.env.IOPAINT_TEXT_REPAIR_FONT_PATH;
const IOPAINT_TEXT_REPAIR_FONT_FAMILY = process.env.IOPAINT_TEXT_REPAIR_FONT_FAMILY || "DejaVu Sans";
const IOPAINT_TEXT_REPAIR_CJK_FONT_FAMILY = process.env.IOPAINT_TEXT_REPAIR_CJK_FONT_FAMILY || "Noto Sans CJK SC";
const IOPAINT_TEXT_REPAIR_CJK_FONT_CANDIDATES = [
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf",
  "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
  "/usr/share/fonts/truetype/arphic/uming.ttc",
  "/System/Library/Fonts/PingFang.ttc",
  "/System/Library/Fonts/STHeiti Light.ttc",
];
const URL_RE = /^https?:\/\//i;
const WATERMARK_HINT_RE =
  /(?:watermark|logo|@|抖音|douyin|tiktok|小红书|xhs|快手|kuaishou|bilibili|b站|微博|weibo|视频号|公众号|微信|vx|wx|ins|instagram|telegram|tg|店铺|同款|关注|原创|搬运|出处)/i;
let waveSpeedQueue: Promise<void> = Promise.resolve();
let nextWaveSpeedStartAt = 0;
let waveSpeedRecentStarts: number[] = [];

function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

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

function normalizeWatermarkRemovalProvider(input: unknown, apiKey?: string): WatermarkRemovalProvider {
  if (input === "iopaint") return "iopaint";
  return apiKey ? "wavespeed" : input === "wavespeed" ? "wavespeed" : "iopaint";
}

function normalizeIOPaintModel(input: unknown): IOPaintModel {
  if (input === "migan" || input === "mat") return input;
  return "lama";
}

function normalizeIOPaintStrategy(input: unknown): IOPaintStrategy {
  if (input === "resize" || input === "original") return input;
  return "crop";
}

function normalizeIOPaintMaskMode(input: unknown): IOPaintMaskMode {
  if (input === "box") return "box";
  return "protect-text";
}

function normalizeOptionalNonNegativeInt(input: unknown): number | undefined {
  const value = Number(input);
  if (!Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
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
  const provider = normalizeWatermarkRemovalProvider(merged.provider, apiKey);
  const enabled = merged.enabled === true ? true : merged.enabled === false ? false : Boolean(apiKey || provider === "iopaint");
  if (!enabled) {
    return undefined;
  }
  if (provider === "wavespeed" && !apiKey) {
    return undefined;
  }

  const resolved: WatermarkRemovalConfig = {
    enabled: true,
    mode: merged.mode === "ocr" ? "ocr" : "always",
    provider,
    apiKey,
    triggerKeywords: normalizeTriggerKeywords(merged.triggerKeywords),
  };
  if (provider === "iopaint") {
    resolved.iopaintModel = normalizeIOPaintModel(merged.iopaintModel);
    resolved.iopaintStrategy = normalizeIOPaintStrategy(merged.iopaintStrategy);
    resolved.iopaintMaskMode = normalizeIOPaintMaskMode(merged.iopaintMaskMode);
    const maskPadding = normalizeOptionalNonNegativeInt(merged.iopaintMaskPadding);
    if (maskPadding !== undefined) {
      resolved.iopaintMaskPadding = maskPadding;
    }
  }
  return resolved;
}

export function shouldUseOcrWatermarkDetection(config?: WatermarkRemovalConfig): boolean {
  const resolved = resolveWatermarkRemovalConfig(config);
  return resolved?.enabled === true && resolved.mode === "ocr";
}

export function shouldPersistWatermarkRemovalConfig(config?: WatermarkRemovalConfig): boolean {
  if (!config || typeof config !== "object") return false;
  if (config.enabled === true || config.enabled === false) return true;
  if (config.mode === "ocr" || config.mode === "always") return true;
  if (config.provider === "wavespeed" || config.provider === "iopaint") return true;
  if (typeof config.apiKey === "string" && config.apiKey.trim().length > 0) return true;
  if (Array.isArray(config.triggerKeywords) && config.triggerKeywords.length > 0) return true;
  if (config.iopaintModel === "lama" || config.iopaintModel === "migan" || config.iopaintModel === "mat") return true;
  if (config.iopaintStrategy === "crop" || config.iopaintStrategy === "resize" || config.iopaintStrategy === "original") return true;
  if (config.iopaintMaskMode === "protect-text" || config.iopaintMaskMode === "box") return true;
  if (typeof config.iopaintMaskPadding === "number" && Number.isFinite(config.iopaintMaskPadding)) return true;
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
    const resolvedUrl = await removeWatermark(imageUrl, options.config, options.maskBlocks);
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
        blocks: [item.block],
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

function normalizeLocalFilePath(input: string): string {
  if (input.startsWith("file://")) {
    return fileURLToPath(input);
  }
  return input;
}

function isLocalReadableUrl(input: string): boolean {
  return input.startsWith("file://") || path.isAbsolute(input);
}

function resolveOutputPublicBaseUrl(): string | undefined {
  return firstNonEmptyString(
    process.env.WATERMARK_REMOVED_BASE_URL,
    process.env.PUBLIC_BASE_URL,
    process.env.NEXT_PUBLIC_BASE_URL,
    process.env.BASE_URL,
  );
}

function buildRemovedImageUrl(filename: string): string {
  const baseUrl = resolveOutputPublicBaseUrl();
  if (!baseUrl) {
    return `file://${path.join(IOPAINT_OUTPUT_DIR, filename)}`;
  }
  return new URL(`/api/watermark/removed/${encodeURIComponent(filename)}`, baseUrl).toString();
}

function strategyToIOPaintValue(strategy?: IOPaintStrategy): "Crop" | "Resize" | "Original" {
  if (strategy === "resize") return "Resize";
  if (strategy === "original") return "Original";
  return "Crop";
}

function fileExtensionFromUrl(imageUrl: string): string {
  try {
    const pathname = isLocalReadableUrl(imageUrl) ? normalizeLocalFilePath(imageUrl) : new URL(imageUrl).pathname;
    const ext = path.extname(pathname).toLowerCase();
    if ([".png", ".jpg", ".jpeg", ".webp"].includes(ext)) return ext;
  } catch {}
  return ".png";
}

interface IOPaintMaskBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface IOPaintMaskRegions {
  watermarkBoxes: IOPaintMaskBox[];
  protectBoxes: IOPaintMaskBox[];
}

function extractMaskBoxes(blocks?: OcrTextBlock[]): IOPaintMaskBox[] {
  if (!Array.isArray(blocks)) return [];
  return blocks
    .map((block) => extractBoxMetrics(block))
    .filter((metrics): metrics is NonNullable<ReturnType<typeof extractBoxMetrics>> => Boolean(metrics))
    .map((metrics) => ({
      minX: metrics.minX,
      minY: metrics.minY,
      maxX: metrics.maxX,
      maxY: metrics.maxY,
    }));
}

function expandMaskBox(box: IOPaintMaskBox, padding: number, imageWidth: number, imageHeight: number): IOPaintMaskBox {
  return {
    minX: Math.max(0, Math.floor(box.minX - padding)),
    minY: Math.max(0, Math.floor(box.minY - padding)),
    maxX: Math.min(imageWidth, Math.ceil(box.maxX + padding)),
    maxY: Math.min(imageHeight, Math.ceil(box.maxY + padding)),
  };
}

function isPointInMaskBox(x: number, y: number, box: IOPaintMaskBox): boolean {
  return x >= box.minX && x < box.maxX && y >= box.minY && y < box.maxY;
}

function boxesOverlap(a: IOPaintMaskBox, b: IOPaintMaskBox): boolean {
  return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;
}

function resolveIOPaintMaskRegions(
  blocks: OcrTextBlock[] | undefined,
  padding: number,
  imageWidth: number,
  imageHeight: number,
): IOPaintMaskRegions {
  const allBlocks = Array.isArray(blocks) ? blocks : [];
  const watermarkBlocks = allBlocks.filter((block) => block.maskRole !== "protect");
  const protectBlocks = allBlocks.filter((block) => block.maskRole === "protect");
  return {
    watermarkBoxes: extractMaskBoxes(watermarkBlocks).map((box) => expandMaskBox(box, padding, imageWidth, imageHeight)),
    protectBoxes: extractMaskBoxes(protectBlocks).map((box) => expandMaskBox(box, 1, imageWidth, imageHeight)),
  };
}

export function shouldPaintIOPaintMaskPoint(
  x: number,
  y: number,
  regions: IOPaintMaskRegions,
  mode: IOPaintMaskMode = "protect-text",
): boolean {
  const inWatermarkBox = regions.watermarkBoxes.some((box) => isPointInMaskBox(x, y, box));
  if (!inWatermarkBox) return false;
  if (mode === "box") return true;
  return !regions.protectBoxes.some((box) => isPointInMaskBox(x, y, box));
}

export function getIOPaintTextRepairBlocks(blocks?: OcrTextBlock[]): OcrTextBlock[] {
  const allBlocks = Array.isArray(blocks) ? blocks : [];
  const watermarkBoxes = extractMaskBoxes(allBlocks.filter((block) => block.maskRole !== "protect"));
  if (watermarkBoxes.length === 0) return [];

  return allBlocks.filter((block) => {
    if (block.maskRole !== "protect" || !String(block.text || "").trim()) return false;
    const metrics = extractBoxMetrics(block);
    if (!metrics) return false;
    const box = { minX: metrics.minX, minY: metrics.minY, maxX: metrics.maxX, maxY: metrics.maxY };
    return watermarkBoxes.some((watermarkBox) => boxesOverlap(box, watermarkBox));
  });
}

function estimateTextUnitCount(text: string): number {
  return Array.from(text).reduce((total, char) => total + (/[\u1100-\u9fff]/u.test(char) ? 1 : 0.58), 0);
}

export function resolveIOPaintTextRepairFontConfig(options?: {
  envPath?: string;
  envFamily?: string;
  cjkFamily?: string;
  candidates?: string[];
  exists?: (candidate: string) => boolean;
}): { fontPath?: string; fontFamily: string; hasCjkFont: boolean } {
  const envPath = options?.envPath ?? IOPAINT_TEXT_REPAIR_FONT_PATH;
  const fontFamily = options?.envFamily || IOPAINT_TEXT_REPAIR_FONT_FAMILY;
  const cjkFamily = options?.cjkFamily || IOPAINT_TEXT_REPAIR_CJK_FONT_FAMILY;
  const exists = options?.exists || existsSync;

  if (envPath && exists(envPath)) {
    return { fontPath: envPath, fontFamily, hasCjkFont: true };
  }

  const cjkFontPath = (options?.candidates || IOPAINT_TEXT_REPAIR_CJK_FONT_CANDIDATES).find((candidate) =>
    exists(candidate),
  );
  if (cjkFontPath) {
    return { fontPath: cjkFontPath, fontFamily: cjkFamily, hasCjkFont: true };
  }

  return { fontFamily, hasCjkFont: false };
}

function sampleRepairTextColor(image: any, box: IOPaintMaskBox): string {
  const x = Math.max(0, Math.floor(box.minX));
  const y = Math.max(0, Math.floor(box.minY));
  const width = Math.max(1, Math.min(image.bitmap.width, Math.ceil(box.maxX)) - x);
  const height = Math.max(1, Math.min(image.bitmap.height, Math.ceil(box.maxY)) - y);
  const samples: Array<{ r: number; g: number; b: number; luminance: number; edge: boolean }> = [];

  image.scan(x, y, width, height, (_x: number, _y: number, idx: number) => {
    const r = image.bitmap.data[idx];
    const g = image.bitmap.data[idx + 1];
    const b = image.bitmap.data[idx + 2];
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const edge = _x === x || _x === x + width - 1 || _y === y || _y === y + height - 1;
    samples.push({ r, g, b, luminance, edge });
  });

  if (samples.length === 0) return "rgb(245, 247, 250)";
  const edgeSamples = samples.filter((sample) => sample.edge);
  const edgeLuminance =
    edgeSamples.reduce((sum, sample) => sum + sample.luminance, 0) / Math.max(1, edgeSamples.length);
  const sorted = samples.slice().sort((a, b) => a.luminance - b.luminance);
  const pickBright = edgeLuminance < 128;
  const picked = pickBright
    ? sorted.slice(Math.max(0, Math.floor(sorted.length * 0.78)))
    : sorted.slice(0, Math.max(1, Math.ceil(sorted.length * 0.22)));
  const avg = picked.reduce(
    (acc, sample) => ({ r: acc.r + sample.r, g: acc.g + sample.g, b: acc.b + sample.b }),
    { r: 0, g: 0, b: 0 },
  );
  const count = Math.max(1, picked.length);
  return `rgb(${Math.round(avg.r / count)}, ${Math.round(avg.g / count)}, ${Math.round(avg.b / count)})`;
}

async function repairOverlappedOcrText(
  sourcePath: string,
  targetPath: string,
  blocks: OcrTextBlock[] | undefined,
  maskMode: IOPaintMaskMode,
): Promise<void> {
  if (!IOPAINT_TEXT_REPAIR_ENABLED || maskMode !== "protect-text") return;
  const repairBlocks = getIOPaintTextRepairBlocks(blocks);
  if (repairBlocks.length === 0) return;

  let canvasModule: any;
  try {
    const requireCanvas = eval("require") as (name: string) => any;
    canvasModule = requireCanvas("@napi-rs/canvas");
  } catch {
    return;
  }

  const { createCanvas, loadImage, GlobalFonts } = canvasModule;
  const fontConfig = resolveIOPaintTextRepairFontConfig();
  const fontFamily = fontConfig.fontFamily;
  if (fontConfig.fontPath) {
    try {
      await fs.access(fontConfig.fontPath);
      GlobalFonts.registerFromPath(fontConfig.fontPath, fontFamily);
    } catch {}
  }

  const target = await loadImage(targetPath);
  const canvas = createCanvas(target.width, target.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(target, 0, 0);
  const sourceImage = await Jimp.read(sourcePath);

  for (const block of repairBlocks) {
    const text = String(block.text || "").trim();
    const metrics = extractBoxMetrics(block);
    if (!text || !metrics) continue;
    if (!fontConfig.hasCjkFont && /[\u3400-\u9fff]/u.test(text)) {
      continue;
    }

    const box = { minX: metrics.minX, minY: metrics.minY, maxX: metrics.maxX, maxY: metrics.maxY };
    const width = Math.max(1, metrics.width);
    const height = Math.max(1, metrics.height);
    let fontSize = Math.max(8, Math.min(height * 0.92, width / Math.max(1, estimateTextUnitCount(text)) * 1.15));
    for (let attempt = 0; attempt < 8; attempt += 1) {
      ctx.font = `500 ${fontSize}px "${fontFamily}"`;
      if (ctx.measureText(text).width <= width * 1.04 || fontSize <= 8) break;
      fontSize *= 0.9;
    }
    ctx.font = `500 ${fontSize}px "${fontFamily}"`;
    ctx.fillStyle = sampleRepairTextColor(sourceImage, box);
    ctx.textBaseline = "middle";
    ctx.fillText(text, metrics.minX, metrics.centerY);
  }

  await fs.writeFile(targetPath, canvas.toBuffer("image/png"));
}

async function createMaskForImage(
  imagePath: string,
  maskPath: string,
  blocks: OcrTextBlock[] | undefined,
  padding: number,
  maskMode: IOPaintMaskMode,
): Promise<void> {
  const image = await Jimp.read(imagePath);
  const mask = new Jimp(image.bitmap.width, image.bitmap.height, 0x000000ff);
  const regions = resolveIOPaintMaskRegions(blocks, padding, image.bitmap.width, image.bitmap.height);
  const boxes = regions.watermarkBoxes;

  if (boxes.length === 0) {
    const width = Math.max(1, Math.round(image.bitmap.width * 0.46));
    const height = Math.max(1, Math.round(image.bitmap.height * 0.22));
    const x = Math.max(0, image.bitmap.width - width);
    const y = Math.max(0, image.bitmap.height - height);
    mask.scan(x, y, width, height, (_x: number, _y: number, idx: number) => {
      mask.bitmap.data[idx] = 255;
      mask.bitmap.data[idx + 1] = 255;
      mask.bitmap.data[idx + 2] = 255;
      mask.bitmap.data[idx + 3] = 255;
    });
    await mask.writeAsync(maskPath);
    return;
  }

  for (const box of boxes) {
    const x = Math.max(0, Math.floor(box.minX));
    const y = Math.max(0, Math.floor(box.minY));
    const right = Math.min(image.bitmap.width, Math.ceil(box.maxX));
    const bottom = Math.min(image.bitmap.height, Math.ceil(box.maxY));
    const width = Math.max(1, right - x);
    const height = Math.max(1, bottom - y);
    mask.scan(x, y, width, height, (_x: number, _y: number, idx: number) => {
      if (!shouldPaintIOPaintMaskPoint(_x, _y, regions, maskMode)) {
        return;
      }
      mask.bitmap.data[idx] = 255;
      mask.bitmap.data[idx + 1] = 255;
      mask.bitmap.data[idx + 2] = 255;
      mask.bitmap.data[idx + 3] = 255;
    });
  }

  await mask.writeAsync(maskPath);
}

function runCommand(command: string, args: string[], options: { cwd?: string; timeoutMs?: number } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`IOPaint timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs ?? IOPAINT_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`IOPaint failed ${code}: ${(stderr || stdout).slice(0, 800)}`));
    });
  });
}

async function removeWatermarkWithIOPaint(
  imageUrl: string,
  config: WatermarkRemovalConfig,
  maskBlocks?: OcrTextBlock[],
): Promise<string> {
  const effective = resolveWatermarkRemovalConfig(config);
  if (!effective || effective.provider !== "iopaint") return imageUrl;

  const jobId = randomUUID();
  const workDir = path.join(IOPAINT_WORK_DIR, jobId);
  const inputDir = path.join(workDir, "input");
  const maskDir = path.join(workDir, "mask");
  const outputDir = path.join(workDir, "output");
  await Promise.all([
    fs.mkdir(inputDir, { recursive: true }),
    fs.mkdir(maskDir, { recursive: true }),
    fs.mkdir(outputDir, { recursive: true }),
    fs.mkdir(IOPAINT_OUTPUT_DIR, { recursive: true }),
  ]);

  const ext = fileExtensionFromUrl(imageUrl);
  const inputPath = path.join(inputDir, `image${ext}`);
  const maskPath = path.join(maskDir, "image.png");
  const configPath = path.join(workDir, "config.json");

  try {
    const buffer = isLocalReadableUrl(imageUrl)
      ? await fs.readFile(normalizeLocalFilePath(imageUrl))
      : await downloadBufferFromUrl(imageUrl);
    await fs.writeFile(inputPath, buffer);
    const padding = effective.iopaintMaskPadding ?? IOPAINT_MASK_PADDING;
    await createMaskForImage(inputPath, maskPath, maskBlocks, padding, effective.iopaintMaskMode || "protect-text");
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          hd_strategy: strategyToIOPaintValue(effective.iopaintStrategy),
          hd_strategy_crop_trigger_size: 800,
          hd_strategy_crop_margin: 128,
          hd_strategy_resize_limit: 1280,
        },
        null,
        2,
      ),
    );

    await runCommand(
      IOPAINT_BIN,
      [
        "run",
        "--model",
        effective.iopaintModel || "lama",
        "--device",
        IOPAINT_DEVICE,
        "--image",
        inputDir,
        "--mask",
        maskDir,
        "--output",
        outputDir,
        "--config",
        configPath,
        "--model-dir",
        IOPAINT_MODEL_DIR,
      ],
      { timeoutMs: IOPAINT_TIMEOUT_MS },
    );

    const generatedPath = path.join(outputDir, "image.png");
    await repairOverlappedOcrText(inputPath, generatedPath, maskBlocks, effective.iopaintMaskMode || "protect-text");
    const filename = `${Date.now()}_${jobId.slice(0, 8)}.png`;
    const savedPath = path.join(IOPAINT_OUTPUT_DIR, filename);
    await fs.copyFile(generatedPath, savedPath);
    return buildRemovedImageUrl(filename);
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
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
  const windowMs =
    typeof options.windowMs === "number" && options.windowMs >= 0
      ? options.windowMs
      : WAVESPEED_RATE_LIMIT_WINDOW_MS;
  const maxRequestsPerWindow =
    typeof options.maxRequestsPerWindow === "number" && options.maxRequestsPerWindow >= 0
      ? options.maxRequestsPerWindow
      : WAVESPEED_RATE_LIMIT_MAX_REQUESTS;

  const previous = waveSpeedQueue.catch(() => {});
  let release!: () => void;
  waveSpeedQueue = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;

  const current = now();
  if (windowMs > 0) {
    waveSpeedRecentStarts = waveSpeedRecentStarts.filter((startedAt) => current - startedAt < windowMs);
  } else {
    waveSpeedRecentStarts = [];
  }

  let startAt = Math.max(current, nextWaveSpeedStartAt);
  if (windowMs > 0 && maxRequestsPerWindow > 0 && waveSpeedRecentStarts.length >= maxRequestsPerWindow) {
    const windowReleaseAt = waveSpeedRecentStarts[0] + windowMs;
    startAt = Math.max(startAt, windowReleaseAt);
  }
  nextWaveSpeedStartAt = startAt + minIntervalMs;
  const delay = startAt - current;
  if (delay > 0) {
    await wait(delay);
  }
  if (windowMs > 0) {
    waveSpeedRecentStarts = waveSpeedRecentStarts.filter((startedAt) => startAt - startedAt < windowMs);
  } else {
    waveSpeedRecentStarts = [];
  }
  waveSpeedRecentStarts.push(startAt);

  try {
    return await task();
  } finally {
    release();
  }
}

export function __resetWaveSpeedRateLimiterForTests(): void {
  waveSpeedQueue = Promise.resolve();
  nextWaveSpeedStartAt = 0;
  waveSpeedRecentStarts = [];
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
  maskBlocks?: OcrTextBlock[],
): Promise<string> {
  const effective = resolveWatermarkRemovalConfig(config);
  if (!effective || !imageUrl) {
    return imageUrl;
  }

  if (effective.provider === "iopaint") {
    if (!URL_RE.test(imageUrl) && !isLocalReadableUrl(imageUrl)) {
      return imageUrl;
    }
    return removeWatermarkWithIOPaint(imageUrl, effective, maskBlocks);
  }

  if (!URL_RE.test(imageUrl)) {
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

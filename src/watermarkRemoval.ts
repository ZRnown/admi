import { randomUUID } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Jimp from "jimp";

export type WatermarkRemovalMode = "ocr" | "always" | "fixed" | "mask";
export type WatermarkRemovalProvider = "wavespeed" | "iopaint";
export type IOPaintModel = "lama" | "migan" | "mat";
export type IOPaintStrategy = "crop" | "resize" | "original";
export type IOPaintMaskMode = "protect-text" | "smart-color" | "box";

export interface WatermarkRemovalManualRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  angle?: number;
  label?: string;
}

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
  manualRegions?: WatermarkRemovalManualRegion[];
  maskColor?: string;
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

interface WatermarkDetectionCandidate {
  item: { block: OcrTextBlock; metrics: NonNullable<ReturnType<typeof extractBoxMetrics>> };
  reason: string;
  priority: number;
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
const IOPAINT_BIN =
  process.env.IOPAINT_BIN ||
  (process.platform === "win32"
    ? path.join(process.cwd(), ".data", "iopaint-venv", "Scripts", "iopaint.exe")
    : "/root/iopaint-test/bin/iopaint");
const IOPAINT_DEVICE = process.env.IOPAINT_DEVICE || "cpu";
const IOPAINT_MODEL_DIR =
  process.env.IOPAINT_MODEL_DIR ||
  (process.platform === "win32"
    ? path.join(process.cwd(), ".data", "iopaint-model-cache")
    : "/root/iopaint-model-cache");
const IOPAINT_TIMEOUT_MS = parseNonNegativeInt(process.env.IOPAINT_TIMEOUT_MS, 120_000);
const IOPAINT_MASK_PADDING = parseNonNegativeInt(process.env.IOPAINT_MASK_PADDING, 8);
const IOPAINT_WORK_DIR = process.env.IOPAINT_WORK_DIR || path.join(process.cwd(), ".data", "iopaint_jobs");
const IOPAINT_OUTPUT_DIR = process.env.IOPAINT_OUTPUT_DIR || path.join(process.cwd(), ".data", "watermark_removed");
const IOPAINT_PROTECT_BOX_SHRINK_RATIO = Math.min(
  0.45,
  Math.max(0, Number(process.env.IOPAINT_PROTECT_BOX_SHRINK_RATIO ?? "0.08")),
);
const IOPAINT_TEXT_REPAIR_ENABLED = process.env.IOPAINT_TEXT_REPAIR_ENABLED === "true";
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
  /(?:watermark|logo|@|抖音|douyin|tiktok|小红书|xhs|快手|kuaishou|bilibili|b站|微博|weibo|视频号|公众号|微信|账号|discord|tg|telegram|ins|instagram|vx|wx|店铺|社区|网站|同款|关注|原创|搬运|出处)/i;
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
  if (input === "smart-color") return "smart-color";
  if (input === "box") return "box";
  return "protect-text";
}

function normalizeOptionalNonNegativeInt(input: unknown): number | undefined {
  const value = Number(input);
  if (!Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

function normalizeMaskColor(input: unknown): string {
  return typeof input === "string" && /^#[0-9a-f]{6}$/i.test(input.trim()) ? input.trim().toLowerCase() : "#000000";
}

function normalizeManualRegions(input: unknown): WatermarkRemovalManualRegion[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const regions = input
    .map((item): WatermarkRemovalManualRegion | undefined => {
      if (!item || typeof item !== "object") return undefined;
      const source = item as Record<string, unknown>;
      const x = Number(source.x);
      const y = Number(source.y);
      const width = Number(source.width);
      const height = Number(source.height);
      if (![x, y, width, height].every(Number.isFinite)) return undefined;
      const clampedX = Math.max(0, Math.min(1, x));
      const clampedY = Math.max(0, Math.min(1, y));
      const clampedWidth = Math.max(0, Math.min(1 - clampedX, width));
      const clampedHeight = Math.max(0, Math.min(1 - clampedY, height));
      if (clampedWidth <= 0 || clampedHeight <= 0) return undefined;
      const rawAngle = Number(source.angle);
      const angle = Number.isFinite(rawAngle) ? ((rawAngle % 360) + 540) % 360 - 180 : 0;
      const label = typeof source.label === "string" && source.label.trim() ? source.label.trim() : undefined;
      return {
        x: clampedX,
        y: clampedY,
        width: clampedWidth,
        height: clampedHeight,
        angle,
        ...(label ? { label } : {}),
      };
    })
    .filter((item): item is WatermarkRemovalManualRegion => Boolean(item));
  return regions.length > 0 ? regions : undefined;
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
    mode: merged.mode === "ocr" || merged.mode === "fixed" || merged.mode === "mask" ? merged.mode : "always",
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
    resolved.manualRegions = normalizeManualRegions(merged.manualRegions);
    resolved.maskColor = normalizeMaskColor(merged.maskColor);
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
  if (config.mode === "ocr" || config.mode === "always" || config.mode === "fixed" || config.mode === "mask") return true;
  if (config.provider === "wavespeed" || config.provider === "iopaint") return true;
  if (typeof config.apiKey === "string" && config.apiKey.trim().length > 0) return true;
  if (Array.isArray(config.triggerKeywords) && config.triggerKeywords.length > 0) return true;
  if (config.iopaintModel === "lama" || config.iopaintModel === "migan" || config.iopaintModel === "mat") return true;
  if (config.iopaintStrategy === "crop" || config.iopaintStrategy === "resize" || config.iopaintStrategy === "original") return true;
  if (
    config.iopaintMaskMode === "protect-text" ||
    config.iopaintMaskMode === "smart-color" ||
    config.iopaintMaskMode === "box"
  ) return true;
  if (typeof config.iopaintMaskPadding === "number" && Number.isFinite(config.iopaintMaskPadding)) return true;
  if (Array.isArray(config.manualRegions) && config.manualRegions.length > 0) return true;
  if (typeof config.maskColor === "string" && config.maskColor.trim().length > 0) return true;
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

function horizontalOverlapRatio(a: { minX: number; maxX: number }, b: { minX: number; maxX: number }): number {
  const overlap = Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX));
  return overlap / Math.max(1, Math.min(a.maxX - a.minX, b.maxX - b.minX));
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

  const candidates: WatermarkDetectionCandidate[] = [];
  for (const item of metrics) {
    const rawText = String(item.block.text || "").trim();
    const normalized = rawText.replace(/\s+/g, "").trim().toLowerCase();
    if (!normalized) continue;
    if (/^[\d.,%+−\-→><￥¥$]+$/u.test(normalized)) continue;
    const box = item.metrics!;
    const shortText = normalized.length <= 22;
    const repeated = (counts.get(normalized) || 0) >= 2;
    const hintMatched = WATERMARK_HINT_RE.test(rawText);
    const nearEdge =
      box.centerX <= imageWidth * 0.22 ||
      box.centerX >= imageWidth * 0.78 ||
      box.centerY <= imageHeight * 0.22 ||
      box.centerY >= imageHeight * 0.78;
    const compactBox = hintMatched ? box.height <= imageHeight * 0.18 : box.width <= imageWidth * 0.45 && box.height <= imageHeight * 0.18;
    const confident = typeof item.block.score !== "number" || item.block.score >= 0.45;

    const eligible = compactBox && confident && (hintMatched || (nearEdge && (shortText || repeated)));

    if (eligible) {
      const reasons = [];
      if (nearEdge) reasons.push("edge");
      if (hintMatched) reasons.push("hint");
      if (shortText) reasons.push("short-text");
      if (repeated) reasons.push("repeated");
      const priority = (hintMatched ? 100 : 0) + (repeated ? 40 : 0) + (shortText ? 10 : 0) + (nearEdge ? 5 : 0);
      candidates.push({
        item: item as WatermarkDetectionCandidate["item"],
        reason: reasons.join("+"),
        priority,
      });
    }
  }

  candidates.sort((a, b) => b.priority - a.priority);
  const best = candidates[0];
  if (best) {
    let selected =
      best.reason.includes("hint")
        ? candidates.filter((candidate) => candidate.reason.includes("hint") && candidate.priority >= best.priority - 30)
        : [best];
    if (best.reason.includes("hint")) {
      const selectedSet = new Set(selected.map((candidate) => candidate.item.block));
      const selectedBoxes = selected.map((candidate) => candidate.item.metrics);
      const nearbyCandidates = metrics.filter((item) => {
        if (selectedSet.has(item.block) || !item.metrics) return false;
        const text = String(item.block.text || "").trim();
        const score = typeof item.block.score === "number" ? item.block.score : 1;
        if (!text || text.length > 24 || score < 0.35) return false;
        if (item.metrics.width > imageWidth * 0.42) return false;
        const lowConfidence = score < 0.85;
        const logoSized = item.metrics.height <= imageHeight * 0.08 || item.metrics.width <= imageWidth * 0.08;
        if (!lowConfidence && !logoSized) return false;
        return selectedBoxes.some((selectedBox) => {
          const closeY = Math.abs(item.metrics!.centerY - selectedBox.centerY) <= imageHeight * 0.2;
          const closeX = horizontalOverlapRatio(item.metrics!, selectedBox) >= 0.45;
          return closeY && closeX;
        });
      });
      if (nearbyCandidates.length > 0) {
        selected = [
          ...nearbyCandidates.map((item) => ({
            item: item as WatermarkDetectionCandidate["item"],
            reason: "nearby-hint",
            priority: best.priority - 20,
          })),
          ...selected,
        ];
      }
    }
    return {
      matched: true,
      reason: best.reason,
      texts: selected.map((candidate) => String(candidate.item.block.text || "").trim()).filter(Boolean),
      blocks: selected.map((candidate) => candidate.item.block),
    };
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

export function resolveIOPaintManualMaskBlocks(
  regions: WatermarkRemovalManualRegion[] | undefined,
  imageWidth: number,
  imageHeight: number,
  padding = 0,
): OcrTextBlock[] {
  const normalized = normalizeManualRegions(regions);
  if (!normalized || imageWidth <= 0 || imageHeight <= 0) return [];
  return normalized.map((region) => {
    const minX = Math.max(0, Math.min(imageWidth, Math.round(region.x * imageWidth) - padding));
    const minY = Math.max(0, Math.min(imageHeight, Math.round(region.y * imageHeight) - padding));
    const maxX = Math.max(minX, Math.min(imageWidth, Math.round((region.x + region.width) * imageWidth) + padding));
    const maxY = Math.max(minY, Math.min(imageHeight, Math.round((region.y + region.height) * imageHeight) + padding));
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const radians = ((region.angle || 0) * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const rotatePoint = (x: number, y: number) => {
      const dx = x - centerX;
      const dy = y - centerY;
      return [
        Math.max(0, Math.min(imageWidth, Math.round(centerX + dx * cos - dy * sin))),
        Math.max(0, Math.min(imageHeight, Math.round(centerY + dx * sin + dy * cos))),
      ];
    };
    return {
      text: region.label || "manual-region",
      maskRole: "watermark",
      box: [
        rotatePoint(minX, minY),
        rotatePoint(maxX, minY),
        rotatePoint(maxX, maxY),
        rotatePoint(minX, maxY),
      ],
    };
  });
}

function isPointInPolygon(x: number, y: number, polygon: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i]?.[0] ?? 0;
    const yi = polygon[i]?.[1] ?? 0;
    const xj = polygon[j]?.[0] ?? 0;
    const yj = polygon[j]?.[1] ?? 0;
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi || Number.EPSILON) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function expandMaskBox(box: IOPaintMaskBox, padding: number, imageWidth: number, imageHeight: number): IOPaintMaskBox {
  return {
    minX: Math.max(0, Math.floor(box.minX - padding)),
    minY: Math.max(0, Math.floor(box.minY - padding)),
    maxX: Math.min(imageWidth, Math.ceil(box.maxX + padding)),
    maxY: Math.min(imageHeight, Math.ceil(box.maxY + padding)),
  };
}

function shrinkMaskBox(box: IOPaintMaskBox, ratio: number): IOPaintMaskBox {
  if (ratio <= 0) return box;
  const width = Math.max(0, box.maxX - box.minX);
  const height = Math.max(0, box.maxY - box.minY);
  const shrinkX = Math.floor(width * ratio);
  const shrinkY = Math.floor(height * ratio);
  if (shrinkX * 2 >= width || shrinkY * 2 >= height) return box;
  return {
    minX: box.minX + shrinkX,
    minY: box.minY + shrinkY,
    maxX: box.maxX - shrinkX,
    maxY: box.maxY - shrinkY,
  };
}

function isPointInMaskBox(x: number, y: number, box: IOPaintMaskBox): boolean {
  return x >= box.minX && x < box.maxX && y >= box.minY && y < box.maxY;
}

function boxesOverlap(a: IOPaintMaskBox, b: IOPaintMaskBox): boolean {
  return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;
}

export function resolveIOPaintMaskRegions(
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
    protectBoxes: extractMaskBoxes(protectBlocks).map((box) => shrinkMaskBox(box, IOPAINT_PROTECT_BOX_SHRINK_RATIO)),
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
    const text = String(block.text || "").trim();
    if (block.maskRole !== "protect" || !text) return false;
    const metrics = extractBoxMetrics(block);
    if (!metrics) return false;
    const compactText = estimateTextUnitCount(text) <= 12;
    const compactBox = metrics.width <= 220 && metrics.height <= 44;
    const confident = typeof block.score !== "number" || block.score >= 0.9;
    if (!compactText || !compactBox || !confident) return false;
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

function getPixelLuminance(r: number, g: number, b: number): number {
  return Math.round(0.299 * r + 0.587 * g + 0.114 * b);
}

function buildDarkTextMap(image: any): Uint8Array {
  const width = image.bitmap.width;
  const darkMap = new Uint8Array(width * image.bitmap.height);
  image.scan(0, 0, width, image.bitmap.height, (x: number, y: number, idx: number) => {
    const luminance = getPixelLuminance(
      image.bitmap.data[idx],
      image.bitmap.data[idx + 1],
      image.bitmap.data[idx + 2],
    );
    if (luminance < 135) darkMap[y * width + x] = 1;
  });
  return darkMap;
}

function hasDarkTextNeighbor(darkMap: Uint8Array, width: number, height: number, x: number, y: number): boolean {
  for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
    const sampleY = y + offsetY;
    if (sampleY < 0 || sampleY >= height) continue;
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      const sampleX = x + offsetX;
      if (sampleX >= 0 && sampleX < width && darkMap[sampleY * width + sampleX]) return true;
    }
  }
  return false;
}

export function shouldPaintSmartColorMaskPixel(
  r: number,
  g: number,
  b: number,
  nearDarkText: boolean,
): boolean {
  return !nearDarkText && getPixelLuminance(r, g, b) < 253;
}

async function neutralizeProtectedDarkText(
  sourcePath: string,
  targetPath: string,
  manualRegions: WatermarkRemovalManualRegion[] | undefined,
  padding: number,
): Promise<void> {
  if (!manualRegions?.length) return;
  const source = await Jimp.read(sourcePath);
  const target = await Jimp.read(targetPath);
  const { width, height } = source.bitmap;
  const darkMap = buildDarkTextMap(source);
  const manualBlocks = resolveIOPaintManualMaskBlocks(manualRegions, width, height, padding);

  for (const block of manualBlocks) {
    const polygon = block.box || [];
    const metrics = extractBoxMetrics(block);
    if (!metrics || polygon.length < 3) continue;
    const left = Math.max(0, Math.floor(metrics.minX));
    const top = Math.max(0, Math.floor(metrics.minY));
    const right = Math.min(width, Math.ceil(metrics.maxX));
    const bottom = Math.min(height, Math.ceil(metrics.maxY));
    source.scan(left, top, Math.max(1, right - left), Math.max(1, bottom - top), (x: number, y: number, idx: number) => {
      if (!isPointInPolygon(x, y, polygon) || !hasDarkTextNeighbor(darkMap, width, height, x, y)) return;
      const r = source.bitmap.data[idx];
      const g = source.bitmap.data[idx + 1];
      const b = source.bitmap.data[idx + 2];
      if (r - Math.max(g, b) <= 4) return;
      const luminance = getPixelLuminance(r, g, b);
      const targetIdx = (y * width + x) * 4;
      target.bitmap.data[targetIdx] = luminance;
      target.bitmap.data[targetIdx + 1] = luminance;
      target.bitmap.data[targetIdx + 2] = luminance;
      target.bitmap.data[targetIdx + 3] = source.bitmap.data[idx + 3];
    });
  }

  await target.writeAsync(targetPath);
}

async function createMaskForImage(
  imagePath: string,
  maskPath: string,
  blocks: OcrTextBlock[] | undefined,
  padding: number,
  maskMode: IOPaintMaskMode,
  manualRegions?: WatermarkRemovalManualRegion[],
): Promise<void> {
  const image = await Jimp.read(imagePath);
  const mask = new Jimp(image.bitmap.width, image.bitmap.height, 0x000000ff);
  const manualBlocks = resolveIOPaintManualMaskBlocks(manualRegions, image.bitmap.width, image.bitmap.height, padding);
  const darkTextMap = maskMode === "smart-color" ? buildDarkTextMap(image) : undefined;
  const regions = resolveIOPaintMaskRegions(blocks, padding, image.bitmap.width, image.bitmap.height);
  const boxes = regions.watermarkBoxes;

  if (boxes.length === 0 && manualBlocks.length === 0) {
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

  for (const block of manualBlocks) {
    const polygon = block.box || [];
    const metrics = extractBoxMetrics(block);
    if (!metrics || polygon.length < 3) continue;
    const left = Math.max(0, Math.floor(metrics.minX));
    const top = Math.max(0, Math.floor(metrics.minY));
    const right = Math.min(image.bitmap.width, Math.ceil(metrics.maxX));
    const bottom = Math.min(image.bitmap.height, Math.ceil(metrics.maxY));
    mask.scan(
      left,
      top,
      Math.max(1, right - left),
      Math.max(1, bottom - top),
      (x: number, y: number, idx: number) => {
        if (!isPointInPolygon(x, y, polygon)) return;
        if (darkTextMap) {
          const sourceIdx = (y * image.bitmap.width + x) * 4;
          const shouldPaint = shouldPaintSmartColorMaskPixel(
            image.bitmap.data[sourceIdx],
            image.bitmap.data[sourceIdx + 1],
            image.bitmap.data[sourceIdx + 2],
            hasDarkTextNeighbor(darkTextMap, image.bitmap.width, image.bitmap.height, x, y),
          );
          if (!shouldPaint) return;
        }
        mask.bitmap.data[idx] = 255;
        mask.bitmap.data[idx + 1] = 255;
        mask.bitmap.data[idx + 2] = 255;
        mask.bitmap.data[idx + 3] = 255;
      },
    );
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

async function runOpenCvInpaint(inputPath: string, maskPath: string, outputPath: string): Promise<void> {
  const pythonBin =
    process.env.PYTHON || process.env.PYTHON_BIN || process.env.PYTHON_EXECUTABLE ||
    (process.platform === "win32" ? "python" : "python3");
  const scriptPath = path.join(process.cwd(), "scripts", "opencv_inpaint.py");
  await runCommand(
    pythonBin,
    ["-B", scriptPath, "--image", inputPath, "--mask", maskPath, "--output", outputPath],
    { timeoutMs: IOPAINT_TIMEOUT_MS },
  );
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
    await createMaskForImage(
      inputPath,
      maskPath,
      maskBlocks,
      padding,
      effective.iopaintMaskMode || "protect-text",
      effective.manualRegions,
    );
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

    const generatedPath = path.join(outputDir, "image.png");
    try {
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
    } catch (error: any) {
      console.warn(`[去水印] IOPaint 不可用，改用 OpenCV 修复: ${String(error?.message || error)}`);
      await runOpenCvInpaint(inputPath, maskPath, generatedPath);
    }

    if (effective.iopaintMaskMode === "smart-color") {
      await neutralizeProtectedDarkText(inputPath, generatedPath, effective.manualRegions, padding);
    }
    await repairOverlappedOcrText(inputPath, generatedPath, maskBlocks, effective.iopaintMaskMode || "protect-text");
    const filename = `${Date.now()}_${jobId.slice(0, 8)}.png`;
    const savedPath = path.join(IOPAINT_OUTPUT_DIR, filename);
    await fs.copyFile(generatedPath, savedPath);
    return buildRemovedImageUrl(filename);
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function coverWatermarkRegions(imageUrl: string, config: WatermarkRemovalConfig): Promise<string> {
  const regions = config.manualRegions;
  if (!regions || regions.length === 0) return imageUrl;
  const buffer = isLocalReadableUrl(imageUrl)
    ? await fs.readFile(normalizeLocalFilePath(imageUrl))
    : await downloadBufferFromUrl(imageUrl);
  const image = await Jimp.read(buffer);
  const padding = config.iopaintMaskPadding ?? IOPAINT_MASK_PADDING;
  const blocks = resolveIOPaintManualMaskBlocks(regions, image.bitmap.width, image.bitmap.height, padding);
  const color = normalizeMaskColor(config.maskColor);
  const rgb = Number.parseInt(color.slice(1), 16);

  for (const block of blocks) {
    const polygon = block.box || [];
    const metrics = extractBoxMetrics(block);
    if (!metrics || polygon.length < 3) continue;
    const left = Math.max(0, Math.floor(metrics.minX));
    const top = Math.max(0, Math.floor(metrics.minY));
    const right = Math.min(image.bitmap.width, Math.ceil(metrics.maxX));
    const bottom = Math.min(image.bitmap.height, Math.ceil(metrics.maxY));
    image.scan(left, top, Math.max(1, right - left), Math.max(1, bottom - top), (x: number, y: number, idx: number) => {
      if (!isPointInPolygon(x, y, polygon)) return;
      image.bitmap.data[idx] = (rgb >> 16) & 0xff;
      image.bitmap.data[idx + 1] = (rgb >> 8) & 0xff;
      image.bitmap.data[idx + 2] = rgb & 0xff;
      image.bitmap.data[idx + 3] = 0xff;
    });
  }

  await fs.mkdir(IOPAINT_OUTPUT_DIR, { recursive: true });
  const filename = `${Date.now()}_${randomUUID().slice(0, 8)}.png`;
  await image.writeAsync(path.join(IOPAINT_OUTPUT_DIR, filename));
  return buildRemovedImageUrl(filename);
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

  if (effective.mode === "mask") {
    if (!URL_RE.test(imageUrl) && !isLocalReadableUrl(imageUrl)) return imageUrl;
    return coverWatermarkRegions(imageUrl, effective);
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

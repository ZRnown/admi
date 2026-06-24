import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import Jimp from "jimp";
import type {
  WatermarkCoverAspect,
  WatermarkCoverConfig,
  WatermarkCoverFillMode,
  WatermarkCoverRegion,
} from "./config";

interface PixelRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  region: WatermarkCoverRegion;
}

type JimpImageLike = {
  bitmap: { width: number; height: number; data: Buffer };
  getPixelColor(x: number, y: number): number;
  scan(x: number, y: number, width: number, height: number, cb: (x: number, y: number, idx: number) => void): void;
};

const DEFAULT_COLOR = "#000000";
const DEFAULT_OPACITY = 85;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function normalizeColor(value?: string): string {
  const raw = String(value || "").trim();
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toLowerCase();
  if (/^[0-9a-fA-F]{6}$/.test(raw)) return `#${raw.toLowerCase()}`;
  return DEFAULT_COLOR;
}

function normalizeOpacity(value?: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_OPACITY;
  return Math.max(0, Math.min(100, Math.round(parsed)));
}

function inferAspect(width: number, height: number): WatermarkCoverAspect {
  const ratio = width / Math.max(1, height);
  if (ratio > 1.08) return "landscape";
  if (ratio < 0.92) return "portrait";
  return "square";
}

function shouldUseRegion(region: WatermarkCoverRegion, width: number, height: number): boolean {
  const aspect = region.aspect || "all";
  if (aspect === "all") return true;
  return inferAspect(width, height) === aspect;
}

function resolvePixelRegions(config: WatermarkCoverConfig | undefined, width: number, height: number): PixelRegion[] {
  if (!config?.enabled || !Array.isArray(config.regions)) return [];
  const result: PixelRegion[] = [];
  for (const region of config.regions) {
    if (!region || !shouldUseRegion(region, width, height)) continue;
    const x = clamp01(Number(region.x));
    const y = clamp01(Number(region.y));
    const w = Math.max(0, Math.min(1 - x, Number(region.width)));
    const h = Math.max(0, Math.min(1 - y, Number(region.height)));
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) continue;
    const px = Math.floor(x * width);
    const py = Math.floor(y * height);
    const pw = Math.max(1, Math.ceil(w * width));
    const ph = Math.max(1, Math.ceil(h * height));
    result.push({
      x: Math.max(0, Math.min(width - 1, px)),
      y: Math.max(0, Math.min(height - 1, py)),
      width: Math.max(1, Math.min(width - px, pw)),
      height: Math.max(1, Math.min(height - py, ph)),
      region,
    });
  }
  return result;
}

function parseHexColor(color: string): { r: number; g: number; b: number } {
  const hex = normalizeColor(color).slice(1);
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  };
}

function sampleSurroundingColor(image: JimpImageLike, box: PixelRegion): { r: number; g: number; b: number } {
  const samples: Array<{ r: number; g: number; b: number }> = [];
  const left = Math.max(0, box.x - 3);
  const top = Math.max(0, box.y - 3);
  const right = Math.min(image.bitmap.width - 1, box.x + box.width + 2);
  const bottom = Math.min(image.bitmap.height - 1, box.y + box.height + 2);
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      const inside = x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height;
      if (inside) continue;
      if (samples.length > 2000 && (x + y) % 5 !== 0) continue;
      const rgba = Jimp.intToRGBA(image.getPixelColor(x, y));
      samples.push({ r: rgba.r, g: rgba.g, b: rgba.b });
    }
  }
  if (samples.length === 0) return parseHexColor(DEFAULT_COLOR);
  samples.sort((a, b) => a.r + a.g + a.b - (b.r + b.g + b.b));
  return samples[Math.floor(samples.length / 2)];
}

function fillRegion(image: JimpImageLike, box: PixelRegion): void {
  const fillMode: WatermarkCoverFillMode = box.region.fillMode === "auto" ? "auto" : "solid";
  const color = fillMode === "auto" ? sampleSurroundingColor(image, box) : parseHexColor(box.region.color || DEFAULT_COLOR);
  const alpha = normalizeOpacity(box.region.opacity) / 100;
  image.scan(box.x, box.y, box.width, box.height, (_x: number, _y: number, idx: number) => {
    const data = image.bitmap.data;
    data[idx] = Math.round(data[idx] * (1 - alpha) + color.r * alpha);
    data[idx + 1] = Math.round(data[idx + 1] * (1 - alpha) + color.g * alpha);
    data[idx + 2] = Math.round(data[idx + 2] * (1 - alpha) + color.b * alpha);
  });
}

export function hasWatermarkCoverRegions(config?: WatermarkCoverConfig): boolean {
  return Boolean(config?.enabled && Array.isArray(config.regions) && config.regions.length > 0);
}

export function resolveWatermarkCoverConfig(
  globalConfig?: WatermarkCoverConfig,
  ruleConfig?: WatermarkCoverConfig,
): WatermarkCoverConfig | undefined {
  if (ruleConfig?.enabled === false) return undefined;

  const hasRuleConfig = Boolean(ruleConfig && typeof ruleConfig === "object");
  const merged: WatermarkCoverConfig = {
    ...(globalConfig && typeof globalConfig === "object" ? globalConfig : {}),
    ...(hasRuleConfig ? ruleConfig : {}),
  };

  if (hasRuleConfig && ruleConfig?.regions === undefined && Array.isArray(globalConfig?.regions)) {
    merged.regions = globalConfig.regions;
  }
  if (hasRuleConfig && ruleConfig?.applyToImages === undefined && globalConfig?.applyToImages !== undefined) {
    merged.applyToImages = globalConfig.applyToImages;
  }
  if (hasRuleConfig && ruleConfig?.applyToVideos === undefined && globalConfig?.applyToVideos !== undefined) {
    merged.applyToVideos = globalConfig.applyToVideos;
  }

  const enabled = hasRuleConfig ? merged.enabled !== false : merged.enabled === true;
  const regions = Array.isArray(merged.regions) ? merged.regions : [];
  if (!enabled || regions.length === 0) return undefined;

  return {
    enabled: true,
    applyToImages: merged.applyToImages !== false,
    applyToVideos: merged.applyToVideos === true,
    regions,
  };
}

export async function applyWatermarkCoverToImageBuffer(
  buffer: Buffer,
  config?: WatermarkCoverConfig,
): Promise<Buffer> {
  if (!hasWatermarkCoverRegions(config) || config?.applyToImages === false) return buffer;
  const image = await Jimp.read(buffer);
  const boxes = resolvePixelRegions(config, image.bitmap.width, image.bitmap.height);
  if (boxes.length === 0) return buffer;
  for (const box of boxes) {
    fillRegion(image, box);
  }
  return await image.getBufferAsync(image.getMIME() || Jimp.MIME_PNG);
}

function ffmpegColor(region: WatermarkCoverRegion): string {
  const { r, g, b } = parseHexColor(region.color || DEFAULT_COLOR);
  const opacity = normalizeOpacity(region.opacity) / 100;
  return `0x${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b
    .toString(16)
    .padStart(2, "0")}@${opacity.toFixed(2)}`;
}

export function buildWatermarkCoverDrawboxFilter(config?: WatermarkCoverConfig): string | undefined {
  if (!hasWatermarkCoverRegions(config) || config?.applyToVideos === false) return undefined;
  const filters = (config?.regions || [])
    .filter((region) => region && (region.aspect || "all") === "all")
    .map((region) => {
      const x = clamp01(Number(region.x));
      const y = clamp01(Number(region.y));
      const w = Math.max(0, Math.min(1 - x, Number(region.width)));
      const h = Math.max(0, Math.min(1 - y, Number(region.height)));
      if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return "";
      return `drawbox=x=iw*${x.toFixed(6)}:y=ih*${y.toFixed(6)}:w=iw*${w.toFixed(6)}:h=ih*${h.toFixed(
        6,
      )}:color=${ffmpegColor(region)}:t=fill`;
    })
    .filter(Boolean);
  return filters.length > 0 ? filters.join(",") : undefined;
}

function runFfmpeg(inputPath: string, outputPath: string, filter: string): Promise<void> {
  const ffmpeg = process.env.FFMPEG_BIN || "ffmpeg";
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, [
      "-y",
      "-i",
      inputPath,
      "-vf",
      filter,
      "-c:a",
      "copy",
      "-movflags",
      "+faststart",
      outputPath,
    ]);
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with ${code}: ${stderr.slice(-1000)}`));
    });
  });
}

export async function applyWatermarkCoverToVideoBuffer(
  buffer: Buffer,
  filename: string,
  config?: WatermarkCoverConfig,
): Promise<Buffer> {
  const filter = buildWatermarkCoverDrawboxFilter(config);
  if (!filter) return buffer;
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "watermark-cover-"));
  const ext = path.extname(String(filename || "")) || ".mp4";
  const inputPath = path.join(workDir, `input${ext}`);
  const outputPath = path.join(workDir, `output${ext}`);
  try {
    await fs.writeFile(inputPath, buffer);
    await runFfmpeg(inputPath, outputPath, filter);
    return await fs.readFile(outputPath);
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

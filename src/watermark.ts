import { promises as fs } from "node:fs";
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import Jimp from "jimp";

import type { WatermarkConfig, WatermarkPosition } from "./config";

const DEFAULT_MARGIN = 8;
const DEFAULT_TEXT_OPACITY = 60;
const DEFAULT_IMAGE_OPACITY = 60;
const DEFAULT_IMAGE_SCALE = 20;
const DEFAULT_TEXT_SIZE = 16;

function clampPercent(value: number, fallback: number) {
  if (!Number.isFinite(value)) return fallback;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return Math.round(value);
}

function resolvePosition(
  position: WatermarkPosition | undefined,
  baseWidth: number,
  baseHeight: number,
  markWidth: number,
  markHeight: number,
  margin: number,
) {
  const pos = position || "bottom-right";
  let x = margin;
  let y = margin;
  switch (pos) {
    case "top-left":
      x = margin;
      y = margin;
      break;
    case "top-right":
      x = baseWidth - markWidth - margin;
      y = margin;
      break;
    case "bottom-left":
      x = margin;
      y = baseHeight - markHeight - margin;
      break;
    case "center":
      x = Math.round((baseWidth - markWidth) / 2);
      y = Math.round((baseHeight - markHeight) / 2);
      break;
    case "bottom-right":
    default:
      x = baseWidth - markWidth - margin;
      y = baseHeight - markHeight - margin;
      break;
  }
  return { x: Math.max(0, x), y: Math.max(0, y) };
}

function pickFontSize(size?: number): number {
  const value = typeof size === "number" ? size : DEFAULT_TEXT_SIZE;
  const candidates = [8, 16, 32, 64, 128];
  let best = candidates[0];
  let bestDiff = Math.abs(value - best);
  for (const candidate of candidates) {
    const diff = Math.abs(value - candidate);
    if (diff < bestDiff) {
      best = candidate;
      bestDiff = diff;
    }
  }
  return best;
}

function isDarkColor(value?: string): boolean {
  if (!value) return false;
  const hex = value.trim().replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return false;
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const brightness = (r * 299 + g * 587 + b * 114) / 1000;
  return brightness < 128;
}

async function downloadBuffer(url: string): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    const req = client.get(new URL(url), (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`Download failed: ${res.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("error", reject);
    req.setTimeout(30000, () => {
      req.destroy(new Error("Download timeout"));
    });
  });
}

async function loadWatermarkImage(source: string): Promise<Jimp | null> {
  try {
    if (/^https?:\/\//i.test(source)) {
      const buf = await downloadBuffer(source);
      return await Jimp.read(buf);
    }
    const file = await fs.readFile(source);
    return await Jimp.read(file);
  } catch (err) {
    console.error(`[Watermark] 加载水印图片失败: ${String((err as Error)?.message || err)}`);
    return null;
  }
}

export function resolveWatermarkConfig(
  globalConfig?: WatermarkConfig,
  ruleConfig?: WatermarkConfig,
): WatermarkConfig | undefined {
  if (ruleConfig && ruleConfig.enabled === false) {
    return undefined;
  }
  const merged = {
    ...(globalConfig || {}),
    ...(ruleConfig || {}),
  } as WatermarkConfig;
  const enabled =
    merged.enabled === true ||
    (ruleConfig && ruleConfig.enabled === true) ||
    (globalConfig && globalConfig.enabled === true);
  if (!enabled) return undefined;
  if (!merged.text && !merged.imageUrl) return undefined;
  return { ...merged, enabled: true };
}

export async function applyWatermarkToBuffer(buffer: Buffer, config?: WatermarkConfig): Promise<Buffer> {
  const effective = config;
  if (!effective || effective.enabled !== true) return buffer;

  try {
    const image = await Jimp.read(buffer);
    const margin = Number.isFinite(effective.margin)
      ? Math.max(0, Math.round(effective.margin as number))
      : DEFAULT_MARGIN;

    if (effective.imageUrl) {
      const watermarkImage = await loadWatermarkImage(effective.imageUrl);
      if (watermarkImage) {
        const scale = clampPercent(
          typeof effective.imageScale === "number" ? effective.imageScale : DEFAULT_IMAGE_SCALE,
          DEFAULT_IMAGE_SCALE,
        );
        const targetWidth = Math.max(1, Math.round(image.bitmap.width * (scale / 100)));
        watermarkImage.resize(targetWidth, Jimp.AUTO);
        const opacity = clampPercent(
          typeof effective.imageOpacity === "number" ? effective.imageOpacity : DEFAULT_IMAGE_OPACITY,
          DEFAULT_IMAGE_OPACITY,
        );
        watermarkImage.opacity(opacity / 100);
        const position = resolvePosition(
          effective.position,
          image.bitmap.width,
          image.bitmap.height,
          watermarkImage.bitmap.width,
          watermarkImage.bitmap.height,
          margin,
        );
        image.composite(watermarkImage, position.x, position.y);
      }
    }

    if (effective.text) {
      const fontSize = pickFontSize(effective.textSize);
      const fontColor = isDarkColor(effective.textColor) ? "BLACK" : "WHITE";
      const font = await Jimp.loadFont((Jimp as any)[`FONT_SANS_${fontSize}_${fontColor}`]);
      const textWidth = Jimp.measureText(font, effective.text);
      const textHeight = Jimp.measureTextHeight(font, effective.text, image.bitmap.width);
      const textImage = await new Jimp(textWidth || 1, textHeight || fontSize, 0x00000000);
      textImage.print(font, 0, 0, effective.text);
      const opacity = clampPercent(
        typeof effective.textOpacity === "number" ? effective.textOpacity : DEFAULT_TEXT_OPACITY,
        DEFAULT_TEXT_OPACITY,
      );
      textImage.opacity(opacity / 100);
      const position = resolvePosition(
        effective.position,
        image.bitmap.width,
        image.bitmap.height,
        textImage.bitmap.width,
        textImage.bitmap.height,
        margin,
      );
      image.composite(textImage, position.x, position.y);
    }

    const mime = image.getMIME();
    return await image.getBufferAsync(mime);
  } catch (err) {
    console.error(`[Watermark] 处理失败: ${String((err as Error)?.message || err)}`);
    return buffer;
  }
}

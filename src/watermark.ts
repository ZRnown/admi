import { promises as fs } from "node:fs";
import http from "node:http";
import https from "node:https";
import { URL, fileURLToPath } from "node:url";
import Jimp from "jimp";

import type { WatermarkConfig, WatermarkPosition } from "./config";

const DEFAULT_MARGIN = 8;
const DEFAULT_TEXT_OPACITY = 60;
const DEFAULT_IMAGE_OPACITY = 60;
const DEFAULT_IMAGE_SCALE = 20;
const DEFAULT_TEXT_SIZE = 16;
const DEFAULT_TILE_GAP = 40;

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
      console.log(`[Watermark] 下载图片水印: ${source}`);
      const buf = await downloadBuffer(source);
      return await Jimp.read(buf);
    }
    if (/^file:\/\//i.test(source)) {
      const filePath = fileURLToPath(source);
      console.log(`[Watermark] 读取图片水印: ${filePath}`);
      const file = await fs.readFile(filePath);
      return await Jimp.read(file);
    }
    console.log(`[Watermark] 读取图片水印: ${source}`);
    const file = await fs.readFile(source);
    return await Jimp.read(file);
  } catch (err) {
    console.error(`[Watermark] 加载水印图片失败 (${source}): ${String((err as Error)?.message || err)}`);
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
  const mode = merged.mode;
  const allowText = mode !== "image";
  const allowImage = mode !== "text";
  const hasText = Boolean(merged.text);
  const hasImage = Boolean(merged.imageUrl);
  if ((!allowText || !hasText) && (!allowImage || !hasImage)) return undefined;
  return { ...merged, enabled: true };
}

export async function applyWatermarkToBuffer(buffer: Buffer, config?: WatermarkConfig): Promise<Buffer> {
  const effective = config;
  if (!effective || effective.enabled !== true) return buffer;

  try {
    const image = await Jimp.read(buffer);
    console.log(
      `[Watermark] 开始处理图片 (${image.bitmap.width}x${image.bitmap.height}) mode=${effective.mode || "auto"}`,
    );
    const margin = Number.isFinite(effective.margin)
      ? Math.max(0, Math.round(effective.margin as number))
      : DEFAULT_MARGIN;
    const mode = effective.mode;
    const allowText = mode !== "image";
    const allowImage = mode !== "text";
    const pattern = effective.pattern === "tile" ? "tile" : "single";
    const gap = Number.isFinite(effective.tileGap)
      ? Math.max(0, Math.round(effective.tileGap as number))
      : DEFAULT_TILE_GAP;

    let applied = false;

    if (effective.imageUrl && allowImage) {
      console.log(`[Watermark] 尝试应用图片水印: ${effective.imageUrl}`);
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
        console.log(
          `[Watermark] 图片水印尺寸=${watermarkImage.bitmap.width}x${watermarkImage.bitmap.height} scale=${scale}% opacity=${opacity}% pattern=${pattern}`,
        );
        if (pattern === "tile") {
          const stepX = Math.max(1, watermarkImage.bitmap.width + gap);
          const stepY = Math.max(1, watermarkImage.bitmap.height + gap);
          for (let y = 0; y < image.bitmap.height; y += stepY) {
            for (let x = 0; x < image.bitmap.width; x += stepX) {
              image.composite(watermarkImage, x, y);
            }
          }
          console.log(`[Watermark] 图片水印平铺完成 stepX=${stepX} stepY=${stepY}`);
        } else {
          const position = resolvePosition(
            effective.position,
            image.bitmap.width,
            image.bitmap.height,
            watermarkImage.bitmap.width,
            watermarkImage.bitmap.height,
            margin,
          );
          image.composite(watermarkImage, position.x, position.y);
          console.log(`[Watermark] 图片水印位置 x=${position.x} y=${position.y}`);
        }
        applied = true;
        console.log(`[Watermark] 图片水印应用完成`);
      } else {
        console.warn(`[Watermark] 图片水印加载失败，跳过: ${effective.imageUrl}`);
      }
    }

    if (effective.text && allowText) {
      const fontSize = pickFontSize(effective.textSize);
      const fontColor = isDarkColor(effective.textColor) ? "BLACK" : "WHITE";
      const fontName = `FONT_SANS_${fontSize}_${fontColor}`;
      const fontPath = (Jimp as any)[fontName];
      if (!fontPath) {
        console.warn(`[Watermark] 字体未找到: ${fontName}，使用默认字体`);
      }
      const font = await Jimp.loadFont(fontPath || Jimp.FONT_SANS_16_WHITE);
      const textWidth = Jimp.measureText(font, effective.text);
      const textHeight = Jimp.measureTextHeight(font, effective.text, image.bitmap.width);
      const safeWidth = Math.max(1, textWidth + 10);
      const safeHeight = Math.max(1, textHeight + 10);
      const textImage = await new Jimp(safeWidth, safeHeight, 0x00000000);
      textImage.print(font, 0, 0, effective.text);
      console.log(
        `[Watermark] 文字水印 size=${fontSize} color=${effective.textColor || "auto"} pattern=${pattern}`,
      );
      if (effective.textColor) {
        try {
          (textImage as any).color([{ apply: "mix", params: [effective.textColor, 100] }]);
        } catch {}
      }
      const opacity = clampPercent(
        typeof effective.textOpacity === "number" ? effective.textOpacity : DEFAULT_TEXT_OPACITY,
        DEFAULT_TEXT_OPACITY,
      );
      textImage.opacity(opacity / 100);
      if (pattern === "tile") {
        const stepX = Math.max(1, textImage.bitmap.width + gap);
        const stepY = Math.max(1, textImage.bitmap.height + gap);
        for (let y = 0; y < image.bitmap.height; y += stepY) {
          for (let x = 0; x < image.bitmap.width; x += stepX) {
            image.composite(textImage, x, y);
          }
        }
        console.log(`[Watermark] 文字水印平铺完成 stepX=${stepX} stepY=${stepY}`);
      } else {
        const position = resolvePosition(
          effective.position,
          image.bitmap.width,
          image.bitmap.height,
          textImage.bitmap.width,
          textImage.bitmap.height,
          margin,
        );
        image.composite(textImage, position.x, position.y);
        console.log(`[Watermark] 文字水印位置 x=${position.x} y=${position.y}`);
      }
      applied = true;
      console.log(`[Watermark] 文字水印应用完成`);
    }

    if (!applied) {
      console.log("[Watermark] 未应用任何水印（配置为空或资源加载失败）");
      return buffer;
    }

    const mime = image.getMIME();
    const result = await image.getBufferAsync(mime);
    console.log(`[Watermark] 处理完成 size=${result.length} mime=${mime}`);
    return result;
  } catch (err) {
    console.error(`[Watermark] 处理失败: ${String((err as Error)?.message || err)}`);
    return buffer;
  }
}

import { promises as fs } from "node:fs";
import http from "node:http";
import https from "node:https";
import { createHash } from "node:crypto";
import path from "node:path";
import { URL, fileURLToPath } from "node:url";
import Jimp from "jimp";

import type { WatermarkConfig, WatermarkPosition } from "./config";

const DEFAULT_MARGIN = 8;
const DEFAULT_TEXT_OPACITY = 60;
const DEFAULT_IMAGE_OPACITY = 60;
const DEFAULT_IMAGE_SCALE = 20;
const DEFAULT_TEXT_SIZE = 16;
const DEFAULT_TILE_GAP = 40;
const AUTO_FONT_DOWNLOAD = process.env.WATERMARK_AUTO_FONT_DOWNLOAD !== "0";
const DEFAULT_CJK_FONT_URLS = (() => {
  const env = process.env.WATERMARK_CJK_FONT_URL;
  if (env && env.trim()) {
    return env
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [
    "https://raw.githubusercontent.com/chengda/popular-fonts/master/%E5%BE%AE%E8%BD%AF%E9%9B%85%E9%BB%91.ttf",
    "https://raw.githubusercontent.com/chengda/popular-fonts/master/%E5%BE%AE%E8%BD%AF%E9%9B%85%E9%BB%91%E7%B2%97%E4%BD%93.ttf",
    "https://raw.githubusercontent.com/chengda/popular-fonts/master/%E5%8D%8E%E6%96%87%E7%BB%86%E9%BB%91.ttf",
    "https://raw.githubusercontent.com/chengda/popular-fonts/master/%E5%8D%8E%E6%96%87%E4%B8%AD%E5%AE%8B.ttf",
    "https://raw.githubusercontent.com/chengda/popular-fonts/master/%E5%8D%8E%E6%96%87%E6%A5%B7%E4%BD%93.ttf",
  ];
})();
const FONT_CACHE_DIR = path.join(process.cwd(), ".data", "watermark_fonts");
const fontDownloadCache = new Map<string, string | null>();

export async function preloadWatermarkFonts(): Promise<void> {
  if (!AUTO_FONT_DOWNLOAD) return;
  try {
    const fontPath = await resolveDefaultFontPath(true);
    if (fontPath) {
      console.log(`[Watermark] 启动预热字体完成: ${fontPath}`);
    }
  } catch (err) {
    console.warn(`[Watermark] 启动预热字体失败: ${String(err)}`);
  }
}

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
    case "top":
      x = Math.round((baseWidth - markWidth) / 2);
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
    case "bottom":
      x = Math.round((baseWidth - markWidth) / 2);
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

function hasNonAsciiText(text: string): boolean {
  return /[^\u0000-\u007f]/.test(text);
}

const canvasModuleLoader = (() => {
  let cached: Promise<any | null> | null = null;
  return async () => {
    if (cached) return cached;
    cached = (async () => {
      try {
        const loader = new Function("moduleName", "return import(moduleName)");
        return await loader("@napi-rs/canvas");
      } catch (err) {
        console.warn(
          `[Watermark] Canvas 依赖不可用，中文可能显示为方块（可安装 @napi-rs/canvas）: ${String(err)}`,
        );
        return null;
      }
    })();
    return cached;
  };
})();

async function resolveDefaultFontPath(preferCjk: boolean): Promise<string | undefined> {
  const cjkCandidates = [
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.otf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.otf",
    "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
  ];
  const latinCandidates = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
  ];
  const candidates = preferCjk ? cjkCandidates : [...cjkCandidates, ...latinCandidates];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {}
  }
  if (preferCjk && AUTO_FONT_DOWNLOAD) {
    for (const url of DEFAULT_CJK_FONT_URLS) {
      const downloaded = await resolveRemoteFontPath(url);
      if (downloaded) {
        return downloaded;
      }
    }
  }
  if (preferCjk) {
    console.warn("[Watermark] 未检测到系统中文字体，可在水印设置中填写字体路径");
  }
  return undefined;
}

async function resolveRemoteFontPath(url: string): Promise<string | undefined> {
  if (!AUTO_FONT_DOWNLOAD || !url) return undefined;
  const cached = fontDownloadCache.get(url);
  if (cached !== undefined) return cached || undefined;
  try {
    await fs.mkdir(FONT_CACHE_DIR, { recursive: true });
    const urlInfo = new URL(url);
    const ext = path.extname(urlInfo.pathname) || ".otf";
    const hash = createHash("sha1").update(url).digest("hex").slice(0, 16);
    const filename = `${hash}${ext}`;
    const target = path.join(FONT_CACHE_DIR, filename);
    try {
      await fs.access(target);
      fontDownloadCache.set(url, target);
      return target;
    } catch {}
    const buffer = await downloadBuffer(url);
    if (!isFontBuffer(buffer)) {
      console.warn(`[Watermark] 下载的字体无效，跳过: ${url}`);
      fontDownloadCache.set(url, null);
      return undefined;
    }
    await fs.writeFile(target, buffer);
    fontDownloadCache.set(url, target);
    console.log(`[Watermark] 已下载字体: ${url} -> ${target}`);
    return target;
  } catch (err) {
    console.warn(`[Watermark] 下载字体失败: ${url} err=${String(err)}`);
    fontDownloadCache.set(url, null);
    return undefined;
  }
}

function isFontBuffer(buffer: Buffer): boolean {
  if (!buffer || buffer.length < 1024) return false;
  const magic = buffer.subarray(0, 4).toString("latin1");
  if (magic === "OTTO" || magic === "ttcf" || magic === "true" || magic === "typ1") return true;
  // TrueType sfnt version 0x00010000
  if (buffer[0] === 0x00 && buffer[1] === 0x01 && buffer[2] === 0x00 && buffer[3] === 0x00) {
    return true;
  }
  // HTML or text response
  const head = buffer.subarray(0, 32).toString("utf8").toLowerCase();
  if (head.includes("<html") || head.includes("<!doctype")) {
    return false;
  }
  return false;
}

async function renderTextWatermarkImage(
  text: string,
  options: {
    fontSize: number;
    color: string;
    opacity: number;
    fontFamily?: string;
    fontPath?: string;
  },
): Promise<any | null> {
  try {
    const canvasModule = await canvasModuleLoader();
    if (!canvasModule?.createCanvas) {
      return null;
    }
    const { createCanvas, registerFont, GlobalFonts } = canvasModule;
    let fontFamily = options.fontFamily || "Noto Sans CJK SC, Noto Sans, Microsoft YaHei, PingFang SC, sans-serif";
    let fontPath = options.fontPath;
    if (fontPath && /^https?:\/\//i.test(fontPath)) {
      fontPath = await resolveRemoteFontPath(fontPath);
    } else if (fontPath && /^file:\/\//i.test(fontPath)) {
      fontPath = fileURLToPath(fontPath);
    }
    if (!fontPath && !options.fontFamily) {
      fontPath = await resolveDefaultFontPath(hasNonAsciiText(text));
      if (fontPath) {
        console.log(`[Watermark] 使用默认字体文件: ${fontPath}`);
      }
    }
    if (fontPath) {
      const familyName = options.fontFamily || "WatermarkFont";
      try {
        if (GlobalFonts && typeof GlobalFonts.registerFromPath === "function") {
          GlobalFonts.registerFromPath(fontPath, familyName);
          fontFamily = familyName;
          console.log(`[Watermark] 字体注册成功(GlobalFonts): ${fontFamily}`);
        } else if (typeof registerFont === "function") {
          registerFont(fontPath, { family: familyName });
          fontFamily = familyName;
          console.log(`[Watermark] 字体注册成功(registerFont): ${fontFamily}`);
        }
      } catch (err) {
        console.warn(`[Watermark] 注册字体失败: ${fontPath} err=${String(err)}`);
      }
    }

    const padding = 10;
    const probeCanvas = createCanvas(1, 1);
    const probeCtx = probeCanvas.getContext("2d");
    probeCtx.font = `${options.fontSize}px "${fontFamily}"`;
    const metrics = probeCtx.measureText(text);
    const width = Math.max(1, Math.ceil(metrics.width));
    const height = Math.max(
      options.fontSize,
      Math.ceil((metrics.actualBoundingBoxAscent || options.fontSize) + (metrics.actualBoundingBoxDescent || 0)),
    );

    const canvas = createCanvas(width + padding, height + padding);
    const ctx = canvas.getContext("2d");
    ctx.font = `${options.fontSize}px "${fontFamily}"`;
    ctx.textBaseline = "top";
    ctx.fillStyle = options.color;
    ctx.globalAlpha = Math.max(0, Math.min(1, options.opacity / 100));
    ctx.fillText(text, 0, 0);

    const buffer = canvas.toBuffer("image/png");
    return await Jimp.read(buffer);
  } catch (err) {
    console.warn(`[Watermark] Canvas 渲染失败: ${String(err)}`);
    return null;
  }
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

async function loadWatermarkImage(source: string): Promise<any | null> {
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
  const hasText = Boolean(merged.text);
  const hasImage = Boolean(merged.imageUrl);
  const enabled =
    merged.enabled === true
      ? true
      : merged.enabled === false
        ? false
        : hasText || hasImage;
  if (!enabled) return undefined;
  const mode = merged.mode === "image" || merged.mode === "text" ? merged.mode : merged.imageUrl ? "image" : "text";
  const allowText = mode === "text";
  const allowImage = mode === "image";
  if ((allowText && !hasText) || (allowImage && !hasImage)) return undefined;
  return { ...merged, enabled: true, mode };
}

export function resolveWatermarkConfigs(
  globalPrimary?: WatermarkConfig,
  rulePrimary?: WatermarkConfig,
  globalSecondary?: WatermarkConfig,
  ruleSecondary?: WatermarkConfig,
): WatermarkConfig[] {
  const primary = resolveWatermarkConfig(globalPrimary, rulePrimary);
  const secondary = resolveWatermarkConfig(globalSecondary, ruleSecondary);
  const mode = primary?.mode || secondary?.mode;
  const resolved: WatermarkConfig[] = [];
  if (primary && (!mode || primary.mode === mode)) {
    resolved.push(primary);
  }
  if (secondary && (!mode || secondary.mode === mode)) {
    resolved.push(secondary);
  }
  return resolved;
}

export function resolveWatermarkList(
  globalList?: WatermarkConfig[],
  ruleList?: WatermarkConfig[],
  globalPrimary?: WatermarkConfig,
  rulePrimary?: WatermarkConfig,
  globalSecondary?: WatermarkConfig,
  ruleSecondary?: WatermarkConfig,
): WatermarkConfig[] {
  const list = ruleList !== undefined ? ruleList : globalList;
  if (list !== undefined) {
    return list
      .map((item) => resolveWatermarkConfig(item))
      .filter((item): item is WatermarkConfig => !!item);
  }
  return resolveWatermarkConfigs(globalPrimary, rulePrimary, globalSecondary, ruleSecondary);
}

export async function applyWatermarksToBuffer(
  buffer: Buffer,
  configs?: WatermarkConfig[],
): Promise<Buffer> {
  if (!configs || configs.length === 0) return buffer;
  let result = buffer;
  for (const config of configs) {
    result = await applyWatermarkToBuffer(result, config);
  }
  return result;
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
    const mode = effective.mode === "image" || effective.mode === "text" ? effective.mode : effective.imageUrl ? "image" : "text";
    const allowText = mode === "text";
    const allowImage = mode === "image";
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
      const opacity = clampPercent(
        typeof effective.textOpacity === "number" ? effective.textOpacity : DEFAULT_TEXT_OPACITY,
        DEFAULT_TEXT_OPACITY,
      );
      const textAngle = Number.isFinite(effective.textAngle) ? (effective.textAngle as number) : 0;
      const color = effective.textColor || (isDarkColor(effective.textColor) ? "#000000" : "#ffffff");
      let textImage: any | null = null;
      const useCanvas = hasNonAsciiText(effective.text) || Boolean(effective.fontPath || effective.fontFamily);
      if (useCanvas) {
        console.log(`[Watermark] 使用 Canvas 渲染文字水印`);
        textImage = await renderTextWatermarkImage(effective.text, {
          fontSize,
          color,
          opacity,
          fontFamily: effective.fontFamily,
          fontPath: effective.fontPath,
        });
      }
      if (!textImage) {
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
        textImage = await new Jimp(safeWidth, safeHeight, 0x00000000);
        textImage.print(font, 0, 0, effective.text);
        if (effective.textColor) {
          try {
            (textImage as any).color([{ apply: "mix", params: [effective.textColor, 100] }]);
          } catch {}
        }
        textImage.opacity(opacity / 100);
      }
      if (textImage && textAngle) {
        try {
          textImage.rotate(textAngle, true);
          console.log(`[Watermark] 文字水印旋转角度: ${textAngle}°`);
        } catch {}
      }
      if (!textImage) {
        console.warn("[Watermark] 文字水印渲染失败，跳过文字水印");
      } else {
        console.log(
          `[Watermark] 文字水印 size=${fontSize} color=${effective.textColor || "auto"} pattern=${pattern}`,
        );
      }
      if (pattern === "tile") {
        if (textImage) {
          const stepX = Math.max(1, textImage.bitmap.width + gap);
          const stepY = Math.max(1, textImage.bitmap.height + gap);
          for (let y = 0; y < image.bitmap.height; y += stepY) {
            for (let x = 0; x < image.bitmap.width; x += stepX) {
              image.composite(textImage, x, y);
            }
          }
          console.log(`[Watermark] 文字水印平铺完成 stepX=${stepX} stepY=${stepY}`);
        }
      } else {
        if (textImage) {
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
      }
      if (textImage) {
        applied = true;
        console.log(`[Watermark] 文字水印应用完成`);
      }
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

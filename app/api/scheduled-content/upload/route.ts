import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { getMultiConfig, saveMultiConfig } from "@/src/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function inferMediaType(mime: string, filename: string): "video" | "image" {
  if (mime && mime.startsWith("video/")) return "video";
  const ext = path.extname(filename).toLowerCase();
  if ([".mp4", ".mov", ".webm", ".mkv", ".avi"].includes(ext)) return "video";
  return "image";
}

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const accountId = form.get("accountId");
    const contentId = form.get("contentId");
    const file = form.get("file");

    if (!accountId || typeof accountId !== "string") {
      return NextResponse.json({ error: "缺少 accountId" }, { status: 400 });
    }
    if (!contentId || typeof contentId !== "string") {
      return NextResponse.json({ error: "缺少 contentId" }, { status: 400 });
    }
    if (!file || typeof file === "string") {
      return NextResponse.json({ error: "缺少内容文件" }, { status: 400 });
    }

    const multi = await getMultiConfig();
    const account = multi.accounts.find((a) => a.id === accountId);
    if (!account) {
      return NextResponse.json({ error: "账号不存在" }, { status: 404 });
    }

    const buffer = Buffer.from(await (file as File).arrayBuffer());
    if (buffer.length === 0) {
      return NextResponse.json({ error: "内容文件为空" }, { status: 400 });
    }

    const dir = path.join(process.cwd(), ".data", "scheduled_contents");
    await fs.mkdir(dir, { recursive: true });
    const rawName = typeof (file as File).name === "string" ? (file as File).name : "content.bin";
    const ext = path.extname(rawName) || ".bin";
    const safeExt = ext.length > 10 ? ".bin" : ext;
    const filename = `${accountId}_${contentId}_${Date.now()}_${randomUUID().slice(0, 8)}${safeExt}`;
    const filePath = path.join(dir, filename);
    await fs.writeFile(filePath, buffer);

    if (!Array.isArray(account.scheduledContents)) {
      account.scheduledContents = [];
    }
    let item = account.scheduledContents.find((entry) => entry && entry.id === contentId);
    if (!item) {
      item = { id: contentId };
      account.scheduledContents.push(item as any);
    }

    const mediaType = inferMediaType((file as File).type || "", rawName);
    item.mediaType = mediaType;
    item.mediaSource = "local";
    item.mediaValue = filePath;
    item.enabled = true;
    if (!item.name) {
      item.name = rawName || item.name;
    }

    await saveMultiConfig(multi);

    return NextResponse.json({ success: true, path: filePath, mediaType });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}

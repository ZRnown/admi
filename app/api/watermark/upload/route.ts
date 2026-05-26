import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { getMultiConfig, saveMultiConfig } from "@/src/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const accountId = form.get("accountId");
    const file = form.get("file");
    const watermarkIndexRaw = form.get("watermarkIndex");
    const skipAssign = form.get("skipAssign") === "1";

    if (!accountId || typeof accountId !== "string") {
      return NextResponse.json({ error: "缺少 accountId" }, { status: 400 });
    }
    if (!file || typeof file === "string") {
      return NextResponse.json({ error: "缺少水印图片" }, { status: 400 });
    }

    const multi = await getMultiConfig();
    const account = multi.accounts.find((a) => a.id === accountId);
    if (!account) {
      return NextResponse.json({ error: "账号不存在" }, { status: 404 });
    }

    const buffer = Buffer.from(await (file as File).arrayBuffer());
    if (buffer.length === 0) {
      return NextResponse.json({ error: "水印图片为空" }, { status: 400 });
    }

    const dir = path.join(process.cwd(), ".data", "watermarks");
    await fs.mkdir(dir, { recursive: true });
    const rawName = typeof (file as File).name === "string" ? (file as File).name : "watermark.png";
    const ext = path.extname(rawName) || ".png";
    const safeExt = ext.length > 10 ? ".png" : ext;
    const filename = `${accountId}_${Date.now()}_${randomUUID().slice(0, 8)}${safeExt}`;
    const filePath = path.join(dir, filename);
    await fs.writeFile(filePath, buffer);

    const parsedIndex =
      typeof watermarkIndexRaw === "string" && watermarkIndexRaw.trim() && !isNaN(Number(watermarkIndexRaw))
        ? Math.max(0, Math.floor(Number(watermarkIndexRaw)))
        : 0;

    if (!skipAssign) {
      if (!Array.isArray(account.watermarks)) {
        account.watermarks = [];
      }
      while (account.watermarks.length <= parsedIndex) {
        account.watermarks.push({});
      }
      const target = account.watermarks[parsedIndex] || {};
      target.imageUrl = filePath;
      target.enabled = true;
      target.mode = "image";
      account.watermarks[parsedIndex] = target;
    }
    await saveMultiConfig(multi);

    return NextResponse.json({ success: true, imageUrl: filePath });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { getMultiConfig } from "@/src/config";
import { buildWebhookAssetUrl } from "@/src/webhookIdentity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const accountId = form.get("accountId");
    const file = form.get("file");

    if (!accountId || typeof accountId !== "string") {
      return NextResponse.json({ error: "缺少 accountId" }, { status: 400 });
    }
    if (!file || typeof file === "string") {
      return NextResponse.json({ error: "缺少头像文件" }, { status: 400 });
    }

    const buffer = Buffer.from(await (file as File).arrayBuffer());
    if (buffer.length === 0) {
      return NextResponse.json({ error: "头像文件为空" }, { status: 400 });
    }

    const dir = path.join(process.cwd(), ".data", "webhook_avatars");
    await fs.mkdir(dir, { recursive: true });
    const rawName = typeof (file as File).name === "string" ? (file as File).name : "avatar.png";
    const ext = path.extname(rawName) || ".png";
    const safeExt = ext.length > 10 ? ".png" : ext;
    const filename = `${accountId}_${Date.now()}_${randomUUID().slice(0, 8)}${safeExt}`;
    const filePath = path.join(dir, filename);
    await fs.writeFile(filePath, buffer);

    const multi = await getMultiConfig();
    const account = multi.accounts.find((a) => a.id === accountId);
    const publicBaseUrl = account?.publicBaseUrl;
    const avatarUrl = buildWebhookAssetUrl(publicBaseUrl, req.url, filename);

    return NextResponse.json({ success: true, avatarUrl, filename });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}

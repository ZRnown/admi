import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { promises as fs } from "fs";
import { getMultiConfig, saveMultiConfig } from "@/src/config";

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
      return NextResponse.json({ error: "缺少 session 文件" }, { status: 400 });
    }

    const multi = await getMultiConfig();
    const account = multi.accounts.find((a) => a.id === accountId);
    if (!account) {
      return NextResponse.json({ error: "账号不存在" }, { status: 404 });
    }

    const buffer = Buffer.from(await (file as File).arrayBuffer());
    if (buffer.length === 0) {
      return NextResponse.json({ error: "Session 文件为空" }, { status: 400 });
    }

    const sessionDir = path.join(process.cwd(), ".data", "telegram_sessions");
    await fs.mkdir(sessionDir, { recursive: true });
    const sessionPath = path.join(sessionDir, `${accountId}.session`);
    await fs.writeFile(sessionPath, buffer);

    account.telegramSessionPath = sessionPath;
    account.telegramSessionString = undefined;
    (account as any).sessionType = "file";
    await saveMultiConfig(multi);

    return NextResponse.json({ success: true, sessionPath });
  } catch (e: any) {
    return NextResponse.json(
      { error: String(e?.message || e) },
      { status: 500 },
    );
  }
}

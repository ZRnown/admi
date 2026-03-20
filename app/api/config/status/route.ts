import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { getMultiConfig } from "@/src/config";
import { buildConfigStatusPayload } from "@/src/configStatusPayload";
import { readDiscordLibraryStatus, readStatus } from "@/app/api/_lib/common";
import { requireAuth } from "@/app/api/_lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const telegramStatusFile = path.resolve(process.cwd(), ".data", "telegram_status.json");
const externalStatusFile = path.resolve(process.cwd(), ".data", "external_forward_status.json");

async function readTelegramStatus() {
  try {
    const content = await fs.readFile(telegramStatusFile, "utf-8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

async function readExternalForwardStatus() {
  try {
    const content = await fs.readFile(externalStatusFile, "utf-8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (auth) return auth;

    const [config, runtimeStatusByAccountId, discordLibraryStatusById, telegramStatusById, externalForwardStatusByKind] =
      await Promise.all([
        getMultiConfig(),
        readStatus(),
        readDiscordLibraryStatus(),
        readTelegramStatus(),
        readExternalForwardStatus(),
      ]);

    return NextResponse.json(
      buildConfigStatusPayload({
        config,
        runtimeStatusByAccountId,
        discordLibraryStatusById,
        telegramStatusById,
        externalForwardStatusByKind,
      }),
    );
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}

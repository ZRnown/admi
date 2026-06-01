import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { getMultiConfig } from "@/src/config";
import { buildConfigStatusPayload } from "@/src/configStatusPayload";
import { resolveDataPath } from "@/src/paths";
import { readDiscordLibraryStatus, readStatus } from "@/app/api/_lib/common";
import { requireAuth } from "@/app/api/_lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const telegramStatusFile = resolveDataPath("telegram_status.json");
const externalStatusFile = resolveDataPath("external_forward_status.json");

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

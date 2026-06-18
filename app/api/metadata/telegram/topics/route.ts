import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { getMultiConfig } from "@/src/config";
import { resolveDataPath } from "@/src/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const topicsCacheFile = resolveDataPath("telegram_topics_cache.json");
const telegramTopicRequestDir = resolveDataPath("telegram_topic_requests");
const telegramTopicResponseDir = resolveDataPath("telegram_topic_responses");

async function waitForTopicResponse(requestId: string, maxWaitMs = 20000): Promise<any | null> {
  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitMs) {
    try {
      const raw = await fs.readFile(path.join(telegramTopicResponseDir, `${requestId}.json`), "utf-8");
      const response = JSON.parse(raw);
      if (response?.id === requestId) {
        await fs.unlink(path.join(telegramTopicResponseDir, `${requestId}.json`)).catch(() => {});
        return response;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const accountId = typeof body?.accountId === "string" ? body.accountId.trim() : "";
    const chatId = typeof body?.chatId === "string" || typeof body?.chatId === "number" ? body.chatId : "";
    if (!accountId || !chatId) {
      return NextResponse.json({ error: "缺少 accountId 或 chatId" }, { status: 400 });
    }

    const config = await getMultiConfig();
    const sourceAccount =
      (config.telegramAccounts || []).find((acc) => acc.id === accountId) ||
      (config.accounts || []).flatMap((acc) => acc.telegramConfig?.accounts || []).find((acc) => acc.id === accountId);
    if (!sourceAccount) {
      return NextResponse.json({ error: "Telegram 账号不存在" }, { status: 404 });
    }

    const requestId = randomUUID();
    await fs.mkdir(telegramTopicRequestDir, { recursive: true });
    await fs.writeFile(
      path.join(telegramTopicRequestDir, `${requestId}.json`),
      JSON.stringify(
        {
          id: requestId,
          accountId,
          chatId,
          accountType: sourceAccount.type === "bot" ? "bot" : "client",
          createdAt: Date.now(),
        },
        null,
        2,
      ),
    );

    const response = await waitForTopicResponse(requestId, 60000);
    if (!response) {
      return NextResponse.json({ error: "获取话题超时(60s)，请确认后端已启动" }, { status: 504 });
    }

    if (!response.success) {
      return NextResponse.json({ error: response.error || "获取话题失败" }, { status: 400 });
    }

    const result = response.result || {};

    if (!result?.success) {
      return NextResponse.json(
        { error: result?.error || result?.message || "获取话题失败" },
        { status: 400 },
      );
    }

    try {
      await fs.mkdir(path.dirname(topicsCacheFile), { recursive: true });
      let cache: Record<string, any[]> = {};
      try {
        cache = JSON.parse(await fs.readFile(topicsCacheFile, "utf-8"));
      } catch {
        cache = {};
      }
      cache[`${accountId}:${chatId}`] = Array.isArray(result.topics) ? result.topics : [];
      await fs.writeFile(topicsCacheFile, JSON.stringify(cache, null, 2));
    } catch {
      // ignore cache write failures
    }

    return NextResponse.json({
      success: true,
      topics: Array.isArray(result.topics) ? result.topics : [],
    });
  } catch (error: any) {
    return NextResponse.json({ error: String(error?.message || error) }, { status: 500 });
  }
}

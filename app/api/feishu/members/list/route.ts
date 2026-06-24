import { NextRequest, NextResponse } from "next/server";
import { getMultiConfig, type AccountConfig } from "@/src/config";
import { FeishuSender } from "@/src/feishuSender";
import { getEnv } from "@/src/env";
import { requireAuth } from "@/app/api/_lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (auth) return auth;

    const body = await req.json().catch(() => ({}));
    const accountId = typeof body?.accountId === "string" ? body.accountId : "";
    const chatId = typeof body?.chatId === "string" ? body.chatId.trim() : "";

    if (!accountId) {
      return NextResponse.json({ error: "缺少 accountId" }, { status: 400 });
    }
    if (!chatId) {
      return NextResponse.json({ error: "缺少飞书群" }, { status: 400 });
    }

    const multi = await getMultiConfig();
    const account: AccountConfig | undefined = multi.accounts.find((a) => a.id === accountId);
    if (!account) {
      return NextResponse.json({ error: "账号不存在" }, { status: 404 });
    }
    if ((account.forwardingType || "discord-to-discord") !== "discord-to-feishu") {
      return NextResponse.json({ error: "只有 Discord → 飞书实例支持查看群成员" }, { status: 400 });
    }

    const env = getEnv();
    const proxy = account.proxyUrl || env.PROXY_URL;
    const httpAgent = proxy ? new (await import("proxy-agent")).ProxyAgent(proxy as any) : undefined;
    const sender = new FeishuSender("temp", httpAgent, account.feishuAppId, account.feishuAppSecret);
    const raw = await sender.listChatMembers(chatId, "open_id");

    if (!raw.items) {
      const code = raw.raw?.code;
      const msg = raw.raw?.msg;
      return NextResponse.json(
        {
          error: msg && code ? `飞书错误(${code}): ${msg}` : "获取群成员失败，请检查应用权限",
          raw: raw.raw,
        },
        { status: 500 },
      );
    }

    return NextResponse.json({ items: raw.items });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}

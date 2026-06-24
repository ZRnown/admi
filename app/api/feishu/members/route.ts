import { NextRequest, NextResponse } from "next/server";
import { getMultiConfig, type AccountConfig } from "@/src/config";
import { FeishuSender } from "@/src/feishuSender";
import { getEnv } from "@/src/env";
import { requireAuth } from "@/app/api/_lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function normalizeList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(Boolean);
  }
  return String(value || "")
    .split(/[\s,，;；]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (auth) return auth;

    const body = await req.json().catch(() => ({}));
    const accountId = typeof body?.accountId === "string" ? body.accountId : "";
    const action = body?.action === "remove" ? "remove" : body?.action === "add" ? "add" : "";
    const requestedMemberIdType =
      body?.memberIdType === "open_id" ||
      body?.memberIdType === "user_id" ||
      body?.memberIdType === "union_id"
        ? body.memberIdType
        : "contact";
    const chatIds = normalizeList(body?.chatIds);
    const memberInputs = normalizeList(body?.memberIds);

    if (!accountId) {
      return NextResponse.json({ error: "缺少 accountId" }, { status: 400 });
    }
    if (!action) {
      return NextResponse.json({ error: "操作类型无效" }, { status: 400 });
    }
    if (chatIds.length === 0) {
      return NextResponse.json({ error: "请填写至少一个飞书 Chat ID" }, { status: 400 });
    }
    if (memberInputs.length === 0) {
      return NextResponse.json({ error: "请填写至少一个手机号、邮箱或成员 ID" }, { status: 400 });
    }

    const multi = await getMultiConfig();
    const account: AccountConfig | undefined = multi.accounts.find((a) => a.id === accountId);
    if (!account) {
      return NextResponse.json({ error: "账号不存在" }, { status: 404 });
    }
    if ((account.forwardingType || "discord-to-discord") !== "discord-to-feishu") {
      return NextResponse.json({ error: "只有 Discord → 飞书实例支持群成员管理" }, { status: 400 });
    }

    const env = getEnv();
    const proxy = account.proxyUrl || env.PROXY_URL;
    const httpAgent = proxy ? new (await import("proxy-agent")).ProxyAgent(proxy as any) : undefined;
    const sender = new FeishuSender("temp", httpAgent, account.feishuAppId, account.feishuAppSecret);
    let memberIdType: "open_id" | "user_id" | "union_id" =
      requestedMemberIdType === "contact" ? "open_id" : requestedMemberIdType;
    let memberIds = memberInputs;
    let unresolvedContacts: string[] = [];

    if (requestedMemberIdType === "contact") {
      const resolved = await sender.resolveOpenIdsByContacts(memberInputs);
      memberIdType = "open_id";
      memberIds = resolved.memberIds;
      unresolvedContacts = resolved.unresolved;
      if (memberIds.length === 0) {
        const msg = resolved.raw?.msg || resolved.raw?.error || "无法根据手机号/邮箱找到飞书用户";
        return NextResponse.json({ error: msg, unresolvedContacts, raw: resolved.raw }, { status: 400 });
      }
    }

    const results = await sender.manageChatMembers({
      action,
      chatIds,
      memberIds,
      memberIdType,
    });
    const okCount = results.filter((item) => item.ok).length;

    return NextResponse.json({
      ok: okCount === results.length,
      okCount,
      total: results.length,
      memberIdType,
      resolvedMemberCount: memberIds.length,
      unresolvedContacts,
      results,
    });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}

const fallbackSiteUrl = "https://admi-bot.example.com";

function normalizeSiteUrl(value?: string): string {
  if (!value) {
    return fallbackSiteUrl;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return fallbackSiteUrl;
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed.replace(/\/$/, "");
  }

  return `https://${trimmed}`.replace(/\/$/, "");
}

function normalizeDocsUrl(value?: string): string {
  if (!value) {
    return "/index.html";
  }

  const trimmed = value.trim();
  return trimmed || "/index.html";
}

export const siteConfig = {
  name: "ADMI Bridge Cloud",
  shortName: "ADMI",
  description:
    "一个面向团队的多平台消息桥接 SaaS：支持 Discord / Telegram 规则转发、OCR 图片风控、主备路由和审计级可观测性。",
  siteUrl: normalizeSiteUrl(process.env.NEXT_PUBLIC_APP_URL),
  keywords: [
    "Discord bridge",
    "Telegram bridge",
    "消息转发",
    "OCR 审核",
    "主备切换",
    "SaaS",
  ],
  socialImage: "/apple-icon.png",
  supportEmail: "support@admi-bridge.example.com",
  nav: {
    dashboard: "/index.html",
    docs: normalizeDocsUrl(process.env.NEXT_PUBLIC_DOCS_URL),
  },
} as const;

export type SiteConfig = typeof siteConfig;

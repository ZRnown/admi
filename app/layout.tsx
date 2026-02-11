import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { siteConfig } from "@/src/site/siteConfig";

import "./globals.css";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#f5f8ff",
};

export const metadata: Metadata = {
  metadataBase: new URL(siteConfig.siteUrl),
  applicationName: siteConfig.name,
  title: {
    default: `${siteConfig.name} | Discord & Telegram Bridge SaaS`,
    template: `%s | ${siteConfig.name}`,
  },
  description: siteConfig.description,
  keywords: [...siteConfig.keywords],
  alternates: {
    canonical: "/",
  },
  robots: {
    index: true,
    follow: true,
    nocache: false,
    googleBot: {
      index: true,
      follow: true,
      "max-snippet": -1,
      "max-image-preview": "large",
      "max-video-preview": -1,
    },
  },
  openGraph: {
    type: "website",
    locale: "zh_CN",
    url: siteConfig.siteUrl,
    siteName: siteConfig.name,
    title: `${siteConfig.name} | Discord & Telegram Bridge SaaS`,
    description: siteConfig.description,
    images: [
      {
        url: siteConfig.socialImage,
        width: 1200,
        height: 630,
        alt: `${siteConfig.name} 封面图`,
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: `${siteConfig.name} | Discord & Telegram Bridge SaaS`,
    description: siteConfig.description,
    images: [siteConfig.socialImage],
  },
};

type RootLayoutProps = {
  children: ReactNode;
};

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="zh-CN">
      <body>
        <a className="skipLink" href="#main-content">
          跳到主要内容
        </a>
        {children}
      </body>
    </html>
  );
}

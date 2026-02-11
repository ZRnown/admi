import Link from "next/link";

import { siteConfig } from "@/src/site/siteConfig";

const productSchema = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: siteConfig.name,
  applicationCategory: "BusinessApplication",
  operatingSystem: "Linux, macOS, Windows",
  description: siteConfig.description,
  url: siteConfig.siteUrl,
};

export default function HomePage() {
  return (
    <main id="main-content" className="mentorPage">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(productSchema) }}
      />

      <header className="mentorNav">
        <Link className="mentorBrand" href="/">
          <span className="mentorMark" aria-hidden="true" />
          {siteConfig.shortName}
        </Link>

        <nav className="mentorLinks" aria-label="主页导航">
          <a href="#overview">概览</a>
        </nav>

        <div className="mentorActions">
          <Link className="btn ghost" href="/login">
            登录
          </Link>
          <Link className="btn primary" href="/register">
            立即开始
          </Link>
        </div>
      </header>

      <section className="mentorHero" id="overview">
        <h1>
          <span>你的消息自动化导师</span>
          <br />
          你的桥接控制引擎
        </h1>
        <p>更少配置，更稳转发。</p>
        <div className="mentorHeroActions">
          <Link className="btn primary" href="/register">
            免费开始
          </Link>
          <Link className="btn subtle" href="/index.html">
            打开控制台
          </Link>
        </div>
        <div className="minimalChips" aria-label="平台能力">
          <span>Discord / Telegram</span>
          <span>图片优先 OCR</span>
          <span>主备静默判定</span>
        </div>
      </section>

      <footer className="minimalFooter">
        <p>© 2026 {siteConfig.shortName}</p>
        <div>
          <Link href="/login">登录</Link>
          <span> · </span>
          <Link href="/register">注册</Link>
          <span> · </span>
          <Link href="/index.html">控制台</Link>
        </div>
      </footer>
    </main>
  );
}

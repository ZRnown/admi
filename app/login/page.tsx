"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";

type LoginState = {
  loading: boolean;
  error: string;
};

export default function LoginPage() {
  const [state, setState] = useState<LoginState>({ loading: false, error: "" });

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const username = String(formData.get("username") || "").trim();
    const password = String(formData.get("password") || "");

    if (!username || !password) {
      setState({ loading: false, error: "请输入账号和密码" });
      return;
    }

    setState({ loading: true, error: "" });
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        setState({ loading: false, error: String(payload?.error || "登录失败") });
        return;
      }

      window.location.href = "/index.html";
    } catch (error: any) {
      setState({ loading: false, error: String(error?.message || error) });
    }
  };

  return (
    <main id="main-content" className="authPage">
      <div className="subPageFrame">
        <header className="subNav">
          <Link className="homeLink" href="/">
            ADMI
          </Link>
          <Link className="btn ghost" href="/register">
            注册申请
          </Link>
        </header>

        <section className="authCard" aria-label="登录表单">
          <p className="authEyebrow">Welcome Back</p>
          <h1>登录 ADMI 控制台</h1>
          <p className="authDescription">继续管理多平台消息路由、OCR 审核和主备策略。</p>

          <form className="authForm" onSubmit={onSubmit}>
            <label htmlFor="username">账号</label>
            <input id="username" name="username" autoComplete="username" required />

            <label htmlFor="password">密码</label>
            <input id="password" name="password" type="password" autoComplete="current-password" required />

            {state.error ? <p className="authError">{state.error}</p> : null}

            <button className="btn primary block" type="submit" disabled={state.loading}>
              {state.loading ? "登录中..." : "登录"}
            </button>
          </form>

          <p className="authHint">
            还没有权限？<Link href="/register">提交开通申请</Link>
          </p>
        </section>
      </div>
    </main>
  );
}

"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";

type RegisterState = {
  loading: boolean;
  error: string;
  success: string;
};

export default function RegisterPage() {
  const [state, setState] = useState<RegisterState>({ loading: false, error: "", success: "" });

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const email = String(formData.get("email") || "").trim();
    const company = String(formData.get("company") || "").trim();
    const useCase = String(formData.get("useCase") || "").trim();

    if (!email) {
      setState({ loading: false, error: "请输入邮箱", success: "" });
      return;
    }

    setState({ loading: true, error: "", success: "" });
    try {
      const response = await fetch("/api/auth/register-intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, company, useCase }),
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setState({ loading: false, error: String(payload?.error || "提交失败"), success: "" });
        return;
      }

      setState({
        loading: false,
        error: "",
        success: String(payload?.message || "提交成功，我们会尽快联系你"),
      });
      event.currentTarget.reset();
    } catch (error: any) {
      setState({ loading: false, error: String(error?.message || error), success: "" });
    }
  };

  return (
    <main id="main-content" className="authPage">
      <div className="subPageFrame">
        <header className="subNav">
          <Link className="homeLink" href="/">
            ADMI
          </Link>
          <Link className="btn ghost" href="/login">
            去登录
          </Link>
        </header>

        <section className="authCard" aria-label="注册申请表单">
          <p className="authEyebrow">Register Interest</p>
          <h1>申请开通账号</h1>
          <p className="authDescription">留下你的信息，我们会按需开通并协助初始化实例。</p>

          <form className="authForm" onSubmit={onSubmit}>
            <label htmlFor="email">工作邮箱</label>
            <input id="email" name="email" type="email" autoComplete="email" required />

            <label htmlFor="company">公司（可选）</label>
            <input id="company" name="company" autoComplete="organization" />

            <label htmlFor="useCase">使用场景（可选）</label>
            <textarea id="useCase" name="useCase" rows={4} />

            {state.error ? <p className="authError">{state.error}</p> : null}
            {state.success ? <p className="authSuccess">{state.success}</p> : null}

            <button className="btn primary block" type="submit" disabled={state.loading}>
              {state.loading ? "提交中..." : "提交申请"}
            </button>
          </form>

          <p className="authHint">
            已有账号？<Link href="/login">前往登录</Link>
          </p>
        </section>
      </div>
    </main>
  );
}

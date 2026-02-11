import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { isAuthTokenValid } from "@/app/api/_lib/auth";
import { listRegisterIntents } from "@/app/api/_lib/registerIntents";

export const dynamic = "force-dynamic";

export default async function AdminLeadsPage() {
  const token = (await cookies()).get("auth_token")?.value;
  const isAuthed = await isAuthTokenValid(token);
  if (!isAuthed) {
    redirect("/login");
  }

  const items = await listRegisterIntents();

  return (
    <main id="main-content" className="adminPage">
      <div className="subPageFrame">
        <header className="subNav">
          <Link className="homeLink" href="/">
            ADMI
          </Link>
          <div className="mentorActions">
            <Link className="btn ghost" href="/index.html">
              控制台
            </Link>
            <Link className="btn ghost" href="/login">
              登录页
            </Link>
          </div>
        </header>

        <section className="adminCard">
          <div className="adminHeader">
            <div>
              <p className="authEyebrow">Admin Leads</p>
              <h1>注册申请列表</h1>
            </div>
            <Link className="btn ghost" href="/index.html">
              返回控制台
            </Link>
          </div>

          <div className="leadMeta">共 {items.length} 条申请</div>

          <div className="leadTableWrap" role="region" aria-label="注册申请列表">
            <table className="leadTable">
              <thead>
                <tr>
                  <th>提交时间</th>
                  <th>邮箱</th>
                  <th>公司</th>
                  <th>使用场景</th>
                </tr>
              </thead>
              <tbody>
                {items.length === 0 ? (
                  <tr>
                    <td colSpan={4}>暂无申请记录</td>
                  </tr>
                ) : (
                  items.map((item) => (
                    <tr key={item.id}>
                      <td>{new Date(item.createdAt).toLocaleString("zh-CN")}</td>
                      <td>{item.email}</td>
                      <td>{item.company || "-"}</td>
                      <td>{item.useCase || "-"}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  );
}

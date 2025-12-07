"use client"

import type React from "react"

import { useEffect, useMemo, useState } from "react"
import { Plus, Trash2, Settings, MessageSquare, ShieldAlert, Info, X } from "lucide-react"
import {
  type ChannelMapping,
  type AccountFormConfig,
  type MultiAccountFormState,
  createEmptyAccount,
  DEFAULT_MULTI_ACCOUNT_STATE,
} from "@/lib/types"

const LOCAL_STORAGE_KEY = "discord-forwarder-multi-config"

const genId = () => {
  try {
    if (typeof globalThis !== "undefined" && (globalThis as any).crypto?.randomUUID) {
      return (globalThis as any).crypto.randomUUID() as string
    }
  } catch {}
  return `id_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

const normalizeMapping = (mapping: any): ChannelMapping => ({
  id: mapping?.id || genId(),
  sourceChannelId: mapping?.sourceChannelId || "",
  targetWebhookUrl: mapping?.targetWebhookUrl || "",
  note: mapping?.note || "",
})

const normalizeAccount = (input: any, index = 0): AccountFormConfig => ({
  id: input?.id || genId(),
  name: input?.name || `账号${index + 1}`,
  type: input?.type === "bot" ? "bot" : "selfbot",
  token: input?.token || input?.discordToken || "",
  proxyUrl: input?.proxyUrl || "",
  loginRequested: input?.loginRequested === true,
  loginNonce: typeof input?.loginNonce === "number" ? input.loginNonce : undefined,
  loginState: input?.loginState || "idle",
  loginMessage: input?.loginMessage || "",
  showSourceIdentity: input?.showSourceIdentity === true,
  mappings: Array.isArray(input?.mappings) && input.mappings.length > 0 ? input.mappings.map(normalizeMapping) : [normalizeMapping({})],
  blockedKeywords: Array.isArray(input?.blockedKeywords) ? input.blockedKeywords : [],
  excludeKeywords: Array.isArray(input?.excludeKeywords) ? input.excludeKeywords : [],
  replacements: Array.isArray(input?.replacements)
    ? input.replacements.map((r: any) => ({ from: r?.from || "", to: r?.to || "" }))
    : [],
  allowedUsersIds: Array.isArray(input?.allowedUsersIds) ? input.allowedUsersIds.map(String) : [],
  mutedUsersIds: Array.isArray(input?.mutedUsersIds) ? input.mutedUsersIds.map(String) : [],
  restartNonce: typeof input?.restartNonce === "number" ? input.restartNonce : undefined,
  enableTranslation: input?.enableTranslation === true,
  deepseekApiKey: input?.deepseekApiKey || "",
})

const normalizeAccounts = (accounts: any[]): AccountFormConfig[] => {
  const normalized = (accounts || []).map((acc, idx) => normalizeAccount(acc, idx))
  if (normalized.length === 0) {
    return [createEmptyAccount("默认账号")]
  }
  return normalized
}

function legacyResponseToState(payload: any): MultiAccountFormState {
  const account = normalizeAccount(
    {
      ...payload,
      token: payload?.discordToken || payload?.token || "",
      mappings: payload?.mappings,
    },
    0,
  )
  return { accounts: [account], activeId: account.id }
}

export function ConfigDashboard() {
  const [state, setState] = useState<MultiAccountFormState>(DEFAULT_MULTI_ACCOUNT_STATE)
  const [showHelp, setShowHelp] = useState(false)

  const setAccountsState = (updater: (prev: MultiAccountFormState) => MultiAccountFormState) => {
    setState((prev) => {
      const next = updater(prev)
      if (next.accounts.length === 0) {
        const acc = createEmptyAccount("默认账号")
        return { accounts: [acc], activeId: acc.id }
      }
      if (!next.activeId || !next.accounts.some((acc) => acc.id === next.activeId)) {
        return { accounts: next.accounts, activeId: next.accounts[0].id }
      }
      return next
    })
  }

  const activeAccount = useMemo(() => {
    const current = state.accounts.find((acc) => acc.id === state.activeId)
    return current || state.accounts[0]
  }, [state])

  // 缓存 pending 状态检查，避免每次渲染都计算
  const hasPendingAccount = useMemo(() => 
    state.accounts.some(acc => acc.loginState === "pending"),
    [state.accounts.map(a => a.loginState).join(",")]
  )

  const updateActiveAccount = (updater: (account: AccountFormConfig) => AccountFormConfig) => {
    const currentId = activeAccount?.id
    if (!currentId) return
    setAccountsState((prev) => {
      const accounts = prev.accounts.map((acc) => (acc.id === currentId ? updater(acc) : acc))
      return { ...prev, accounts }
    })
  }

  const addAccount = () => {
    const newAccount = createEmptyAccount(`账号${state.accounts.length + 1}`)
    setAccountsState((prev) => ({
      accounts: [...prev.accounts, newAccount],
      activeId: newAccount.id,
    }))
  }

  const removeActiveAccount = () => {
    if (state.accounts.length <= 1) return
    const currentId = activeAccount?.id
    if (!currentId) return
    if (!confirm("确定要删除当前账号吗？此账号的所有配置将被移除。")) return
    setAccountsState((prev) => {
      const accounts = prev.accounts.filter((acc) => acc.id !== currentId)
      const activeId = prev.activeId === currentId ? accounts[0]?.id || "" : prev.activeId
      return { accounts, activeId: activeId || (accounts[0]?.id ?? "") }
    })
  }

  // Load from localStorage + server
  useEffect(() => {
    const saved = localStorage.getItem(LOCAL_STORAGE_KEY)
    if (saved) {
      try {
        const parsed = JSON.parse(saved)
        if (Array.isArray(parsed?.accounts)) {
          setState({
            accounts: normalizeAccounts(parsed.accounts),
            activeId: parsed.activeId || parsed.accounts[0]?.id || "",
          })
        } else {
          setState(legacyResponseToState(parsed))
        }
      } catch (e) {
        console.error("[ConfigDashboard] 加载本地配置失败", e)
      }
    }
    ;(async () => {
      try {
        const res = await fetch("/api/config", { cache: "no-store" })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        if (Array.isArray(data?.accounts)) {
          setState({
            accounts: normalizeAccounts(data.accounts),
            activeId: data.activeId || data.accounts[0]?.id || "",
          })
        } else {
          setState(legacyResponseToState(data))
        }
      } catch (e: any) {
        console.error("[ConfigDashboard] 从服务器加载配置失败", e)
      }
    })()
  }, [])

  // Auto save to localStorage + server (debounced)
  useEffect(() => {
    try {
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(state))
    } catch {}
    
    // 使用 debounce 避免频繁保存
    const t = setTimeout(async () => {
      try {
        const res = await fetch("/api/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(state),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
      } catch (e: any) {
        console.error("[ConfigDashboard] 自动保存失败", e)
      }
    }, 800) // 增加 debounce 时间到 800ms，减少保存频率
    return () => clearTimeout(t)
  }, [state])

  // 轮询获取最新登录状态（不覆盖本地其他字段）
  // 只在有账号处于 pending 状态时才频繁轮询，否则降低频率
  useEffect(() => {
    const syncStatus = async () => {
      try {
        const res = await fetch("/api/config", { cache: "no-store" })
        if (!res.ok) return
          const data = await res.json()
        if (!Array.isArray(data?.accounts)) return
        setAccountsState((prev) => {
          let hasChange = false
          const merged = prev.accounts.map((acc) => {
            const remote = data.accounts.find((a: any) => a.id === acc.id)
            if (!remote) return acc
            
            const remoteState = remote.loginState ?? "idle"
            const remoteMessage = remote.loginMessage ?? ""
            
            // 如果本地状态是 pending，且远程状态是 idle，保持 pending（避免轮询覆盖）
            // 只有当远程状态变为 online 或 error 时，才更新状态
            if (acc.loginState === "pending" && remoteState === "idle") {
              // 保持 pending 状态，不更新
              return acc
            }
            
            const newState = remoteState
            const newMessage = remoteMessage
            
            // 只在状态真正变化时才更新
            if (newState !== acc.loginState || newMessage !== acc.loginMessage) {
              hasChange = true
              return {
                ...acc,
                loginState: newState,
                loginMessage: newMessage,
              }
            }
            return acc
          })
          
          // 如果没有变化，不更新状态，避免不必要的重渲染
          if (!hasChange) return prev
          
          return { ...prev, accounts: merged }
        })
      } catch {}
    }

    // 如果有 pending 状态，每 1 秒轮询一次；否则每 15 秒轮询一次（降低频率）
    const interval = hasPendingAccount ? 1000 : 15000
    
    const timer = setInterval(syncStatus, interval)
    syncStatus()
    return () => clearInterval(timer)
  }, [state.accounts.map(a => `${a.id}:${a.loginState}`).join(",")]) // 只在登录状态变化时重新设置轮询

  if (!activeAccount) {
    return (
      <div className="max-w-4xl mx-auto space-y-4">
        <div className="bg-yellow-50 border border-yellow-200 text-yellow-800 px-4 py-3 rounded">
          当前没有可配置的账号，请添加一个账号开始配置。
        </div>
        <button
          onClick={addAccount}
          className="inline-flex items-center gap-2 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow hover:bg-indigo-500"
        >
          <Plus className="w-4 h-4" />
          添加账号
        </button>
      </div>
    )
  }

  const handleAddMapping = () => {
    updateActiveAccount((acc) => ({
      ...acc,
      mappings: [...acc.mappings, { id: genId(), sourceChannelId: "", targetWebhookUrl: "", note: "" }],
    }))
  }

  const handleRemoveMapping = (id: string) => {
    updateActiveAccount((acc) => ({
      ...acc,
      mappings: acc.mappings.filter((m) => m.id !== id),
    }))
  }

  const updateMapping = (id: string, field: keyof ChannelMapping, value: string) => {
    updateActiveAccount((acc) => ({
      ...acc,
      mappings: acc.mappings.map((m) => (m.id === id ? { ...m, [field]: value } : m)),
    }))
  }

  const addKeyword = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      const val = e.currentTarget.value.trim()
      if (val && !activeAccount.blockedKeywords.includes(val)) {
        updateActiveAccount((acc) => ({
          ...acc,
          blockedKeywords: [...acc.blockedKeywords, val],
        }))
        e.currentTarget.value = ""
      }
    }
  }

  const removeKeyword = (keyword: string) => {
    updateActiveAccount((acc) => ({
      ...acc,
      blockedKeywords: acc.blockedKeywords.filter((k) => k !== keyword),
    }))
  }

  const addExcludeKeyword = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      const val = e.currentTarget.value.trim()
      if (val && !activeAccount.excludeKeywords.includes(val)) {
        updateActiveAccount((acc) => ({
          ...acc,
          excludeKeywords: [...acc.excludeKeywords, val],
        }))
        e.currentTarget.value = ""
      }
    }
  }

  const removeExcludeKeyword = (keyword: string) => {
    updateActiveAccount((acc) => ({
      ...acc,
      excludeKeywords: acc.excludeKeywords.filter((k) => k !== keyword),
    }))
  }

  const addReplacement = () => {
    updateActiveAccount((acc) => ({
      ...acc,
      replacements: [...acc.replacements, { from: "", to: "" }],
    }))
  }

  const updateReplacement = (idx: number, field: "from" | "to", value: string) => {
    updateActiveAccount((acc) => ({
      ...acc,
      replacements: acc.replacements.map((r, i) => (i === idx ? { ...r, [field]: value } : r)),
    }))
  }

  const removeReplacement = (idx: number) => {
    updateActiveAccount((acc) => ({
      ...acc,
      replacements: acc.replacements.filter((_, i) => i !== idx),
    }))
  }
  const addAllowedUser = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      const val = e.currentTarget.value.trim()
      if (val && !activeAccount.allowedUsersIds.includes(val)) {
        updateActiveAccount((acc) => ({
          ...acc,
          allowedUsersIds: [...acc.allowedUsersIds, val],
        }))
        e.currentTarget.value = ""
      }
    }
  }

  const removeAllowedUser = (id: string) => {
    updateActiveAccount((acc) => ({
      ...acc,
      allowedUsersIds: acc.allowedUsersIds.filter((x) => x !== id),
    }))
  }

  const addMutedUser = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      const val = e.currentTarget.value.trim()
      if (val && !activeAccount.mutedUsersIds.includes(val)) {
        updateActiveAccount((acc) => ({
          ...acc,
          mutedUsersIds: [...acc.mutedUsersIds, val],
        }))
        e.currentTarget.value = ""
      }
    }
  }

  const removeMutedUser = (id: string) => {
    updateActiveAccount((acc) => ({
      ...acc,
      mutedUsersIds: acc.mutedUsersIds.filter((x) => x !== id),
    }))
  }

  const requestLogin = async () => {
    // 如果已经登录成功，不允许再次登录
    if (activeAccount.loginState === "online") {
      return
    }
    
    // 如果正在登录中，不允许重复点击
    if (activeAccount.loginState === "pending") {
      return
    }
    
    // 立即更新本地状态为 pending
    setAccountsState((prev) => {
      return {
        ...prev,
        accounts: prev.accounts.map(acc =>
          acc.id === activeAccount.id
            ? {
                ...acc,
                loginState: "pending" as const,
                loginMessage: "正在登录...",
              }
            : acc
        ),
      }
    })

    // 直接调用 API 处理登录
    try {
      const res = await fetch("/api/account/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: activeAccount.id,
          action: "login",
        }),
      })

      const data = await res.json()
      
      if (!res.ok) {
        // 如果已经登录，更新状态
        if (data.loginState === "online") {
          setAccountsState((prev) => ({
            ...prev,
            accounts: prev.accounts.map(acc =>
              acc.id === activeAccount.id
                ? {
                    ...acc,
                    loginState: "online" as const,
                    loginMessage: "已登录",
                  }
                : acc
            ),
          }))
        }
        return
      }

      // API 调用成功，状态已经在后端设置，轮询会更新
    } catch (e) {
      console.error("[ConfigDashboard] 登录请求失败", e)
      // 恢复状态
      setAccountsState((prev) => ({
        ...prev,
        accounts: prev.accounts.map(acc =>
          acc.id === activeAccount.id
            ? {
                ...acc,
                loginState: "idle" as const,
                loginMessage: "登录请求失败",
              }
            : acc
        ),
      }))
    }
  }

  const requestStop = async () => {
    // 如果正在登录中，不允许停止
    if (activeAccount.loginState === "pending") {
      return
    }

    // 如果已经停止，不需要操作
    if (activeAccount.loginState === "idle" || activeAccount.loginState === "stopped") {
      return
    }

    // 立即更新本地状态
    setAccountsState((prev) => {
      return {
        ...prev,
        accounts: prev.accounts.map(acc =>
          acc.id === activeAccount.id
            ? {
                ...acc,
                loginState: "idle" as const,
                loginMessage: "正在停止...",
              }
            : acc
        ),
      }
    })

    // 直接调用 API 处理停止
    try {
      const res = await fetch("/api/account/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: activeAccount.id,
          action: "stop",
        }),
      })

      const data = await res.json()

      if (res.ok) {
        // 更新状态
        setAccountsState((prev) => ({
          ...prev,
          accounts: prev.accounts.map(acc =>
            acc.id === activeAccount.id
              ? {
                  ...acc,
                  loginState: data.loginState || "idle",
                  loginMessage: data.loginMessage || "已停止该账号登录",
                }
              : acc
          ),
        }))
      }
    } catch (e) {
      console.error("[ConfigDashboard] 停止请求失败", e)
      // 恢复状态
      setAccountsState((prev) => ({
        ...prev,
        accounts: prev.accounts.map(acc =>
          acc.id === activeAccount.id
            ? {
                ...acc,
                loginState: activeAccount.loginState || "idle",
                loginMessage: "停止请求失败",
              }
            : acc
        ),
      }))
    }
  }

  const isPending = activeAccount.loginState === "pending"
  const isOnline = activeAccount.loginState === "online"

  return (
    <div className="max-w-4xl mx-auto space-y-6 pb-20">
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-slate-100 bg-slate-50/60 p-4">
          <div className="flex flex-wrap items-center gap-2">
            {state.accounts.map((account) => (
              <button
                key={account.id}
                onClick={() =>
                  setAccountsState((prev) => ({
                    ...prev,
                    activeId: account.id,
                  }))
                }
                className={`rounded-full px-3 py-1 text-sm font-medium transition ${
                  account.id === activeAccount.id
                    ? "bg-indigo-600 text-white shadow"
                    : "bg-white text-slate-600 border border-slate-200 hover:bg-slate-100"
                }`}
              >
                {account.name || "未命名账号"}
              </button>
            ))}
            <button
              onClick={addAccount}
              className="inline-flex items-center gap-1 rounded-full border border-dashed border-indigo-300 px-3 py-1 text-sm font-medium text-indigo-600 hover:bg-indigo-50"
            >
              <Plus className="w-3 h-3" /> 添加账号
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => setShowHelp(true)}
              className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100"
            >
              <Info className="w-3 h-3" /> 使用说明
            </button>
            {state.accounts.length > 1 && (
              <button
                onClick={removeActiveAccount}
                className="inline-flex items-center gap-1 rounded-md border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50"
              >
                <Trash2 className="w-3 h-3" /> 删除当前账号
              </button>
            )}
          </div>
        </div>
        {showHelp && (
          <div className="relative border-b border-slate-100 bg-slate-50 px-6 py-4 text-sm leading-relaxed text-slate-600">
            <button
              onClick={() => setShowHelp(false)}
              className="absolute right-3 top-3 text-slate-400 hover:text-slate-600"
            >
              <X className="w-4 h-4" />
            </button>
            <p className="font-semibold text-slate-800">使用说明</p>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              <li>一个账号对应一个 Discord Token，可选择机器人 Token 或自用号 Token。</li>
              <li>每个账号都可以单独配置转发规则、关键词、排除/替换规则。</li>
              <li>转发时如需伪装为源用户，请勾选「使用源用户昵称和头像」。关闭则使用 Webhook 默认头像。</li>
              <li>排除关键词会直接删除命中的词，而不会阻止整条消息转发。</li>
              <li>可以添加多个账号并行运行，后端会为每个账号独立登录并转发。</li>
            </ul>
          </div>
        )}
      </div>

      {/* General Settings */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/50 flex items-center gap-2">
          <Settings className="w-4 h-4 text-indigo-600" />
          <h2 className="font-semibold text-slate-800">基础设置</h2>
        </div>
        <div className="p-6 space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1">
              <label className="block text-sm font-medium text-slate-700">账号名称</label>
              <input
                type="text"
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                value={activeAccount.name}
                onChange={(e) => updateActiveAccount((acc) => ({ ...acc, name: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <label className="block text-sm font-medium text-slate-700">账号类型</label>
              <select
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                value={activeAccount.type}
                onChange={(e) =>
                  updateActiveAccount((acc) => ({ ...acc, type: e.target.value === "bot" ? "bot" : "selfbot" }))
                }
              >
                <option value="selfbot">用户 Token（SelfBot）</option>
                <option value="bot">机器人 Token</option>
              </select>
            </div>
          </div>
          <div className="space-y-1">
            <label className="block text-sm font-medium text-slate-700 mb-1">Discord Token</label>
            <div className="flex flex-col gap-2">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              type="password"
                  className="flex-1 px-3 py-2 bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all font-mono text-sm"
              placeholder="OT..."
                  value={activeAccount.token}
                  onChange={(e) => updateActiveAccount((acc) => ({ ...acc, token: e.target.value }))}
                />
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={requestLogin}
                    disabled={isPending || isOnline}
                    className={`inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium shadow transition ${
                      isPending || isOnline
                        ? "bg-indigo-300 text-white cursor-not-allowed"
                        : "bg-indigo-600 text-white hover:bg-indigo-500"
                    }`}
                  >
                    {isPending ? "登录中..." : isOnline ? "已登录" : "登录"}
                  </button>
                  <button
                    type="button"
                    onClick={requestStop}
                    disabled={isPending || (!isOnline && activeAccount.loginState !== "error")}
                    className={`inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs font-medium transition ${
                      isPending || (!isOnline && activeAccount.loginState !== "error")
                        ? "border-slate-200 text-slate-400 cursor-not-allowed bg-slate-50"
                        : "border-slate-200 text-slate-600 hover:bg-slate-100"
                    }`}
                  >
                    停止
                  </button>
                </div>
              </div>
              <div className="text-xs text-slate-500 flex flex-wrap items-center gap-2">
                <span>点击「登录」后才会使用该 Token 进行连接并开始转发。</span>
                <span className="inline-flex items-center gap-2 text-slate-600">
                  <span
                    className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                      activeAccount.loginState === "online"
                        ? "bg-emerald-50 text-emerald-700"
                        : activeAccount.loginState === "error"
                          ? "bg-red-50 text-red-700"
                          : "bg-slate-100 text-slate-600"
                    }`}
                  >
                    状态: {activeAccount.loginState || "idle"}
                  </span>
                  {activeAccount.loginMessage && <span className="text-slate-500">{activeAccount.loginMessage}</span>}
                </span>
              </div>
            </div>
          </div>
          <div className="space-y-1">
            <label className="block text-sm font-medium text-slate-700 mb-1">代理地址 (Proxy URL)</label>
            <input
              type="text"
              className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all font-mono text-sm"
              placeholder="http://127.0.0.1:7890"
              value={activeAccount.proxyUrl}
              onChange={(e) => updateActiveAccount((acc) => ({ ...acc, proxyUrl: e.target.value }))}
            />
            <p className="text-xs text-slate-500 mt-1">可选，如果网络环境需要代理请填写</p>
          </div>
          <div className="flex items-center gap-2 pt-2">
            <input
              id="showSourceIdentity"
              type="checkbox"
              className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
              checked={activeAccount.showSourceIdentity}
              onChange={(e) => updateActiveAccount((acc) => ({ ...acc, showSourceIdentity: e.target.checked }))}
            />
            <label htmlFor="showSourceIdentity" className="text-sm text-slate-700">
              使用源用户的昵称和头像进行转发（关闭则使用 Webhook 默认头像和名称）
            </label>
          </div>
          <div className="border-t border-slate-200 pt-4 space-y-4">
            <div className="flex items-center gap-2">
              <input
                id="enableTranslation"
                type="checkbox"
                className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                checked={activeAccount.enableTranslation || false}
                onChange={(e) => updateActiveAccount((acc) => ({ ...acc, enableTranslation: e.target.checked }))}
              />
              <label htmlFor="enableTranslation" className="text-sm text-slate-700">
                启用自动翻译（使用 DeepSeek API，源为中文时不翻译）
              </label>
            </div>
            {activeAccount.enableTranslation && (
              <div className="space-y-1">
                <label className="block text-sm font-medium text-slate-700 mb-1">DeepSeek API Key</label>
                <input
                  type="password"
                  className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all font-mono text-sm"
                  placeholder="sk-..."
                  value={activeAccount.deepseekApiKey || ""}
                  onChange={(e) => updateActiveAccount((acc) => ({ ...acc, deepseekApiKey: e.target.value }))}
                />
                <p className="text-xs text-slate-500 mt-1">
                  翻译后的消息格式：原文 + 横线分隔 + 翻译。如果源消息是中文，则不会翻译。
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Mappings */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/50 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <MessageSquare className="w-4 h-4 text-indigo-600" />
            <h2 className="font-semibold text-slate-800">转发规则</h2>
          </div>
          <button
            onClick={handleAddMapping}
            className="text-xs flex items-center gap-1 bg-indigo-50 text-indigo-600 px-2 py-1 rounded-md hover:bg-indigo-100 transition-colors font-medium"
          >
            <Plus className="w-3 h-3" /> 添加规则
          </button>
        </div>
        <div className="p-6 space-y-4">
          {activeAccount.mappings.map((mapping, index) => (
            <div
              key={mapping.id}
              className="flex flex-col sm:flex-row gap-3 items-start sm:items-center p-3 rounded-lg border border-slate-100 bg-slate-50/30 hover:border-indigo-100 transition-colors group"
            >
              <div className="flex-1 w-full">
                <input
                  type="text"
                  className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 text-sm font-mono"
                  placeholder="来源频道 ID"
                  value={mapping.sourceChannelId}
                  onChange={(e) => updateMapping(mapping.id, "sourceChannelId", e.target.value)}
                />
              </div>
              <div className="hidden sm:block text-slate-300">→</div>
              <div className="flex-[2] w-full">
                <input
                  type="text"
                  className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 text-sm font-mono"
                  placeholder="目标 Webhook URL"
                  value={mapping.targetWebhookUrl}
                  onChange={(e) => updateMapping(mapping.id, "targetWebhookUrl", e.target.value)}
                />
                <input
                  type="text"
                  className="mt-2 w-full px-3 py-1.5 bg-white border border-dashed border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 text-xs"
                  placeholder="备注（可选，例如：主频道 / 备份 / 某个用途说明）"
                  value={mapping.note || ""}
                  onChange={(e) => updateMapping(mapping.id, "note", e.target.value)}
                />
              </div>
              <button
                onClick={() => handleRemoveMapping(mapping.id)}
                className="p-2 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-md transition-colors opacity-100 sm:opacity-0 group-hover:opacity-100"
                title="删除规则"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
          {activeAccount.mappings.length === 0 && (
            <div className="text-center py-8 text-slate-400 text-sm border-2 border-dashed border-slate-100 rounded-lg">
              暂无转发规则，点击右上角添加
            </div>
          )}
        </div>
      </div>

      {/* Trigger Keywords */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/50 flex items-center gap-2">
          <ShieldAlert className="w-4 h-4 text-indigo-600" />
          <h2 className="font-semibold text-slate-800">关键词触发（至少命中一个才转发）</h2>
        </div>
        <div className="p-6">
          <div className="flex flex-wrap gap-2 mb-3">
            {activeAccount.blockedKeywords.map((keyword) => (
              <span
                key={keyword}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-red-50 text-red-600 text-sm border border-red-100"
              >
                {keyword}
                <button onClick={() => removeKeyword(keyword)} className="hover:text-red-800">
                  <Trash2 className="w-3 h-3" />
                </button>
              </span>
            ))}
            <input
              type="text"
              className="flex-1 min-w-[120px] px-3 py-1 bg-transparent border-none focus:outline-none text-sm placeholder:text-slate-400"
              placeholder="输入关键词后回车..."
              onKeyDown={addKeyword}
            />
          </div>
          <p className="text-xs text-slate-500">只有包含以上任意关键词的消息才会被转发。留空则转发所有消息。</p>
        </div>
      </div>

      {/* Block Keywords */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/50 flex items-center gap-2">
          <ShieldAlert className="w-4 h-4 text-amber-600" />
          <h2 className="font-semibold text-slate-800">屏蔽关键词（命中则不转发）</h2>
        </div>
        <div className="p-6 space-y-2">
          <div className="flex flex-wrap gap-2 mb-3">
            {activeAccount.excludeKeywords.map((keyword) => (
              <span
                key={keyword}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-amber-50 text-amber-700 text-sm border border-amber-100"
              >
                {keyword}
                <button
                  onClick={() => removeExcludeKeyword(keyword)}
                  className="hover:text-amber-900"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </span>
            ))}
            <input
              type="text"
              className="flex-1 min-w-[120px] px-3 py-1 bg-transparent border-none focus:outline-none text-sm placeholder:text-slate-400"
              placeholder="输入屏蔽词后回车..."
              onKeyDown={addExcludeKeyword}
            />
          </div>
          <p className="text-xs text-slate-500">
            包含以上任意词的消息将直接丢弃，不会转发。
          </p>
        </div>
      </div>

      {/* User Filters */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/50 flex items-center gap-2">
          <ShieldAlert className="w-4 h-4 text-emerald-600" />
          <h2 className="font-semibold text-slate-800">用户过滤（按用户 ID）</h2>
        </div>
        <div className="p-6 space-y-4">
          <div>
            <p className="text-xs font-medium text-slate-700 mb-2">仅转发这些用户 ID（白名单，可选）</p>
            <div className="flex flex-wrap gap-2 mb-2">
              {activeAccount.allowedUsersIds.map((id) => (
                <span
                  key={id}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700 text-xs border border-emerald-100"
                >
                  {id}
                  <button onClick={() => removeAllowedUser(id)} className="hover:text-emerald-900">
                    <Trash2 className="w-3 h-3" />
                  </button>
                </span>
              ))}
              <input
                type="text"
                className="flex-1 min-w-[160px] px-3 py-1 bg-transparent border-none focus:outline-none text-xs placeholder:text-slate-400"
                placeholder="输入用户 ID 后回车..."
                onKeyDown={addAllowedUser}
              />
            </div>
            <p className="text-xs text-slate-500">
              留空表示不限制用户；如填写，则只有这些用户发送的消息才会被转发。
            </p>
          </div>

          <div>
            <p className="text-xs font-medium text-slate-700 mb-2">不转发这些用户 ID（黑名单，可选）</p>
            <div className="flex flex-wrap gap-2 mb-2">
              {activeAccount.mutedUsersIds.map((id) => (
                <span
                  key={id}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-slate-100 text-slate-700 text-xs border border-slate-200"
                >
                  {id}
                  <button onClick={() => removeMutedUser(id)} className="hover:text-slate-900">
                    <Trash2 className="w-3 h-3" />
            </button>
                </span>
              ))}
              <input
                type="text"
                className="flex-1 min-w-[160px] px-3 py-1 bg-transparent border-none focus:outline-none text-xs placeholder:text-slate-400"
                placeholder="输入用户 ID 后回车..."
                onKeyDown={addMutedUser}
              />
            </div>
            <p className="text-xs text-slate-500">这些用户发送的消息将被忽略，不会转发。</p>
          </div>
        </div>
      </div>

      {/* Replacements */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/50 flex items-center gap-2">
          <ShieldAlert className="w-4 h-4 text-sky-600" />
          <h2 className="font-semibold text-slate-800">关键词替换</h2>
        </div>
        <div className="p-6 space-y-3">
          <div className="space-y-2">
            {activeAccount.replacements.map((r, idx) => (
              <div key={idx} className="flex flex-col sm:flex-row gap-2 items-start sm:items-center">
                <input
                  type="text"
                  className="w-full sm:w-40 px-3 py-1.5 bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 text-sm font-mono"
                  placeholder="原词"
                  value={r.from}
                  onChange={(e) => updateReplacement(idx, "from", e.target.value)}
                />
                <span className="hidden sm:inline text-slate-400">→</span>
                <input
                  type="text"
                  className="w-full px-3 py-1.5 bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 text-sm font-mono"
                  placeholder="替换为"
                  value={r.to}
                  onChange={(e) => updateReplacement(idx, "to", e.target.value)}
                />
                <button
                  onClick={() => removeReplacement(idx)}
                  className="mt-1 sm:mt-0 p-2 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-md transition-colors"
                  title="删除该替换规则"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            className="text-xs flex items-center gap-1 bg-slate-50 text-slate-700 px-2 py-1 rounded-md hover:bg-slate-100 transition-colors font-medium"
            onClick={addReplacement}
          >
            <Plus className="w-3 h-3" /> 添加替换规则
          </button>
          <p className="text-xs text-slate-500">
            替换规则在转发前按顺序应用，对整条消息内容生效（包括回复提示行）。
          </p>
        </div>
      </div>
    </div>
  )
}

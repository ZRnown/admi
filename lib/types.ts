export type AccountType = "bot" | "selfbot"

export interface ChannelMapping {
  id: string
  sourceChannelId: string
  targetWebhookUrl: string
  note?: string
}

export interface ReplacementRule {
  from: string
  to: string
}

export interface AccountFormConfig {
  id: string
  name: string
  type: AccountType
  token: string
  proxyUrl: string
  loginRequested: boolean
  loginNonce?: number
  loginState?: string
  loginMessage?: string
  showSourceIdentity: boolean
  mappings: ChannelMapping[]
  blockedKeywords: string[]
  excludeKeywords: string[]
  replacements: ReplacementRule[]
  allowedUsersIds: string[]
  mutedUsersIds: string[]
  /** 前端用来触发"重启账号"的计数器，改动即视为需要重启 */
  restartNonce?: number
  enableTranslation?: boolean
  deepseekApiKey?: string
}

export interface MultiAccountFormState {
  accounts: AccountFormConfig[]
  activeId: string
}

const genId = () => {
  try {
    if (typeof globalThis !== "undefined" && (globalThis as any).crypto?.randomUUID) {
      return (globalThis as any).crypto.randomUUID() as string
    }
  } catch {}
  return `id_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export const createEmptyAccount = (name = "新账号"): AccountFormConfig => ({
  id: genId(),
  name,
  type: "selfbot",
  token: "",
  proxyUrl: "",
  loginRequested: false,
  loginNonce: undefined,
  loginState: "idle",
  loginMessage: "",
  showSourceIdentity: false,
  mappings: [{ id: genId(), sourceChannelId: "", targetWebhookUrl: "", note: "" }],
  blockedKeywords: [],
  excludeKeywords: [],
  replacements: [],
  allowedUsersIds: [],
  mutedUsersIds: [],
  enableTranslation: false,
  deepseekApiKey: "",
})

const defaultAccount = createEmptyAccount("默认账号")

export const DEFAULT_MULTI_ACCOUNT_STATE: MultiAccountFormState = {
  accounts: [defaultAccount],
  activeId: defaultAccount.id,
}

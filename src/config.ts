import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { randomUUID } from "crypto";
import { getEnv } from "./env";

export type ChannelId = number | string;
export type ChatId = ChannelId;

export interface ChannelConfig {
  muted: ChannelId[];
  allowed: ChannelId[];
}

/**
 * 旧版（单账号）配置结构。仅用于向后兼容读取旧的 config.json。
 */
export interface LegacyConfig {
  // 映射：源频道ID -> 目标Webhook URL（一对一）
  channelWebhooks?: Record<string, string>;
  // 每个频道的备注，仅用于管理界面展示
  channelNotes?: Record<string, string>;
  mutedGuildsIds?: ChannelId[];
  allowedGuildsIds?: ChannelId[];
  mutedChannelsIds?: ChannelId[];
  allowedChannelsIds?: ChannelId[];
  allowedUsersIds?: ChannelId[];
  mutedUsersIds?: ChannelId[];
  channelConfigs?: Record<string, ChannelConfig>;
  blockedKeywords?: string[];
  // 需要从内容中“排除”的关键词（会被删除，而不是整条消息屏蔽）
  excludeKeywords?: string[];
  // 是否在目标中伪装为源用户头像和昵称
  showSourceIdentity?: boolean;
  showDate?: boolean;
  showChat?: boolean;
  stackMessages?: boolean;
  showMessageDeletions?: boolean;
  showMessageUpdates?: boolean;
  replacementsDictionary?: Record<string, string>;
  historyScan?: {
    enabled?: boolean;
    limit?: number;
    channels?: string[];
  };
}

export interface AccountConfig extends LegacyConfig {
  id: string;
  name: string;
  /**
   * 账号类型：bot = 机器人 Token，selfbot = 用户（自用号）Token
   */
  type: "bot" | "selfbot";
  token: string;
  proxyUrl?: string;
  restartNonce?: number;
  /**
   * 前端显式点击登录后置为 true；仅 loginRequested=true 的账号会实际登录
   */
  loginRequested?: boolean;
  /**
   * 点击“登录”按钮时递增，用于触发对应账号的重启/重登
   */
  loginNonce?: number;
  loginState?: string;
  loginMessage?: string;
}

export interface MultiConfig {
  accounts: AccountConfig[];
  activeId?: string;
}

function createDefaultAccount(): AccountConfig {
  const env = getEnv();
  return {
    id: randomUUID(),
    name: "默认账号",
    type: "selfbot",
    token: env.DISCORD_TOKEN || "",
    proxyUrl: env.PROXY_URL,
    loginRequested: false,
    loginNonce: undefined,
    loginState: "idle",
    loginMessage: "",
    channelWebhooks: {},
    channelNotes: {},
    blockedKeywords: [],
    excludeKeywords: [],
    showSourceIdentity: false,
    showDate: false,
    showChat: true,
    stackMessages: false,
    showMessageUpdates: false,
    showMessageDeletions: false,
    replacementsDictionary: {},
    historyScan: { enabled: true },
    mutedGuildsIds: [],
    allowedGuildsIds: [],
    mutedChannelsIds: [],
    allowedChannelsIds: [],
    allowedUsersIds: [],
    mutedUsersIds: [],
    channelConfigs: {},
  };
}

// 导出 ensureConfigFile 供程序启动时调用，而不是在每次读取时调用
// 这样可以避免在原子保存间隙时误判文件不存在而覆盖配置
export async function ensureConfigFile() {
  if (!existsSync("./config.json")) {
    const defaultAccount = createDefaultAccount();
    const multi: MultiConfig = { accounts: [defaultAccount], activeId: defaultAccount.id };
    await writeFile("./config.json", JSON.stringify(multi, null, 2) + "\n");
    console.log("Created default config.json");
  }
}

// 修改：readRawConfig 不再负责创建文件
// 如果文件不存在或读取失败，抛出错误让上层处理（可能是在原子保存间隙，需要重试）
async function readRawConfig(): Promise<any> {
  // 删除 await ensureConfigFile(); 
  // 绝对不要在读取时创建文件，这会导致在原子保存间隙时覆盖用户配置
  
  try {
    const buf = await readFile("./config.json");
    return JSON.parse(buf.toString());
  } catch (e) {
    // 如果读取失败（例如文件正在写入中），抛出错误让上层处理
    // 上层应该进行重试，而不是在这里写入默认配置
    throw e;
  }
}

function normalizeAccount(input: any, fallbackName = "未命名账号"): AccountConfig {
  const id = typeof input?.id === "string" && input.id.length > 0 ? input.id : randomUUID();
  const name = typeof input?.name === "string" && input.name.trim() ? input.name.trim() : fallbackName;
  const type: "bot" | "selfbot" = input?.type === "bot" ? "bot" : "selfbot";
  const token = typeof input?.token === "string" ? input.token : "";
  const proxyUrl = typeof input?.proxyUrl === "string" && input.proxyUrl.trim() ? input.proxyUrl.trim() : undefined;
  const replacementsDict: Record<string, string> =
    input?.replacementsDictionary && typeof input.replacementsDictionary === "object"
      ? input.replacementsDictionary
      : {};

  return {
    id,
    name,
    type,
    token,
    proxyUrl,
    loginRequested: input?.loginRequested === true,
    loginNonce: typeof input?.loginNonce === "number" ? input.loginNonce : undefined,
    loginState: typeof input?.loginState === "string" ? input.loginState : "idle",
    loginMessage: typeof input?.loginMessage === "string" ? input.loginMessage : "",
    channelWebhooks: input?.channelWebhooks || {},
    channelNotes: input?.channelNotes || {},
    blockedKeywords: Array.isArray(input?.blockedKeywords) ? input.blockedKeywords : [],
    excludeKeywords: Array.isArray(input?.excludeKeywords) ? input.excludeKeywords : [],
    showSourceIdentity: input?.showSourceIdentity === true,
    showDate: input?.showDate,
    showChat: input?.showChat ?? true,
    stackMessages: input?.stackMessages,
    showMessageDeletions: input?.showMessageDeletions,
    showMessageUpdates: input?.showMessageUpdates,
    replacementsDictionary: replacementsDict,
    historyScan: input?.historyScan,
    mutedGuildsIds: input?.mutedGuildsIds || [],
    allowedGuildsIds: input?.allowedGuildsIds || [],
    mutedChannelsIds: input?.mutedChannelsIds || [],
    allowedChannelsIds: input?.allowedChannelsIds || [],
    allowedUsersIds: input?.allowedUsersIds || [],
    mutedUsersIds: input?.mutedUsersIds || [],
    channelConfigs: input?.channelConfigs || {},
  };
}

function migrateLegacyToMulti(raw: any): MultiConfig {
  const legacy = raw as LegacyConfig;
  const account = normalizeAccount({ ...legacy, token: getEnv().DISCORD_TOKEN || "" }, "默认账号");
  return { accounts: [account], activeId: account.id };
}

export async function getMultiConfig(): Promise<MultiConfig> {
  const raw = await readRawConfig();
  if (Array.isArray(raw?.accounts)) {
    const accounts = raw.accounts.map((acc: any, idx: number) =>
      normalizeAccount(acc, idx === 0 ? "默认账号" : `账号${idx + 1}`),
    );
    const active = typeof raw.activeId === "string" ? raw.activeId : accounts[0]?.id;
    return { accounts, activeId: active };
  }
  return migrateLegacyToMulti(raw);
}

export async function saveMultiConfig(config: MultiConfig) {
  await writeFile("./config.json", JSON.stringify(config, null, 2) + "\n");
}

export type Config = LegacyConfig;

export function accountToLegacyConfig(account?: AccountConfig): LegacyConfig {
  if (!account) {
    return {
      channelWebhooks: {},
      channelNotes: {},
      blockedKeywords: [],
      excludeKeywords: [],
      showSourceIdentity: false,
      replacementsDictionary: {},
      historyScan: { enabled: true },
      mutedGuildsIds: [],
      allowedGuildsIds: [],
      mutedChannelsIds: [],
      allowedChannelsIds: [],
      allowedUsersIds: [],
      mutedUsersIds: [],
      channelConfigs: {},
      showChat: true,
      stackMessages: false,
      showMessageUpdates: false,
      showMessageDeletions: false,
      showDate: false,
    };
  }
  return {
    channelWebhooks: account.channelWebhooks,
    channelNotes: account.channelNotes,
    blockedKeywords: account.blockedKeywords,
    excludeKeywords: account.excludeKeywords,
    showSourceIdentity: account.showSourceIdentity,
    showDate: account.showDate,
    showChat: account.showChat,
    stackMessages: account.stackMessages,
    showMessageDeletions: account.showMessageDeletions,
    showMessageUpdates: account.showMessageUpdates,
    replacementsDictionary: account.replacementsDictionary,
    historyScan: account.historyScan,
    mutedGuildsIds: account.mutedGuildsIds,
    allowedGuildsIds: account.allowedGuildsIds,
    mutedChannelsIds: account.mutedChannelsIds,
    allowedChannelsIds: account.allowedChannelsIds,
    allowedUsersIds: account.allowedUsersIds,
    mutedUsersIds: account.mutedUsersIds,
    channelConfigs: account.channelConfigs,
  };
}

export async function getConfig(): Promise<LegacyConfig> {
  const multi = await getMultiConfig();
  return accountToLegacyConfig(multi.accounts[0]);
}


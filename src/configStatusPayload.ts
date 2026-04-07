import type { MultiConfig } from "./config";

type TelegramStatusEntry = {
  state?: string;
  message?: string;
  userInfo?: any;
};

type DiscordLibraryStatusEntry = {
  loginEnabled?: boolean;
  loginState?: string;
  loginMessage?: string;
  syncedUser?: any;
  guildsCount?: number;
  channelsCount?: number;
  lastSyncTime?: string;
};

type ExternalRuleStatus = {
  lastPollAt?: number;
  lastSuccessAt?: number;
  lastForwardAt?: number;
  lastError?: string;
  lastErrorAt?: number;
  lastItemId?: string;
};

type ExternalForwardStatusMap = {
  x?: Record<string, Record<string, ExternalRuleStatus>>;
  truthsocial?: Record<string, Record<string, ExternalRuleStatus>>;
};

type RuntimeRelayStatus = {
  id?: string;
  loginState?: string;
  loginMessage?: string;
};

type RuntimeStatusEntry = {
  loginRequested?: boolean;
  loginState?: string;
  loginMessage?: string;
  telegramBotState?: string;
  telegramBotMessage?: string;
  telegramClientState?: string;
  telegramClientMessage?: string;
  botRelays?: RuntimeRelayStatus[];
};

type BuildConfigStatusPayloadArgs = {
  config: MultiConfig;
  runtimeStatusByAccountId?: Record<string, RuntimeStatusEntry>;
  discordLibraryStatusById?: Record<string, DiscordLibraryStatusEntry>;
  telegramStatusById?: Record<string, TelegramStatusEntry>;
  externalForwardStatusByKind?: ExternalForwardStatusMap;
};

function normalizeTelegramState(state?: string): string {
  const value = String(state || "").toLowerCase();
  if (value === "connected" || value === "online") return "online";
  if (value === "connecting" || value === "pending") return "pending";
  if (value === "disconnected" || value === "idle") return "idle";
  if (value === "error") return "error";
  return state || "idle";
}

function normalizeDiscordState(state?: string): string {
  if (!state) return "idle";
  if (String(state).toLowerCase() === "stopped") return "idle";
  return state;
}

function normalizeTelegramMessage(state: string, message?: string): string {
  const trimmed = typeof message === "string" ? message.trim() : "";
  if (trimmed) return trimmed;
  if (state === "online") return "已连接";
  if (state === "pending") return "连接中";
  if (state === "error") return "连接异常";
  return "未连接";
}

function resolveTelegramAccountStatuses(
  account: any,
  telegramStatusById: Record<string, TelegramStatusEntry>,
  telegramLibraryById: Map<string, any>,
) {
  const selectedIds = [account.telegramListenerAccountId, account.telegramSenderAccountId].filter(
    (id, idx, arr): id is string => !!id && arr.indexOf(id) === idx,
  );
  const selectedAccounts = selectedIds
    .map((id) => telegramLibraryById.get(id))
    .filter((item) => !!item);

  const telegramAccounts =
    selectedAccounts.length > 0 ? selectedAccounts : account.telegramConfig?.accounts || [];
  const activeAccounts = telegramAccounts.filter((acc: any) => acc.enabled !== false);

  const botAccount = activeAccounts.find((acc: any) => acc.type === "bot") || null;
  const clientAccount = activeAccounts.find((acc: any) => acc.type === "client") || null;

  const hasExplicitBot = telegramAccounts.some((acc: any) => acc.type === "bot");
  const hasExplicitClient = telegramAccounts.some((acc: any) => acc.type === "client");
  const hasLegacyBotConfig = Boolean(account.telegramBotToken);
  const hasLegacyClientConfig = Boolean(
    (account.telegramSessionPath || account.telegramSessionString) &&
      account.telegramApiId &&
      account.telegramApiHash,
  );

  const botAccountId =
    botAccount?.id || (!hasExplicitBot && hasLegacyBotConfig ? `${account.id}_bot` : undefined);
  const clientAccountId =
    clientAccount?.id || (!hasExplicitClient && hasLegacyClientConfig ? account.id : undefined);

  let botStatus = botAccountId ? telegramStatusById[botAccountId] : undefined;
  let clientStatus = clientAccountId ? telegramStatusById[clientAccountId] : undefined;

  if (clientStatus?.userInfo?.username?.toLowerCase().endsWith("bot")) {
    if (!botStatus) {
      botStatus = clientStatus;
    }
    clientStatus = undefined;
  }

  return {
    botStatus,
    clientStatus,
  };
}

function buildTelegramAccountStates(
  account: any,
  telegramStatusById: Record<string, TelegramStatusEntry>,
  telegramLibraryById: Map<string, any>,
) {
  const result: Record<string, { state?: string; message?: string; userInfo?: any }> = {};
  const selectedIds = [account.telegramListenerAccountId, account.telegramSenderAccountId].filter(
    (id, idx, arr): id is string => !!id && arr.indexOf(id) === idx,
  );
  const selectedAccounts = selectedIds
    .map((id) => telegramLibraryById.get(id))
    .filter((item) => !!item);
  const accounts =
    selectedAccounts.length > 0 ? selectedAccounts : account.telegramConfig?.accounts || [];

  for (const item of accounts) {
    if (!item?.id) continue;
    if (item.enabled === false) {
      result[item.id] = {
        state: "idle",
        message: "未连接",
      };
      continue;
    }
    const status = telegramStatusById[item.id];
    const normalizedState = normalizeTelegramState(status?.state);
    result[item.id] = {
      state: normalizedState,
      message: normalizeTelegramMessage(normalizedState, status?.message),
      userInfo: status?.userInfo,
    };
  }
  return result;
}

function buildRelayStatuses(account: any, runtimeStatus: RuntimeStatusEntry | undefined) {
  const runtimeRelayMap = new Map<string, RuntimeRelayStatus>();
  if (Array.isArray(runtimeStatus?.botRelays)) {
    runtimeStatus.botRelays.forEach((relay) => {
      if (relay?.id) {
        runtimeRelayMap.set(relay.id, relay);
      }
    });
  }

  return (account.botRelays || []).map((relay: any) => {
    const runtimeRelay = relay?.id ? runtimeRelayMap.get(relay.id) : undefined;
    return {
      id: relay.id,
      loginState: normalizeDiscordState(runtimeRelay?.loginState || relay?.loginState),
      loginMessage:
        typeof runtimeRelay?.loginMessage === "string"
          ? runtimeRelay.loginMessage
          : typeof relay?.loginMessage === "string"
            ? relay.loginMessage
            : "",
    };
  });
}

export function buildConfigStatusPayload({
  config,
  runtimeStatusByAccountId = {},
  discordLibraryStatusById = {},
  telegramStatusById = {},
  externalForwardStatusByKind = {},
}: BuildConfigStatusPayloadArgs) {
  const telegramLibrary = Array.isArray(config.telegramAccounts) ? config.telegramAccounts : [];
  const telegramLibraryById = new Map(telegramLibrary.map((acc) => [acc.id, acc]));
  const discordLibrary = Array.isArray(config.discordAccounts) ? config.discordAccounts : [];

  return {
    accounts: (config.accounts || []).map((account: any) => {
      const runtimeStatus = runtimeStatusByAccountId[account.id] || {};
      const normalizedLoginState = normalizeDiscordState(
        typeof runtimeStatus.loginState === "string" ? runtimeStatus.loginState : account.loginState,
      );
      const { botStatus, clientStatus } = resolveTelegramAccountStatuses(
        account,
        telegramStatusById,
        telegramLibraryById,
      );
      const botState = normalizeTelegramState(botStatus?.state);
      const clientState = normalizeTelegramState(clientStatus?.state);

      return {
        id: account.id,
        forwardingType: account.forwardingType || "telegram-to-telegram",
        loginRequested:
          typeof runtimeStatus.loginRequested === "boolean"
            ? runtimeStatus.loginRequested
            : account.loginRequested === true,
        loginState: normalizedLoginState,
        loginMessage:
          typeof runtimeStatus.loginMessage === "string"
            ? runtimeStatus.loginMessage
            : account.loginMessage || "",
        telegramBotState: botState,
        telegramBotMessage: normalizeTelegramMessage(botState, botStatus?.message),
        telegramClientState: clientState,
        telegramClientMessage: normalizeTelegramMessage(clientState, clientStatus?.message),
        telegramAccountStates: buildTelegramAccountStates(
          account,
          telegramStatusById,
          telegramLibraryById,
        ),
        botRelays: buildRelayStatuses(account, runtimeStatus),
        telegramConfig: account.telegramConfig
          ? {
              accounts: Array.isArray(account.telegramConfig.accounts)
                ? account.telegramConfig.accounts.map((item: any) => ({
                    id: item.id,
                    enabled: item.enabled,
                  }))
                : [],
            }
          : undefined,
        externalForwardStatus: {
          x: externalForwardStatusByKind?.x?.[account.id],
          truthsocial: externalForwardStatusByKind?.truthsocial?.[account.id],
        },
      };
    }),
    discordAccounts: discordLibrary.map((account: any) => {
      const statusEntry = discordLibraryStatusById[account.id] || {};
      return {
        id: account.id,
        name: account.name || "",
        loginEnabled:
          typeof statusEntry.loginEnabled === "boolean" ? statusEntry.loginEnabled : account.loginEnabled,
        loginState: normalizeDiscordState(statusEntry.loginState),
        loginMessage:
          typeof statusEntry.loginMessage === "string" ? statusEntry.loginMessage : undefined,
        syncedUser: statusEntry.syncedUser,
        guildsCount:
          typeof statusEntry.guildsCount === "number" ? statusEntry.guildsCount : account.guildsCount,
        channelsCount:
          typeof statusEntry.channelsCount === "number"
            ? statusEntry.channelsCount
            : account.channelsCount,
        lastSyncTime:
          typeof statusEntry.lastSyncTime === "string" ? statusEntry.lastSyncTime : account.lastSyncTime,
      };
    }),
    telegramAccounts: telegramLibrary.map((account: any) => {
      const statusEntry = telegramStatusById[account.id];
      const normalizedState = normalizeTelegramState(statusEntry?.state);
      return {
        id: account.id,
        name: account.name || "",
        enabled: account.enabled,
        loginState: normalizedState,
        loginMessage: normalizeTelegramMessage(normalizedState, statusEntry?.message),
        userInfo: statusEntry?.userInfo,
      };
    }),
  };
}

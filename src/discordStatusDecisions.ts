export function normalizeDiscordLoginErrorMessage(error?: string): string {
  const msg = typeof error === "string" ? error.trim() : "";
  if (!msg) return "";
  if (msg.includes("Improper token")) {
    return "";
  }
  if (msg.includes("DISCORD_LOGIN_TIMEOUT")) {
    return "登录超时，可能被风控或网络受限";
  }
  if (msg.includes("Request to use mfa")) {
    return "账号开启 MFA，请填写谷歌验证密钥";
  }
  return msg;
}

export function getDiscordErrorMessage(error?: string): string {
  return normalizeDiscordLoginErrorMessage(error) || "连接失败";
}

export function getDiscordDisconnectMessage(error?: string): string {
  return normalizeDiscordLoginErrorMessage(error) || "连接已断开";
}

export function shouldPreserveLibraryOnlineStatus(input: {
  metadataState?: string;
  dependentInstanceState?: string;
}): boolean {
  const metadataState = String(input.metadataState || "").toLowerCase();
  const dependentInstanceState = String(input.dependentInstanceState || "").toLowerCase();
  if (dependentInstanceState !== "online") {
    return false;
  }
  return metadataState === "disconnected" || metadataState === "idle";
}

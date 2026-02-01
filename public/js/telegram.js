/**
 * Telegram 相关功能模块
 */

// 确保 Telegram 配置存在
function ensureTelegramConfig(acc) {
  if (!acc.telegramConfig) {
    acc.telegramConfig = { accounts: [], mappings: [], enableTelegramForward: true };
  }
  if (!acc.telegramConfig.accounts) acc.telegramConfig.accounts = [];
  if (!acc.telegramConfig.mappings) acc.telegramConfig.mappings = [];
  if (acc.telegramConfig.enableTelegramForward === undefined) {
    acc.telegramConfig.enableTelegramForward = acc.enableForwarding !== false;
  }
}

// 获取 Telegram 角色账号 ID
function getTelegramRoleAccountId(acc, role, type) {
  return `${acc.id}_tg_${role}_${type}`;
}

// 获取 Telegram 角色账号
function getTelegramRoleAccount(acc, role, type) {
  if (!acc.telegramConfig || !Array.isArray(acc.telegramConfig.accounts)) return null;
  const accountId = getTelegramRoleAccountId(acc, role, type);
  return acc.telegramConfig.accounts.find(entry => entry.id === accountId) || null;
}

// 确保 Telegram 角色账号存在
function ensureTelegramRoleAccount(acc, role, type) {
  ensureTelegramConfig(acc);
  const accountId = getTelegramRoleAccountId(acc, role, type);
  let entry = acc.telegramConfig.accounts.find(item => item.id === accountId);
  if (!entry) {
    entry = {
      id: accountId,
      name: role === 'listener' ? 'Telegram 监听账号' : 'Telegram 发送账号',
      type,
      token: '',
      enabled: false,
      role
    };
    acc.telegramConfig.accounts.push(entry);
  }
  entry.role = role;
  entry.type = type;
  if (!entry.sessionType) {
    entry.sessionType = acc.sessionType || 'file';
  }
  return entry;
}

// 禁用其他类型的 Telegram 角色账号
function disableTelegramRoleAccounts(acc, role, keepType) {
  if (!acc.telegramConfig || !Array.isArray(acc.telegramConfig.accounts)) return;
  acc.telegramConfig.accounts.forEach((entry) => {
    if (entry.role !== role) return;
    if (entry.type === keepType) return;
    entry.enabled = false;
  });
}

// 检查 Telegram 转发是否启用
function isTelegramForwardEnabled(acc) {
  if (!acc.telegramConfig) return acc.enableForwarding !== false;
  if (acc.telegramConfig.enableTelegramForward === undefined) {
    return acc.enableForwarding !== false;
  }
  return acc.telegramConfig.enableTelegramForward !== false;
}

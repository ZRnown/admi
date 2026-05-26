/**
 * 账号库管理模块
 * 处理 Discord 和 Telegram 账号库的管理
 */

// ==================== 账号库标签函数 ====================

function getDiscordLibraryLabel(item) {
  if (!item) return '未命名账号';
  const typeLabel = item.type === 'bot' ? '机器人' : '用户';
  return `${item.name || 'Discord账号'} (${typeLabel})`;
}

function getTelegramLibraryLabel(item) {
  if (!item) return '未命名账号';
  const typeLabel = item.type === 'bot' ? 'Bot' : 'Client';
  return `${item.name || 'Telegram账号'} [${typeLabel}]`;
}

function getTruthLibraryLabel(item) {
  return item?.name || 'TruthSocial账号';
}

// ==================== 账号库选项函数 ====================

function getDiscordLibraryOptions(selectedId, skipEmpty = false) {
  const options = skipEmpty ? [] : [`<option value="">请选择账号</option>`];
  (state.discordAccounts || []).forEach((item) => {
    if (!item?.id) return;
    options.push(
      `<option value="${item.id}" ${item.id === selectedId ? 'selected' : ''}>${escapeHtml(getDiscordLibraryLabel(item))}</option>`
    );
  });
  return options.join('');
}

function getTelegramLibraryOptions(selectedId, filterType) {
  const options = [`<option value="">请选择账号</option>`];
  (state.telegramAccounts || []).forEach((item) => {
    if (!item?.id) return;
    if (filterType && item.type !== filterType) return;
    options.push(
      `<option value="${item.id}" ${item.id === selectedId ? 'selected' : ''}>${escapeHtml(getTelegramLibraryLabel(item))}</option>`
    );
  });
  return options.join('');
}

function getTruthLibraryOptions(selectedId) {
  const options = [`<option value="">未选择</option>`];
  (state.truthSocialAccounts || []).forEach((item) => {
    if (!item?.id) return;
    options.push(
      `<option value="${item.id}" ${item.id === selectedId ? 'selected' : ''}>${escapeHtml(getTruthLibraryLabel(item))}</option>`
    );
  });
  return options.join('');
}

// ==================== 账号库查询函数 ====================

function getTelegramLibraryAccountById(accountId) {
  return (state.telegramAccounts || []).find((item) => item.id === accountId);
}

function getTelegramLibraryAccountTypeById(accountId) {
  const account = getTelegramLibraryAccountById(accountId);
  if (!account) return null;
  return account.type === 'bot' || account.type === 'client' ? account.type : null;
}

function getSelectedTelegramAccountType(acc, role) {
  if (!acc) return null;
  const selectedId = role === 'listener' ? acc.telegramListenerAccountId : acc.telegramSenderAccountId;
  if (!selectedId) return null;
  return getTelegramLibraryAccountTypeById(selectedId);
}

function hasTelegramLibrarySelection(acc) {
  return Boolean(getSelectedTelegramAccountType(acc, 'listener') || getSelectedTelegramAccountType(acc, 'sender'));
}

function getTelegramLibraryStatus(accountId) {
  const account = getTelegramLibraryAccountById(accountId);
  const stateValue = account?.loginState || 'idle';
  const message = account?.loginMessage || '';
  return { state: stateValue, message };
}

/**
 * 主渲染逻辑模块
 */

// 渲染主界面
function render() {
  const acc = getActiveAccount();
  if (!acc) return;

  const forwardingType = acc.forwardingType || 'discord-to-discord';
  currentForwardingType = forwardingType;

  // 渲染账号标签页
  renderAccountTabs();

  // 渲染主配置表单
  renderConfigForm(acc, forwardingType);
}

// 渲染账号标签页
function renderAccountTabs() {
  const container = document.getElementById('instanceTabs');
  if (!container) return;

  container.innerHTML = state.accounts.map(acc => {
    const isActive = acc.id === state.activeId;
    const summary = buildAccountCardSummary(acc);
    return `
      <button onclick="switchAccount('${acc.id}')"
        class="px-4 py-2 rounded-lg text-sm font-medium transition-colors ${isActive ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}">
        <span>${escapeHtml(acc.name || '未命名实例')}</span>
        <span id="account-tab-status-${acc.id}" class="ml-2 px-2 py-0.5 rounded-full text-xs ${getBadgeClass(summary.state)}">${summary.badgeLabel}</span>
      </button>
    `;
  }).join('');
}

// 切换账号
function switchAccount(accountId) {
  state.activeId = accountId;
  saveConfig();
  render();
}

// 更新账号卡片状态
function updateAccountCardStatus(acc) {
  const summary = buildAccountCardSummary(acc);
  const badgeEl = document.getElementById(`account-tab-status-${acc.id}`);
  if (badgeEl) {
    badgeEl.textContent = summary.badgeLabel;
    badgeEl.className = `ml-2 px-2 py-0.5 rounded-full text-xs ${getBadgeClass(summary.state)}`;
  }
}

// 构建账号卡片摘要
function buildAccountCardSummary(acc) {
  const state = acc.loginState || 'idle';
  const labels = {
    'idle': '已停止',
    'pending': '启动中',
    'connecting': '连接中',
    'online': '运行中',
    'error': '错误'
  };
  return {
    state,
    badgeLabel: labels[state] || state
  };
}

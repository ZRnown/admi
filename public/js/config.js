/**
 * 配置管理模块
 * 处理配置的加载、保存、导入导出
 */

// 加载配置
async function loadConfig() {
  try {
    const res = await fetch('/api/config?includeSecrets=1');
    if (res.status === 401) {
      handleUnauthorized();
      throw new Error('unauthorized');
    }
    if (!res.ok) {
      console.error('加载配置失败: HTTP', res.status);
      return;
    }
    const data = await res.json();
    if (Array.isArray(data?.accounts)) {
      state = {
        accounts: data.accounts,
        activeId: data.activeId || data.accounts[0]?.id || "",
        loginUser: data.loginUser || "",
        loginPassword: data.loginPassword || "",
        telegramAvatarBaseUrl: data.telegramAvatarBaseUrl || "",
        enabledForwardingTypes: data.enabledForwardingTypes || null,
        discordAccounts: Array.isArray(data.discordAccounts) ? data.discordAccounts : [],
        telegramAccounts: Array.isArray(data.telegramAccounts) ? data.telegramAccounts : [],
        truthSocialAccounts: Array.isArray(data.truthSocialAccounts) ? data.truthSocialAccounts : [],
      };
    } else {
      console.warn('配置数据格式不正确:', data);
    }
  } catch (e) {
    console.error('加载配置失败', e);
    throw e;
  }
}

// 立即保存配置（无防抖，用于关键字段更新）
async function saveConfigImmediate() {
  if (suspendAutoSave) return;
  isSaving = true;
  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state)
    });
    if (res.status === 401) {
      handleUnauthorized();
      return;
    }
    if (!res.ok) {
      throw new Error(`保存失败: HTTP ${res.status}`);
    }
  } catch (e) {
    console.error('立即保存失败', e);
    alert('保存失败: ' + (e.message || e));
    throw e;
  } finally {
    isSaving = false;
  }
}

// 保存配置（防抖）
async function saveConfig() {
  if (suspendAutoSave) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    if (suspendAutoSave) return;
    try {
      await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state)
      }).then((res) => {
        if (res.status === 401) {
          handleUnauthorized();
        }
      });
    } catch (e) {
      console.error('保存失败', e);
    }
  }, 800);
}

// 导出配置
async function exportConfig() {
  try {
    const res = await fetch('/api/config?includeSecrets=1');
    if (res.status === 401) {
      handleUnauthorized();
      return;
    }
    const data = await res.json();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `转发狗-config-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    alert('导出失败: ' + e.message);
  }
}

// 触发导入配置
function importConfig() {
  document.getElementById('importConfigFile').click();
}

// 处理导入配置
async function handleImportConfig(event) {
  const file = event.target.files[0];
  if (!file) return;
  const prevSuspend = suspendAutoSave;
  suspendAutoSave = true;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  let reloadScheduled = false;

  try {
    const text = await file.text();
    const importedConfig = JSON.parse(text);

    if (!importedConfig.accounts || !Array.isArray(importedConfig.accounts)) {
      alert('配置文件格式错误：缺少 accounts 数组');
      return;
    }

    if (!confirm('确定要导入配置吗？这将覆盖当前所有配置。')) {
      return;
    }

    const res = await fetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(importedConfig)
    });

    if (res.status === 401) {
      handleUnauthorized();
      return;
    }

    if (!res.ok) {
      const errData = await res.json();
      throw new Error(errData.error || '导入失败');
    }

    alert('配置导入成功！页面将刷新。');
    reloadScheduled = true;
    location.reload();
  } catch (e) {
    alert('导入失败: ' + e.message);
  } finally {
    if (!reloadScheduled) {
      suspendAutoSave = prevSuspend;
    }
    event.target.value = '';
  }
}

/**
 * 认证模块
 * 处理登录、登出、密码管理
 */

// 检查登录状态
async function checkLoginStatus() {
  let authed = false;
  try {
    const res = await fetch('/api/auth/status');
    if (res.ok) {
      const data = await res.json();
      authed = data.authenticated === true;
    }
  } catch (e) {
    authed = false;
  }
  setLoginStatus(authed);
  return authed;
}

// 设置登录状态
function setLoginStatus(loggedIn) {
  isLoggedIn = loggedIn;
  localStorage.setItem('isLoggedIn', loggedIn ? 'true' : 'false');
}

// 显示登录页面
function showLoginPage(message) {
  document.getElementById('loginPage').style.display = 'block';
  document.getElementById('mainPage').style.display = 'none';
  document.getElementById('app').style.display = 'none';
  const errorEl = document.getElementById('loginError');
  if (message) {
    errorEl.textContent = message;
    errorEl.classList.remove('hidden');
  } else {
    errorEl.classList.add('hidden');
  }
}

// 处理未授权
function handleUnauthorized(message) {
  setLoginStatus(false);
  showLoginPage(message || '登录已失效，请重新登录');
}

// 处理登录
async function handleLogin() {
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value.trim();
  const errorEl = document.getElementById('loginError');

  if (!username || !password) {
    errorEl.textContent = '请输入用户名和密码';
    errorEl.classList.remove('hidden');
    return;
  }

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) {
      errorEl.textContent = data?.error || '用户名或密码错误';
      errorEl.classList.remove('hidden');
      return;
    }
    setLoginStatus(true);
    errorEl.classList.add('hidden');
    // 重新初始化以显示主页面
    await init();
  } catch (e) {
    console.error('登录失败', e);
    errorEl.textContent = '登录失败，请重试';
    errorEl.classList.remove('hidden');
  }
}

// 处理退出登录
async function handleLogout() {
  if (confirm('确定要退出登录吗？')) {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch (e) {
      console.warn('登出请求失败', e);
    }
    setLoginStatus(false);
    document.getElementById('loginUsername').value = '';
    document.getElementById('loginPassword').value = '';
    showLoginPage();
  }
}

// 显示修改密码弹窗
function showChangePasswordModal() {
  const modal = document.getElementById('changePasswordModal');
  if (modal) {
    modal.classList.remove('hidden');
    document.getElementById('newUsername').value = state.loginUser || '';
    document.getElementById('newPassword').value = '';
    document.getElementById('confirmPassword').value = '';
    document.getElementById('passwordError').classList.add('hidden');
  }
}

// 关闭修改密码弹窗
function closeChangePasswordModal() {
  const modal = document.getElementById('changePasswordModal');
  if (modal) {
    modal.classList.add('hidden');
  }
}

// 保存新密码
async function saveNewPassword() {
  const newUsername = document.getElementById('newUsername').value.trim();
  const newPassword = document.getElementById('newPassword').value.trim();
  const confirmPassword = document.getElementById('confirmPassword').value.trim();
  const errorEl = document.getElementById('passwordError');

  if (!newUsername) {
    errorEl.textContent = '用户名不能为空';
    errorEl.classList.remove('hidden');
    return;
  }

  if (newPassword && newPassword !== confirmPassword) {
    errorEl.textContent = '两次输入的密码不一致';
    errorEl.classList.remove('hidden');
    return;
  }

  // 更新配置
  state.loginUser = newUsername;
  if (newPassword) {
    state.loginPassword = newPassword;
  }

  try {
    const saveData = {
      accounts: state.accounts,
      activeId: state.activeId,
      loginUser: state.loginUser,
      telegramAvatarBaseUrl: state.telegramAvatarBaseUrl,
      discordAccounts: state.discordAccounts,
      telegramAccounts: state.telegramAccounts,
      xAccounts: state.xAccounts,
      truthSocialAccounts: state.truthSocialAccounts,
      enabledForwardingTypes: state.enabledForwardingTypes
    };

    if (newPassword) {
      saveData.loginPassword = state.loginPassword;
    } else {
      const res = await fetch('/api/config');
      if (res.status === 401) {
        handleUnauthorized();
        return;
      }
      const data = await res.json();
      saveData.loginPassword = data.loginPassword || state.loginPassword;
    }

    const saveRes = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(saveData)
    });
    if (saveRes.status === 401) {
      handleUnauthorized();
      return;
    }
    errorEl.classList.add('hidden');
    closeChangePasswordModal();
    if (newPassword) {
      alert('账密修改成功！请使用新账密重新登录。');
      handleLogout();
    } else {
      alert('用户名修改成功！');
      await loadConfig();
    }
  } catch (e) {
    console.error('保存失败', e);
    errorEl.textContent = '保存失败，请重试';
    errorEl.classList.remove('hidden');
  }
}

// 绑定到 window 以供 HTML 内联事件使用
window.handleLogin = handleLogin;
window.handleLogout = handleLogout;

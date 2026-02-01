/**
 * 主入口和状态管理模块
 */

// 全局状态
const state = {
  accounts: [],
  activeId: '',
  loginUser: 'admin',
  telegramAvatarBaseUrl: '',
  discordAccounts: [],
  telegramAccounts: [],
  xAccounts: [],
  truthSocialAccounts: [],
  enabledForwardingTypes: null
};

// 缓存和计时器
const watermarkPreviewCache = new Map();
const watermarkPreviewRaf = new Map();
const watermarkPreviewSizes = {};
let saveTimer = null;
let isLoggedIn = false;
let isSaving = false;
let suspendAutoSave = false;
let pendingStatusRender = false;
let lastFormInteractionAt = 0;
let currentForwardingType = 'discord-to-discord';

// 分页状态
const pagination = {
  botRelayPage: 1,
  pageSize: 5
};

// 断开连接保持状态
const disconnectHold = {};

function setDisconnectHold(key, duration) {
  disconnectHold[key] = Date.now() + (duration || 5000);
}

function getDisconnectHold(key) {
  return disconnectHold[key] || 0;
}

function clearDisconnectHold(key) {
  delete disconnectHold[key];
}

// 表单交互检测
function isFormElementActive() {
  const el = document.activeElement;
  return isFormTarget(el);
}

function markFormInteraction() {
  lastFormInteractionAt = Date.now();
}

// 获取当前活动账号
function getActiveAccount() {
  return state.accounts.find(a => a.id === state.activeId) || state.accounts[0];
}

// 初始化函数
async function init() {
  const authed = await checkLoginStatus();
  if (!authed) {
    showLoginPage();
    return;
  }
  document.getElementById('loginPage').style.display = 'none';
  document.getElementById('mainPage').style.display = 'block';
  document.getElementById('app').style.display = 'block';
  await loadConfig();
  startStatusPolling();
}

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', init);

/**
 * 工具函数模块
 * 包含通用的辅助函数
 */

// 兼容的 ID 生成函数
function genId() {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    if (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.randomUUID) {
      return globalThis.crypto.randomUUID();
    }
  } catch (e) {
    // 降级方案
  }
  // 降级：使用时间戳 + 随机数
  return `id_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// HTML 转义函数，防止 XSS
function escapeHtml(str) {
  if (typeof str !== 'string') return String(str);
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// 格式化关键词标签
function formatKeywordLabel(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const parts = raw.split(/[，,&＆]/).map((part) => part.trim()).filter(Boolean);
  if (parts.length <= 1) return escapeHtml(raw);
  return escapeHtml(parts.join('&'));
}

// 格式化时间
function formatTime(value) {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString('zh-CN', { hour12: false });
  } catch (e) {
    return '—';
  }
}

// 状态标签映射
const statusLabelMap = {
  online: '已连接',
  idle: '未连接',
  pending: '连接中',
  connecting: '连接中',
  disconnecting: '断开中',
  error: '异常'
};

// 获取状态标签
function getStatusLabel(state) {
  if (!state) return statusLabelMap.idle;
  return statusLabelMap[state] || state;
}

// 获取徽章样式类
function getBadgeClass(state) {
  const normalized = state || 'idle';
  const badgeState = normalized === 'disconnecting' ? 'pending' : normalized;
  if (badgeState === 'online') return 'bg-emerald-50 text-emerald-700';
  if (badgeState === 'error') return 'bg-red-50 text-red-700';
  if (badgeState === 'pending' || badgeState === 'connecting') return 'bg-amber-50 text-amber-700';
  return 'bg-slate-100 text-slate-600';
}

// 获取转发类型标签
function getForwardingTypeLabel(type) {
  const value = type || 'discord-to-discord';
  switch (value) {
    case 'discord-to-discord':
      return 'Discord → Discord';
    case 'discord-to-telegram':
      return 'Discord → Telegram';
    case 'telegram-to-discord':
      return 'Telegram → Discord';
    case 'telegram-to-telegram':
      return 'Telegram → Telegram';
    case 'discord-to-feishu':
      return 'Discord → 飞书';
    case 'discord-to-safew':
      return 'Discord → SafeW';
    case 'x-to-discord':
      return 'X → Discord';
    case 'truthsocial-to-discord':
      return 'TruthSocial → Discord';
    default:
      return value;
  }
}

// 实例状态徽章样式
function getInstanceStatusBadgeClass(acc) {
  const state = acc?.loginState || 'idle';
  if (state === 'online') return 'bg-emerald-50 text-emerald-700';
  if (state === 'error') return 'bg-red-50 text-red-700';
  if (state === 'pending' || state === 'connecting') return 'bg-amber-50 text-amber-700';
  return 'bg-slate-100 text-slate-600';
}

// 实例状态标签
function getInstanceStatusLabel(acc) {
  const state = acc?.loginState || 'idle';
  const labels = {
    'idle': '已停止',
    'pending': '启动中...',
    'connecting': '连接中...',
    'online': '运行中',
    'error': '错误'
  };
  return labels[state] || state;
}

// 限制预览尺寸
function clampPreviewSize(value, maxSize) {
  if (!Number.isFinite(value)) return 180;
  const max = Number.isFinite(maxSize) ? maxSize : 1200;
  return Math.min(max, Math.max(140, value));
}

// 判断是否为表单元素
function isFormTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

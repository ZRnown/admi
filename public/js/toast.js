/**
 * Toast 通知系统模块
 */

// 获取或创建 Toast 容器
function getToastContainer() {
  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    container.className = 'fixed top-4 right-4 z-[9999] flex flex-col gap-2';
    document.body.appendChild(container);
  }
  return container;
}

// 显示 Toast 通知
function showToast(message, type = 'success') {
  const config = {
    success: {
      bg: 'bg-white',
      border: 'border-emerald-200',
      text: 'text-emerald-700',
      icon: '✓',
      iconBg: 'bg-emerald-100 text-emerald-600'
    },
    error: {
      bg: 'bg-white',
      border: 'border-red-200',
      text: 'text-red-700',
      icon: '✕',
      iconBg: 'bg-red-100 text-red-600'
    },
    info: {
      bg: 'bg-white',
      border: 'border-slate-200',
      text: 'text-slate-700',
      icon: 'ℹ',
      iconBg: 'bg-slate-100 text-slate-600'
    }
  };
  const c = config[type] || config.success;
  const toast = document.createElement('div');
  toast.className = `${c.bg} ${c.border} border ${c.text} px-4 py-3 rounded-xl shadow-lg flex items-center gap-3 transition-all duration-300 transform translate-x-0`;
  toast.innerHTML = `
    <span class="w-6 h-6 rounded-full ${c.iconBg} flex items-center justify-center text-sm font-bold">${c.icon}</span>
    <span class="text-sm font-medium">${message}</span>
  `;
  toast.setAttribute('role', 'status');
  const container = getToastContainer();
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('opacity-0', 'translate-x-4');
  }, 2500);
  setTimeout(() => {
    toast.remove();
    if (container.childElementCount === 0) {
      container.remove();
    }
  }, 2800);
}

// 复制到剪贴板
function fallbackCopyToClipboard(value, type) {
  const textArea = document.createElement('textarea');
  textArea.value = value;
  textArea.setAttribute('readonly', '');
  textArea.style.position = 'fixed';
  textArea.style.left = '-9999px';
  textArea.style.top = '0';
  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch (err) {
    console.error('复制失败:', err);
  }
  document.body.removeChild(textArea);
  if (copied) {
    showToast(`${type}已复制到剪贴板`, 'success');
  } else {
    showToast(`复制失败，请手动复制：${value}`, 'error');
  }
  return copied;
}

function copyToClipboard(text, type) {
  const value = String(text ?? '');
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    navigator.clipboard.writeText(value)
      .then(() => {
        showToast(`${type}已复制到剪贴板`, 'success');
      })
      .catch(err => {
        console.error('复制失败，尝试降级复制:', err);
        fallbackCopyToClipboard(value, type);
      });
    return;
  }
  fallbackCopyToClipboard(value, type);
}

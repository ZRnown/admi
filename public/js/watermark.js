/**
 * 水印功能模块
 */

// 水印字体预设
const watermarkFontPresets = [
  { key: 'noto-sans-sc', label: '思源黑体', family: 'Noto Sans SC', url: 'https://fonts.googleapis.com/css2?family=Noto+Sans+SC&display=swap' },
  { key: 'noto-serif-sc', label: '思源宋体', family: 'Noto Serif SC', url: 'https://fonts.googleapis.com/css2?family=Noto+Serif+SC&display=swap' }
];

// 创建默认水印配置
function createWatermarkDefaults() {
  return {
    enabled: false,
    mode: 'text',
    pattern: 'single',
    text: '',
    textSize: 16,
    textColor: '#ffffff',
    textOpacity: 60,
    textAngle: 0,
    imageUrl: '',
    imageScale: 20,
    imageOpacity: 60,
    position: 'bottom-right',
    margin: 8,
    tileGap: 40
  };
}

// 创建启用的水印配置
function createActiveWatermark() {
  const defaults = createWatermarkDefaults();
  defaults.enabled = true;
  return defaults;
}

// 标准化水印模式
function normalizeWatermarkMode(watermark) {
  if (!watermark) return 'text';
  if (watermark.mode === 'image') return 'image';
  return 'text';
}

// 获取水印预览尺寸
function getWatermarkPreviewSize(accountId) {
  return watermarkPreviewSizes[accountId] || { width: 180, height: 180 };
}

// 更新水印预览尺寸
function updateWatermarkPreviewSize(accountId, width, height) {
  watermarkPreviewSizes[accountId] = {
    width: clampPreviewSize(width),
    height: clampPreviewSize(height)
  };
}

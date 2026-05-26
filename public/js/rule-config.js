/**
 * 规则配置弹窗模块
 */

// 当前规则配置状态
let currentRuleConfigIndex = -1;
let currentRuleConfigType = '';
let ruleConfigData = {
  allowedUsersIds: [],
  mutedUsersIds: [],
  blockedKeywords: [],
  excludeKeywords: [],
  ocrBlockedKeywords: [],
  ocrTriggerKeywords: [],
  replacements: [],
  watermarks: [],
  watermarkMode: 'inherit',
  scheduledBroadcastMode: 'inherit',
  scheduledIntervalMinutes: 60,
  scheduledContentIds: []
};

// 打开规则配置弹窗
function openRuleConfigModal(index, forwardingType) {
  currentRuleConfigIndex = index;
  currentRuleConfigType = forwardingType;

  const acc = getActiveAccount();
  let mapping;

  // 根据转发类型获取对应的规则
  if (forwardingType === 'discord-to-telegram' || forwardingType === 'telegram-to-discord' || forwardingType === 'telegram-to-telegram') {
    ensureTelegramConfig(acc);
    const mappings = (acc.telegramConfig.mappings || []).filter(m => m.type === forwardingType);
    mapping = mappings[index];
  } else {
    if (!acc.mappings) acc.mappings = [];
    mapping = acc.mappings[index];
  }

  if (!mapping) {
    console.error('找不到规则', index);
    return;
  }

  // 初始化规则配置数据
  ruleConfigData = {
    allowedUsersIds: [...(mapping.allowedUsersIds || [])],
    mutedUsersIds: [...(mapping.mutedUsersIds || [])],
    blockedKeywords: [...(mapping.blockedKeywords || [])],
    excludeKeywords: [...(mapping.excludeKeywords || [])],
    ocrBlockedKeywords: [...(mapping.ocrBlockedKeywords || [])],
    ocrTriggerKeywords: [...(mapping.ocrTriggerKeywords || [])],
    replacements: [],
    watermarks: [],
    watermarkMode: 'inherit',
    scheduledBroadcastMode: 'inherit',
    scheduledIntervalMinutes: 60,
    scheduledContentIds: []
  };

  document.getElementById('ruleConfigModal').classList.remove('hidden');
}

// 关闭规则配置弹窗
function closeRuleConfigModal() {
  document.getElementById('ruleConfigModal').classList.add('hidden');
  currentRuleConfigIndex = -1;
  currentRuleConfigType = '';
}

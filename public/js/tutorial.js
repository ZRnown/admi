/**
 * 新手教程模块
 * 使用 Driver.js 实现引导教程
 */

// 启动新手教程
function startTutorial() {
  const driver = window.driver.js.driver;

  const driverObj = driver({
    showProgress: true,
    animate: true,
    allowClose: true,
    overlayClickNext: false,
    stagePadding: 10,
    popoverClass: 'driverjs-theme',
    nextBtnText: '下一步',
    prevBtnText: '上一步',
    doneBtnText: '完成教程',
    progressText: '{{current}} / {{total}}',
    steps: [
      // 步骤 1: 欢迎页
      {
        popover: {
          title: '欢迎使用转发狗！',
          description: '<div class="text-left"><p>转发狗是一款强大的消息转发工具，支持：</p><ul class="list-disc pl-4 mt-2 space-y-1"><li>Discord ↔ Discord</li><li>Discord ↔ Telegram</li><li>Telegram ↔ Telegram</li><li>Discord → 飞书</li><li>X/TruthSocial → Discord</li></ul><p class="mt-2">让我们开始配置吧！</p></div>',
          side: 'center',
          align: 'center'
        }
      },
      // 步骤 2: 账号库入口
      {
        element: '#accountLibraryBtn',
        popover: {
          title: '第一步：配置账号库',
          description: '账号库是所有转发功能的基础。<br><br><b>👆 请点击「账号库」按钮继续</b>',
          side: 'bottom',
          align: 'start',
          showButtons: ['close']
        },
        onHighlightStarted: () => {
          const btn = document.getElementById('accountLibraryBtn');
          if (btn) {
            btn._tutorialClickHandler = () => {
              openAccountLibrary();
              setTimeout(() => driverObj.moveNext(), 300);
            };
            btn.addEventListener('click', btn._tutorialClickHandler, { once: true });
          }
        },
        onDeselected: () => {
          const btn = document.getElementById('accountLibraryBtn');
          if (btn && btn._tutorialClickHandler) {
            btn.removeEventListener('click', btn._tutorialClickHandler);
          }
        }
      },
      // 步骤 3: 账号库 - 添加账号
      {
        element: '#libraryFilterSelect',
        popover: {
          title: '筛选账号类型',
          description: '在这里筛选当前列表显示的账号类型。',
          side: 'bottom',
          align: 'start'
        },
        onHighlightStarted: () => {
          if (!document.getElementById('accountLibraryModal')?.classList.contains('hidden') === false) {
            openAccountLibrary();
          }
        }
      },
      // 步骤 4: 账号库 - 新建按钮
      {
        element: 'button[onclick="addLibraryAccountFromSelect()"]',
        popover: {
          title: '新建账号',
          description: '点击此按钮创建新账号。创建后会弹出编辑窗口，填写账号凭证信息（备注可选）。',
          side: 'bottom',
          align: 'start'
        }
      },
      // 步骤 5: 账号库 - 一键同步
      {
        element: 'button[onclick="syncAllAccounts()"]',
        popover: {
          title: '一键同步',
          description: '添加账号后，点击此按钮同步所有账号的数据。同步后可以直接从列表选择频道，无需手动输入 ID。',
          side: 'bottom',
          align: 'start'
        }
      },
      // 步骤 6: 账号库 - 同步信息
      {
        element: '#librarySyncInfoHeader',
        popover: {
          title: '查看同步信息',
          description: '同步完成后，在表格「同步数据」列点击即可查看服务器/频道数量和上次同步时间，并可进入详情列表。',
          side: 'bottom',
          align: 'start'
        }
      },
      // 步骤 6: 账号类型说明
      {
        popover: {
          title: '账号类型说明',
          description: '<div class="text-left"><p class="font-semibold mb-2">支持的账号类型：</p><ul class="list-disc pl-4 space-y-1"><li><b>Discord Bot</b>：机器人账号，推荐使用</li><li><b>Discord 用户</b>：Selfbot 模式</li><li><b>Telegram Bot</b>：从 @BotFather 获取</li><li><b>Telegram 用户</b>：需要 API ID/Hash</li></ul></div>',
          side: 'center',
          align: 'center'
        }
      },
      // 步骤 7: 转发实例
      {
        element: '#accountTabs',
        popover: {
          title: '转发实例',
          description: '每个实例是一个独立的转发配置。您可以创建多个实例来管理不同的转发任务，每个实例可以使用不同的账号和规则。',
          side: 'bottom',
          align: 'start'
        }
      },
      // 步骤 8: 规则填写模式
      {
        element: '#ruleInputModeToggle',
        popover: {
          title: '规则填写模式',
          description: '支持两种模式：<br>• 列表选择：从已同步的服务器/频道中选择<br>• 手动输入：直接填写频道 ID<br>建议先同步账号后使用列表选择。',
          side: 'bottom',
          align: 'start'
        }
      },
      // 步骤 8: 新手教程按钮
      {
        element: '#tutorialBtn',
        popover: {
          title: '新手教程',
          description: '随时点击这个按钮可以重新查看新手教程，帮助您快速上手。',
          side: 'bottom',
          align: 'start'
        }
      },
      // 步骤 9: 导出导入
      {
        element: 'button[onclick="exportConfig()"]',
        popover: {
          title: '导入导出配置',
          description: '使用导入/导出功能可以备份您的配置，或在不同设备间迁移配置。导出的文件包含所有账号和规则信息。',
          side: 'bottom',
          align: 'start'
        }
      },
      // 步骤 10: 配置表单
      {
        element: '#configForm',
        popover: {
          title: '配置表单',
          description: '这是主要的配置区域。在这里您可以设置转发类型、账号信息、转发规则、关键词过滤等所有功能。',
          side: 'top',
          align: 'center'
        }
      },
      // 步骤 11: 转发类型
      {
        popover: {
          title: '选择转发类型',
          description: '<div class="text-left"><p class="font-semibold mb-2">支持的转发类型：</p><ul class="list-disc pl-4 space-y-1"><li><b>Discord → Discord</b>：使用 Webhook 转发</li><li><b>Discord → Telegram</b>：需要 Telegram Bot</li><li><b>Telegram → Discord</b>：需要 API ID/Hash</li><li><b>Telegram → Telegram</b>：支持机器人/用户发送</li><li><b>Discord → 飞书</b>：支持 Webhook 或应用</li></ul></div>',
          side: 'center',
          align: 'center'
        }
      },
      // 步骤 12: 添加转发规则
      {
        popover: {
          title: '添加转发规则',
          description: '<div class="text-left"><p>在转发规则区域点击"添加规则"：</p><ul class="list-disc pl-4 mt-2 space-y-1"><li>设置源频道（消息来源）</li><li>设置目标频道（消息发送目的地）</li><li>可以添加多条规则实现多对多转发</li></ul></div>',
          side: 'center',
          align: 'center'
        }
      },
      // 步骤 13: 规则填写方式
      {
        popover: {
          title: '规则填写方式',
          description: '<div class="text-left"><p class="mb-2">两种填写方式：</p><ul class="list-disc pl-4 space-y-1"><li><b>手动输入</b>：直接填写频道 ID 或 Webhook URL</li><li><b>从列表选择</b>：从同步的数据中选择频道</li></ul><p class="mt-2 text-sm text-slate-500">建议先同步账号数据，然后从列表选择，避免输入错误。</p></div>',
          side: 'center',
          align: 'center'
        }
      },
      // 步骤 14: 规则配置
      {
        popover: {
          title: '规则配置',
          description: '点击规则旁边的"配置"按钮，可以为每条规则单独设置关键词过滤、用户过滤、水印等高级选项。规则级别的设置会覆盖全局设置。',
          side: 'center',
          align: 'center'
        }
      },
      // 步骤 15: 关键词过滤
      {
        popover: {
          title: '关键词过滤',
          description: '<div class="text-left"><p class="font-semibold mb-2">关键词过滤功能：</p><ul class="list-disc pl-4 space-y-1"><li><b>触发关键词</b>：只转发包含这些词的消息</li><li><b>屏蔽关键词</b>：不转发包含这些词的消息</li><li>使用 & 符号表示"同时包含"，如：关键词A&关键词B</li></ul></div>',
          side: 'center',
          align: 'center'
        }
      },
      // 步骤 16: OCR 功能
      {
        popover: {
          title: 'OCR 图片识别',
          description: '<div class="text-left"><p>开启 OCR 功能后：</p><ul class="list-disc pl-4 mt-2 space-y-1"><li>自动识别图片中的文字</li><li>可以对图片内容进行关键词过滤</li><li>支持 OCR 触发关键词和屏蔽关键词</li></ul><p class="mt-2 text-sm text-slate-500">需要启动 OCR 服务：pnpm start:paddle-ocr-server</p></div>',
          side: 'center',
          align: 'center'
        }
      },
      // 步骤 17: 用户过滤
      {
        popover: {
          title: '用户过滤',
          description: '<div class="text-left"><p class="font-semibold mb-2">用户过滤功能：</p><ul class="list-disc pl-4 space-y-1"><li><b>用户白名单</b>：只转发这些用户的消息</li><li><b>用户黑名单</b>：不转发这些用户的消息</li><li>黑名单优先级高于白名单</li><li>支持 Discord 身份组过滤</li></ul></div>',
          side: 'center',
          align: 'center'
        }
      },
      // 步骤 18: 水印功能
      {
        popover: {
          title: '水印功能',
          description: '<div class="text-left"><p class="mb-2">为转发的图片添加水印：</p><ul class="list-disc pl-4 space-y-1"><li>支持文字水印和图片水印</li><li>可设置位置、透明度、角度</li><li>支持单个或平铺模式</li><li>可在规则级别单独配置</li></ul></div>',
          side: 'center',
          align: 'center'
        }
      },
      // 步骤 19: 翻译和忽略选项
      {
        popover: {
          title: '翻译和忽略选项',
          description: '<div class="text-left"><p class="font-semibold mb-2">翻译功能：</p><ul class="list-disc pl-4 space-y-1"><li>支持 DeepSeek、Google、百度、有道等</li></ul><p class="font-semibold mt-2 mb-2">忽略选项：</p><ul class="list-disc pl-4 space-y-1"><li>忽略图片、视频、音频、文档</li><li>按语言过滤消息</li></ul></div>',
          side: 'center',
          align: 'center'
        }
      },
      // 步骤 20: 完成
      {
        popover: {
          title: '教程完成！',
          description: '<div class="text-left"><p>恭喜您完成了新手教程！</p><p class="mt-2">快速开始步骤：</p><ol class="list-decimal pl-4 mt-1 space-y-1"><li>打开账号库，添加账号</li><li>同步账号数据</li><li>选择转发类型</li><li>添加转发规则</li><li>启动实例</li></ol><p class="mt-2 text-sm text-slate-500">随时点击"新手教程"按钮可以重新查看。祝您使用愉快！</p></div>',
          side: 'center',
          align: 'center'
        }
      }
    ]
  });

  driverObj.drive();
}

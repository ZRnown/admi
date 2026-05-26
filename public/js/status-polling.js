/**
 * 状态轮询模块
 */

// 判断是否应用远程状态
function shouldApplyRemoteState(localState, remoteState, holdUntil) {
  const holdActive = typeof holdUntil === 'number' ? holdUntil > Date.now() : true;
  if (localState === 'disconnecting' && (remoteState === 'online' || remoteState === 'pending' || remoteState === 'connecting')) {
    return !holdActive;
  }
  if ((localState === 'pending' || localState === 'connecting') && remoteState === 'idle') {
    return false;
  }
  return true;
}

// 启动状态轮询
function startStatusPolling() {
  setInterval(async () => {
    try {
      if (!document.getElementById('configForm')) return;
      if (!isLoggedIn) return;

      const res = await fetch('/api/config');
      if (res.status === 401) {
        handleUnauthorized();
        return;
      }
      const data = await res.json();
      if (!Array.isArray(data?.accounts)) return;

      let shouldRender = false;

      data.accounts.forEach(remoteAcc => {
        const localAcc = state.accounts.find(acc => acc.id === remoteAcc.id);
        if (!localAcc) return;

        const isActive = localAcc.id === state.activeId;

        // 更新登录状态
        if (typeof remoteAcc.loginRequested === 'boolean' && localAcc.loginRequested !== remoteAcc.loginRequested) {
          localAcc.loginRequested = remoteAcc.loginRequested;
        }

        const loginHoldUntil = getDisconnectHold(`discord:${localAcc.id}`);
        const remoteLoginState = remoteAcc.loginState || 'idle';
        const remoteLoginMessage = remoteAcc.loginMessage || '';
        if (shouldApplyRemoteState(localAcc.loginState, remoteLoginState, loginHoldUntil)) {
          const loginChanged = remoteLoginState !== localAcc.loginState || remoteLoginMessage !== localAcc.loginMessage;
          if (loginChanged) {
            localAcc.loginState = remoteLoginState;
            localAcc.loginMessage = remoteLoginMessage;
            if (isActive) {
              updateStatusElement('discord', remoteLoginState, remoteLoginMessage);
            }
          }
        }

        // 更新 Telegram Bot 状态
        const botHoldUntil = getDisconnectHold(`telegram-bot:${localAcc.id}`);
        const remoteBotState = remoteAcc.telegramBotState || 'idle';
        const remoteBotMessage = remoteAcc.telegramBotMessage || '';
        if (shouldApplyRemoteState(localAcc.telegramBotState, remoteBotState, botHoldUntil)) {
          const botChanged = remoteBotState !== localAcc.telegramBotState || remoteBotMessage !== localAcc.telegramBotMessage;
          if (botChanged) {
            localAcc.telegramBotState = remoteBotState;
            localAcc.telegramBotMessage = remoteBotMessage;
            if (isActive) {
              updateStatusElement('telegram-bot', remoteBotState, remoteBotMessage);
            }
          }
        }

        // 更新 Telegram Client 状态
        const clientHoldUntil = getDisconnectHold(`telegram-client:${localAcc.id}`);
        const remoteClientState = remoteAcc.telegramClientState || 'idle';
        const remoteClientMessage = remoteAcc.telegramClientMessage || '';
        if (shouldApplyRemoteState(localAcc.telegramClientState, remoteClientState, clientHoldUntil)) {
          const clientChanged = remoteClientState !== localAcc.telegramClientState || remoteClientMessage !== localAcc.telegramClientMessage;
          if (clientChanged) {
            localAcc.telegramClientState = remoteClientState;
            localAcc.telegramClientMessage = remoteClientMessage;
            if (isActive) {
              updateStatusElement('telegram-client', remoteClientState, remoteClientMessage);
            }
          }
        }

        // 更新账号卡片状态
        updateAccountCardStatus(localAcc);
      });

      if (shouldRender) {
        if (isFormElementActive()) {
          pendingStatusRender = true;
        } else {
          render();
        }
      }
    } catch (e) {
      // 忽略轮询错误
    }
  }, 2000);
}

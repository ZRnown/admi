"""
连接状态管理器
负责管理Telegram连接的生命周期、状态监控和自动重连
"""

import asyncio
import time
from typing import Dict, Optional, Callable, Any
from dataclasses import dataclass

from loguru import logger

from .telegram_types import ConnectionStatus, ConnectionState


@dataclass
class ReconnectConfig:
    """重连配置"""

    max_attempts: int = 5
    base_delay: float = 1.0  # 基础延迟时间（秒）
    max_delay: float = 300.0  # 最大延迟时间（秒）
    backoff_multiplier: float = 2.0  # 退避倍数


class ConnectionManager:
    """连接管理器"""

    def __init__(self, reconnect_config: Optional[ReconnectConfig] = None):
        self.reconnect_config = reconnect_config or ReconnectConfig()
        self.states: Dict[str, ConnectionState] = {}
        self.reconnect_tasks: Dict[str, asyncio.Task] = {}
        self.status_callbacks: Dict[str, Callable[[str, ConnectionState], None]] = {}

    def register_status_callback(self, account_id: str, callback: Callable[[str, ConnectionState], None]):
        """注册状态变更回调"""

        self.status_callbacks[account_id] = callback

    def unregister_status_callback(self, account_id: str):
        """取消注册状态变更回调"""

        self.status_callbacks.pop(account_id, None)

    def update_state(
        self,
        account_id: str,
        status: ConnectionStatus,
        error_message: Optional[str] = None,
        user_info: Optional[Dict[str, Any]] = None,
    ):
        """更新连接状态"""

        now = time.time()
        current_time = int(now)

        if account_id not in self.states:
            self.states[account_id] = ConnectionState(account_id=account_id, status=status)

        state = self.states[account_id]
        old_status = state.status
        old_error = state.error_message

        state.status = status
        if user_info is not None:
            state.user_info = user_info

        status_changed = old_status != status
        is_disconnected = status in (ConnectionStatus.DISCONNECTED, ConnectionStatus.ERROR)
        was_disconnected = old_status in (ConnectionStatus.DISCONNECTED, ConnectionStatus.ERROR)

        if status == ConnectionStatus.CONNECTED:
            state.last_connected_at = current_time
            state.reconnect_count = 0
            if state.last_disconnected_at:
                state.last_recovery_duration_ms = max(0, int((now - state.last_disconnected_at) * 1000))
            if was_disconnected and state.last_recovery_duration_ms is not None:
                reason = state.last_disconnect_reason or "unknown"
                logger.info(
                    f"Connection recovered for {account_id} in {state.last_recovery_duration_ms}ms (reason={reason})"
                )
            state.consecutive_disconnect_count = 0
            state.error_message = None

        elif is_disconnected:
            if status_changed and not was_disconnected:
                state.last_disconnected_at = current_time
                state.consecutive_disconnect_count += 1
            if error_message:
                state.last_disconnect_reason = error_message
            elif state.last_disconnect_reason is None:
                state.last_disconnect_reason = status.value
            state.error_message = error_message or state.error_message

        else:
            if error_message is not None:
                state.error_message = error_message

        # 通知回调
        if status_changed and account_id in self.status_callbacks:
            try:
                self.status_callbacks[account_id](account_id, state)
            except Exception as e:
                logger.error(f"Error in status callback for {account_id}: {e}")

        if status_changed or (state.error_message and state.error_message != old_error):
            logger.info(f"Connection state updated for {account_id}: {old_status} -> {status}")

    def get_state(self, account_id: str) -> Optional[ConnectionState]:
        """获取连接状态"""

        return self.states.get(account_id)

    def is_connected(self, account_id: str) -> bool:
        """检查是否已连接"""

        state = self.get_state(account_id)
        return state is not None and state.status == ConnectionStatus.CONNECTED

    async def start_reconnect(self, account_id: str, connect_func: Callable[[], Any]):
        """启动自动重连"""

        if account_id in self.reconnect_tasks:
            logger.warning(f"Reconnect already in progress for {account_id}")
            return

        task = asyncio.create_task(self._reconnect_loop(account_id, connect_func))
        self.reconnect_tasks[account_id] = task

        logger.info(f"Started reconnect task for {account_id}")

    async def stop_reconnect(self, account_id: str):
        """停止自动重连"""

        if account_id in self.reconnect_tasks:
            task = self.reconnect_tasks[account_id]
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            del self.reconnect_tasks[account_id]
            logger.info(f"Stopped reconnect task for {account_id}")

    async def _reconnect_loop(self, account_id: str, connect_func: Callable[[], Any]):
        """重连循环"""

        state = self.get_state(account_id)
        if not state:
            return

        attempt = 0
        while attempt < self.reconnect_config.max_attempts:
            try:
                # 检查是否已经连接
                if self.is_connected(account_id):
                    logger.info(f"Already connected for {account_id}, stopping reconnect")
                    return

                # 更新状态为连接中
                self.update_state(account_id, ConnectionStatus.CONNECTING)

                # 尝试连接
                result = await connect_func()
                if result and result.get("success"):
                    self.update_state(
                        account_id,
                        ConnectionStatus.CONNECTED,
                        user_info=result.get("userInfo"),
                    )
                    logger.info(f"Successfully reconnected {account_id}")
                    return

                error_msg = result.get("message") if result else "Connection failed"
                self.update_state(account_id, ConnectionStatus.ERROR, error_msg)

            except Exception as e:
                logger.error(f"Reconnect attempt {attempt + 1} failed for {account_id}: {e}")
                self.update_state(account_id, ConnectionStatus.ERROR, str(e))

            state.reconnect_count += 1
            delay = min(
                self.reconnect_config.base_delay * (self.reconnect_config.backoff_multiplier ** attempt),
                self.reconnect_config.max_delay,
            )

            logger.info(f"Reconnect attempt {attempt + 1} for {account_id} failed, retrying in {delay}s")
            await asyncio.sleep(delay)
            attempt += 1

        logger.error(f"Max reconnect attempts reached for {account_id}")
        self.update_state(
            account_id,
            ConnectionStatus.ERROR,
            f"Max reconnect attempts ({self.reconnect_config.max_attempts}) reached",
        )

    def get_connection_stats(self) -> Dict[str, Dict[str, Any]]:
        """获取连接统计信息"""

        stats = {}
        current_time = int(time.time())

        for account_id, state in self.states.items():
            uptime = 0
            if state.last_connected_at and state.status == ConnectionStatus.CONNECTED:
                uptime = current_time - state.last_connected_at

            downtime = 0
            if state.last_disconnected_at and state.status != ConnectionStatus.CONNECTED:
                downtime = current_time - state.last_disconnected_at

            stats[account_id] = {
                "status": state.status.value,
                "reconnect_count": state.reconnect_count,
                "uptime_seconds": uptime,
                "downtime_seconds": downtime,
                "last_connected_at": state.last_connected_at,
                "last_disconnected_at": state.last_disconnected_at,
                "error_message": state.error_message,
                "has_user_info": state.user_info is not None,
                "last_disconnect_reason": state.last_disconnect_reason,
                "last_recovery_duration_ms": state.last_recovery_duration_ms,
                "consecutive_disconnect_count": state.consecutive_disconnect_count,
            }

        return stats

    async def cleanup(self):
        """清理资源"""

        for account_id in list(self.reconnect_tasks.keys()):
            await self.stop_reconnect(account_id)

        self.states.clear()
        self.status_callbacks.clear()

        logger.info("Connection manager cleaned up")


class ConnectionMonitor:
    """连接监控器"""

    def __init__(self, connection_manager: ConnectionManager, check_interval: float = 30.0):
        self.connection_manager = connection_manager
        self.check_interval = check_interval
        self.monitoring = False
        self.monitor_task: Optional[asyncio.Task] = None
        self.health_checks: Dict[str, Callable[[str], Any]] = {}

    def register_health_check(self, account_id: str, check_func: Callable[[str], Any]):
        """注册健康检查函数"""

        self.health_checks[account_id] = check_func

    def unregister_health_check(self, account_id: str):
        """取消注册健康检查函数"""

        self.health_checks.pop(account_id, None)

    async def start_monitoring(self):
        """启动监控"""

        if self.monitoring:
            return

        self.monitoring = True
        self.monitor_task = asyncio.create_task(self._monitor_loop())
        logger.info("Connection monitoring started")

    async def stop_monitoring(self):
        """停止监控"""

        if not self.monitoring:
            return

        self.monitoring = False
        if self.monitor_task:
            self.monitor_task.cancel()
            try:
                await self.monitor_task
            except asyncio.CancelledError:
                pass

        logger.info("Connection monitoring stopped")

    async def _monitor_loop(self):
        """监控循环"""

        while self.monitoring:
            try:
                await self._perform_health_checks()
                await asyncio.sleep(self.check_interval)
            except Exception as e:
                logger.error(f"Error in monitoring loop: {e}")
                await asyncio.sleep(self.check_interval)

    async def _perform_health_checks(self):
        """执行健康检查"""

        for account_id, check_func in self.health_checks.items():
            try:
                result = await check_func(account_id)
                if not result:
                    state = self.connection_manager.get_state(account_id)
                    if state and state.status == ConnectionStatus.CONNECTED:
                        logger.warning(f"Health check failed for {account_id}")
                        self.connection_manager.update_state(
                            account_id,
                            ConnectionStatus.ERROR,
                            "Health check failed",
                        )
            except Exception as e:
                logger.error(f"Health check error for {account_id}: {e}")
                self.connection_manager.update_state(
                    account_id,
                    ConnectionStatus.ERROR,
                    f"Health check error: {e}",
                )

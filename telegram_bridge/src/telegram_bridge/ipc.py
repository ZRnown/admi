"""
IPC通信层
实现JSON-RPC over stdio的通信协议
"""

import asyncio
import json
import sys
from typing import Dict, Any, Callable, Optional
from loguru import logger
from .telegram_types import IPCMessage, IPCRequest, IPCResponse, IPCNotification


class IPCServer:
    """IPC服务器"""

    def __init__(self):
        self.handlers: Dict[str, Callable] = {}
        self.running = False
        self._reader: Optional[asyncio.StreamReader] = None
        self._writer: Optional[asyncio.StreamWriter] = None

    async def start(self):
        """启动IPC服务器"""
        logger.info("Starting IPC server...")

        # 使用stdio进行通信
        loop = asyncio.get_event_loop()
        self._reader = asyncio.StreamReader()
        reader_protocol = asyncio.StreamReaderProtocol(self._reader)
        await loop.connect_read_pipe(lambda: reader_protocol, sys.stdin)

        # 创建writer
        write_transport, write_protocol = await loop.connect_write_pipe(
            asyncio.streams.FlowControlMixin, sys.stdout
        )
        self._writer = asyncio.StreamWriter(write_transport, write_protocol, None, loop)

        self.running = True
        logger.info("IPC server started")

        # 开始处理消息
        await self._message_loop()

    async def stop(self):
        """停止IPC服务器"""
        logger.info("Stopping IPC server...")
        self.running = False

        if self._writer:
            self._writer.close()
            await self._writer.wait_closed()

        logger.info("IPC server stopped")

    def register_handler(self, method: str, handler: Callable):
        """注册消息处理器"""
        self.handlers[method] = handler
        logger.debug(f"Registered handler for method: {method}")

    async def _message_loop(self):
        """消息处理循环"""
        buffer = ""

        while self.running:
            try:
                # 读取一行数据
                if self._reader:
                    line = await self._reader.readline()
                    if not line:  # EOF
                        break

                    line_str = line.decode('utf-8').strip()
                    if not line_str:
                        continue

                    buffer += line_str

                    # 尝试解析JSON
                    try:
                        message_data = json.loads(buffer)
                        buffer = ""  # 清空缓冲区

                        # 处理消息
                        await self._handle_message(message_data)

                    except json.JSONDecodeError:
                        # JSON不完整，继续读取
                        continue

            except Exception as e:
                logger.error(f"Error in message loop: {e}")
                break

    async def _handle_message(self, message_data: Dict[str, Any]):
        """处理接收到的消息"""
        try:
            # 解析消息
            if "method" in message_data and "id" in message_data:
                # 请求消息
                request = IPCRequest(**message_data)
                await self._handle_request(request)
            elif "method" in message_data:
                # 通知消息
                notification = IPCNotification(**message_data)
                await self._handle_notification(notification)
            else:
                logger.warning(f"Invalid message format: {message_data}")

        except Exception as e:
            logger.error(f"Failed to handle message: {e}")
            # 发送错误响应
            await self._send_error_response(message_data.get("id"), -32600, "Invalid Request")

    async def _handle_request(self, request: IPCRequest):
        """处理请求消息"""
        try:
            method = request.method
            params = request.params or {}

            if method not in self.handlers:
                await self._send_error_response(request.id, -32601, f"Method not found: {method}")
                return

            # 调用处理器
            handler = self.handlers[method]
            if asyncio.iscoroutinefunction(handler):
                result = await handler(params)
            else:
                result = handler(params)

            # 发送成功响应
            await self._send_response(request.id, result)

        except Exception as e:
            logger.error(f"Error handling request {request.id}: {e}")
            await self._send_error_response(request.id, -32603, str(e))

    async def _handle_notification(self, notification: IPCNotification):
        """处理通知消息"""
        try:
            method = notification.method
            params = notification.params or {}

            if method not in self.handlers:
                logger.warning(f"Notification method not found: {method}")
                return

            # 调用处理器
            handler = self.handlers[method]
            if asyncio.iscoroutinefunction(handler):
                await handler(params)
            else:
                handler(params)

        except Exception as e:
            logger.error(f"Error handling notification: {e}")

    async def _send_response(self, request_id: str, result: Any):
        """发送响应消息"""
        response = IPCResponse(
            id=request_id,
            result=result
        )

        await self._send_message(response.dict())

    async def _send_error_response(self, request_id: str, code: int, message: str):
        """发送错误响应"""
        response = IPCResponse(
            id=request_id,
            error={
                "code": code,
                "message": message
            }
        )

        await self._send_message(response.dict())

    async def send_notification(self, method: str, params: Dict[str, Any]):
        """发送通知消息"""
        notification = IPCNotification(
            method=method,
            params=params
        )

        await self._send_message(notification.dict())

    async def _send_message(self, message: Dict[str, Any]):
        """发送消息到stdout"""
        try:
            if self._writer:
                json_str = json.dumps(message, ensure_ascii=False)
                self._writer.write((json_str + "\n").encode('utf-8'))
                await self._writer.drain()
        except Exception as e:
            logger.error(f"Failed to send message: {e}")


class IPCClient:
    """IPC客户端（用于测试）"""

    def __init__(self):
        self._reader: Optional[asyncio.StreamReader] = None
        self._writer: Optional[asyncio.StreamWriter] = None
        self.request_id = 0

    async def connect(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        """连接到IPC服务器"""
        self._reader = reader
        self._writer = writer

    async def call(self, method: str, params: Optional[Dict[str, Any]] = None) -> Any:
        """调用远程方法"""
        self.request_id += 1
        request_id = str(self.request_id)

        request = IPCRequest(
            id=request_id,
            method=method,
            params=params or {}
        )

        # 发送请求
        await self._send_message(request.dict())

        # 等待响应
        while True:
            response_data = await self._receive_message()
            if response_data.get("id") == request_id:
                response = IPCResponse(**response_data)
                if response.error:
                    raise Exception(f"RPC Error {response.error['code']}: {response.error['message']}")
                return response.result

    async def notify(self, method: str, params: Optional[Dict[str, Any]] = None):
        """发送通知"""
        notification = IPCNotification(
            method=method,
            params=params or {}
        )

        await self._send_message(notification.dict())

    async def _send_message(self, message: Dict[str, Any]):
        """发送消息"""
        if self._writer:
            json_str = json.dumps(message, ensure_ascii=False)
            self._writer.write((json_str + "\n").encode('utf-8'))
            await self._writer.drain()

    async def _receive_message(self) -> Dict[str, Any]:
        """接收消息"""
        if self._reader:
            line = await self._reader.readline()
            line_str = line.decode('utf-8').strip()
            return json.loads(line_str)

        raise Exception("Not connected")

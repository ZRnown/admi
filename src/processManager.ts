import { spawn, spawnSync, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import path from "path";
import fs from "fs/promises";

export interface ProcessInfo {
  pid: number;
  startTime: number;
  status: 'running' | 'stopped' | 'error';
  memoryUsage?: number;
  cpuUsage?: number;
  restartCount: number;
  lastRestartTime?: number;
  errorMessage?: string;
}

export class TelegramBridgeManager extends EventEmitter {
  private process: ChildProcess | null = null;
  private processInfo: ProcessInfo | null = null;
  private restartAttempts = 0;
  private maxRestartAttempts = 5;
  private restartDelay = 5000; // 5秒
  private isShuttingDown = false;

  constructor() {
    super();
  }

  /**
   * 启动Telegram Bridge进程
   */
  async start(): Promise<{ success: boolean; message: string; pid?: number }> {
    try {
      if (this.process && !this.process.killed) {
        return { success: false, message: "进程已在运行中" };
      }

      // 检查telegram_bridge目录是否存在
      const bridgePath = path.join(process.cwd(), 'telegram_bridge');
      const srcPath = path.join(bridgePath, 'src');
      const mainScript = path.join(bridgePath, 'src', 'telegram_bridge', 'main.py');

      try {
        await fs.access(mainScript);
      } catch {
        return { success: false, message: "Telegram Bridge主程序不存在" };
      }

      const pythonCandidates = [
        process.env.PYTHON,
        process.env.PYTHON_BIN,
        process.env.PYTHON_EXECUTABLE,
        'python3',
        'python',
      ].filter(Boolean) as string[];
      const pythonBin = pythonCandidates.find((bin) => {
        const result = spawnSync(bin, ['-V'], { stdio: 'ignore' });
        return !result.error;
      });
      if (!pythonBin) {
        return { success: false, message: "未找到可用的Python可执行文件，请安装python3或设置PYTHON环境变量" };
      }

      // 启动进程 - 使用模块导入方式避免相对导入错误
      this.process = spawn(pythonBin, ['-B', '-m', 'telegram_bridge.main'], {
        cwd: srcPath,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONPATH: path.join(bridgePath, 'src') }
      });

      if (!this.process.pid) {
        return { success: false, message: "无法启动进程" };
      }

      // 初始化进程信息
      this.processInfo = {
        pid: this.process.pid,
        startTime: Date.now(),
        status: 'running',
        restartCount: this.restartAttempts,
        lastRestartTime: Date.now()
      };

      // 设置事件监听器
      this.setupProcessListeners();

      // 重置重启计数
      this.restartAttempts = 0;

      this.emit('started', this.processInfo);
      console.log(`[ProcessManager] Telegram Bridge started with PID: ${this.process.pid}`);

      return {
        success: true,
        message: "Telegram Bridge启动成功",
        pid: this.process.pid
      };

    } catch (error: any) {
      console.error(`[ProcessManager] Failed to start Telegram Bridge: ${error.message}`);
      return { success: false, message: `启动失败: ${error.message}` };
    }
  }

  /**
   * 停止Telegram Bridge进程
   */
  async stop(): Promise<{ success: boolean; message: string }> {
    try {
      this.isShuttingDown = true;

      if (!this.process || this.process.killed) {
        return { success: false, message: "进程未在运行" };
      }

      // 优雅关闭
      this.process.kill('SIGTERM');

      // 等待进程退出，最多等待10秒
      const timeout = setTimeout(() => {
        if (this.process && !this.process.killed) {
          console.log('[ProcessManager] Force killing process...');
          this.process.kill('SIGKILL');
        }
      }, 10000);

      return new Promise((resolve) => {
        if (this.process) {
          this.process.on('exit', (code) => {
            clearTimeout(timeout);
            this.process = null;
            if (this.processInfo) {
              this.processInfo.status = 'stopped';
            }
            this.emit('stopped', code);
            console.log(`[ProcessManager] Telegram Bridge stopped with code: ${code}`);
            resolve({ success: true, message: "Telegram Bridge已停止" });
          });

          this.process.on('error', (error) => {
            clearTimeout(timeout);
            console.error(`[ProcessManager] Error stopping process: ${error.message}`);
            resolve({ success: false, message: `停止失败: ${error.message}` });
          });
        } else {
          clearTimeout(timeout);
          resolve({ success: false, message: "进程不存在" });
        }
      });

    } catch (error: any) {
      console.error(`[ProcessManager] Failed to stop Telegram Bridge: ${error.message}`);
      return { success: false, message: `停止失败: ${error.message}` };
    }
  }

  /**
   * 重启Telegram Bridge进程
   */
  async restart(): Promise<{ success: boolean; message: string }> {
    console.log('[ProcessManager] Restarting Telegram Bridge...');

    const stopResult = await this.stop();
    if (!stopResult.success) {
      return stopResult;
    }

    // 等待一秒再启动
    await new Promise(resolve => setTimeout(resolve, 1000));

    return await this.start();
  }

  /**
   * 获取进程状态
   */
  getStatus(): ProcessInfo | null {
    if (!this.processInfo) {
      return null;
    }

    // 更新实时信息
    if (this.process && !this.process.killed) {
      try {
        const usage = process.memoryUsage();
        this.processInfo.memoryUsage = usage.heapUsed;
        // CPU使用率需要更复杂的计算，这里简化
        this.processInfo.cpuUsage = 0;
      } catch (error) {
        // 忽略获取使用率时的错误
      }
    }

    return { ...this.processInfo };
  }

  /**
   * 检查进程是否在运行
   */
  isRunning(): boolean {
    return this.process !== null && !this.process.killed && this.processInfo?.status === 'running';
  }

  /**
   * 设置进程监听器
   */
  private setupProcessListeners(): void {
    if (!this.process) return;

    this.process.on('exit', (code, signal) => {
      console.log(`[ProcessManager] Process exited with code ${code}, signal ${signal}`);

      if (this.processInfo) {
        this.processInfo.status = 'stopped';
      }
      this.process = null;

      this.emit('exited', code, signal);

      // 如果不是主动关闭且重启次数未达上限，则自动重启
      if (!this.isShuttingDown && this.restartAttempts < this.maxRestartAttempts) {
        console.log(`[ProcessManager] Auto-restarting in ${this.restartDelay}ms...`);
        setTimeout(async () => {
          if (!this.isShuttingDown) {
            this.restartAttempts++;
            await this.start();
          }
        }, this.restartDelay);
      }
    });

    this.process.on('error', (error) => {
      console.error(`[ProcessManager] Process error: ${error.message}`);

      if (this.processInfo) {
        this.processInfo.status = 'error';
        this.processInfo.errorMessage = error.message;
      }

      this.emit('error', error);
    });

    // 监听stdout和stderr
    if (this.process.stdout) {
      this.process.stdout.on('data', (data) => {
        console.log(`[TelegramBridge] ${data.toString().trim()}`);
        this.emit('stdout', data);
      });
    }

    if (this.process.stderr) {
      this.process.stderr.on('data', (data) => {
        console.error(`[TelegramBridge] ${data.toString().trim()}`);
        this.emit('stderr', data);
      });
    }
  }

  /**
   * 发送消息到进程
   */
  sendMessage(message: string): boolean {
    if (!this.process || !this.process.stdin) {
      return false;
    }

    try {
      this.process.stdin.write(message + '\n');
      return true;
    } catch (error) {
      console.error(`[ProcessManager] Failed to send message: ${error}`);
      return false;
    }
  }

  /**
   * 清理资源
   */
  async cleanup(): Promise<void> {
    this.isShuttingDown = true;
    await this.stop();
    this.removeAllListeners();
  }

  /**
   * 获取进程实例（用于 IPC 通信）
   */
  getProcess(): ChildProcess | null {
    return this.process;
  }
}

// 创建全局实例
export const telegramBridgeManager = new TelegramBridgeManager();

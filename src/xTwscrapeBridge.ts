import { spawn, spawnSync } from "child_process";
import path from "node:path";
import { resolvePythonBin } from "./pythonRuntime";
import { buildTwscrapeInput, normalizeTwscrapeTweets, type TwscrapeInput } from "./xTwscrapeShape";

function resolveTwscrapePythonBin(): string {
  const projectRoot = process.cwd();
  const candidate = resolvePythonBin({ cwd: projectRoot });
  if (!candidate) throw new Error("未找到可用的 Python 解释器");
  return candidate;
}

function assertTwscrapeAvailable(pythonBin: string): void {
  const result = spawnSync(pythonBin, ["-c", "import twscrape"], { stdio: "ignore" });
  if (result.error || result.status !== 0) {
    throw new Error("Python 环境未安装 twscrape，请执行：pip install \"twscrape[curl]\"");
  }
}

export async function runTwscrape(input: TwscrapeInput): Promise<any[]> {
  const pythonBin = resolveTwscrapePythonBin();
  assertTwscrapeAvailable(pythonBin);
  const bridgeModule = "x_twscrape_bridge.fetch_latest";
  const bridgeRoot = path.resolve(process.cwd(), "python_services");
  const bridgeInput = buildTwscrapeInput(input);
  if (bridgeInput.dbPath && !path.isAbsolute(bridgeInput.dbPath)) {
    bridgeInput.dbPath = path.resolve(process.cwd(), bridgeInput.dbPath);
  }
  const payload = JSON.stringify(bridgeInput);

  return new Promise((resolve, reject) => {
    const child = spawn(pythonBin, ["-B", "-m", bridgeModule], {
      cwd: bridgeRoot,
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: "1",
        PYTHONPATH: bridgeRoot,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `twscrape bridge exited with code ${code}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout || "{}");
        if (parsed?.success === false) {
          reject(new Error(parsed.error || "twscrape bridge failed"));
          return;
        }
        resolve(normalizeTwscrapeTweets(Array.isArray(parsed?.tweets) ? parsed.tweets : []));
      } catch (error: any) {
        reject(new Error(`无法解析 twscrape 输出: ${String(error?.message || error)}`));
      }
    });
    child.stdin.write(payload);
    child.stdin.end();
  });
}

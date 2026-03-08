import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { app } from "electron";
import path from "node:path";
import { existsSync } from "node:fs";
import http from "node:http";

export interface PythonBackendOptions {
  pythonPath: string;
  port: number;
}

/**
 * Manages the Python backend subprocess.
 * Follows chaiNNer's pattern: spawn → health check → ready.
 */
export class PythonBackendProcess {
  private process: ChildProcessWithoutNullStreams | null = null;
  private _port: number;
  private _pythonPath: string;
  private _running = false;
  private _logs: string[] = [];

  constructor(options: PythonBackendOptions) {
    this._port = options.port;
    this._pythonPath = options.pythonPath;
  }

  get port(): number {
    return this._port;
  }

  get url(): string {
    return `http://127.0.0.1:${this._port}`;
  }

  get running(): boolean {
    return this._running;
  }

  get logs(): string[] {
    return this._logs;
  }

  /**
   * Find the path to server.py
   */
  private getServerPath(): string {
    const candidates = [
      // Production: bundled with app
      path.join(process.resourcesPath, "python-backend", "src", "server.py"),
      // Development: relative to electron dir
      path.join(app.getAppPath(), "python-backend", "src", "server.py"),
      // Fallback: cwd
      path.join(process.cwd(), "python-backend", "src", "server.py"),
    ];

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }

    throw new Error(
      `Cannot find server.py. Checked:\n${candidates.join("\n")}`
    );
  }

  /**
   * Spawn the Python backend process
   */
  async spawn(): Promise<void> {
    if (this.process) {
      await this.kill();
    }

    const serverPath = this.getServerPath();
    const isDev = !app.isPackaged;
    const args = [serverPath, String(this._port)];
    if (isDev) args.push("--dev");
    console.log(`[PythonBackend] Spawning: ${this._pythonPath} ${args.join(" ")}${isDev ? " (dev mode)" : ""}`);

    this.process = spawn(this._pythonPath, args, {
      env: {
        ...process.env,
        PYTHONNOUSERSITE: "1",
        PYTHONUNBUFFERED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Capture stdout/stderr
    this.process.stdout.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      if (line) {
        this._logs.push(`[stdout] ${line}`);
        console.log(`[Python] ${line}`);
      }
    });

    this.process.stderr.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      if (line) {
        this._logs.push(`[stderr] ${line}`);
        console.error(`[Python] ${line}`);
      }
    });

    this.process.on("error", (err) => {
      console.error(`[PythonBackend] Process error:`, err);
      this._running = false;
    });

    this.process.on("exit", (code, signal) => {
      console.log(`[PythonBackend] Exited with code=${code} signal=${signal}`);
      this._running = false;
      this.process = null;
    });

    // Wait for health check to pass
    await this.waitForReady();
    this._running = true;
    console.log(`[PythonBackend] Ready at ${this.url}`);
  }

  /**
   * Poll /health until the server responds (up to 30 seconds)
   */
  private async waitForReady(timeoutMs = 30000): Promise<void> {
    const start = Date.now();
    const interval = 500;

    while (Date.now() - start < timeoutMs) {
      if (!this.process || this.process.exitCode !== null) {
        throw new Error("Python backend process exited before becoming ready");
      }

      const healthy = await this.healthCheck();
      if (healthy) return;

      await new Promise((r) => setTimeout(r, interval));
    }

    throw new Error(`Python backend did not become ready within ${timeoutMs}ms`);
  }

  /**
   * Check if the backend is healthy
   */
  async healthCheck(): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get(`${this.url}/health`, { timeout: 2000 }, (res) => {
        if (res.statusCode === 200) {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => resolve(true));
        } else {
          resolve(false);
        }
      });
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
    });
  }

  /**
   * Make a request to the Python backend
   */
  async request<T = unknown>(
    method: "GET" | "POST",
    endpoint: string,
    body?: unknown
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const url = new URL(endpoint, this.url);
      const postData = body ? JSON.stringify(body) : undefined;

      const options: http.RequestOptions = {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        timeout: 120000, // 2 min timeout for inference
        headers: {
          "Content-Type": "application/json",
          ...(postData ? { "Content-Length": Buffer.byteLength(postData) } : {}),
        },
      };

      const req = http.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode && res.statusCode >= 400) {
              reject(new Error(parsed.message || `HTTP ${res.statusCode}`));
            } else {
              resolve(parsed as T);
            }
          } catch {
            reject(new Error(`Invalid JSON response: ${data.slice(0, 200)}`));
          }
        });
      });

      req.on("error", (err) => reject(err));
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Request timed out"));
      });

      if (postData) req.write(postData);
      req.end();
    });
  }

  /**
   * Gracefully shut down the backend
   */
  async kill(): Promise<void> {
    if (!this.process) return;

    try {
      // Try graceful shutdown first
      await this.request("POST", "/shutdown");
    } catch {
      // Ignore — process may already be dead
    }

    // Force kill if still running after 3 seconds
    if (this.process && this.process.exitCode === null) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          this.process?.kill("SIGKILL");
          resolve();
        }, 3000);

        this.process!.on("exit", () => {
          clearTimeout(timeout);
          resolve();
        });

        this.process!.kill("SIGTERM");
      });
    }

    this.process = null;
    this._running = false;
  }

  /**
   * Restart the backend
   */
  async restart(): Promise<void> {
    await this.kill();
    await this.spawn();
  }
}

/**
 * Find a free port
 */
export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = require("node:net").createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

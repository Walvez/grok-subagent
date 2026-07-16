import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export class McpTestClient {
  constructor(serverPath) {
    this.proc = spawn(process.execPath, [serverPath], { stdio: ["pipe", "pipe", "pipe"] });
    this.nextId = 0;
    this.pending = new Map();
    this.stderr = "";
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", chunk => { this.stderr += chunk; });
    const lines = createInterface({ input: this.proc.stdout });
    lines.on("line", line => {
      const message = JSON.parse(line);
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  request(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}\n${this.stderr}`));
      }, 45_000);
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); }
      });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  async call(name, args = {}) {
    const result = await this.request("tools/call", { name, arguments: args });
    const parsed = JSON.parse(result.content[0].text);
    if (result.isError) throw new Error(parsed.error || result.content[0].text);
    return parsed;
  }

  close() {
    this.proc.kill("SIGTERM");
  }
}

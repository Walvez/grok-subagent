import assert from "node:assert/strict";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpTestClient } from "./mcp-client.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const client = new McpTestClient(resolve(here, "../mcp-server/server.mjs"));
const target = resolve(process.env.GROK_E2E_CWD || process.cwd());
const expectedCwd = basename(target);
let agentId;

try {
  await client.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });

  let guardWorked = false;
  try {
    await client.call("grok_spawn_worker", {
      task: "Do nothing.",
      worktree: target,
      confirm_write_scope: true
    });
  } catch (error) {
    guardWorked = /worktree|Git|checkout/i.test(error.message);
  }
  assert(guardWorked, "writing guard did not reject a non-linked-worktree target");

  const started = await client.call("grok_spawn_readonly", {
    cwd: target,
    role: "installation test reviewer",
    model: "grok-4.5",
    timeout_seconds: 240,
    task: `This is a read-only integration test. Inspect only the current directory. Reply with exactly two lines: GROK_SUBAGENT_OK and cwd=${expectedCwd}. Do not modify files and do not use subagents.`
  });
  agentId = started.agent_id;

  let result;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    result = await client.call("grok_result", { agent_id: agentId, wait_seconds: 30 });
    if (["completed", "failed", "cancelled"].includes(result.status)) break;
  }
  assert.equal(result.status, "completed", result.error || `unexpected status: ${result.status}`);
  assert.match(result.response, /GROK_SUBAGENT_OK/);
  assert(result.response.includes(`cwd=${expectedCwd}`));
  await client.call("grok_close", { agent_id: agentId });
  agentId = null;
  console.log("Grok ACP end-to-end test passed (read-only response and worker guard).\n" + result.response.trim());
} finally {
  if (agentId) {
    try { await client.call("grok_close", { agent_id: agentId }); } catch {}
  }
  client.close();
}

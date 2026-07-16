import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpTestClient } from "./mcp-client.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const client = new McpTestClient(resolve(here, "../mcp-server/server.mjs"));

try {
  const initialized = await client.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
  assert.equal(initialized.serverInfo.name, "grok-subagent");
  const listed = await client.request("tools/list");
  const names = listed.tools.map(tool => tool.name);
  for (const name of ["grok_spawn_readonly", "grok_spawn_worker", "grok_status", "grok_result", "grok_send", "grok_cancel", "grok_close", "grok_list"]) {
    assert(names.includes(name), `missing ${name}`);
  }
  assert.equal(listed.tools.find(tool => tool.name === "grok_spawn_readonly").annotations.readOnlyHint, true);
  assert.equal(listed.tools.find(tool => tool.name === "grok_spawn_worker").annotations.destructiveHint, true);
  console.log(`MCP smoke passed (${names.length} tools).`);
} finally {
  client.close();
}

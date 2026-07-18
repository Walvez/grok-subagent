import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageManifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const marketplace = JSON.parse(readFileSync(resolve(root, ".agents/plugins/marketplace.json"), "utf8"));

assert.equal(marketplace.name, "walvez-grok");
assert.equal(marketplace.plugins.length, 1);
const entry = marketplace.plugins[0];
assert.equal(entry.name, "grok-subagent");
assert.equal(entry.source.source, "local");
assert.equal(entry.policy.installation, "AVAILABLE");
assert.equal(entry.policy.authentication, "ON_INSTALL");

const pluginRoot = resolve(root, entry.source.path);
assert(statSync(pluginRoot).isDirectory());
const manifest = JSON.parse(readFileSync(resolve(pluginRoot, ".codex-plugin/plugin.json"), "utf8"));
const serverSource = readFileSync(resolve(pluginRoot, "mcp-server/server.mjs"), "utf8");
assert.equal(manifest.name, entry.name);
assert.equal(manifest.version, packageManifest.version);
assert.match(serverSource, new RegExp(`const VERSION = ["']${packageManifest.version.replaceAll(".", "\\.")}["'];`));
assert.equal(manifest.mcpServers, "./.mcp.json");
assert(statSync(resolve(pluginRoot, "mcp-server/server.mjs")).isFile());
assert(statSync(resolve(pluginRoot, "skills/grok-subagent/SKILL.md")).isFile());

console.log("Marketplace and plugin layout are valid.");

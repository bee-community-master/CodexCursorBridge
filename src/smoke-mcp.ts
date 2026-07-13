import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const distDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(distDir, "..");
const home = await mkdtemp(path.join(os.tmpdir(), "cursor-mcp-smoke-"));
const env = Object.fromEntries(
  Object.entries({ ...process.env, CURSOR_BRIDGE_ROOT: projectRoot, CURSOR_BRIDGE_HOME: home })
    .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(distDir, "mcp.js")],
  cwd: projectRoot,
  env,
  stderr: "pipe",
});
const client = new Client({ name: "cursor-bridge-smoke", version: "0.1.0" });
try {
  await client.connect(transport);
  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name).sort();
  const expected = ["cursor_cancel_task", "cursor_get_report", "cursor_get_task", "cursor_start_task"];
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(`Unexpected MCP tools: ${names.join(", ")}`);
  }
  process.stdout.write(`MCP smoke passed: ${names.join(", ")}\n`);
} finally {
  await client.close();
}

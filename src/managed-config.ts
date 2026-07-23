import path from "node:path";
import process from "node:process";

const MCP_BEGIN = "# BEGIN cursor-bridge managed main MCP";
const MCP_END = "# END cursor-bridge managed main MCP";
const LEGACY_AGENT_BEGIN = "# BEGIN cursor-bridge managed CURSOR agent";
const LEGACY_AGENT_END = "# END cursor-bridge managed CURSOR agent";

function escapeToml(value: string): string {
  const escapedControls: Record<string, string> = {
    "\b": "\\b",
    "\t": "\\t",
    "\n": "\\n",
    "\f": "\\f",
    "\r": "\\r",
  };
  let escaped = "";
  for (const character of value) {
    if (character === "\\") {
      escaped += "\\\\";
    } else if (character === '"') {
      escaped += '\\"';
    } else {
      const codePoint = character.codePointAt(0)!;
      escaped += codePoint <= 0x1f || codePoint === 0x7f
        ? escapedControls[character]
          ?? `\\u${codePoint.toString(16).padStart(4, "0")}`
        : character;
    }
  }
  return escaped;
}

function removeBlock(content: string, begin: string, end: string): string {
  let start = content.indexOf(begin);
  if (start < 0) return content;
  const endMarker = content.indexOf(end, start);
  if (endMarker < 0) throw new Error(`Malformed cursor-bridge managed block: ${begin}`);
  if (start > 0 && content.slice(start - 2, start) === "\n\n") start -= 1;
  const after = endMarker + end.length + (content[endMarker + end.length] === "\n" ? 1 : 0);
  return content.slice(0, start) + content.slice(after);
}

function mcpBlock(projectRoot: string): string {
  const root = path.resolve(projectRoot);
  const mcpScript = path.join(root, "dist", "mcp.js");
  return `${MCP_BEGIN}
[mcp_servers.cursor_bridge]
command = "${escapeToml(process.execPath)}"
args = ["${escapeToml(mcpScript)}"]
cwd = "${escapeToml(root)}"
env = { CURSOR_BRIDGE_ROOT = "${escapeToml(root)}" }
enabled_tools = ["cursor_start_task", "cursor_get_task", "cursor_cancel_task", "cursor_get_report"]
startup_timeout_sec = 20
tool_timeout_sec = 45
default_tools_approval_mode = "approve"
${MCP_END}
`;
}

export function removeManagedRegistrationBlocks(content: string): string {
  return removeBlock(
    removeBlock(content, MCP_BEGIN, MCP_END),
    LEGACY_AGENT_BEGIN,
    LEGACY_AGENT_END,
  );
}

export function upsertManagedMcpBlock(content: string, projectRoot: string): string {
  const clean = removeManagedRegistrationBlocks(content);
  const separator = clean.length === 0 || clean.endsWith("\n\n") ? "" : clean.endsWith("\n") ? "\n" : "\n\n";
  return `${clean}${separator}${mcpBlock(projectRoot)}`;
}

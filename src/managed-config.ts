const BEGIN = "# BEGIN cursor-bridge managed CURSOR agent";
const END = "# END cursor-bridge managed CURSOR agent";

function escapeToml(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function block(configFile: string): string {
  return `${BEGIN}\n[agents.cursor]\ndescription = "Delegates approved coding tasks to Cursor through the Cursor Bridge MCP"\nconfig_file = "${escapeToml(configFile)}"\n${END}\n`;
}

export function removeManagedAgentBlock(content: string): string {
  let start = content.indexOf(BEGIN);
  if (start < 0) return content;
  const endMarker = content.indexOf(END, start);
  if (endMarker < 0) throw new Error("Malformed cursor-bridge managed block");
  if (start > 0 && content.slice(start - 2, start) === "\n\n") start -= 1;
  const after = endMarker + END.length + (content[endMarker + END.length] === "\n" ? 1 : 0);
  return content.slice(0, start) + content.slice(after);
}

export function upsertManagedAgentBlock(content: string, configFile: string): string {
  const clean = removeManagedAgentBlock(content);
  const separator = clean.length === 0 || clean.endsWith("\n\n") ? "" : clean.endsWith("\n") ? "\n" : "\n\n";
  return `${clean}${separator}${block(configFile)}`;
}

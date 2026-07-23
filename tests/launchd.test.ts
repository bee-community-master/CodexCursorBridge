import { describe, expect, it } from "vitest";
import { SUPERVISOR_LABEL, renderSupervisorPlist } from "../src/launchd.js";

describe("launchd supervisor registration", () => {
  it("renders an owner-local durable supervisor with a minimal environment", () => {
    const plist = renderSupervisorPlist(
      "/Users/example/bridge",
      "/Users/example/.config/codex-cursor-bridge",
      "/opt/homebrew/bin/node",
    );

    expect(plist).toContain(`<string>${SUPERVISOR_LABEL}</string>`);
    expect(plist).toContain("/Users/example/bridge/dist/supervisor.js");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<true/>");
    expect(plist).toContain("CURSOR_BRIDGE_HOME");
    expect(plist).not.toContain("GH_TOKEN");
    expect(plist).not.toContain("CURSOR_BRIDGE_API_KEY");
  });
});

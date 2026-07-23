import { link, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  SUPERVISOR_LABEL,
  isMissingLaunchdService,
  renderSupervisorPlist,
  writeSupervisorPlist,
} from "../src/launchd.js";

describe("launchd supervisor registration", () => {
  it("renders an owner-local durable supervisor with a minimal environment", () => {
    const plist = renderSupervisorPlist(
      "/Users/example/bridge",
      "/Users/example/.config/codex-cursor-bridge",
      "/opt/homebrew/bin/node",
      ":relative-bin:/opt/homebrew/bin:/usr/bin",
    );

    expect(plist).toContain(`<string>${SUPERVISOR_LABEL}</string>`);
    expect(plist).toContain("/Users/example/bridge/dist/supervisor.js");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<true/>");
    expect(plist).toContain("<key>Umask</key>");
    expect(plist).toContain("<integer>63</integer>");
    expect(plist).toContain("CURSOR_BRIDGE_HOME");
    expect(plist).toContain("<string>/opt/homebrew/bin:/usr/bin</string>");
    expect(plist).not.toContain("relative-bin");
    expect(plist).not.toContain("GH_TOKEN");
    expect(plist).not.toContain("CURSOR_BRIDGE_API_KEY");
  });

  it("treats only launchd's service-not-found status as an absent service", () => {
    expect(isMissingLaunchdService({ code: 113 })).toBe(true);
    expect(isMissingLaunchdService({ code: 1 })).toBe(false);
    expect(isMissingLaunchdService(new Error("launchctl unavailable"))).toBe(false);
  });

  it("atomically replaces the managed plist without following file links", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cursor-launchd-file-"));
    const target = path.join(directory, "shared.plist");
    const hardLink = path.join(directory, "hard.plist");
    const symbolicLink = path.join(directory, "symbolic.plist");
    await writeFile(target, "keep\n", "utf8");
    await link(target, hardLink);
    await symlink(target, symbolicLink);

    await writeSupervisorPlist(hardLink, "managed hard link\n");
    await writeSupervisorPlist(symbolicLink, "managed symbolic link\n");

    expect(await readFile(target, "utf8")).toBe("keep\n");
    expect(await readFile(hardLink, "utf8")).toBe("managed hard link\n");
    expect(await readFile(symbolicLink, "utf8")).toBe("managed symbolic link\n");
  });
});

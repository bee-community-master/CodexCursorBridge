import { describe, expect, it } from "vitest";
import {
  isMissingKeychainItem,
  keychainReadError,
  keychainStoreRequest,
} from "../src/keychain.js";

describe("Keychain credential storage", () => {
  it("uses the native interactive prompt without a password argument", () => {
    const request = keychainStoreRequest();

    expect(request.command).toBe("/usr/bin/security");
    expect(request.args.at(-1)).toBe("-w");
    expect(request.args).toEqual([
      "add-generic-password",
      "-U",
      "-s",
      "codex-cursor-bridge",
      "-a",
      "cursor-api-key",
      "-w",
    ]);
  });

  it("treats only the macOS item-not-found exit code as idempotent deletion", () => {
    expect(isMissingKeychainItem({ code: 44 })).toBe(true);
    expect(isMissingKeychainItem({ code: 1 })).toBe(false);
    expect(isMissingKeychainItem(new Error("security unavailable"))).toBe(false);
  });

  it("distinguishes an absent API key from other Keychain read failures", () => {
    expect(keychainReadError({ code: 44 }).message).toMatch(/not configured/i);
    expect(keychainReadError({ code: 36 }).message).toMatch(/could not be read/i);
    expect(keychainReadError(new Error("security unavailable")).message).toMatch(/could not be read/i);
  });
});

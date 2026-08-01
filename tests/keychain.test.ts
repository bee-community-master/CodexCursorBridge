import { describe, expect, it, vi } from "vitest";
import {
  ensureCursorApiKey,
  isMissingKeychainItem,
  keychainReadError,
  keychainStoreRequest,
} from "../src/keychain.js";

const withoutLock = <T>(work: () => Promise<T>): Promise<T> => work();

describe("Keychain credential storage", () => {
  it("uses the native interactive prompt without a password or update argument", () => {
    const request = keychainStoreRequest();

    expect(request.command).toBe("/usr/bin/security");
    expect(request.args.at(-1)).toBe("-w");
    expect(request.args).toEqual([
      "add-generic-password",
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

  it("reuses a non-empty key without prompting or storing", async () => {
    const prompt = vi.fn();
    const store = vi.fn();
    const inspect = vi.fn().mockResolvedValue({ kind: "present", value: "cursor-secret" as string });

    await expect(ensureCursorApiKey({ inspect, prompt, store, withLock: withoutLock })).resolves.toBe("cursor-secret");
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(prompt).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
  });

  it("prompts and stores only when the item is missing", async () => {
    const prompt = vi.fn();
    const store = vi.fn().mockResolvedValue(undefined);
    const inspect = vi.fn()
      .mockResolvedValueOnce({ kind: "missing" as const })
      .mockResolvedValueOnce({ kind: "present" as const, value: "new-secret" });

    await expect(ensureCursorApiKey({ inspect, prompt, store, withLock: withoutLock })).resolves.toBe("new-secret");
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(store).toHaveBeenCalledTimes(1);
  });

  it("prompts and stores only when the item is empty", async () => {
    const prompt = vi.fn();
    const store = vi.fn().mockResolvedValue(undefined);
    const inspect = vi.fn()
      .mockResolvedValueOnce({ kind: "empty" as const })
      .mockResolvedValueOnce({ kind: "present" as const, value: "repaired-secret" });

    await expect(ensureCursorApiKey({ inspect, prompt, store, withLock: withoutLock })).resolves.toBe("repaired-secret");
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(store).toHaveBeenCalledTimes(1);
  });

  it("keeps a valid key if an interactive store aborts after a race", async () => {
    const prompt = vi.fn();
    const store = vi.fn().mockRejectedValue(new Error("Keychain command exited with code 1; password=cursor-secret"));
    const inspect = vi.fn()
      .mockResolvedValueOnce({ kind: "empty" as const })
      .mockResolvedValueOnce({ kind: "present" as const, value: "cursor-secret" });

    await expect(ensureCursorApiKey({ inspect, prompt, store, withLock: withoutLock })).resolves.toBe("cursor-secret");
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(store).toHaveBeenCalledTimes(1);
  });

  it("redacts store failures and stops when no key was written", async () => {
    const prompt = vi.fn();
    const store = vi.fn().mockRejectedValue(new Error("Keychain command exited with code 1; password=cursor-secret"));
    const inspect = vi.fn()
      .mockResolvedValueOnce({ kind: "missing" as const })
      .mockResolvedValueOnce({ kind: "missing" as const });

    await expect(ensureCursorApiKey({ inspect, prompt, store, withLock: withoutLock })).rejects.toThrow(/could not be stored/i);
    await expect(ensureCursorApiKey({
      inspect: vi.fn()
        .mockResolvedValueOnce({ kind: "missing" as const })
        .mockResolvedValueOnce({ kind: "missing" as const }),
      prompt,
      store,
      withLock: withoutLock,
    })).rejects.not.toThrow("cursor-secret");
  });
});

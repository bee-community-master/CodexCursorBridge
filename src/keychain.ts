import { runFile } from "./git.js";

export const keychainService = "codex-cursor-bridge";
export const keychainAccount = "cursor-api-key";

export async function readCursorApiKey(): Promise<string> {
  if (process.env.CURSOR_BRIDGE_API_KEY) return process.env.CURSOR_BRIDGE_API_KEY;
  if (process.platform !== "darwin") throw new Error("macOS Keychain is required in v1");
  try {
    const result = await runFile("security", [
      "find-generic-password", "-s", keychainService, "-a", keychainAccount, "-w",
    ]);
    const key = result.stdout.trim();
    if (!key) throw new Error("empty key");
    return key;
  } catch {
    throw new Error("Cursor API key is not configured; run pnpm bootstrap");
  }
}

export async function storeCursorApiKey(key: string): Promise<void> {
  if (process.platform !== "darwin") throw new Error("macOS Keychain is required in v1");
  if (!key.trim()) throw new Error("Cursor API key cannot be empty");
  await runFile("security", [
    "add-generic-password", "-U", "-s", keychainService, "-a", keychainAccount, "-w", key.trim(),
  ]);
}

export async function deleteCursorApiKey(): Promise<void> {
  if (process.platform !== "darwin") return;
  try {
    await runFile("security", ["delete-generic-password", "-s", keychainService, "-a", keychainAccount]);
  } catch {
    // Idempotent uninstall: an absent key is already removed.
  }
}

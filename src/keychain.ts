import { spawn } from "node:child_process";
import { runFile } from "./git.js";

export const keychainService = "codex-cursor-bridge";
export const keychainAccount = "cursor-api-key";
const securityCommand = "/usr/bin/security";

interface KeychainStoreRequest {
  command: string;
  args: string[];
}

export function keychainStoreRequest(): KeychainStoreRequest {
  return {
    command: securityCommand,
    args: [
      "add-generic-password",
      "-U",
      "-s",
      keychainService,
      "-a",
      keychainAccount,
      "-w",
    ],
  };
}

export function isMissingKeychainItem(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === 44;
}

export function keychainReadError(error: unknown): Error {
  return isMissingKeychainItem(error)
    ? new Error("Cursor API key is not configured; run pnpm bootstrap", { cause: error })
    : new Error("Cursor API key could not be read from macOS Keychain", { cause: error });
}

async function executeKeychainStore(request: KeychainStoreRequest): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(request.command, request.args, {
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Keychain command exited with code ${code ?? "unknown"}`));
    });
  });
}

export async function readCursorApiKey(): Promise<string> {
  if (process.platform !== "darwin") throw new Error("macOS Keychain is required in v1");
  try {
    const result = await runFile(securityCommand, [
      "find-generic-password", "-s", keychainService, "-a", keychainAccount, "-w",
    ]);
    const key = result.stdout.trim();
    if (!key) throw new Error("empty key");
    return key;
  } catch (error) {
    throw keychainReadError(error);
  }
}

export async function storeCursorApiKey(): Promise<void> {
  if (process.platform !== "darwin") throw new Error("macOS Keychain is required in v1");
  if (!process.stdin.isTTY) {
    throw new Error("Interactive terminal is required for Keychain password input");
  }
  await executeKeychainStore(keychainStoreRequest());
}

export async function deleteCursorApiKey(): Promise<void> {
  if (process.platform !== "darwin") return;
  try {
    await runFile(securityCommand, [
      "delete-generic-password",
      "-s",
      keychainService,
      "-a",
      keychainAccount,
    ]);
  } catch (error) {
    if (!isMissingKeychainItem(error)) throw error;
  }
}

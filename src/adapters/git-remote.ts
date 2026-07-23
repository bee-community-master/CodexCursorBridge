import { git } from "./git-runtime.js";

function matchesExpectedOrigin(
  remoteUrl: string,
  expectedOrigin: string,
): boolean {
  try {
    return githubOriginSlug(remoteUrl) === expectedOrigin;
  } catch {
    return false;
  }
}

async function assertRemoteMatches(
  root: string,
  expectedOrigin: string,
  direction: "fetch" | "push",
): Promise<void> {
  const args = direction === "push"
    ? ["remote", "get-url", "--push", "--all", "origin"]
    : ["remote", "get-url", "--all", "origin"];
  const urls = (await git(root, ...args))
    .split(/\r?\n/)
    .filter(Boolean);
  if (
    urls.length !== 1
    || !urls.every((url) => matchesExpectedOrigin(url, expectedOrigin))
  ) {
    throw new Error(`Git ${direction} remote does not match the registered repository`);
  }
}

export async function assertGitHubRemote(
  root: string,
  expectedOrigin: string,
): Promise<void> {
  await assertRemoteMatches(root, expectedOrigin, "fetch");
  await assertRemoteMatches(root, expectedOrigin, "push");
}

export function githubOriginSlug(originUrl: string): string {
  const scp = originUrl.match(/^git@github\.com:([^?#]+)$/i);
  let repositoryPath: string;
  if (scp?.[1]) {
    repositoryPath = scp[1];
  } else {
    let parsed: URL;
    try {
      parsed = new URL(originUrl);
    } catch {
      throw new Error("Origin is not a GitHub repository");
    }
    if (
      parsed.hostname.toLowerCase() !== "github.com"
      || !["https:", "ssh:"].includes(parsed.protocol)
      || parsed.search
      || parsed.hash
    ) {
      throw new Error("Origin is not a GitHub repository");
    }
    if (
      parsed.password
      || (parsed.protocol === "https:" && parsed.username)
      || (parsed.protocol === "ssh:" && parsed.username !== "git")
    ) {
      throw new Error("GitHub remote URLs may not contain embedded credentials");
    }
    repositoryPath = parsed.pathname;
  }
  const normalized = repositoryPath
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "");
  const parts = normalized.split("/");
  if (
    parts.length !== 2
    || parts.some((part) => !part || part === "." || part === ".." || /\s/.test(part))
  ) {
    throw new Error("Origin is not a GitHub repository");
  }
  return normalized;
}

import { git } from "./git-runtime.js";

export async function assertGitHubRemote(
  root: string,
  expectedOrigin: string,
): Promise<void> {
  const fetchUrls = (await git(root, "remote", "get-url", "--all", "origin"))
    .split(/\r?\n/)
    .filter(Boolean);
  if (
    fetchUrls.length !== 1
    || fetchUrls.some((url) => {
      try {
        return githubOriginSlug(url) !== expectedOrigin;
      } catch {
        return true;
      }
    })
  ) {
    throw new Error("Git fetch remote does not match the registered repository");
  }
  const pushUrls = (await git(
    root,
    "remote",
    "get-url",
    "--push",
    "--all",
    "origin",
  )).split(/\r?\n/).filter(Boolean);
  if (
    pushUrls.length !== 1
    || pushUrls.some((url) => {
      try {
        return githubOriginSlug(url) !== expectedOrigin;
      } catch {
        return true;
      }
    })
  ) {
    throw new Error("Git push remote does not match the registered repository");
  }
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

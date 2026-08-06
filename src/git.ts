export { runFile } from "./adapters/command-runner.js";
export type { CommandResult } from "./adapters/command-runner.js";
export {
  collectChanges,
  collectTreeChanges,
  computeCandidateTree,
  computeContextDigest,
} from "./adapters/git-candidate.js";
export { git } from "./adapters/git-runtime.js";
export {
  assertGitHubRemote,
  githubOriginSlug,
} from "./adapters/git-remote.js";
export {
  assertStandaloneCloneIdentity,
  assertWorktreeIdentity,
  captureWorktreeIdentity,
} from "./adapters/git-worktree-identity.js";
export type {
  CandidateTree,
  CollectedChanges,
  WorktreeIdentity,
} from "./application/workflow-ports.js";

import { execSync } from "node:child_process";
import path from "node:path";

export function resolveWorkspaceRoot(cwd = process.cwd()) {
  try {
    const gitRoot = execSync("git rev-parse --show-toplevel", {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    if (gitRoot) {
      return gitRoot;
    }
  } catch {
    // Not a git repository
  }

  return path.resolve(cwd);
}

export function resolveWorkspaceName(cwd = process.cwd()) {
  const root = resolveWorkspaceRoot(cwd);
  return path.basename(root) || "workspace";
}

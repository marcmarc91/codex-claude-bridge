import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

async function resolveCanonicalProjectPath(workingDirectory: string): Promise<string> {
  try {
    const { stdout } = await executeFile(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: workingDirectory },
    );
    return realpath(stdout.trim());
  } catch {
    return realpath(workingDirectory);
  }
}

export async function resolveProjectIdentity(workingDirectory: string): Promise<string> {
  const canonicalProjectPath = await resolveCanonicalProjectPath(workingDirectory);
  return createHash("sha256").update(canonicalProjectPath).digest("hex").slice(0, 24);
}

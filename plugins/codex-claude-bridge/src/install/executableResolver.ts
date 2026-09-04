import { constants } from "node:fs";
import { access, lstat, readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export interface InstallerExecutables {
  node: string;
  npm: string;
  codex: string;
  claude: string;
}

export type VersionTuple = [number, number, number];

export async function resolvePathExecutable(
  executableName: string,
  environmentPath: string,
): Promise<string | undefined> {
  for (const pathDirectory of environmentPath.split(":")) {
    if (!isAbsolute(pathDirectory)) {
      continue;
    }
    const candidatePath = join(pathDirectory, executableName);
    try {
      await access(candidatePath, constants.X_OK);
      const status = await lstat(candidatePath);
      if (status.isFile() || status.isSymbolicLink()) {
        return candidatePath;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

export function parseVersionTuple(value: string): VersionTuple | undefined {
  const match = value.match(/(\d+)\.(\d+)\.(\d+)/u);
  if (match === null) {
    return undefined;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareVersionTuple(
  first: VersionTuple,
  second: VersionTuple,
): number {
  for (let index = 0; index < first.length; index += 1) {
    if (first[index] !== second[index]) {
      return first[index] - second[index];
    }
  }
  return 0;
}

export function versionAtLeast(
  detected: VersionTuple,
  minimum: VersionTuple,
): boolean {
  return compareVersionTuple(detected, minimum) >= 0;
}

export async function resolveClaudeExecutable(options: {
  homeDirectory: string;
  environmentPath: string;
}): Promise<string> {
  const pathExecutable = await resolvePathExecutable(
    "claude",
    options.environmentPath,
  );
  if (pathExecutable !== undefined) {
    return pathExecutable;
  }
  const userLocalExecutable = join(
    options.homeDirectory,
    ".local",
    "bin",
    "claude",
  );
  try {
    await access(userLocalExecutable, constants.X_OK);
    return userLocalExecutable;
  } catch {
    const extensionDirectory = join(
      options.homeDirectory,
      ".vscode",
      "extensions",
    );
    let entries;
    try {
      entries = await readdir(extensionDirectory, { withFileTypes: true });
    } catch {
      throw new Error("Unable to resolve the Claude executable");
    }
    const candidates = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        name: entry.name,
        version: parseVersionTuple(entry.name),
      }))
      .filter(
        (entry): entry is { name: string; version: VersionTuple } =>
          entry.name.startsWith("anthropic.claude-code-") &&
          entry.version !== undefined,
      )
      .sort((first, second) =>
        compareVersionTuple(second.version, first.version),
      );
    for (const candidate of candidates) {
      const candidatePath = join(
        extensionDirectory,
        candidate.name,
        "resources",
        "native-binary",
        "claude",
      );
      try {
        await access(candidatePath, constants.X_OK);
        return candidatePath;
      } catch {
        continue;
      }
    }
    throw new Error("Unable to resolve the Claude executable");
  }
}

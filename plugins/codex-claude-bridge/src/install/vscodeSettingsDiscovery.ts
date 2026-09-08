import { lstat } from "node:fs/promises";
import { join } from "node:path";

const supportedEditorDirectoryNames = [
  "Code",
  "Code - Insiders",
  "Cursor",
  "Windsurf",
] as const;

const userSettingsFileName = "settings.json";

export function vscodeUserSettingsPath(
  homeDirectory: string,
  editorDirectoryName: string,
  platform: NodeJS.Platform,
): string {
  if (platform === "darwin") {
    return join(
      homeDirectory,
      "Library",
      "Application Support",
      editorDirectoryName,
      "User",
      userSettingsFileName,
    );
  }
  return join(
    homeDirectory,
    ".config",
    editorDirectoryName,
    "User",
    userSettingsFileName,
  );
}

async function pathExists(candidatePath: string): Promise<boolean> {
  try {
    await lstat(candidatePath);
    return true;
  } catch {
    return false;
  }
}

export async function discoverVscodeUserSettingsPaths(
  homeDirectory: string,
  platform: NodeJS.Platform,
): Promise<string[]> {
  const discoveredSettingsPaths: string[] = [];
  for (const editorDirectoryName of supportedEditorDirectoryNames) {
    const settingsPath = vscodeUserSettingsPath(
      homeDirectory,
      editorDirectoryName,
      platform,
    );
    if (await pathExists(settingsPath)) {
      discoveredSettingsPaths.push(settingsPath);
    }
  }
  return discoveredSettingsPaths;
}

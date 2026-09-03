import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

import { uuidSchema } from "../protocol/messageEnvelope.js";

export interface ClaudeSessionMetadata {
  pid: number;
  sessionId: string;
  name: string;
  cwd: string;
}

const absolutePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => isAbsolute(value) && !value.includes("\0"));

const claudeSessionMetadataSchema = z
  .object({
    pid: z.number().int().safe().positive(),
    sessionId: uuidSchema,
    name: z
      .string()
      .max(256)
      .refine((value) => value.trim().length > 0 && !value.includes("\0")),
    cwd: absolutePathSchema,
  })
  .strip();

function validateParentProcessIdentifier(parentProcessIdentifier: number): number {
  return z.number().int().safe().positive().parse(parentProcessIdentifier);
}

function validateHomeDirectory(homeDirectory: string): string {
  if (!isAbsolute(homeDirectory) || homeDirectory.includes("\0")) {
    throw new TypeError("Claude home directory must be an absolute path");
  }

  return resolve(homeDirectory);
}

async function verifyMetadataDirectory(directoryPath: string): Promise<void> {
  const directoryStatus = await lstat(directoryPath);
  if (
    directoryStatus.isSymbolicLink() ||
    !directoryStatus.isDirectory() ||
    (typeof process.getuid === "function" && directoryStatus.uid !== process.getuid())
  ) {
    throw new Error("Claude session metadata directory is not trusted");
  }
  if ((await realpath(directoryPath)) !== directoryPath) {
    throw new Error("Claude session metadata directory is not canonical");
  }
}

export async function readOwningClaudeSessionMetadata(
  parentProcessIdentifier: number,
  homeDirectory = homedir(),
): Promise<ClaudeSessionMetadata> {
  const validatedProcessIdentifier = validateParentProcessIdentifier(
    parentProcessIdentifier,
  );
  const validatedHomeDirectory = await realpath(validateHomeDirectory(homeDirectory));
  const claudeDirectory = join(validatedHomeDirectory, ".claude");
  const sessionsDirectory = join(claudeDirectory, "sessions");
  await verifyMetadataDirectory(validatedHomeDirectory);
  await verifyMetadataDirectory(claudeDirectory);
  await verifyMetadataDirectory(sessionsDirectory);

  const metadataPath = join(sessionsDirectory, `${validatedProcessIdentifier}.json`);
  const metadataFile = await open(
    metadataPath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );

  try {
    const metadataStatus = await metadataFile.stat();
    if (
      !metadataStatus.isFile() ||
      (typeof process.getuid === "function" && metadataStatus.uid !== process.getuid()) ||
      metadataStatus.size > 65_536
    ) {
      throw new Error("Claude session metadata file is not trusted");
    }

    const parsedMetadata = claudeSessionMetadataSchema.parse(
      JSON.parse(await metadataFile.readFile("utf8")) as unknown,
    );
    if (parsedMetadata.pid !== validatedProcessIdentifier) {
      throw new Error("Claude session metadata PID does not match its path");
    }

    return parsedMetadata;
  } finally {
    await metadataFile.close();
  }
}

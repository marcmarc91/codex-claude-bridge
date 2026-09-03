import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function acquireInheritedDescriptorLock(
  fileDescriptor: number,
  timeoutSeconds: number,
): Promise<number | null> {
  return new Promise((resolveProcess, rejectProcess) => {
    const lockProcess = spawn(
      "/usr/bin/lockf",
      ["-s", "-t", String(timeoutSeconds), "3"],
      {
        shell: false,
        stdio: ["ignore", "ignore", "ignore", fileDescriptor],
      },
    );

    lockProcess.once("error", rejectProcess);
    lockProcess.once("close", resolveProcess);
  });
}

test("an inherited lockf descriptor remains locked until the parent file handle closes", async (testContext) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "ccb-lockf-"));
  const lockFilePath = join(temporaryDirectory, "session.lock");
  const openFlags = constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW;
  const owningFileHandle = await open(lockFilePath, openFlags, 0o600);
  const competingFileHandle = await open(lockFilePath, openFlags, 0o600);

  testContext.after(async () => {
    await owningFileHandle.close().catch(() => undefined);
    await competingFileHandle.close().catch(() => undefined);
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  assert.equal(await acquireInheritedDescriptorLock(owningFileHandle.fd, 0), 0);
  assert.equal(await acquireInheritedDescriptorLock(competingFileHandle.fd, 0), 75);

  await owningFileHandle.close();

  assert.equal(await acquireInheritedDescriptorLock(competingFileHandle.fd, 0), 0);
});

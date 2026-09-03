import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createPrivateRegularFile,
  ensurePrivateBridgeDirectory,
  prepareSecureBridgeState,
  verifyPrivateRegularFileDescriptor,
} from "../src/registry/secureStateFilesystem.js";

test("descriptor checks reject bridge directories and files owned by another user", async (testContext) => {
  const stateHomeDirectory = await mkdtemp(join(tmpdir(), "ccb-owner-"));
  testContext.after(() => rm(stateHomeDirectory, { recursive: true, force: true }));

  const bridgeStateContext = await prepareSecureBridgeState(stateHomeDirectory);
  const sessionsDirectory = join(bridgeStateContext.bridgeStateDirectory, "sessions");
  await ensurePrivateBridgeDirectory(bridgeStateContext, sessionsDirectory, true);
  const privateFilePath = join(sessionsDirectory, "ownership-check");
  const privateFile = await createPrivateRegularFile(
    bridgeStateContext,
    privateFilePath,
  );

  await assert.rejects(() =>
    verifyPrivateRegularFileDescriptor(
      privateFile.fileHandle,
      privateFilePath,
      bridgeStateContext.userIdentifier + 1,
    ),
  );
  await privateFile.fileHandle.close();

  const unexpectedOwnerContext = {
    ...bridgeStateContext,
    userIdentifier: bridgeStateContext.userIdentifier + 1,
  };

  await assert.rejects(() =>
    ensurePrivateBridgeDirectory(
      unexpectedOwnerContext,
      sessionsDirectory,
      false,
    ),
  );
});

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

import { resolvePathExecutable } from "../src/install/executableResolver.js";

test("resolves executable files only from absolute PATH directories", async (testContext) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "ccb-executable-"));
  testContext.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const executablePath = join(temporaryDirectory, "bridge-command");
  await writeFile(executablePath, "executable", { mode: 0o700 });

  assert.equal(
    await resolvePathExecutable("bridge-command", temporaryDirectory),
    executablePath,
  );
  assert.equal(
    await resolvePathExecutable(
      "bridge-command",
      relative(process.cwd(), temporaryDirectory),
    ),
    undefined,
  );
});

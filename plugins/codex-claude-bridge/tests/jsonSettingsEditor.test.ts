import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  compareAndSwapJsonStringSetting,
  readJsonSetting,
  updateJsonStringSetting,
} from "../src/install/jsonSettingsEditor.js";

const settingName = "claudeCode.claudeProcessWrapper";

test("preserves JSONC comments, trailing commas, unrelated settings, and file mode", async (testContext) => {
  const temporaryDirectory = await realpath(await mkdtemp(join(tmpdir(), "ccb-jsonc-")));
  testContext.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const settingsPath = join(temporaryDirectory, "settings.json");
  await writeFile(
    settingsPath,
    [
      "{",
      "  // retained",
      '  "editor.fontSize": 15,',
      "}",
      "",
    ].join("\n"),
  );
  await chmod(settingsPath, 0o640);

  const previousSetting = await updateJsonStringSetting({
    settingsPath,
    settingName,
    value: "/global/bin/claude-code-bridge-wrapper",
  });

  const updatedText = await readFile(settingsPath, "utf8");
  assert.deepEqual(previousSetting, { fileExisted: true, present: false });
  assert.match(updatedText, /\/\/ retained/u);
  assert.match(updatedText, /"editor\.fontSize": 15,/u);
  assert.match(
    updatedText,
    /"claudeCode\.claudeProcessWrapper": "\/global\/bin\/claude-code-bridge-wrapper"/u,
  );
  assert.equal((await lstat(settingsPath)).mode & 0o777, 0o640);
});

test("restores or removes the prior value only when the installed value still matches", async (testContext) => {
  const temporaryDirectory = await realpath(await mkdtemp(join(tmpdir(), "ccb-jsonc-cas-")));
  testContext.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const settingsPath = join(temporaryDirectory, "settings.json");
  await writeFile(
    settingsPath,
    JSON.stringify({ [settingName]: "/previous/wrapper", keep: true }, null, 2),
  );
  await updateJsonStringSetting({
    settingsPath,
    settingName,
    value: "/installed/wrapper",
  });

  assert.equal(
    await compareAndSwapJsonStringSetting({
      settingsPath,
      settingName,
      expectedValue: "/installed/wrapper",
      replacement: { present: true, value: "/previous/wrapper" },
    }),
    "updated",
  );
  assert.deepEqual(await readJsonSetting(settingsPath, settingName), {
    fileExisted: true,
    present: true,
    value: "/previous/wrapper",
  });

  await updateJsonStringSetting({
    settingsPath,
    settingName,
    value: "/user/took-over",
  });
  assert.equal(
    await compareAndSwapJsonStringSetting({
      settingsPath,
      settingName,
      expectedValue: "/installed/wrapper",
      replacement: { present: false },
    }),
    "conflict",
  );
  assert.equal(
    (await readJsonSetting(settingsPath, settingName)).value,
    "/user/took-over",
  );
});

test("creates a private settings file atomically when it is absent", async (testContext) => {
  const temporaryDirectory = await realpath(await mkdtemp(join(tmpdir(), "ccb-jsonc-new-")));
  testContext.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const settingsPath = join(temporaryDirectory, "Code", "User", "settings.json");

  const previousSetting = await updateJsonStringSetting({
    settingsPath,
    settingName,
    value: "/installed/wrapper",
  });

  assert.deepEqual(previousSetting, { fileExisted: false, present: false });
  assert.equal((await lstat(settingsPath)).mode & 0o777, 0o600);
  assert.equal(
    (await readJsonSetting(settingsPath, settingName)).value,
    "/installed/wrapper",
  );
});

test("does not replace the settings file when the requested value is already installed", async (testContext) => {
  const temporaryDirectory = await realpath(await mkdtemp(join(tmpdir(), "ccb-jsonc-noop-")));
  testContext.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const settingsPath = join(temporaryDirectory, "settings.json");
  await writeFile(
    settingsPath,
    JSON.stringify({ [settingName]: "/installed/wrapper" }, null, 2),
  );
  const inodeBeforeUpdate = (await lstat(settingsPath)).ino;

  await updateJsonStringSetting({
    settingsPath,
    settingName,
    value: "/installed/wrapper",
  });

  assert.equal((await lstat(settingsPath)).ino, inodeBeforeUpdate);
});

test("refuses symlinks, duplicate keys, invalid JSONC, and non-string wrapper values", async (testContext) => {
  const temporaryDirectory = await realpath(await mkdtemp(join(tmpdir(), "ccb-jsonc-refuse-")));
  testContext.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const targetPath = join(temporaryDirectory, "target.json");
  const symlinkPath = join(temporaryDirectory, "settings.json");
  await writeFile(targetPath, "{}\n");
  await symlink(targetPath, symlinkPath);

  await assert.rejects(
    updateJsonStringSetting({
      settingsPath: symlinkPath,
      settingName,
      value: "/installed/wrapper",
    }),
    /symbolic link/u,
  );

  const invalidInputs = [
    `{ "${settingName}": "/one", "${settingName}": "/two" }`,
    `{ "${settingName}": }`,
    `{ "${settingName}": false }`,
  ];
  for (const [index, input] of invalidInputs.entries()) {
    const invalidPath = join(temporaryDirectory, `invalid-${index}.json`);
    await writeFile(invalidPath, input);
    await assert.rejects(
      updateJsonStringSetting({
        settingsPath: invalidPath,
        settingName,
        value: "/installed/wrapper",
      }),
    );
  }
});

test("rejects a concurrent settings save without overwriting it", async (testContext) => {
  const temporaryDirectory = await realpath(await mkdtemp(join(tmpdir(), "ccb-jsonc-race-")));
  testContext.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const settingsPath = join(temporaryDirectory, "settings.json");
  await writeFile(settingsPath, '{ "keep": "before" }\n');

  await assert.rejects(
    updateJsonStringSetting({
      settingsPath,
      settingName,
      value: "/installed/wrapper",
      beforeReplace: async () => {
        await writeFile(settingsPath, '{ "keep": "user-save" }\n');
      },
    }),
    /changed concurrently/u,
  );
  assert.equal(await readFile(settingsPath, "utf8"), '{ "keep": "user-save" }\n');
});

test("cleans its temporary file when atomic rename fails", async (testContext) => {
  const temporaryDirectory = await realpath(await mkdtemp(join(tmpdir(), "ccb-jsonc-rename-")));
  testContext.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const settingsPath = join(temporaryDirectory, "settings.json");
  await writeFile(settingsPath, "{}\n");

  await assert.rejects(
    updateJsonStringSetting({
      settingsPath,
      settingName,
      value: "/installed/wrapper",
      renameFile: async () => {
        throw new Error("rename denied");
      },
    }),
    /rename denied/u,
  );
  assert.deepEqual(await readdir(temporaryDirectory), ["settings.json"]);
});

test("refuses oversized files and settings below a symbolic-link parent", async (testContext) => {
  const temporaryDirectory = await realpath(await mkdtemp(join(tmpdir(), "ccb-jsonc-path-")));
  testContext.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const oversizedPath = join(temporaryDirectory, "oversized.json");
  await writeFile(oversizedPath, `{ "padding": "${"x".repeat(1024 * 1024)}" }`);
  await assert.rejects(
    readJsonSetting(oversizedPath, settingName),
    /too large/u,
  );

  const realParent = join(temporaryDirectory, "real-parent");
  const linkedParent = join(temporaryDirectory, "linked-parent");
  await mkdir(realParent);
  await writeFile(join(realParent, "settings.json"), "{}\n");
  await symlink(realParent, linkedParent);
  await assert.rejects(
    readJsonSetting(join(linkedParent, "settings.json"), settingName),
    /symbolic link/u,
  );
});

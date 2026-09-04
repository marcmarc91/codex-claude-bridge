#!/usr/bin/env node

import { runClaudeProcessWrapper } from "../wrapper/claudeProcessWrapper.js";

try {
  process.exitCode = await runClaudeProcessWrapper(process.argv.slice(2));
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Claude wrapper failed"}\n`,
  );
  process.exitCode = 1;
}

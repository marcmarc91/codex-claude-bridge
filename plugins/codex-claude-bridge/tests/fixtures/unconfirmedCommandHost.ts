import { spawn } from "node:child_process";

import {
  CommandTerminationUnconfirmedError,
  executeBoundedCommand,
} from "../../src/install/commandExecution.js";

const descendantMarkerPath = process.argv[2];

if (descendantMarkerPath === undefined) {
  throw new Error("Descendant marker path is required");
}

try {
  await executeBoundedCommand(
    {
      executablePath: "/bin/sh",
      arguments: [
        "-c",
        'sleep 5 & echo "$!" > "$1"; wait',
        "bridge-fixture",
        descendantMarkerPath,
      ],
      timeoutMilliseconds: 20,
      maximumOutputBytes: 1024,
    },
    {
      spawnProcess: spawn,
      killProcessGroup: () => {
        const error = new Error("operation not permitted") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      },
      terminationGraceMilliseconds: 20,
    },
  );
  process.exitCode = 1;
} catch (error) {
  process.exitCode = error instanceof CommandTerminationUnconfirmedError ? 0 : 1;
}

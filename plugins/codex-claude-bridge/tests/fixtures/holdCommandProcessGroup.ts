import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const markerPath = process.argv[2];
if (markerPath === undefined) {
  process.exit(2);
}

const descendant = spawn(
  process.execPath,
  ["-e", "setInterval(() => undefined, 1000)"],
  { stdio: ["ignore", "inherit", "inherit"] },
);
writeFileSync(markerPath, String(descendant.pid));
setInterval(() => undefined, 1000);

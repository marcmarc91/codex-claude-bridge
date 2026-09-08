import { withSessionMutationLock } from "../../src/registry/sessionMutationLock.js";

const [stateHomeDirectory, projectIdentifier, sessionIdentifier] = process.argv.slice(2);

if (
  stateHomeDirectory === undefined ||
  projectIdentifier === undefined ||
  sessionIdentifier === undefined
) {
  throw new TypeError("The lock fixture requires state, project, and session identifiers");
}

await withSessionMutationLock(
  stateHomeDirectory,
  projectIdentifier,
  sessionIdentifier,
  async () => {
    process.send?.("acquired");
    setInterval(() => undefined, 1_000_000);
    await new Promise(() => undefined);
  },
);

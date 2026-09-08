import { createMessageStatusStore } from "../../src/conversations/messageStatusStore.js";
import type { AgentAddress } from "../../src/protocol/messageEnvelope.js";

const configuration = JSON.parse(process.argv[2]!) as {
  stateHomeDirectory: string;
  messageId: string;
  recipient: AgentAddress;
  timestamp: string;
  mutation: "accepted" | "seen";
};
const store = createMessageStatusStore({
  stateHomeDirectory: configuration.stateHomeDirectory,
  currentDate: () => new Date(configuration.timestamp),
});
const startSignal = new Promise<void>((resolveStart, rejectStart) => {
  process.once("message", (message) => {
    if (message !== "start") {
      rejectStart(new Error("Unexpected message mutation start signal"));
      return;
    }
    resolveStart();
  });
});
process.send!("ready");
await startSignal;
if (configuration.mutation === "accepted") {
  await store.markAccepted(configuration.messageId);
} else {
  await store.markSeen(configuration.messageId, configuration.recipient);
}
process.disconnect();

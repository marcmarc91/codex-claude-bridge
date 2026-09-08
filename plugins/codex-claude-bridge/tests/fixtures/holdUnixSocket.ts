import { chmodSync } from "node:fs";
import { createServer } from "node:net";

const [socketPath] = process.argv.slice(2);

if (socketPath === undefined) {
  throw new TypeError("The socket fixture requires a socket path");
}

const server = createServer();
server.listen(socketPath, () => {
  chmodSync(socketPath, 0o600);
  process.send?.("listening");
});

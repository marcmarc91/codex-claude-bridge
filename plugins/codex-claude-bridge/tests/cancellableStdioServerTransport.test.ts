import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import { CancellableStdioServerTransport } from "../src/channel/cancellableStdioServerTransport.js";

class ControlledBackpressureOutput extends Writable {
  readonly deliveredChunks: string[] = [];
  private heldWrite:
    | { chunk: Buffer; completeWrite: (error?: Error | null) => void }
    | undefined;
  private resolveWriteStarted: (() => void) | undefined;
  readonly writeStarted = new Promise<void>((resolve) => {
    this.resolveWriteStarted = resolve;
  });

  constructor() {
    super({ highWaterMark: 1 });
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    completeWrite: (error?: Error | null) => void,
  ): void {
    this.heldWrite = { chunk: Buffer.from(chunk), completeWrite };
    this.resolveWriteStarted?.();
  }

  override _destroy(
    error: Error | null,
    completeDestroy: (error?: Error | null) => void,
  ): void {
    this.heldWrite = undefined;
    completeDestroy(error);
  }

  releaseWrite(): void {
    const heldWrite = this.heldWrite;
    if (heldWrite === undefined || this.destroyed) {
      return;
    }
    this.heldWrite = undefined;
    this.deliveredChunks.push(heldWrite.chunk.toString("utf8"));
    heldWrite.completeWrite();
  }
}

test("close rejects a backpressured send and prevents a late stdout delivery", async () => {
  const input = new PassThrough();
  const output = new ControlledBackpressureOutput();
  const transport = new CancellableStdioServerTransport(input, output);
  await transport.start();
  const pendingSend = transport.send({
    jsonrpc: "2.0",
    method: "notifications/claude/channel",
    params: { content: "blocked" },
  });
  await output.writeStarted;
  let sendSettled = false;
  void pendingSend.catch(() => undefined).finally(() => {
    sendSettled = true;
  });

  await transport.close();

  await assert.rejects(pendingSend, /transport closed/u);
  assert.equal(sendSettled, true);
  assert.equal(output.destroyed, true);
  output.releaseWrite();
  assert.deepEqual(output.deliveredChunks, []);
});

import process from "node:process";
import type { Readable, Writable } from "node:stream";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

interface PendingSend {
  rejectSend(error: Error): void;
}

export class CancellableStdioServerTransport extends StdioServerTransport {
  private readonly output: Writable;
  private readonly pendingSends = new Set<PendingSend>();
  private transportClosed = false;
  private closePromise: Promise<void> | undefined;

  constructor(
    input: Readable = process.stdin,
    output: Writable = process.stdout,
    options?: { maxBufferSize?: number },
  ) {
    super(input, output, options);
    this.output = output;
  }

  private readonly handleOutputError = (error: Error): void => {
    this.onerror?.(error);
    this.rejectPendingSends(error);
    void this.close().catch(() => undefined);
  };

  private readonly handleOutputClose = (): void => {
    void this.close().catch(() => undefined);
  };

  private rejectPendingSends(error: Error): void {
    for (const pendingSend of [...this.pendingSends]) {
      pendingSend.rejectSend(error);
    }
  }

  override async start(): Promise<void> {
    if (this.transportClosed) {
      throw new Error("Cancellable stdio transport closed before start");
    }
    this.output.on("error", this.handleOutputError);
    this.output.on("close", this.handleOutputClose);
    try {
      await super.start();
    } catch (error) {
      this.output.off("error", this.handleOutputError);
      this.output.off("close", this.handleOutputClose);
      throw error;
    }
  }

  override send(
    message: JSONRPCMessage,
    _options?: TransportSendOptions,
  ): Promise<void> {
    if (this.transportClosed || this.output.destroyed) {
      return Promise.reject(new Error("Cancellable stdio transport closed"));
    }
    const serializedMessage = serializeMessage(message);
    return new Promise<void>((resolveSend, rejectSend) => {
      let sendSettled = false;
      let pendingSend: PendingSend;
      const settleSend = (error?: Error | null) => {
        if (sendSettled) {
          return;
        }
        sendSettled = true;
        this.pendingSends.delete(pendingSend);
        if (error === undefined || error === null) {
          resolveSend();
        } else {
          rejectSend(error);
        }
      };
      pendingSend = {
        rejectSend: (error) => settleSend(error),
      };
      this.pendingSends.add(pendingSend);
      try {
        this.output.write(serializedMessage, (error) => settleSend(error));
      } catch (error) {
        settleSend(
          error instanceof Error
            ? error
            : new Error("Cancellable stdio transport write failed"),
        );
      }
    });
  }

  override close(): Promise<void> {
    if (this.closePromise === undefined) {
      this.transportClosed = true;
      this.rejectPendingSends(new Error("Cancellable stdio transport closed"));
      this.output.off("error", this.handleOutputError);
      this.output.off("close", this.handleOutputClose);
      if (!this.output.destroyed) {
        this.output.destroy();
      }
      this.closePromise = super.close();
    }
    return this.closePromise;
  }
}

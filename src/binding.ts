import net from "node:net";
import os from "node:os";
import {createHash, randomUUID} from "node:crypto";

type Endpoint = string | {host: "127.0.0.1"; port: number};
interface BindingOptions {
  key: string;
  onTakeover: () => Promise<void>;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Isolated test namespace; production uses the current OS user's namespace. */
  namespace?: string;
}
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function endpointFor(key: string, namespace: string): Endpoint {
  const digest = createHash("sha256").update(`${namespace}\0${key}`).digest("hex");
  if (process.platform === "win32") return `\\\\.\\pipe\\omp-slack-binding-${digest.slice(0, 32)}`;
  // OS-owned loopback sockets also disappear on a crash. A protocol/key mismatch
  // is refused rather than taking over an unrelated service on a colliding port.
  return {host: "127.0.0.1", port: 30000 + Number.parseInt(digest.slice(0, 8), 16) % 30000};
}
function requestTakeover(endpoint: Endpoint, key: string, signal: AbortSignal | undefined, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint as net.NetConnectOpts);
    let buffer = "", done = false;
    const finish = (error?: Error) => {
      if (done) return; done = true;
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      // Graceful EOF is important for Bun's Windows pipe peers: destroying an
      // open client can leave the remote pipe handle retained after release.
      if (!socket.destroyed) {
        const force = setTimeout(() => socket.destroy(), 1000);force.unref();
        socket.once("close", () => clearTimeout(force));
        if (!socket.writableEnded) socket.end();
      }
      error ? reject(error) : resolve();
    };
    const abort = () => finish(new Error("Slack binding cancelled."));
    const timer = setTimeout(() => finish(new Error("Old Slack binding did not finish takeover.")), timeoutMs);
    signal?.addEventListener("abort", abort, {once: true});
    socket.on("error", error => finish(error));
    socket.on("connect", () => {
      if (done) {if (!socket.destroyed && !socket.writableEnded) socket.end(); return;}
      socket.write(JSON.stringify({version: 1, key, action: "takeover"}) + "\n");
    });
    socket.on("data", data => {
      buffer += data.toString("utf8");
      if (buffer.length > 2048) return finish(new Error("Unexpected Slack binding response."));
      if (!buffer.includes("\n")) return;
      try {
        const response = JSON.parse(buffer.split("\n", 1)[0]!);
        if (response.version !== 1 || response.key !== key || response.released !== true) throw new Error("Old Slack binding did not release ownership.");
        finish();
      } catch {finish(new Error("Old Slack binding did not release ownership."));}
    });
    socket.on("end", () => {
      if (!done) {const error: NodeJS.ErrnoException = new Error("Slack binding endpoint closed during takeover.");error.code = "ECONNRESET";finish(error);}
    });
    if (signal?.aborted) abort();
  });
}

/** One cooperative owner per OS user/workspace/app, only while manually enabled. */
export class LocalBinding {
  #server: net.Server;
  #peers = new Set<net.Socket>();
  #owned = false;
  #handoff?: Promise<void>;
  #closed?: Promise<void>;
  readonly endpoint: Endpoint;
  readonly key: string;
  readonly id = randomUUID();
  private constructor(options: BindingOptions) {
    this.key = options.key;
    this.endpoint = endpointFor(options.key, options.namespace ?? os.homedir());
    this.#server = net.createServer(socket => {
      this.#peers.add(socket);
      socket.on("error", () => {});socket.on("close", () => this.#peers.delete(socket));
      socket.setTimeout(15000, () => socket.destroy());
      let buffer = "", handled = false;
      socket.on("data", data => {
        if (handled) return;
        buffer += data.toString("utf8");
        if (buffer.length > 2048) {handled = true; socket.destroy(); return;}
        if (!buffer.includes("\n")) return;
        handled = true;
        try {
          const request = JSON.parse(buffer.split("\n", 1)[0]!);
          if (request.version !== 1 || request.key !== this.key || request.action !== "takeover") throw new Error();
          if (!this.#handoff) {
            // Revoke before any await. The callback closes the old bridge before
            // this server acknowledges release and a new Slack socket can start.
            this.#owned = false;
            const handoff = (async () => {await options.onTakeover();void this.#closeListener();})();
            this.#handoff = handoff;
            // Keep the endpoint held when physical shutdown fails, but permit a
            // later request to retry the retained owner's shutdown callback.
            void handoff.catch(() => {if (this.#handoff === handoff) this.#handoff = undefined;});
          }
          void this.#handoff.then(() => socket.end(JSON.stringify({version: 1, key: this.key, released: true}) + "\n"),
            () => socket.end(JSON.stringify({version: 1, key: this.key, released: false}) + "\n"));
        } catch {socket.destroy();}
      });
    });
    this.#server.on("error", () => {});
  }
  #listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const error = (value: Error) => {this.#server.removeListener("listening", ready); reject(value);};
      const ready = () => {this.#server.removeListener("error", error); this.#owned = true; resolve();};
      this.#server.once("error", error);this.#server.once("listening", ready);
      try {this.#server.listen(this.endpoint as net.ListenOptions);}
      catch (value) {this.#server.removeListener("error", error);this.#server.removeListener("listening", ready);reject(value);}
    });
  }
  #closeListener(): Promise<void> {
    if (!this.#closed) this.#closed = new Promise(resolve => {
      if (!this.#server.listening) resolve();
      else this.#server.close(() => resolve());
    });
    return this.#closed;
  }
  isOwner() {return this.#owned;}
  async release(): Promise<void> {
    this.#owned = false;
    const closed = this.#closeListener();
    for (const peer of this.#peers) peer.destroy();
    await closed;
  }
  static async acquire(options: BindingOptions): Promise<LocalBinding> {
    const deadline = Date.now() + (options.timeoutMs ?? 15000);
    let lastError: unknown;
    while (Date.now() < deadline) {
      options.signal?.throwIfAborted();
      const candidate = new LocalBinding(options);
      try {
        await candidate.#listen();
        if (options.signal?.aborted) {await candidate.release(); options.signal.throwIfAborted();}
        return candidate;
      } catch (error) {
        lastError = error;await candidate.release();
      }
      options.signal?.throwIfAborted();
      try {
        await requestTakeover(candidate.endpoint, options.key, options.signal, Math.max(1, Math.min(10000, deadline - Date.now())));
      } catch (error) {
        lastError = error;
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code !== "ENOENT" && code !== "ECONNREFUSED" && code !== "EPIPE" && code !== "ECONNRESET") {
          throw new Error("Slack takeover could not confirm the previous listener stopped.", {cause: error});
        }
      }
      await delay(25);
    }
    throw new Error("Slack takeover timed out before exclusive ownership was available.", {cause: lastError});
  }
}

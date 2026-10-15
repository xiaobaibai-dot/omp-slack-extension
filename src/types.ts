export interface Config {
  appToken: string;
  botToken: string;
  teamId: string;
  appId: string;
  owners: ReadonlySet<string>;
  channels: ReadonlySet<string>;
  channelAllUsers?: ReadonlySet<string>;
  localTools: readonly string[];
  uploadRoot?: string;
  uploadMode?: "host";
  cwd?: string;
  maxQueue: number;
  /** Legacy isolated runner only; the main-session bridge has no task deadline. */
  maxTaskMs?: number;
}
export interface Route {
  readonly team: string;
  readonly channel: string;
  readonly thread: string;
  readonly user: string;
}
export interface Job {
  readonly id: string;
  readonly route: Route;
  readonly text: string;
  readonly ts: string;
  readonly files?: readonly {id: string; name?: string}[];
  readonly delivery?: "followUp" | "steer";
}
export interface ThreadPage {
  messages: { user: string; text: string; ts: string }[];
  nextCursor?: string;
  truncated: boolean;
}
export interface Conversation { id: string; name: string; isPrivate?: boolean; isIm: boolean }
export interface Transport {
  start(onEvent: (body: unknown) => void, onDisconnect?: (error: unknown) => void): Promise<{ teamId: string; botUserId: string }>;
  isReady?(): boolean;
  stop(): Promise<void>;
  post(route: Route, text: string, signal?: AbortSignal): Promise<void>;
  readThread(route: Route, cursor?: string, signal?: AbortSignal): Promise<ThreadPage>;
  upload(route: Route, content: Buffer, filename: string, title: string, signal: AbortSignal): Promise<void | {fileId: string}>;
  download?(route: Route, fileId: string, signal: AbortSignal): Promise<{bytes: Buffer; filename: string}>;
  list(cursor?: string): Promise<{ conversations: Conversation[]; nextCursor?: string }>;
}
export interface Capabilities {
  reply(text: string): Promise<void>;
  readThread(cursor?: string): Promise<ThreadPage>;
  upload(relativePath: string, title?: string): Promise<void | {fileId: string}>;
  download?(fileId: string, targetPath: string): Promise<{path: string; bytes: number; sha256: string}>;
  listConversations(): Promise<{ conversations: Conversation[]; scope: string }>;
}
export type Runner = (job: Job, capabilities: Capabilities, signal: AbortSignal) => Promise<string>;
export interface Host {
  notify(message: string, level?: "info" | "warning" | "error"): void;
  log?(entry: import("./request-lifecycle.ts").RequestLog): void;
  status?(route?: Route): NativeStatus;
  onStopped?(): void | Promise<void>;
}
export interface NativeStatus {
  streaming: boolean;
  submitting: number;
  followUp: number;
  steering: number;
  consumed: number;
  claimed: number;
  activeToolCalls: number;
  lastEvent?: string;
  lastObservedAt?: string;
}

export interface Config {
  appToken: string;
  botToken: string;
  teamId: string;
  appId: string;
  owners: ReadonlySet<string>;
  channels: ReadonlySet<string>;
  localTools: readonly string[];
  uploadRoot?: string;
  maxQueue: number;
  maxTaskMs: number;
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
}
export interface ThreadPage {
  messages: { user: string; text: string; ts: string }[];
  nextCursor?: string;
  truncated: boolean;
}
export interface Conversation { id: string; name: string; isPrivate?: boolean; isIm: boolean }
export interface Transport {
  start(onEvent: (body: unknown) => void): Promise<{ teamId: string; botUserId: string }>;
  stop(): Promise<void>;
  post(route: Route, text: string): Promise<void>;
  readThread(route: Route, cursor?: string): Promise<ThreadPage>;
  upload(route: Route, content: Buffer, filename: string, title: string, signal: AbortSignal): Promise<void>;
  list(cursor?: string): Promise<{ conversations: Conversation[]; nextCursor?: string }>;
}
export interface Capabilities {
  reply(text: string): Promise<void>;
  readThread(cursor?: string): Promise<ThreadPage>;
  upload(relativePath: string, title?: string): Promise<void>;
  listConversations(): Promise<{ conversations: Conversation[]; scope: string }>;
}
export type Runner = (job: Job, capabilities: Capabilities, signal: AbortSignal) => Promise<string>;
export interface Host {
  canRun(): boolean;
  notify(message: string, level?: "info" | "warning" | "error"): void;
}

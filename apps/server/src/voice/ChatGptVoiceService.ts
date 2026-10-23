// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalTimers:off globalDate:off - The ChatGPT web transcriber and `codex app-server` are driven through a CDP WebSocket and a stdio child process.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

const TRANSCRIBE_URL = "https://chatgpt.com/backend-api/transcribe";
const DEFAULT_CDP_ENDPOINT = "http://127.0.0.1:49593";
const CODEX_AUTH_PATH = path.join(os.homedir(), ".codex", "auth.json");
const LAUNCHER_BROWSER_PATH = path.join(
  os.homedir(),
  ".codex-chatgpt-web",
  "runtime",
  "launcher-browser.json",
);
const CDP_TIMEOUT_MS = 60_000;
const SDP_TIMEOUT_MS = 15_000;
const RPC_TIMEOUT_MS = 15_000;
const DUPLICATE_TRANSCRIPT_WINDOW_MS = 2_000;

export const MIN_AUDIO_BYTES = 1024;
export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
export const CHATGPT_TRANSCRIBE_MODEL = "chatgpt/transcribe" as const;

export class ChatGptVoiceError extends Data.TaggedError("ChatGptVoiceError")<{
  readonly message: string;
  readonly status?: number;
  readonly cause?: unknown;
}> {}

export interface VoiceRealtimeEvent {
  readonly type: "user-final";
  readonly role: "user";
  readonly final: true;
  readonly text: string;
}

export interface TranscribeInput {
  readonly audioBase64: string;
  readonly mimeType: string;
}

export interface StartRealtimeInput {
  readonly sdp: string;
  readonly voice?: string | undefined;
}

export class ChatGptVoiceService extends Context.Service<
  ChatGptVoiceService,
  {
    readonly transcribe: (
      input: TranscribeInput,
    ) => Effect.Effect<{ text: string; model: typeof CHATGPT_TRANSCRIBE_MODEL }, ChatGptVoiceError>;
    readonly startRealtime: (
      input: StartRealtimeInput,
    ) => Effect.Effect<{ sessionId: string; sdp: string }, ChatGptVoiceError>;
    readonly hasSession: (sessionId: string) => boolean;
    readonly events: (sessionId: string) => Stream.Stream<VoiceRealtimeEvent>;
    readonly stopRealtime: (sessionId: string) => Effect.Effect<void>;
  }
>()("t3/voice/ChatGptVoiceService") {}

const fail = (message: string, extra?: { status?: number; cause?: unknown }) =>
  new ChatGptVoiceError({ message, ...extra });

const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export function validateAudioBytes(byteLength: number): void {
  if (byteLength < MIN_AUDIO_BYTES) {
    throw fail("Audio recording is too short to transcribe.", { status: 400 });
  }
  if (byteLength > MAX_AUDIO_BYTES) {
    throw fail("Audio recording exceeds the 10 MB limit.", { status: 400 });
  }
}

async function readJsonFile(file: string): Promise<Record<string, any> | null> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

export interface CodexAuth {
  readonly accessToken: string | null;
  readonly accountId: string | null;
}

export async function readCodexAuth(): Promise<CodexAuth> {
  const json = await readJsonFile(CODEX_AUTH_PATH);
  const token = json?.tokens?.access_token;
  const accountId = json?.tokens?.account_id;
  return {
    accessToken: typeof token === "string" && token.length > 0 ? token : null,
    accountId: typeof accountId === "string" && accountId.length > 0 ? accountId : null,
  };
}

export function buildChatGptTranscribeHeaders(auth: {
  accessToken: string;
  accountId?: string | null;
}): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.accessToken}`,
    originator: "codex_cli_rs",
    version: "0.1.0",
  };
  if (typeof auth.accountId === "string" && auth.accountId.length > 0) {
    headers["chatgpt-account-id"] = auth.accountId;
  }
  return headers;
}

export function audioFileName(mimeType: string): string {
  if (mimeType.includes("mp4")) return "voice.mp4";
  if (mimeType.includes("ogg")) return "voice.ogg";
  if (mimeType.includes("wav")) return "voice.wav";
  return "voice.webm";
}

const VOICE_TERM_REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /(?<![\p{L}\p{N}])(?:thứ ba cấp|tê ba cốt|tê 3 cốt|t3 cốt|t 3 code|tê ba code|t3code)(?![\p{L}\p{N}])/giu,
    "T3 Code",
  ],
  [/(?<![\p{L}\p{N}])(?:s tờ tờ|ét tê tê|es tê tê|s t t)(?![\p{L}\p{N}])/giu, "STT"],
  [/(?<![\p{L}\p{N}])(?:tê tê ét|tờ tờ s|t t s)(?![\p{L}\p{N}])/giu, "TTS"],
  [/(?<![\p{L}\p{N}])(?:chát g p t|chat g p t|chát gpt)(?![\p{L}\p{N}])/giu, "ChatGPT"],
  [/(?<![\p{L}\p{N}])(?:cô đex|cô đếc|co dex)(?![\p{L}\p{N}])/giu, "Codex"],
  [/(?<![\p{L}\p{N}])(?:ớp áp săt|app a sa|app chấm a sa)(?![\p{L}\p{N}])/giu, "app.asar"],
  [/(?<![\p{L}\p{N}])(?:sắp ây gần|sub ây gần|sấp ây gần)(?![\p{L}\p{N}])/giu, "subagent"],
  [/(?<![\p{L}\p{N}])(tạo|mở|merge|review|link)(\s+)(?:pờ rờ|pê rờ)(?![\p{L}\p{N}])/giu, "$1$2PR"],
];

export function normalizeVoiceTranscript(rawText: string): string {
  let normalized = rawText.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  for (const [pattern, replacement] of VOICE_TERM_REPLACEMENTS) {
    normalized = normalized.replace(pattern, replacement);
  }
  return normalized;
}

export interface TranscribeReply {
  readonly status: number;
  readonly body: string;
}

export function readTranscript(reply: TranscribeReply): string {
  if (reply.status < 200 || reply.status >= 300) {
    throw fail(`ChatGPT transcribe failed (${reply.status}): ${reply.body.slice(0, 200)}`, {
      status: reply.status === 401 || reply.status === 403 ? 401 : 502,
    });
  }
  const text = (JSON.parse(reply.body) as { text?: unknown }).text;
  return typeof text === "string" ? normalizeVoiceTranscript(text) : "";
}

interface CdpTarget {
  readonly type?: string;
  readonly url?: string;
  readonly webSocketDebuggerUrl?: string;
}

async function listCdpPages(): Promise<CdpTarget[]> {
  const launcher = await readJsonFile(LAUNCHER_BROWSER_PATH);
  const endpoint =
    typeof launcher?.endpoint === "string" ? launcher.endpoint : DEFAULT_CDP_ENDPOINT;
  const response = await fetch(`${endpoint}/json/list`, { signal: AbortSignal.timeout(2_000) });
  return (await response.json()) as CdpTarget[];
}

async function findChatGptPage(): Promise<string | null> {
  const targets = await listCdpPages();
  return (
    targets.find(
      (target) =>
        target.type === "page" &&
        target.url?.includes("chatgpt.com") &&
        target.webSocketDebuggerUrl,
    )?.webSocketDebuggerUrl ?? null
  );
}

function cdpEvaluate(webSocketUrl: string, expression: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("CDP evaluate timed out."));
    }, CDP_TIMEOUT_MS);
    const settle = (action: () => void) => {
      clearTimeout(timer);
      socket.close();
      action();
    };
    socket.onopen = () =>
      socket.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      );
    socket.onerror = () => settle(() => reject(new Error("CDP connection failed.")));
    socket.onmessage = (message) => {
      const reply = JSON.parse(String(message.data));
      if (reply.id !== 1) return;
      if (reply.error || reply.result?.exceptionDetails) {
        settle(() =>
          reject(
            new Error(
              reply.error?.message ??
                reply.result.exceptionDetails.exception?.description ??
                "CDP evaluate failed.",
            ),
          ),
        );
        return;
      }
      settle(() => resolve(reply.result?.result?.value));
    };
  });
}

function pageTranscribeExpression(input: TranscribeInput, auth: CodexAuth): string {
  return `(async () => {
    const binary = atob(${JSON.stringify(input.audioBase64)});
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: ${JSON.stringify(input.mimeType)} }), ${JSON.stringify(audioFileName(input.mimeType))});
    let token = ${JSON.stringify(auth.accessToken)};
    let accountId = ${JSON.stringify(auth.accountId)};
    if (!token) {
      const session = await (await fetch("/api/auth/session", { credentials: "include" })).json();
      token = session && session.accessToken;
      if (!accountId && session && session.account && typeof session.account.id === "string") {
        accountId = session.account.id;
      }
    }
    const headers = { Authorization: "Bearer " + token };
    if (accountId) {
      headers["chatgpt-account-id"] = accountId;
    }
    const response = await fetch(${JSON.stringify(TRANSCRIBE_URL)}, {
      method: "POST",
      headers,
      body: form,
      credentials: "include",
    });
    return JSON.stringify({ status: response.status, body: await response.text() });
  })()`;
}

async function transcribeViaPage(input: TranscribeInput, auth: CodexAuth): Promise<string> {
  const webSocketUrl = await findChatGptPage();
  if (!webSocketUrl) throw new Error("No chatgpt.com tab is open in the CDP browser.");
  const value = await cdpEvaluate(webSocketUrl, pageTranscribeExpression(input, auth));
  return readTranscript(JSON.parse(String(value)) as TranscribeReply);
}

async function transcribeDirect(
  audioBuffer: Buffer,
  mimeType: string,
  auth: CodexAuth,
): Promise<string> {
  if (!auth.accessToken) {
    throw fail("No ChatGPT access token found in ~/.codex/auth.json.", { status: 401 });
  }
  const form = new FormData();
  form.append("file", new Blob([audioBuffer], { type: mimeType }), audioFileName(mimeType));
  const response = await fetch(TRANSCRIBE_URL, {
    method: "POST",
    headers: buildChatGptTranscribeHeaders({
      accessToken: auth.accessToken,
      accountId: auth.accountId,
    }),
    body: form,
    signal: AbortSignal.timeout(CDP_TIMEOUT_MS),
  });
  return readTranscript({ status: response.status, body: await response.text() });
}

async function transcribeRaw(input: TranscribeInput): Promise<string> {
  const audioBuffer = Buffer.from(input.audioBase64, "base64");
  validateAudioBytes(audioBuffer.byteLength);
  const auth = await readCodexAuth();
  try {
    return await transcribeViaPage(input, auth);
  } catch (cause) {
    if (cause instanceof ChatGptVoiceError) throw cause;
    // Any CDP transport failure falls back to a direct call with Codex CLI headers.
    return transcribeDirect(audioBuffer, input.mimeType, auth);
  }
}

interface RealtimeSession {
  readonly child: ChildProcessWithoutNullStreams;
  readonly listeners: Set<(event: VoiceRealtimeEvent) => void>;
  readonly closers: Set<() => void>;
  lastRaw: string;
  lastAt: number;
}

interface AppServerRpc {
  readonly request: (method: string, params: unknown) => Promise<any>;
  readonly notify: (method: string, params?: unknown) => void;
}

function createRpc(
  child: ChildProcessWithoutNullStreams,
  onNotification: (method: string, params: any) => void,
): AppServerRpc {
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >();
  const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const rejectAll = (error: Error) => {
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };

  createInterface({ input: child.stdout }).on("line", (line) => {
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.method && message.id !== undefined) {
      send({ id: message.id, error: { code: -32601, message: "Unsupported by t3code-voice." } });
    } else if (message.method) {
      onNotification(message.method, message.params);
    } else if (typeof message.id === "number") {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) entry?.reject(new Error(message.error.message ?? "app-server error"));
      else entry?.resolve(message.result);
    }
  });
  child.on("exit", () => rejectAll(new Error("codex app-server exited.")));
  child.stdin.on("error", () => {});

  return {
    request: (method, params) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`codex app-server ${method} timed out.`));
        }, RPC_TIMEOUT_MS);
        pending.set(id, {
          resolve: (value) => (clearTimeout(timer), resolve(value)),
          reject: (error) => (clearTimeout(timer), reject(error)),
        });
        send({ id, method, params });
      }),
    notify: (method, params) => send(params === undefined ? { method } : { method, params }),
  };
}

export function userTranscriptOf(method: string, params: any): string | null {
  if (method === "thread/realtime/transcript/done" && params?.role === "user") {
    return typeof params.text === "string" ? normalizeVoiceTranscript(params.text) : null;
  }
  if (
    method === "thread/realtime/item/completed" &&
    params?.item?.type === "transcriptSegment" &&
    params.item.role === "user"
  ) {
    return typeof params.item.text === "string" ? normalizeVoiceTranscript(params.item.text) : null;
  }
  return null;
}

export const layer = Layer.effect(
  ChatGptVoiceService,
  Effect.gen(function* () {
    const sessions = new Map<string, RealtimeSession>();

    const endSession = (sessionId: string) => {
      const session = sessions.get(sessionId);
      if (!session) return;
      sessions.delete(sessionId);
      session.child.kill();
      for (const close of session.closers) close();
    };

    yield* Effect.addFinalizer(() => Effect.sync(() => [...sessions.keys()].forEach(endSession)));

    const transcribe: ChatGptVoiceService["Service"]["transcribe"] = (input) =>
      Effect.gen(function* () {
        const text = yield* Effect.tryPromise({
          try: () => transcribeRaw(input),
          catch: (cause) =>
            cause instanceof ChatGptVoiceError
              ? cause
              : fail(`Transcription failed: ${errorMessage(cause)}`, { status: 502, cause }),
        });
        return { text, model: CHATGPT_TRANSCRIBE_MODEL };
      });

    const launchRealtime = async (
      input: StartRealtimeInput,
    ): Promise<{ sessionId: string; sdp: string }> => {
      const child = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });
      child.stderr.resume();
      let sessionId = "";
      let resolveSdp: (sdp: string) => void = () => {};
      let rejectSdp: (error: Error) => void = () => {};
      const sdpAnswer = new Promise<string>((resolve, reject) => {
        resolveSdp = resolve;
        rejectSdp = reject;
      });
      sdpAnswer.catch(() => {});
      const session: RealtimeSession = {
        child,
        listeners: new Set(),
        closers: new Set(),
        lastRaw: "",
        lastAt: 0,
      };

      const rpc = createRpc(child, (method, params) => {
        if (method === "thread/realtime/sdp" && params?.threadId === sessionId) {
          resolveSdp(params.sdp);
          return;
        }
        if (method === "thread/realtime/error" && params?.threadId === sessionId) {
          rejectSdp(new Error(String(params.message ?? "Realtime session failed.")));
          return;
        }
        if (method === "thread/realtime/closed" && params?.threadId === sessionId) {
          endSession(sessionId);
          return;
        }
        const text = userTranscriptOf(method, params);
        if (!text || !text.trim() || params?.threadId !== sessionId) return;
        const now = Date.now();
        if (text === session.lastRaw && now - session.lastAt < DUPLICATE_TRANSCRIPT_WINDOW_MS)
          return;
        session.lastRaw = text;
        session.lastAt = now;
        const event: VoiceRealtimeEvent = {
          type: "user-final",
          role: "user",
          final: true,
          text,
        };
        for (const listener of session.listeners) listener(event);
      });

      try {
        const exited = new Promise<never>((_, reject) =>
          child.once("exit", () =>
            reject(new Error("codex app-server exited before the session started.")),
          ),
        );
        child.once("error", () => {});
        await Promise.race([
          rpc.request("initialize", {
            clientInfo: { name: "t3code-voice", version: "1.0.0" },
            capabilities: { experimentalApi: true },
          }),
          exited,
        ]);
        rpc.notify("initialized");
        const started = await rpc.request("thread/start", { cwd: os.tmpdir(), ephemeral: true });
        sessionId = String(started?.thread?.id ?? "");
        if (!sessionId) throw new Error("codex app-server did not return a thread id.");
        sessions.set(sessionId, session);

        const startReply = rpc.request("thread/realtime/start", {
          threadId: sessionId,
          version: "v3",
          outputModality: "audio",
          voice: input.voice || "cove",
          prompt: "You are a voice assistant inside T3 Code. Keep spoken replies concise.",
          initialItems: [],
          includeStartupContext: false,
          clientManagedHandoffs: true,
          transport: { type: "webrtc", sdp: input.sdp },
        });
        startReply.catch(() => {});
        const sdp = await Promise.race([
          sdpAnswer,
          startReply.then(() => new Promise<never>(() => {})),
          exited,
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("Timed out waiting for the realtime SDP answer.")),
              SDP_TIMEOUT_MS,
            ),
          ),
        ]);
        child.on("exit", () => endSession(sessionId));
        return { sessionId, sdp };
      } catch (cause) {
        sessions.delete(sessionId);
        child.kill();
        throw cause;
      }
    };

    return ChatGptVoiceService.of({
      transcribe,
      startRealtime: (input) =>
        Effect.tryPromise({
          try: () => launchRealtime(input),
          catch: (cause) =>
            fail(`Could not start live voice: ${errorMessage(cause)}`, { status: 502, cause }),
        }),
      hasSession: (sessionId) => sessions.has(sessionId),
      events: (sessionId) =>
        Stream.callback<VoiceRealtimeEvent>((queue) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              const session = sessions.get(sessionId);
              if (!session) {
                Queue.endUnsafe(queue);
                return () => {};
              }
              const listener = (event: VoiceRealtimeEvent) => void Queue.offerUnsafe(queue, event);
              const close = () => void Queue.endUnsafe(queue);
              session.listeners.add(listener);
              session.closers.add(close);
              return () => {
                session.listeners.delete(listener);
                session.closers.delete(close);
              };
            }),
            (release) => Effect.sync(release),
          ),
        ),
      stopRealtime: (sessionId) => Effect.sync(() => endSession(sessionId)),
    });
  }),
);

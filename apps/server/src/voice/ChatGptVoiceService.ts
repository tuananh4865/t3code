// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalTimers:off globalDate:off - The ChatGPT web transcriber and `codex app-server` are driven through a CDP WebSocket and a stdio child process.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

import { ServerSettingsService } from "../serverSettings.ts";
import type { VoiceDictionary, VoiceSubscriptionProvider } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import {
  buildRealtimeStartContext,
  normalizeTranscript,
  withDefaultVoiceDictionary,
} from "./voiceDictionary.ts";

const TRANSCRIBE_URL = "https://chatgpt.com/backend-api/transcribe";
const DEFAULT_CDP_ENDPOINT = "http://127.0.0.1:49593";
const CODEX_AUTH_PATH = path.join(os.homedir(), ".codex", "auth.json");
const GROK_AUTH_PATH = path.join(os.homedir(), ".grok", "auth.json");
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
  readonly raw: string;
}

export interface TranscribeInput {
  readonly audioBase64: string;
  readonly mimeType: string;
  readonly dictionary?: VoiceDictionary | undefined;
  readonly provider?: VoiceSubscriptionProvider | undefined;
}

export interface StartRealtimeInput {
  readonly sdp: string;
  readonly voice?: string | undefined;
  readonly dictionary?: VoiceDictionary | undefined;
  readonly provider?: VoiceSubscriptionProvider | undefined;
}

export class ChatGptVoiceService extends Context.Service<
  ChatGptVoiceService,
  {
    readonly transcribe: (
      input: TranscribeInput,
    ) => Effect.Effect<{ text: string; raw: string }, ChatGptVoiceError>;
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

async function readJsonFile(file: string): Promise<Record<string, any> | null> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function readAccessToken(): Promise<string | null> {
  const token = (await readJsonFile(CODEX_AUTH_PATH))?.tokens?.access_token;
  return typeof token === "string" && token.length > 0 ? token : null;
}

function audioFileName(mimeType: string): string {
  if (mimeType.includes("mp4")) return "voice.mp4";
  if (mimeType.includes("ogg")) return "voice.ogg";
  if (mimeType.includes("wav")) return "voice.wav";
  return "voice.webm";
}

interface TranscribeReply {
  readonly status: number;
  readonly body: string;
}

function readTranscript(reply: TranscribeReply): string {
  if (reply.status < 200 || reply.status >= 300) {
    throw fail(`ChatGPT transcribe failed (${reply.status}): ${reply.body.slice(0, 200)}`, {
      status: reply.status === 401 || reply.status === 403 ? 401 : 502,
    });
  }
  const text = (JSON.parse(reply.body) as { text?: unknown }).text;
  return typeof text === "string" ? text : "";
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

async function hasGrokSession(): Promise<boolean> {
  if (process.env.XAI_API_KEY) return true;
  if (await readJsonFile(GROK_AUTH_PATH)) return true;
  try {
    return (await listCdpPages()).some(
      (target) =>
        target.type === "page" && (target.url?.includes("grok.com") || target.url?.includes("x.com")),
    );
  } catch {
    return false;
  }
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

function pageTranscribeExpression(input: TranscribeInput, token: string | null): string {
  return `(async () => {
    const binary = atob(${JSON.stringify(input.audioBase64)});
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: ${JSON.stringify(input.mimeType)} }), ${JSON.stringify(audioFileName(input.mimeType))});
    let token = ${JSON.stringify(token)};
    if (!token) {
      const session = await (await fetch("/api/auth/session", { credentials: "include" })).json();
      token = session && session.accessToken;
    }
    const response = await fetch(${JSON.stringify(TRANSCRIBE_URL)}, {
      method: "POST",
      headers: { Authorization: "Bearer " + token },
      body: form,
      credentials: "include",
    });
    return JSON.stringify({ status: response.status, body: await response.text() });
  })()`;
}

async function transcribeViaPage(input: TranscribeInput, token: string | null): Promise<string> {
  const webSocketUrl = await findChatGptPage();
  if (!webSocketUrl) throw new Error("No chatgpt.com tab is open in the CDP browser.");
  const value = await cdpEvaluate(webSocketUrl, pageTranscribeExpression(input, token));
  return readTranscript(JSON.parse(String(value)) as TranscribeReply);
}

async function transcribeDirect(input: TranscribeInput, token: string | null): Promise<string> {
  if (!token) throw fail("No ChatGPT access token found in ~/.codex/auth.json.", { status: 401 });
  const form = new FormData();
  form.append(
    "file",
    new Blob([Buffer.from(input.audioBase64, "base64")], { type: input.mimeType }),
    audioFileName(input.mimeType),
  );
  const response = await fetch(TRANSCRIBE_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
    signal: AbortSignal.timeout(CDP_TIMEOUT_MS),
  });
  return readTranscript({ status: response.status, body: await response.text() });
}

async function transcribeRaw(input: TranscribeInput): Promise<string> {
  const token = await readAccessToken();
  try {
    return await transcribeViaPage(input, token);
  } catch (cause) {
    if (cause instanceof ChatGptVoiceError) throw cause;
    // ponytail: any CDP transport failure falls back to a direct call; Cloudflare may reject it without the browser's cookies.
    return transcribeDirect(input, token);
  }
}

interface RealtimeSession {
  readonly child: ChildProcessWithoutNullStreams;
  readonly dictionary: VoiceDictionary;
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

function userTranscriptOf(method: string, params: any): string | null {
  if (method === "thread/realtime/transcript/done" && params?.role === "user") {
    return typeof params.text === "string" ? params.text : null;
  }
  if (
    method === "thread/realtime/item/completed" &&
    params?.item?.type === "transcriptSegment" &&
    params.item.role === "user"
  ) {
    return typeof params.item.text === "string" ? params.item.text : null;
  }
  return null;
}

export const layer = Layer.effect(
  ChatGptVoiceService,
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    const sessions = new Map<string, RealtimeSession>();

    const endSession = (sessionId: string) => {
      const session = sessions.get(sessionId);
      if (!session) return;
      sessions.delete(sessionId);
      session.child.kill();
      for (const close of session.closers) close();
    };

    yield* Effect.addFinalizer(() => Effect.sync(() => [...sessions.keys()].forEach(endSession)));

    const resolveDictionary = (
      dictionary: VoiceDictionary | undefined,
      requested: VoiceSubscriptionProvider | undefined,
    ) =>
      Effect.gen(function* () {
        const current = yield* settings.getSettings.pipe(
          Effect.mapError((cause) => fail("Could not read voice settings.", { cause })),
        );
        const wanted = requested ?? current.voiceSubscriptionProvider;
        // ponytail: no Grok speech endpoint is wired; Grok only picks the dictionary preset, audio always goes through the ChatGPT/Codex transport. Without a Grok session we fall back to the ChatGPT preset.
        const provider: VoiceSubscriptionProvider =
          wanted === "grok" && !(yield* Effect.promise(hasGrokSession)) ? "chatgpt" : wanted;
        return withDefaultVoiceDictionary(dictionary ?? current.voiceDictionary, provider);
      });

    const transcribe: ChatGptVoiceService["Service"]["transcribe"] = (input) =>
      Effect.gen(function* () {
        const dictionary = yield* resolveDictionary(input.dictionary, input.provider);
        const raw = yield* Effect.tryPromise({
          try: () => transcribeRaw(input),
          catch: (cause) =>
            cause instanceof ChatGptVoiceError
              ? cause
              : fail(`Transcription failed: ${errorMessage(cause)}`, { status: 502, cause }),
        });
        return { text: normalizeTranscript(raw, dictionary), raw };
      });

    const launchRealtime = async (
      input: StartRealtimeInput,
      dictionary: VoiceDictionary,
    ): Promise<{ sessionId: string; sdp: string }> => {
      const context = buildRealtimeStartContext(dictionary);
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
        dictionary,
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
        const raw = userTranscriptOf(method, params);
        if (!raw || !raw.trim() || params?.threadId !== sessionId) return;
        const now = Date.now();
        if (raw === session.lastRaw && now - session.lastAt < DUPLICATE_TRANSCRIPT_WINDOW_MS)
          return;
        session.lastRaw = raw;
        session.lastAt = now;
        const event: VoiceRealtimeEvent = {
          type: "user-final",
          role: "user",
          final: true,
          text: normalizeTranscript(raw, session.dictionary),
          raw,
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
          prompt: context.prompt,
          initialItems: context.initialItems,
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
        Effect.gen(function* () {
          const dictionary = yield* resolveDictionary(input.dictionary, input.provider);
          return yield* Effect.tryPromise({
            try: () => launchRealtime(input, dictionary),
            catch: (cause) =>
              fail(`Could not start live voice: ${errorMessage(cause)}`, { status: 502, cause }),
          });
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

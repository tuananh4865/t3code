import type { VoiceDictionary } from "@t3tools/contracts";
import {
  formatVoiceDictionaryText,
  normalizeTranscript,
  parseVoiceDictionaryText,
  VOICE_DICTIONARY_MAX_ENTRIES,
  withDefaultVoiceDictionary,
} from "@t3tools/shared/voiceDictionary";
import { Effect } from "effect";
import * as Schema from "effect/Schema";
import { AudioLinesIcon, ChevronDownIcon, MicIcon, RadioIcon, RepeatIcon } from "lucide-react";
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { readDesktopPrimaryBearerToken } from "../../environments/primary/desktopAuth";
import { resolvePrimaryEnvironmentHttpUrl } from "../../environments/primary";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "../ui/menu";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useComposerMenuProps } from "./composerEventScope";

export {
  formatVoiceDictionaryText,
  parseVoiceDictionaryText,
  VOICE_DICTIONARY_MAX_ENTRIES,
};

export const VOICE_SETTINGS_STORAGE_KEY = "t3code.voice.settings.v1";
export const VOICE_MODES = ["dictation", "hands-free", "live"] as const;
export const VOICE_AUTO_STOP_OPTIONS = [0, 1500, 2500, 4000, 6000] as const;
export const VOICE_REALTIME_VOICES = [
  "cove",
  "sol",
  "juniper",
  "maple",
  "spruce",
  "ember",
  "vale",
  "breeze",
  "arbor",
] as const;

export const VOICE_SUBSCRIPTION_PROVIDERS = ["chatgpt", "grok"] as const;

export const VOICE_MODE_LABELS: Record<T3VoiceMode, string> = {
  dictation: "Dictate",
  "hands-free": "Hands-free loop",
  live: "Live voice",
};

const VoiceDictionaryEntrySchema = Schema.Struct({
  term: Schema.String,
  aliases: Schema.Array(Schema.String),
});

export const VoiceSettingsSchema = Schema.Struct({
  mode: Schema.Literals(VOICE_MODES),
  autoStopMs: Schema.Literals(VOICE_AUTO_STOP_OPTIONS),
  realtimeVoice: Schema.Literals(VOICE_REALTIME_VOICES),
  prompt: Schema.String,
  entries: Schema.Array(VoiceDictionaryEntrySchema),
  subscriptionProvider: Schema.Literals(VOICE_SUBSCRIPTION_PROVIDERS).pipe(
    Schema.withDecodingDefault(Effect.succeed("chatgpt" as const)),
  ),
});

export type T3VoiceSettings = typeof VoiceSettingsSchema.Type;
export type T3VoiceMode = T3VoiceSettings["mode"];
export type T3VoiceDictionaryEntry = T3VoiceSettings["entries"][number];
export type T3VoiceSubscriptionProvider = (typeof VOICE_SUBSCRIPTION_PROVIDERS)[number];

export const VOICE_SUBSCRIPTION_LABELS: Record<T3VoiceSubscriptionProvider, string> = {
  chatgpt: "ChatGPT Subscription (Plus / Pro)",
  grok: "Grok Subscription (SuperGrok / X Premium+)",
};

export const VOICE_SUBSCRIPTION_DICTIONARY_PRESETS: Record<
  T3VoiceSubscriptionProvider,
  { prompt: string; entries: T3VoiceDictionaryEntry[] }
> = {
  chatgpt: {
    prompt:
      "ChatGPT subscription (Plus, Pro, Team) voice and dictation for T3 Code, OpenAI Codex and Empryo.",
    entries: [
      { term: "ChatGPT Plus", aliases: ["chat gpt plus", "chat g p t plus"] },
      { term: "ChatGPT Pro", aliases: ["chat gpt pro", "chat g p t pro"] },
      { term: "ChatGPT Team", aliases: ["chat gpt team", "chat g p t team"] },
      { term: "OpenAI Codex", aliases: ["open ai codex", "openai codecs"] },
      { term: "Empryo", aliases: ["empire o", "em pry o"] },
      { term: "T3 Code", aliases: ["t3 code", "tee three code"] },
    ],
  },
  grok: {
    prompt:
      "Grok subscription (SuperGrok, X Premium+) voice and dictation for T3 Code, xAI Grok Build and Empryo.",
    entries: [
      { term: "SuperGrok", aliases: ["super grok", "super grock"] },
      { term: "Grok Heavy", aliases: ["grok heavy", "grock heavy"] },
      { term: "X Premium+", aliases: ["x premium plus", "ex premium plus"] },
      { term: "Grok Build", aliases: ["grok build", "grock build"] },
      { term: "xAI", aliases: ["x a i", "ex a i"] },
      { term: "Grok", aliases: ["grock", "groc"] },
      { term: "Empryo", aliases: ["empire o", "em pry o"] },
      { term: "T3 Code", aliases: ["t3 code", "tee three code"] },
    ],
  },
};

export const DEFAULT_VOICE_SETTINGS: T3VoiceSettings = {
  mode: "dictation",
  autoStopMs: 2500,
  realtimeVoice: "cove",
  prompt: "",
  entries: [],
  subscriptionProvider: "chatgpt",
};

/** Swaps preset terms for the chosen subscription while keeping the user's own terms. */
export function applySubscriptionDictionaryPreset(
  current: T3VoiceSettings,
  subscriptionProvider: T3VoiceSubscriptionProvider,
): T3VoiceSettings {
  const preset = VOICE_SUBSCRIPTION_DICTIONARY_PRESETS[subscriptionProvider];
  const presetTerms = new Set(
    VOICE_SUBSCRIPTION_PROVIDERS.flatMap((provider) =>
      VOICE_SUBSCRIPTION_DICTIONARY_PRESETS[provider].entries.map((entry) =>
        entry.term.toLowerCase(),
      ),
    ),
  );
  const custom = current.entries.filter((entry) => !presetTerms.has(entry.term.toLowerCase()));
  return {
    ...current,
    subscriptionProvider,
    prompt: preset.prompt,
    entries: [...preset.entries, ...custom].slice(0, VOICE_DICTIONARY_MAX_ENTRIES),
  };
}

/** Server settings win over defaults when contracts ship `voiceDictionary` / `voiceRealtimeVoice`; local edits win over both. */
export function voiceSettingsFromServer(serverSettings: unknown): T3VoiceSettings {
  const source = (serverSettings ?? {}) as {
    voiceDictionary?: { prompt?: unknown; entries?: unknown };
    voiceRealtimeVoice?: unknown;
    voiceSubscriptionProvider?: unknown;
  };
  const dictionary = source.voiceDictionary;
  const realtimeVoice = VOICE_REALTIME_VOICES.find((voice) => voice === source.voiceRealtimeVoice);
  const subscriptionProvider = VOICE_SUBSCRIPTION_PROVIDERS.find(
    (provider) => provider === source.voiceSubscriptionProvider,
  );
  return {
    ...DEFAULT_VOICE_SETTINGS,
    ...(realtimeVoice ? { realtimeVoice } : {}),
    ...(subscriptionProvider ? { subscriptionProvider } : {}),
    ...(typeof dictionary?.prompt === "string" ? { prompt: dictionary.prompt } : {}),
    ...(Array.isArray(dictionary?.entries)
      ? {
          entries: dictionary.entries
            .filter(Schema.is(VoiceDictionaryEntrySchema))
            .slice(0, VOICE_DICTIONARY_MAX_ENTRIES),
        }
      : {}),
  };
}

export function useVoiceSettings(serverSettings?: unknown) {
  const fallback = useMemo(() => voiceSettingsFromServer(serverSettings), [serverSettings]);
  const [local, setLocal] = useLocalStorage(VOICE_SETTINGS_STORAGE_KEY, fallback, VoiceSettingsSchema);
  const resolved = useMemo<T3VoiceSettings>(
    () => ({
      ...local,
      prompt: local.prompt || fallback.prompt,
      entries: local.entries.length > 0 ? local.entries : fallback.entries,
    }),
    [fallback.entries, fallback.prompt, local],
  );
  return [resolved, setLocal] as const;
}

/** RMS of an 8-bit time-domain frame, scaled to 0..1. */
export function computeVoiceLevel(samples: Uint8Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) {
    const centered = (sample - 128) / 128;
    sum += centered * centered;
  }
  return Math.min(1, Math.sqrt(sum / samples.length) * 4);
}

const SPEECH_LEVEL_THRESHOLD = 0.08;

/** Fires once after speech was heard and then stayed quiet for `autoStopMs`. Off when 0. */
export function createSilenceDetector(autoStopMs: number) {
  let heardSpeech = false;
  let quietSince: number | null = null;
  return (level: number, now: number): boolean => {
    if (autoStopMs <= 0) return false;
    if (level >= SPEECH_LEVEL_THRESHOLD) {
      heardSpeech = true;
      quietSince = null;
      return false;
    }
    if (!heardSpeech) return false;
    quietSince ??= now;
    return now - quietSince >= autoStopMs;
  };
}

async function voiceRequestInit(body: unknown): Promise<RequestInit> {
  const token = await readDesktopPrimaryBearerToken().catch(() => null);
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(token ? {} : { credentials: "include" as const }),
    body: JSON.stringify(body),
  };
}

async function postVoiceJson<T>(pathname: string, body: unknown): Promise<T> {
  const response = await fetch(resolvePrimaryEnvironmentHttpUrl(pathname), {
    ...(await voiceRequestInit(body)),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(detail || `Voice request failed (${response.status}).`);
  }
  return (await response.json()) as T;
}

function dictionaryPayload(settings: T3VoiceSettings) {
  return { prompt: settings.prompt, entries: settings.entries };
}

function providerPayload(settings: T3VoiceSettings) {
  return settings.subscriptionProvider !== "chatgpt"
    ? { provider: settings.subscriptionProvider }
    : {};
}

export async function transcribeVoiceAudio(
  audio: Blob,
  settings: T3VoiceSettings,
): Promise<string> {
  const dictionary = dictionaryPayload(settings);
  const { text } = await postVoiceJson<{ text?: string }>("/api/voice/transcribe", {
    audioBase64: await blobToBase64(audio),
    mimeType: audio.type || "audio/webm",
    dictionary,
    ...providerPayload(settings),
  });
  const trimmed = (text ?? "").trim();
  return trimmed ? normalizeTranscript(trimmed, withDefaultVoiceDictionary(dictionary)) : "";
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

/** Pulls a finished user transcript out of a realtime SSE payload; null for partials and assistant speech. */
export function readRealtimeTranscript(
  data: string,
  dictionary?: VoiceDictionary | null,
): string | null {
  let event: { type?: unknown; text?: unknown; transcript?: unknown; role?: unknown; final?: unknown };
  try {
    event = JSON.parse(data);
  } catch {
    return null;
  }
  if (event.role === "assistant") return null;
  const type = typeof event.type === "string" ? event.type : "";
  const isFinal = event.final === true || /completed|final|done/.test(type);
  if (!isFinal) return null;
  const text = typeof event.text === "string" ? event.text : event.transcript;
  const trimmed = typeof text === "string" && text.trim() ? text.trim() : null;
  if (!trimmed) return null;
  return dictionary ? normalizeTranscript(trimmed, withDefaultVoiceDictionary(dictionary)) : trimmed;
}

type VoiceStatus = "idle" | "recording" | "transcribing" | "live";

interface VoiceSession {
  stop: () => void;
  finish?: () => void;
}

function startLevelMeter(
  stream: MediaStream,
  target: HTMLElement | null,
  onLevel: (level: number, now: number) => void,
): () => void {
  const context = new AudioContext();
  const analyser = context.createAnalyser();
  analyser.fftSize = 256;
  context.createMediaStreamSource(stream).connect(analyser);
  const samples = new Uint8Array(analyser.fftSize);
  let frame = 0;
  const tick = (now: number) => {
    analyser.getByteTimeDomainData(samples);
    const level = computeVoiceLevel(samples);
    target?.style.setProperty("--voice-level", level.toFixed(3));
    onLevel(level, now);
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  return () => {
    cancelAnimationFrame(frame);
    target?.style.setProperty("--voice-level", "0");
    void context.close();
  };
}

function reportVoiceError(error: unknown) {
  toastManager.add({
    type: "error",
    title: "Voice input failed",
    description: error instanceof Error ? error.message : String(error),
  });
}

export interface ComposerVoiceControlsProps {
  disabled?: boolean;
  isAgentRunning: boolean;
  serverSettings?: unknown;
  onInsertText: (text: string) => void;
  onSendText: (text: string) => void;
}

export function ComposerVoiceControls({
  disabled = false,
  isAgentRunning,
  serverSettings,
  onInsertText,
  onSendText,
}: ComposerVoiceControlsProps) {
  const [settings, setSettings] = useVoiceSettings(serverSettings);
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [handsFreeActive, setHandsFreeActive] = useState(false);
  const sessionRef = useRef<VoiceSession | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const menuProps = useComposerMenuProps();
  const latest = useRef({ settings, onInsertText, onSendText });
  useEffect(() => {
    latest.current = { settings, onInsertText, onSendText };
  });

  const stopSession = useCallback(() => {
    sessionRef.current?.stop();
    sessionRef.current = null;
  }, []);

  useEffect(() => stopSession, [stopSession]);

  const startRecording = useCallback(
    async (handsFree: boolean) => {
      const voiceSettings = latest.current.settings;
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (error) {
        setHandsFreeActive(false);
        reportVoiceError(error);
        return;
      }
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "";
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks: Blob[] = [];
      let cancelled = false;
      const isSilent = createSilenceDetector(voiceSettings.autoStopMs);
      const stopMeter = startLevelMeter(stream, buttonRef.current, (level, now) => {
        if (recorder.state === "recording" && isSilent(level, now)) recorder.stop();
      });
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onstop = async () => {
        stopMeter();
        for (const track of stream.getTracks()) track.stop();
        if (sessionRef.current === session) sessionRef.current = null;
        if (cancelled || chunks.length === 0) {
          setStatus("idle");
          return;
        }
        setStatus("transcribing");
        try {
          const text = await transcribeVoiceAudio(
            new Blob(chunks, { type: recorder.mimeType || "audio/webm" }),
            voiceSettings,
          );
          if (text) {
            if (handsFree) latest.current.onSendText(text);
            else latest.current.onInsertText(text);
          }
        } catch (error) {
          setHandsFreeActive(false);
          reportVoiceError(error);
        }
        setStatus("idle");
      };
      const session: VoiceSession = {
        stop: () => {
          cancelled = true;
          if (recorder.state !== "inactive") recorder.stop();
        },
        finish: () => {
          if (recorder.state !== "inactive") recorder.stop();
        },
      };
      sessionRef.current = session;
      recorder.start();
      setStatus("recording");
    },
    [],
  );

  const startLive = useCallback(async () => {
    const voiceSettings = latest.current.settings;
    let stream: MediaStream | null = null;
    let peer: RTCPeerConnection | null = null;
    let events: EventSource | null = null;
    let stopMeter = () => {};
    let activeSessionId: string | null = null;
    const stopServerSession = () => {
      if (activeSessionId === null) return;
      const sessionId = activeSessionId;
      activeSessionId = null;
      void voiceRequestInit({ sessionId })
        .then((init) => fetch(resolvePrimaryEnvironmentHttpUrl("/api/voice/realtime/stop"), init))
        .catch(() => {});
    };
    const session: VoiceSession = {
      stop: () => {
        stopServerSession();
        events?.close();
        peer?.close();
        stopMeter();
        for (const track of stream?.getTracks() ?? []) track.stop();
        if (audioRef.current) audioRef.current.srcObject = null;
        setStatus("idle");
      },
    };
    sessionRef.current = session;
    setStatus("live");
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      peer = new RTCPeerConnection();
      for (const track of stream.getTracks()) peer.addTrack(track, stream);
      peer.ontrack = (event) => {
        if (audioRef.current) audioRef.current.srcObject = event.streams[0] ?? null;
      };
      peer.createDataChannel("oai-events");
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      const answer = await postVoiceJson<{ sessionId: string; sdp: string }>(
        "/api/voice/realtime/start",
        {
          sdp: offer.sdp,
          voice: voiceSettings.realtimeVoice,
          dictionary: dictionaryPayload(voiceSettings),
          ...providerPayload(voiceSettings),
        },
      );
      activeSessionId = answer.sessionId;
      if (sessionRef.current !== session) return stopServerSession();
      await peer.setRemoteDescription({ type: "answer", sdp: answer.sdp });
      stopMeter = startLevelMeter(stream, buttonRef.current, () => {});
      // ponytail: EventSource cannot carry the desktop bearer header; relies on cookie auth or a server-side session check.
      events = new EventSource(
        resolvePrimaryEnvironmentHttpUrl("/api/voice/realtime/events", {
          sessionId: answer.sessionId,
        }),
        { withCredentials: true },
      );
      events.addEventListener("message", (message) => {
        const text = readRealtimeTranscript(
          String(message.data),
          dictionaryPayload(latest.current.settings),
        );
        if (text) latest.current.onInsertText(text);
      });
    } catch (error) {
      session.stop();
      if (sessionRef.current === session) sessionRef.current = null;
      reportVoiceError(error);
    }
  }, []);

  useEffect(() => {
    if (!handsFreeActive || status !== "idle" || isAgentRunning || disabled) return;
    const timer = window.setTimeout(() => void startRecording(true), 600);
    return () => window.clearTimeout(timer);
  }, [disabled, handsFreeActive, isAgentRunning, startRecording, status]);

  const active = status !== "idle" || handsFreeActive;

  const toggle = () => {
    if (active) {
      setHandsFreeActive(false);
      if (status === "recording" && !handsFreeActive) {
        sessionRef.current?.finish?.();
        return;
      }
      stopSession();
      return;
    }
    if (settings.mode === "live") void startLive();
    else if (settings.mode === "hands-free") setHandsFreeActive(true);
    else void startRecording(false);
  };

  const label = active
    ? status === "transcribing"
      ? "Transcribing…"
      : `Stop ${VOICE_MODE_LABELS[settings.mode].toLowerCase()}`
    : VOICE_MODE_LABELS[settings.mode];
  const ModeIcon =
    settings.mode === "live" ? AudioLinesIcon : settings.mode === "hands-free" ? RepeatIcon : MicIcon;

  return (
    <div data-composer-voice-controls="true" className="flex items-center">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              ref={buttonRef}
              type="button"
              variant={active ? "secondary" : "ghost"}
              size="icon-sm"
              disabled={disabled && !active}
              data-voice-status={status}
              aria-pressed={active}
              aria-label={label}
              onPointerDown={(event) => event.preventDefault()}
              onClick={toggle}
              className="relative"
              style={{ "--voice-level": 0 } as CSSProperties}
            />
          }
        >
          {active ? (
            <span
              aria-hidden
              className="pointer-events-none absolute inset-0 rounded-full bg-primary/20 transition-transform duration-75"
              style={{ transform: "scale(calc(1 + var(--voice-level, 0) * 0.35))" }}
            />
          ) : null}
          <ModeIcon className="relative" />
        </TooltipTrigger>
        <TooltipPopup>{label}</TooltipPopup>
      </Tooltip>
      <Menu>
        <MenuTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              disabled={active}
              aria-label="Voice mode"
              onPointerDown={(event) => event.preventDefault()}
            />
          }
        >
          <ChevronDownIcon className="size-3 opacity-60" />
        </MenuTrigger>
        <MenuPopup align="end" side="top" {...menuProps}>
          <MenuGroup>
            <MenuGroupLabel>Voice mode</MenuGroupLabel>
            <MenuRadioGroup
              value={settings.mode}
              onValueChange={(value) => {
                const mode = VOICE_MODES.find((candidate) => candidate === value);
                if (mode) setSettings((current) => ({ ...current, mode }));
              }}
            >
              {VOICE_MODES.map((mode) => (
                <MenuRadioItem key={mode} value={mode} closeOnClick>
                  <span className="flex items-center gap-1.5">
                    {mode === "live" ? (
                      <RadioIcon className="size-3" aria-hidden />
                    ) : mode === "hands-free" ? (
                      <RepeatIcon className="size-3" aria-hidden />
                    ) : (
                      <MicIcon className="size-3" aria-hidden />
                    )}
                    {VOICE_MODE_LABELS[mode]}
                  </span>
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
          <MenuGroup>
            <MenuGroupLabel>Subscription dictionary</MenuGroupLabel>
            <MenuRadioGroup
              value={settings.subscriptionProvider}
              onValueChange={(value) => {
                const provider = VOICE_SUBSCRIPTION_PROVIDERS.find((candidate) => candidate === value);
                if (provider) setSettings((current) => applySubscriptionDictionaryPreset(current, provider));
              }}
            >
              {VOICE_SUBSCRIPTION_PROVIDERS.map((provider) => (
                <MenuRadioItem key={provider} value={provider} closeOnClick>
                  {VOICE_SUBSCRIPTION_LABELS[provider]}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
        </MenuPopup>
      </Menu>
      <audio ref={audioRef} autoPlay playsInline hidden />
    </div>
  );
}

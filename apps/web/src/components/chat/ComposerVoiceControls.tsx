import * as Schema from "effect/Schema";
import { AudioLinesIcon, ChevronDownIcon, MicIcon, RadioIcon, RepeatIcon } from "lucide-react";
import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";

import { resolvePrimaryEnvironmentHttpUrl } from "../../environments/primary";
import { readDesktopPrimaryBearerToken } from "../../environments/primary/desktopAuth";
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

export const RECORDING_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
] as const;

export const VoiceSettingsSchema = Schema.Struct({
  mode: Schema.Literals(VOICE_MODES),
  autoStopMs: Schema.Literals(VOICE_AUTO_STOP_OPTIONS),
  realtimeVoice: Schema.Literals(VOICE_REALTIME_VOICES),
});

export type T3VoiceSettings = typeof VoiceSettingsSchema.Type;
export type T3VoiceMode = T3VoiceSettings["mode"];
export type T3VoiceAutoStopMs = T3VoiceSettings["autoStopMs"];

export const DEFAULT_VOICE_SETTINGS: T3VoiceSettings = {
  mode: "dictation",
  autoStopMs: 2500,
  realtimeVoice: "cove",
};

export const VOICE_MODE_LABELS: Record<T3VoiceMode, string> = {
  dictation: "Dictate",
  "hands-free": "Hands-free loop",
  live: "Live voice",
};

export const VOICE_AUTO_STOP_LABELS: Record<T3VoiceAutoStopMs, string> = {
  0: "Off",
  1500: "1.5s",
  2500: "2.5s",
  4000: "4s",
  6000: "6s",
};

export function useVoiceSettings() {
  return useLocalStorage(VOICE_SETTINGS_STORAGE_KEY, DEFAULT_VOICE_SETTINGS, VoiceSettingsSchema);
}

/** Picks the first supported MediaRecorder MIME type in Empryo's priority order. */
export function pickRecordingMimeType(): string {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    return "";
  }
  for (const candidate of RECORDING_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(candidate)) return candidate;
  }
  return "";
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

export async function transcribeVoiceAudio(audio: Blob): Promise<string> {
  const { text } = await postVoiceJson<{ text?: string }>("/api/voice/transcribe", {
    audioBase64: await blobToBase64(audio),
    mimeType: audio.type || "audio/webm",
  });
  return (text ?? "").trim();
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
export function readRealtimeTranscript(data: string): string | null {
  let event: { type?: unknown; text?: unknown };
  try {
    event = JSON.parse(data);
  } catch {
    return null;
  }
  if (event.type !== "user-final" || typeof event.text !== "string") {
    return null;
  }
  return event.text.trim() || null;
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
  onInsertText: (text: string) => void;
  onSendText: (text: string) => void;
}

export function ComposerVoiceControls({
  disabled = false,
  isAgentRunning,
  onInsertText,
  onSendText,
}: ComposerVoiceControlsProps) {
  const [settings, setSettings] = useVoiceSettings();
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

  const startRecording = useCallback(async (handsFree: boolean) => {
    const voiceSettings = latest.current.settings;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      setHandsFreeActive(false);
      reportVoiceError(error);
      return;
    }
    const mimeType = pickRecordingMimeType();
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
          new Blob(chunks, { type: recorder.mimeType || mimeType || "audio/webm" }),
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
  }, []);

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
        },
      );
      activeSessionId = answer.sessionId;
      if (sessionRef.current !== session) return stopServerSession();
      await peer.setRemoteDescription({ type: "answer", sdp: answer.sdp });
      stopMeter = startLevelMeter(stream, buttonRef.current, () => {});
      events = new EventSource(
        resolvePrimaryEnvironmentHttpUrl("/api/voice/realtime/events", {
          sessionId: answer.sessionId,
        }),
        { withCredentials: true },
      );
      events.addEventListener("message", (message) => {
        const text = readRealtimeTranscript(String(message.data));
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
    settings.mode === "live"
      ? AudioLinesIcon
      : settings.mode === "hands-free"
        ? RepeatIcon
        : MicIcon;

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
            <MenuGroupLabel>Auto-stop on silence</MenuGroupLabel>
            <MenuRadioGroup
              value={String(settings.autoStopMs)}
              onValueChange={(value) => {
                const autoStopMs = VOICE_AUTO_STOP_OPTIONS.find(
                  (candidate) => String(candidate) === String(value),
                );
                if (autoStopMs !== undefined) {
                  setSettings((current) => ({ ...current, autoStopMs }));
                }
              }}
            >
              {VOICE_AUTO_STOP_OPTIONS.map((autoStopMs) => (
                <MenuRadioItem key={autoStopMs} value={String(autoStopMs)} closeOnClick>
                  {VOICE_AUTO_STOP_LABELS[autoStopMs]}
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

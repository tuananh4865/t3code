import { act, cloneElement, createContext, isValidElement, type ReactElement, type ReactNode, useContext } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
// @ts-expect-error jsdom ships no type declarations
import { JSDOM } from "jsdom";

const { window: jsdomWindow } = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://primary.test/",
});
Object.assign(globalThis, {
  window: jsdomWindow,
  document: jsdomWindow.document,
  localStorage: jsdomWindow.localStorage,
  HTMLElement: jsdomWindow.HTMLElement,
  Element: jsdomWindow.Element,
  Node: jsdomWindow.Node,
  Event: jsdomWindow.Event,
  CustomEvent: jsdomWindow.CustomEvent,
});
Object.defineProperty(globalThis, "navigator", {
  value: jsdomWindow.navigator,
  configurable: true,
  writable: true,
});

const restoredGlobals = new Map<string, PropertyDescriptor | undefined>();
function setGlobal(name: string, value: unknown) {
  if (!restoredGlobals.has(name)) {
    restoredGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  }
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
  });
}

const RadioGroupContext = createContext<{
  value?: unknown;
  onValueChange?: ((value: unknown) => void) | undefined;
}>({});

vi.mock("../ui/menu", () => ({
  Menu: ({ children }: { children?: ReactNode }) => <div data-slot="menu">{children}</div>,
  MenuTrigger: ({ render, children }: { render?: ReactElement; children?: ReactNode }) =>
    isValidElement(render) ? cloneElement(render, undefined, children) : <button type="button">{children}</button>,
  MenuPopup: ({ children }: { children?: ReactNode }) => <div role="menu">{children}</div>,
  MenuGroup: ({ children }: { children?: ReactNode }) => <div role="group">{children}</div>,
  MenuGroupLabel: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  MenuRadioGroup: ({
    value,
    onValueChange,
    children,
  }: {
    value?: unknown;
    onValueChange?: (value: unknown) => void;
    children?: ReactNode;
  }) => (
    <RadioGroupContext.Provider value={{ value, onValueChange }}>
      <div role="radiogroup">{children}</div>
    </RadioGroupContext.Provider>
  ),
  MenuRadioItem: ({ value, children }: { value: unknown; children?: ReactNode }) => {
    const group = useContext(RadioGroupContext);
    return (
      <button
        type="button"
        role="menuitemradio"
        aria-checked={group.value === value}
        onClick={() => group.onValueChange?.(value)}
      >
        {children}
      </button>
    );
  },
}));

vi.mock("../../environments/primary", () => ({
  resolvePrimaryEnvironmentHttpUrl: (pathname: string) => `http://primary.test${pathname}`,
}));
vi.mock("../../environments/primary/desktopAuth", () => ({
  readDesktopPrimaryBearerToken: vi.fn(async () => "desktop-token"),
}));

import {
  ComposerVoiceControls,
  computeVoiceLevel,
  createSilenceDetector,
  DEFAULT_VOICE_SETTINGS,
  pickRecordingMimeType,
  readRealtimeTranscript,
  transcribeVoiceAudio,
  VOICE_SETTINGS_STORAGE_KEY,
} from "./ComposerVoiceControls";

afterEach(() => {
  for (const [name, descriptor] of restoredGlobals) {
    if (descriptor) {
      Object.defineProperty(globalThis, name, descriptor);
    } else {
      Reflect.deleteProperty(globalThis, name);
    }
  }
  restoredGlobals.clear();
  localStorage.clear();
});

describe("computeVoiceLevel", () => {
  it("is 0 for silence and rises with amplitude, clamped to 1", () => {
    expect(computeVoiceLevel(new Uint8Array(256).fill(128))).toBe(0);
    const quiet = computeVoiceLevel(
      Uint8Array.from({ length: 256 }, (_, i) => (i % 2 ? 132 : 124)),
    );
    const loud = computeVoiceLevel(Uint8Array.from({ length: 256 }, (_, i) => (i % 2 ? 255 : 0)));
    expect(quiet).toBeGreaterThan(0);
    expect(loud).toBe(1);
    expect(loud).toBeGreaterThan(quiet);
  });
});

describe("createSilenceDetector", () => {
  it("never stops before speech was heard", () => {
    const isSilent = createSilenceDetector(2500);
    expect(isSilent(0, 0)).toBe(false);
    expect(isSilent(0, 10_000)).toBe(false);
  });

  it("stops after autoStopMs of quiet following speech, and resets when speech resumes", () => {
    const isSilent = createSilenceDetector(2500);
    expect(isSilent(0.5, 0)).toBe(false);
    expect(isSilent(0, 100)).toBe(false);
    expect(isSilent(0, 2000)).toBe(false);
    expect(isSilent(0.5, 2100)).toBe(false);
    expect(isSilent(0, 2200)).toBe(false);
    expect(isSilent(0, 4699)).toBe(false);
    expect(isSilent(0, 4700)).toBe(true);
  });

  it("is disabled when autoStopMs is 0", () => {
    const isSilent = createSilenceDetector(0);
    isSilent(0.5, 0);
    expect(isSilent(0, 60_000)).toBe(false);
  });
});

describe("pickRecordingMimeType", () => {
  it("returns the first supported mimeType in Empryo priority order", () => {
    setGlobal("MediaRecorder", {
      isTypeSupported: (mime: string) => mime === "audio/mp4" || mime === "audio/ogg;codecs=opus",
    });
    expect(pickRecordingMimeType()).toBe("audio/mp4");
  });

  it("returns empty string when MediaRecorder is unavailable", () => {
    setGlobal("MediaRecorder", undefined);
    expect(pickRecordingMimeType()).toBe("");
  });
});

describe("readRealtimeTranscript", () => {
  it("returns trimmed text for user-final events only", () => {
    expect(readRealtimeTranscript('{"type":"user-final","text":" hello "}')).toBe("hello");
    expect(readRealtimeTranscript('{"type":"user-final","text":"   "}')).toBeNull();
    expect(readRealtimeTranscript('{"type":"transcript.delta","text":"hel"}')).toBeNull();
    expect(readRealtimeTranscript("not json")).toBeNull();
  });
});

describe("transcribeVoiceAudio", () => {
  it("posts base64 audio and mimeType with the desktop bearer token", async () => {
    const fetchMock = vi.fn(async () => Response.json({ text: "  ship it  " }));
    setGlobal("fetch", fetchMock);

    const text = await transcribeVoiceAudio(
      new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm;codecs=opus" }),
    );

    expect(text).toBe("ship it");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://primary.test/api/voice/transcribe");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer desktop-token");
    expect(JSON.parse(String(init.body))).toEqual({
      audioBase64: "AQID",
      mimeType: "audio/webm;codecs=opus",
    });
  });

  it("falls back to audio/webm when blob type is empty and surfaces server errors", async () => {
    setGlobal("fetch", async () => new Response("no key", { status: 500 }));
    await expect(transcribeVoiceAudio(new Blob([new Uint8Array([1])]))).rejects.toThrow("no key");
  });
});

describe("ComposerVoiceControls", () => {
  it("renders the mic button with the voice level variable and a mode menu", () => {
    const markup = renderToStaticMarkup(
      <ComposerVoiceControls
        isAgentRunning={false}
        onInsertText={() => {}}
        onSendText={() => {}}
      />,
    );
    expect(markup).toContain('aria-label="Dictate"');
    expect(markup).toContain("--voice-level:0");
    expect(markup).toContain('aria-label="Voice mode"');
    expect(markup).toContain("<audio");
  });

  it("disables the mic when the composer is disabled", () => {
    const markup = renderToStaticMarkup(
      <ComposerVoiceControls
        disabled
        isAgentRunning={false}
        onInsertText={() => {}}
        onSendText={() => {}}
      />,
    );
    expect(markup).toMatch(
      /<button[^>]*disabled[^>]*aria-label="Dictate"|<button[^>]*aria-label="Dictate"[^>]*disabled/,
    );
  });

  it("switches voice modes (Dictate, Hands-free loop, Live voice) and auto-stop on silence", async () => {
    setGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <ComposerVoiceControls
          isAgentRunning={false}
          onInsertText={() => {}}
          onSendText={() => {}}
        />,
      );
    });
    const button = container.querySelector<HTMLButtonElement>("[data-voice-status]")!;
    expect(button.getAttribute("aria-label")).toBe("Dictate");

    const findRadioItem = (text: string) =>
      Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')).find(
        (el) => el.textContent?.trim() === text,
      );

    await act(async () => {
      findRadioItem("Hands-free loop")!.click();
    });
    expect(button.getAttribute("aria-label")).toBe("Hands-free loop");
    expect(JSON.parse(localStorage.getItem(VOICE_SETTINGS_STORAGE_KEY)!).mode).toBe("hands-free");

    await act(async () => {
      findRadioItem("Live voice")!.click();
    });
    expect(button.getAttribute("aria-label")).toBe("Live voice");
    expect(JSON.parse(localStorage.getItem(VOICE_SETTINGS_STORAGE_KEY)!).mode).toBe("live");

    await act(async () => {
      findRadioItem("Dictate")!.click();
    });
    expect(button.getAttribute("aria-label")).toBe("Dictate");
    expect(JSON.parse(localStorage.getItem(VOICE_SETTINGS_STORAGE_KEY)!).mode).toBe("dictation");

    await act(async () => {
      findRadioItem("4s")!.click();
    });
    expect(JSON.parse(localStorage.getItem(VOICE_SETTINGS_STORAGE_KEY)!).autoStopMs).toBe(4000);

    await act(async () => {
      findRadioItem("Off")!.click();
    });
    expect(JSON.parse(localStorage.getItem(VOICE_SETTINGS_STORAGE_KEY)!).autoStopMs).toBe(0);

    await act(async () => root.unmount());
    container.remove();
  });
});

describe("ComposerVoiceControls live mode", () => {
  it("tells the server to stop the realtime session when the user stops Live", async () => {
    setGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    localStorage.setItem(
      VOICE_SETTINGS_STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_VOICE_SETTINGS, mode: "live" }),
    );
    const track = { stop: vi.fn() };
    setGlobal("navigator", {
      ...navigator,
      mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })) },
    });
    class FakePeer {
      ontrack: unknown;
      addTrack = vi.fn();
      createDataChannel = vi.fn();
      createOffer = vi.fn(async () => ({ type: "offer", sdp: "offer-sdp" }));
      setLocalDescription = vi.fn(async () => {});
      setRemoteDescription = vi.fn(async () => {});
      close = vi.fn();
    }
    class FakeEventSource {
      addEventListener = vi.fn();
      close = vi.fn();
    }
    class FakeAudioContext {
      createAnalyser = () => ({ fftSize: 0, getByteTimeDomainData: vi.fn() });
      createMediaStreamSource = () => ({ connect: vi.fn() });
      close = vi.fn(async () => {});
    }
    setGlobal("RTCPeerConnection", FakePeer);
    setGlobal("EventSource", FakeEventSource);
    setGlobal("AudioContext", FakeAudioContext);
    setGlobal("requestAnimationFrame", () => 1);
    setGlobal("cancelAnimationFrame", () => {});
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
      url.endsWith("/realtime/start")
        ? Response.json({ sessionId: "thread-1", sdp: "answer-sdp" })
        : new Response(null, { status: 204 }),
    );
    setGlobal("fetch", fetchMock);

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <ComposerVoiceControls
          isAgentRunning={false}
          onInsertText={() => {}}
          onSendText={() => {}}
        />,
      );
    });
    const button = container.querySelector<HTMLButtonElement>("[data-voice-status]")!;

    await act(async () => button.click());
    expect(button.dataset.voiceStatus).toBe("live");
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "http://primary.test/api/voice/realtime/start",
    ]);
    const startInit = fetchMock.mock.calls[0]![1]!;
    expect(JSON.parse(String(startInit.body))).toEqual({
      sdp: "offer-sdp",
      voice: "cove",
    });

    await act(async () => button.click());
    const stopCall = fetchMock.mock.calls.find(([url]) => url.endsWith("/api/voice/realtime/stop"));
    expect(stopCall).toBeDefined();
    const init = stopCall![1]!;
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ sessionId: "thread-1" });

    await act(async () => root.unmount());
    container.remove();
  });
});

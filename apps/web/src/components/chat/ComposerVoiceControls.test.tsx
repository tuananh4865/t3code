import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

await vi.hoisted(async () => {
  // @ts-expect-error jsdom ships no type declarations
  const { JSDOM } = await import("jsdom");
  const { window } = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://primary.test/",
  });
  Object.assign(globalThis, {
    window,
    document: window.document,
    localStorage: window.localStorage,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    Event: window.Event,
    CustomEvent: window.CustomEvent,
  });
  Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
});

vi.mock("../../environments/primary", () => ({
  resolvePrimaryEnvironmentHttpUrl: (pathname: string) => `http://primary.test${pathname}`,
}));
vi.mock("../../environments/primary/desktopAuth", () => ({
  readDesktopPrimaryBearerToken: vi.fn(async () => "desktop-token"),
}));

import {
  applySubscriptionDictionaryPreset,
  ComposerVoiceControls,
  computeVoiceLevel,
  createSilenceDetector,
  DEFAULT_VOICE_SETTINGS,
  formatVoiceDictionaryText,
  parseVoiceDictionaryText,
  readRealtimeTranscript,
  transcribeVoiceAudio,
  VOICE_DICTIONARY_MAX_ENTRIES,
  VOICE_SETTINGS_STORAGE_KEY,
  voiceSettingsFromServer,
} from "./ComposerVoiceControls";

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("parseVoiceDictionaryText", () => {
  it("reads plain terms and `Term: alias, alias` lines, skipping blanks and duplicates", () => {
    expect(parseVoiceDictionaryText("T3 Code\n\nEffect: effect ts, effects ,\nt3 code\n  ")).toEqual(
      [
        { term: "T3 Code", aliases: [] },
        { term: "Effect", aliases: ["effect ts", "effects"] },
      ],
    );
  });

  it(`caps the dictionary at ${VOICE_DICTIONARY_MAX_ENTRIES} terms`, () => {
    const text = Array.from({ length: 150 }, (_, index) => `term-${index}`).join("\n");
    const entries = parseVoiceDictionaryText(text);
    expect(entries).toHaveLength(VOICE_DICTIONARY_MAX_ENTRIES);
    expect(entries.at(-1)?.term).toBe("term-99");
  });

  it("round-trips through the text format", () => {
    const entries = [
      { term: "Hermes", aliases: ["hermez", "her mes"] },
      { term: "Empryo", aliases: [] },
    ];
    expect(parseVoiceDictionaryText(formatVoiceDictionaryText(entries))).toEqual(entries);
  });
});

describe("computeVoiceLevel", () => {
  it("is 0 for silence and rises with amplitude, clamped to 1", () => {
    expect(computeVoiceLevel(new Uint8Array(256).fill(128))).toBe(0);
    const quiet = computeVoiceLevel(Uint8Array.from({ length: 256 }, (_, i) => (i % 2 ? 132 : 124)));
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

describe("voiceSettingsFromServer", () => {
  it("defaults to dictation with a 2.5s auto stop", () => {
    expect(voiceSettingsFromServer(undefined)).toEqual(DEFAULT_VOICE_SETTINGS);
    expect(DEFAULT_VOICE_SETTINGS.autoStopMs).toBe(2500);
  });

  it("picks up valid server voice fields and ignores invalid ones", () => {
    expect(
      voiceSettingsFromServer({
        voiceRealtimeVoice: "ember",
        voiceDictionary: { prompt: "T3", entries: [{ term: "Bun", aliases: [] }, { bad: 1 }] },
      }),
    ).toMatchObject({ realtimeVoice: "ember", prompt: "T3", entries: [{ term: "Bun", aliases: [] }] });
    expect(voiceSettingsFromServer({ voiceRealtimeVoice: "robot" }).realtimeVoice).toBe("cove");
  });
});

describe("subscription dictionary presets", () => {
  it("swaps preset terms when switching providers and keeps custom terms", () => {
    const custom = { term: "Hermes", aliases: ["hermez"] };
    const grok = applySubscriptionDictionaryPreset(
      { ...DEFAULT_VOICE_SETTINGS, entries: [custom] },
      "grok",
    );
    expect(grok.subscriptionProvider).toBe("grok");
    const grokTerms = grok.entries.map((entry) => entry.term);
    expect(grokTerms).toEqual(
      expect.arrayContaining(["SuperGrok", "Grok Heavy", "X Premium+", "Grok Build", "xAI", "Hermes"]),
    );
    expect(grokTerms).not.toContain("ChatGPT Plus");

    const chatgpt = applySubscriptionDictionaryPreset(grok, "chatgpt");
    const chatgptTerms = chatgpt.entries.map((entry) => entry.term);
    expect(chatgpt.subscriptionProvider).toBe("chatgpt");
    expect(chatgptTerms).toEqual(
      expect.arrayContaining(["ChatGPT Plus", "ChatGPT Pro", "OpenAI Codex", "Hermes"]),
    );
    expect(chatgptTerms).not.toContain("SuperGrok");
    expect(chatgptTerms.filter((term) => term === "Empryo")).toHaveLength(1);
  });

  it("reads voiceSubscriptionProvider from server settings", () => {
    expect(voiceSettingsFromServer({ voiceSubscriptionProvider: "grok" }).subscriptionProvider).toBe(
      "grok",
    );
    expect(voiceSettingsFromServer({ voiceSubscriptionProvider: "bard" }).subscriptionProvider).toBe(
      "chatgpt",
    );
  });
});

describe("readRealtimeTranscript", () => {
  it("returns final user transcripts only and normalizes dictionary terms when provided", () => {
    expect(readRealtimeTranscript('{"type":"transcript.completed","text":" hello "}')).toBe("hello");
    expect(
      readRealtimeTranscript(
        '{"type":"transcript.completed","text":" mở tai pờ scờ ríp cho dam me "}',
        { prompt: "", entries: [{ term: "Dầm Mê", aliases: ["dam me"] }] },
      ),
    ).toBe("mở TypeScript cho Dầm Mê");
    expect(readRealtimeTranscript('{"type":"transcript.delta","text":"hel"}')).toBeNull();
    expect(
      readRealtimeTranscript('{"type":"transcript.completed","role":"assistant","text":"hi"}'),
    ).toBeNull();
    expect(readRealtimeTranscript("not json")).toBeNull();
  });
});

describe("transcribeVoiceAudio", () => {
  it("posts base64 audio and the dictionary with the desktop bearer token", async () => {
    const fetchMock = vi.fn(async () => Response.json({ text: "  ship it  " }));
    vi.stubGlobal("fetch", fetchMock);

    const text = await transcribeVoiceAudio(
      new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm;codecs=opus" }),
      { ...DEFAULT_VOICE_SETTINGS, prompt: "T3", entries: [{ term: "Bun", aliases: ["bunn"] }] },
    );

    expect(text).toBe("ship it");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://primary.test/api/voice/transcribe");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer desktop-token");
    expect(JSON.parse(String(init.body))).toEqual({
      audioBase64: "AQID",
      mimeType: "audio/webm;codecs=opus",
      dictionary: { prompt: "T3", entries: [{ term: "Bun", aliases: ["bunn"] }] },
    });
  });

  it("sends provider grok when the Grok subscription is selected", async () => {
    const fetchMock = vi.fn(async () => Response.json({ text: "hi" }));
    vi.stubGlobal("fetch", fetchMock);

    await transcribeVoiceAudio(new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }), {
      ...DEFAULT_VOICE_SETTINGS,
      subscriptionProvider: "grok",
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      audioBase64: "AQID",
      mimeType: "audio/webm",
      dictionary: { prompt: "", entries: [] },
      provider: "grok",
    });
  });

  it("surfaces server errors", async () => {
    vi.stubGlobal("fetch", async () => new Response("no key", { status: 500 }));
    await expect(
      transcribeVoiceAudio(new Blob([new Uint8Array([1])]), DEFAULT_VOICE_SETTINGS),
    ).rejects.toThrow("no key");
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
    expect(markup).toMatch(/<button[^>]*disabled[^>]*aria-label="Dictate"|<button[^>]*aria-label="Dictate"[^>]*disabled/);
  });
});

describe("ComposerVoiceControls live mode", () => {
  it("tells the server to stop the realtime session when the user stops Live", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    localStorage.setItem(
      VOICE_SETTINGS_STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_VOICE_SETTINGS, mode: "live" }),
    );
    const track = { stop: vi.fn() };
    vi.stubGlobal("navigator", {
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
    vi.stubGlobal("RTCPeerConnection", FakePeer);
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
      url.endsWith("/realtime/start")
        ? Response.json({ sessionId: "thread-1", sdp: "answer-sdp" })
        : new Response(null, { status: 204 }),
    );
    vi.stubGlobal("fetch", fetchMock);

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

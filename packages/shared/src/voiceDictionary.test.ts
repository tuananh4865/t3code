import { describe, expect, it } from "@effect/vitest";

import {
  buildRealtimeStartContext,
  DEFAULT_VOICE_DICTIONARY,
  foldVoiceText,
  formatVoiceDictionaryText,
  normalizeTranscript,
  parseVoiceDictionaryText,
  phoneticKey,
  suggestVoiceDictionaryTerms,
  getSubscriptionVoiceDictionary,
  VOICE_DICTIONARY_MAX_ENTRIES,
  VOICE_SUBSCRIPTION_PROVIDERS,
  withDefaultVoiceDictionary,
} from "./voiceDictionary.ts";

const entries = (...terms: string[]) => ({
  prompt: "",
  entries: terms.map((term) => ({ term, aliases: [] as string[] })),
});

describe("voiceDictionary (@t3tools/shared/voiceDictionary)", () => {
  it("folds accents and đ", () => {
    expect(foldVoiceText("Đường Mở ơ")).toBe("duong mo o");
  });

  it("maps Vietnamese and English spellings to one phonetic key", () => {
    expect(phoneticKey("phone")).toBe(phoneticKey("fone"));
    expect(phoneticKey("chat")).toBe(phoneticKey("trat"));
    expect(phoneticKey("coffee")).toBe(phoneticKey("kofe"));
  });

  it("normalizes with DEFAULT_VOICE_DICTIONARY when dictionary is omitted", () => {
    expect(normalizeTranscript("tích hợp từ điển của em prio vào ti ba cốt")).toBe(
      "tích hợp từ điển của Empryo vào T3 Code",
    );
  });

  it("merges custom entries ahead of default entries in withDefaultVoiceDictionary", () => {
    const merged = withDefaultVoiceDictionary({
      prompt: "Custom prompt",
      entries: [{ term: "Dầm Mê", aliases: ["dam me"] }],
    });
    expect(merged.prompt).toBe("Custom prompt");
    expect(merged.entries[0]).toEqual({ term: "Dầm Mê", aliases: ["dam me"] });
    expect(merged.entries.some((entry) => entry.term === "T3 Code")).toBe(true);
    expect(normalizeTranscript("bán hàng dam me trên ti ba cốt", merged)).toBe(
      "bán hàng Dầm Mê trên T3 Code",
    );
  });

  it("suggests canonical terms for misspelled words in spellcheck menus", () => {
    expect(suggestVoiceDictionaryTerms("typescirpt")).toContain("TypeScript");
    expect(suggestVoiceDictionaryTerms("emprio")).toContain("Empryo");
    expect(
      suggestVoiceDictionaryTerms("damme", {
        prompt: "",
        entries: [{ term: "Dầm Mê", aliases: ["dam me"] }],
      }),
    ).toContain("Dầm Mê");
    expect(suggestVoiceDictionaryTerms("TypeScript")).toEqual([]);
  });

  it("parses and formats dictionary text up to VOICE_DICTIONARY_MAX_ENTRIES", () => {
    const parsed = parseVoiceDictionaryText("T3 Code\nEffect: effect ts, effects\n");
    expect(parsed).toEqual([
      { term: "T3 Code", aliases: [] },
      { term: "Effect", aliases: ["effect ts", "effects"] },
    ]);
    expect(parseVoiceDictionaryText(formatVoiceDictionaryText(parsed))).toEqual(parsed);
    expect(DEFAULT_VOICE_DICTIONARY.entries.length).toBeLessThanOrEqual(
      VOICE_DICTIONARY_MAX_ENTRIES,
    );
  });

  it("builds realtime context and respects protected inline code and URLs", () => {
    const dictionary = entries("TypeScript");
    expect(normalizeTranscript("`type script` https://type-script.dev", dictionary)).toBe(
      "`type script` https://type-script.dev",
    );
    expect(buildRealtimeStartContext(dictionary).prompt).toContain("TypeScript");
  });

  it("ships a tailored dictionary per subscription provider", () => {
    expect(VOICE_SUBSCRIPTION_PROVIDERS).toEqual(["chatgpt", "grok"]);
    const grok = getSubscriptionVoiceDictionary("grok");
    const chatgpt = getSubscriptionVoiceDictionary("chatgpt");
    expect(grok.entries.map((e) => e.term)).toEqual(
      expect.arrayContaining(["SuperGrok", "Grok Heavy", "X Premium+", "Grok Build", "xAI", "Grok", "T3 Code"]),
    );
    expect(chatgpt.entries.map((e) => e.term)).toEqual(
      expect.arrayContaining(["ChatGPT Plus", "ChatGPT Pro", "ChatGPT Team", "OpenAI Codex"]),
    );
    expect(grok.prompt).not.toBe(chatgpt.prompt);
  });

  it("recognizes both subscriptions by default and merges the provider preset", () => {
    expect(normalizeTranscript("gói super grok", DEFAULT_VOICE_DICTIONARY)).toBe("SuperGrok");
    expect(normalizeTranscript("chat gpt plus", DEFAULT_VOICE_DICTIONARY)).toBe("ChatGPT Plus");
    const merged = withDefaultVoiceDictionary(null, "grok");
    expect(merged.entries.map((e) => e.term)).toContain("Grok Heavy");
    expect(normalizeTranscript("grốc he vi", merged)).toBe("Grok Heavy");
    expect(merged.prompt).toBe(getSubscriptionVoiceDictionary("grok").prompt);
    expect(withDefaultVoiceDictionary({ prompt: "mine", entries: [] }, "grok").prompt).toBe("mine");
    expect(withDefaultVoiceDictionary(null)).toBe(DEFAULT_VOICE_DICTIONARY);
  });
});

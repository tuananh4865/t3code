// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - The fake `codex` child process is driven through the real filesystem, PATH and wall clock.
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { layerTest } from "../serverSettings.ts";
import * as ChatGptVoice from "./ChatGptVoiceService.ts";
import {
  buildRealtimeStartContext,
  foldVoiceText,
  normalizeTranscript,
  phoneticKey,
  VOICE_SUBSCRIPTION_DICTIONARIES,
  withDefaultVoiceDictionary,
} from "./voiceDictionary.ts";

const entries = (...terms: string[]) => ({
  prompt: "",
  entries: terms.map((term) => ({ term, aliases: [] as string[] })),
});

describe("voiceDictionary", () => {
  it("folds accents and đ", () => {
    expect(foldVoiceText("Đường Mở ơ")).toBe("duong mo o");
  });

  it("maps Vietnamese and English spellings to one phonetic key", () => {
    expect(phoneticKey("phone")).toBe(phoneticKey("fone"));
    expect(phoneticKey("chat")).toBe(phoneticKey("trat"));
    expect(phoneticKey("coffee")).toBe(phoneticKey("kofe"));
  });

  it.each([
    ["mở file tai pờ scờ ríp", "TypeScript", "mở file TypeScript"],
    ["dùng type script nhé", "TypeScript", "dùng TypeScript nhé"],
    ["chạy pi en pi em", "pnpm", "chạy pnpm"],
    ["gọi giê mi nai", "Gemini", "gọi Gemini"],
    ["rì ách", "React", "React"],
    ["Hermes wiki", "Hermes", "Hermes wiki"],
    ["`typescript`", "TypeScript", "`typescript`"],
    ["cat", "Codex", "cat"],
  ])("normalizes %j with %s", (input, term, expected) => {
    expect(normalizeTranscript(input, entries(term))).toBe(expected);
  });

  it("replaces several terms in one sentence", () => {
    expect(
      normalizeTranscript(
        "tích hợp từ điển của em prio vào ti ba cốt",
        entries("Empryo", "T3 Code"),
      ),
    ).toBe("tích hợp từ điển của Empryo vào T3 Code");
  });

  it("skips URLs and paths", () => {
    const dictionary = entries("TypeScript");
    expect(normalizeTranscript("mở https://type-script.dev rồi", dictionary)).toBe(
      "mở https://type-script.dev rồi",
    );
    expect(normalizeTranscript("sửa src/type script/a.ts", dictionary)).toBe(
      "sửa src/type script/a.ts",
    );
  });

  it("uses custom aliases and fixes small misspellings", () => {
    const dictionary = {
      prompt: "",
      entries: [
        { term: "Dầm Mê", aliases: ["dam me"] },
        { term: "Codex", aliases: [] },
      ],
    };
    expect(normalizeTranscript("bán hàng dam me", dictionary)).toBe("bán hàng Dầm Mê");
    expect(normalizeTranscript("chạy codes đi", dictionary)).toBe("chạy Codex đi");
  });

  it("does not turn gõ into Go", () => {
    expect(normalizeTranscript("gõ phím", entries("Go"))).toBe("gõ phím");
  });

  it("leaves text alone without a dictionary", () => {
    expect(normalizeTranscript("xin chào", entries())).toBe("xin chào");
  });

  it("builds a realtime context from entries and the free-form prompt", () => {
    const context = buildRealtimeStartContext({
      prompt: "Speak Vietnamese.",
      entries: [{ term: "Empryo", aliases: ["em prio"] }],
    });
    expect(context.prompt).toContain("Empryo (may be heard as: em prio");
    expect(context.prompt).toContain("Speak Vietnamese.");
    expect(context.initialItems).toEqual([{ role: "developer", text: context.prompt }]);
    expect(buildRealtimeStartContext(entries()).initialItems).toEqual([]);
  });

  it("caps realtime context at 100 entries", () => {
    const many = entries(...Array.from({ length: 150 }, (_, i) => `Term${i}`));
    expect(buildRealtimeStartContext(many).prompt).not.toContain("Term100");
  });
});

describe("ChatGptVoiceService realtime start", () => {
  const fakeCodex = `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.FAKE_CODEX_PID_FILE, String(process.pid));
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method } = JSON.parse(line);
  if (method === "initialize") send({ id, result: {} });
  if (method === "thread/start") send({ id, result: { thread: { id: "thread-1" } } });
  if (method === "thread/realtime/start") {
    send({ method: "thread/realtime/error", params: { threadId: "thread-1", message: "quota exceeded" } });
  }
});
setInterval(() => {}, 1000);
`;

  it.live("fails fast with the original error and kills the child on thread/realtime/error", () =>
    Effect.gen(function* () {
      const directory = mkdtempSync(path.join(os.tmpdir(), "fake-codex-"));
      const pidFile = path.join(directory, "pid");
      const executable = path.join(directory, "codex");
      writeFileSync(executable, fakeCodex);
      chmodSync(executable, 0o755);
      const previous = { PATH: process.env.PATH, pidFile: process.env.FAKE_CODEX_PID_FILE };
      process.env.PATH = `${directory}${path.delimiter}${process.env.PATH ?? ""}`;
      process.env.FAKE_CODEX_PID_FILE = pidFile;
      try {
        const voice = yield* ChatGptVoice.ChatGptVoiceService;
        const startedAt = yield* Clock.currentTimeMillis;
        const error = yield* voice
          .startRealtime({ sdp: "offer", dictionary: { prompt: "", entries: [] } })
          .pipe(Effect.flip);
        expect(error.message).toContain("quota exceeded");
        expect((yield* Clock.currentTimeMillis) - startedAt).toBeLessThan(5_000);

        const pid = Number(readFileSync(pidFile, "utf8"));
        yield* Effect.promise(async () => {
          for (let attempt = 0; attempt < 50; attempt += 1) {
            try {
              process.kill(pid, 0);
            } catch {
              return;
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        });
        expect(() => process.kill(pid, 0)).toThrow();
      } finally {
        process.env.PATH = previous.PATH;
        if (previous.pidFile === undefined) delete process.env.FAKE_CODEX_PID_FILE;
        else process.env.FAKE_CODEX_PID_FILE = previous.pidFile;
        if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
      }
    }).pipe(
      Effect.provide(ChatGptVoice.layer.pipe(Layer.provide(layerTest()))),
    ),
  );

  it("re-exports the subscription dictionaries", () => {
    expect(Object.keys(VOICE_SUBSCRIPTION_DICTIONARIES)).toEqual(["chatgpt", "grok"]);
    const grok = withDefaultVoiceDictionary(null, "grok");
    expect(normalizeTranscript("ích ai", grok)).toBe("xAI");
  });
});

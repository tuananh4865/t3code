import { describe, expect, it } from "vite-plus/test";
import {
  CHATGPT_TRANSCRIBE_MODEL,
  ChatGptVoiceError,
  MAX_AUDIO_BYTES,
  MIN_AUDIO_BYTES,
  audioFileName,
  buildChatGptTranscribeHeaders,
  normalizeVoiceTranscript,
  readTranscript,
  userTranscriptOf,
  validateAudioBytes,
} from "./ChatGptVoiceService.ts";

describe("ChatGptVoiceService", () => {
  describe("buildChatGptTranscribeHeaders", () => {
    it("builds required Codex CLI headers without accountId when omitted or empty", () => {
      expect(buildChatGptTranscribeHeaders({ accessToken: "tok_123" })).toEqual({
        Authorization: "Bearer tok_123",
        originator: "codex_cli_rs",
        version: "0.1.0",
      });
      expect(buildChatGptTranscribeHeaders({ accessToken: "tok_123", accountId: null })).toEqual({
        Authorization: "Bearer tok_123",
        originator: "codex_cli_rs",
        version: "0.1.0",
      });
      expect(buildChatGptTranscribeHeaders({ accessToken: "tok_123", accountId: "" })).toEqual({
        Authorization: "Bearer tok_123",
        originator: "codex_cli_rs",
        version: "0.1.0",
      });
    });

    it("includes chatgpt-account-id when accountId is non-empty", () => {
      expect(
        buildChatGptTranscribeHeaders({
          accessToken: "tok_abc",
          accountId: "acct_999",
        }),
      ).toEqual({
        Authorization: "Bearer tok_abc",
        originator: "codex_cli_rs",
        version: "0.1.0",
        "chatgpt-account-id": "acct_999",
      });
    });
  });

  describe("validateAudioBytes", () => {
    it("throws status 400 when audio is shorter than MIN_AUDIO_BYTES (1024B)", () => {
      expect(() => validateAudioBytes(0)).toThrowError(ChatGptVoiceError);
      try {
        validateAudioBytes(MIN_AUDIO_BYTES - 1);
        expect.unreachable("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ChatGptVoiceError);
        expect((err as ChatGptVoiceError).status).toBe(400);
        expect((err as ChatGptVoiceError).message).toBe(
          "Audio recording is too short to transcribe.",
        );
      }
    });

    it("accepts valid byte lengths between 1024B and 10MB", () => {
      expect(() => validateAudioBytes(MIN_AUDIO_BYTES)).not.toThrow();
      expect(() => validateAudioBytes(64 * 1024)).not.toThrow();
      expect(() => validateAudioBytes(MAX_AUDIO_BYTES)).not.toThrow();
    });

    it("throws status 400 when audio exceeds MAX_AUDIO_BYTES (10MB)", () => {
      try {
        validateAudioBytes(MAX_AUDIO_BYTES + 1);
        expect.unreachable("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ChatGptVoiceError);
        expect((err as ChatGptVoiceError).status).toBe(400);
        expect((err as ChatGptVoiceError).message).toBe("Audio recording exceeds the 10 MB limit.");
      }
    });
  });

  describe("audioFileName", () => {
    it("maps MIME types to appropriate extensions", () => {
      expect(audioFileName("audio/mp4")).toBe("voice.mp4");
      expect(audioFileName("audio/ogg; codecs=opus")).toBe("voice.ogg");
      expect(audioFileName("audio/wav")).toBe("voice.wav");
      expect(audioFileName("audio/webm;codecs=opus")).toBe("voice.webm");
      expect(audioFileName("application/octet-stream")).toBe("voice.webm");
    });
  });

  describe("normalizeVoiceTranscript", () => {
    it("trims and collapses whitespace while normalizing Vietnamese-English technical terms", () => {
      expect(
        normalizeVoiceTranscript("  Tại sao anh dùng S tờ tờ trên thứ ba cấp vẫn không ra đúng?  "),
      ).toBe("Tại sao anh dùng STT trên T3 Code vẫn không ra đúng?");
      expect(normalizeVoiceTranscript("Dùng chát g p t và cô đex với ét tê tê")).toBe(
        "Dùng ChatGPT và Codex với STT",
      );
      expect(
        normalizeVoiceTranscript(
          "Bật tê tê ét trên tê 3 cốt rồi đóng gói ớp áp săt cho sắp ây gần",
        ),
      ).toBe("Bật TTS trên T3 Code rồi đóng gói app.asar cho subagent");
      expect(
        normalizeVoiceTranscript(
          "Kiểm tra t3code, tê ba cốt, t3 cốt, t 3 code, tê ba code, es tê tê, s t t, tờ tờ s, t t s",
        ),
      ).toBe("Kiểm tra T3 Code, T3 Code, T3 Code, T3 Code, T3 Code, STT, STT, TTS, TTS");
      expect(
        normalizeVoiceTranscript(
          "chat g p t, chát gpt, cô đếc, co dex, app a sa, app chấm a sa, sub ây gần, sấp ây gần",
        ),
      ).toBe("ChatGPT, ChatGPT, Codex, Codex, app.asar, app.asar, subagent, subagent");
    });

    it("normalizes PR phonetics only after action verbs while preserving Unicode word boundaries", () => {
      expect(
        normalizeVoiceTranscript(
          "Anh bảo tạo pờ rờ rồi mở pê rờ, review pờ rờ, link pê rờ, merge pờ rờ",
        ),
      ).toBe("Anh bảo tạo PR rồi mở PR, review PR, link PR, merge PR");
      expect(normalizeVoiceTranscript("Nói chuyện pờ rờ không liên quan")).toBe(
        "Nói chuyện pờ rờ không liên quan",
      );
      expect(normalizeVoiceTranscript("   ")).toBe("");
    });
  });

  describe("readTranscript", () => {
    it("extracts text on 200 OK", () => {
      expect(
        readTranscript({
          status: 200,
          body: JSON.stringify({ text: "Xin chào T3 Code" }),
        }),
      ).toBe("Xin chào T3 Code");
      expect(
        readTranscript({
          status: 200,
          body: JSON.stringify({ text: "  Mở thứ ba cấp kiểm tra ét tê tê  " }),
        }),
      ).toBe("Mở T3 Code kiểm tra STT");
      expect(
        readTranscript({
          status: 200,
          body: JSON.stringify({}),
        }),
      ).toBe("");
    });

    it("maps 401 and 403 replies to status 401 ChatGptVoiceError", () => {
      for (const status of [401, 403]) {
        try {
          readTranscript({ status, body: "Unauthorized" });
          expect.unreachable("Should have thrown");
        } catch (err) {
          expect(err).toBeInstanceOf(ChatGptVoiceError);
          expect((err as ChatGptVoiceError).status).toBe(401);
        }
      }
    });

    it("maps 500 replies to status 502 ChatGptVoiceError", () => {
      try {
        readTranscript({ status: 500, body: "Internal Server Error" });
        expect.unreachable("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ChatGptVoiceError);
        expect((err as ChatGptVoiceError).status).toBe(502);
      }
    });
  });

  describe("userTranscriptOf", () => {
    it("extracts user transcript from thread/realtime/transcript/done", () => {
      expect(
        userTranscriptOf("thread/realtime/transcript/done", {
          role: "user",
          text: "Run all tests",
        }),
      ).toBe("Run all tests");
      expect(
        userTranscriptOf("thread/realtime/transcript/done", {
          role: "user",
          text: "  Dùng chát g p t tạo pờ rờ cho tê ba cốt ",
        }),
      ).toBe("Dùng ChatGPT tạo PR cho T3 Code");
      expect(
        userTranscriptOf("thread/realtime/transcript/done", {
          role: "assistant",
          text: "Ignored",
        }),
      ).toBeNull();
    });

    it("extracts user transcript from thread/realtime/item/completed", () => {
      expect(
        userTranscriptOf("thread/realtime/item/completed", {
          item: {
            type: "transcriptSegment",
            role: "user",
            text: "Deploy now",
          },
        }),
      ).toBe("Deploy now");
      expect(
        userTranscriptOf("thread/realtime/item/completed", {
          item: {
            type: "transcriptSegment",
            role: "assistant",
            text: "Ignored",
          },
        }),
      ).toBeNull();
      expect(userTranscriptOf("other/method", {})).toBeNull();
    });

    it("exposes CHATGPT_TRANSCRIBE_MODEL constant", () => {
      expect(CHATGPT_TRANSCRIBE_MODEL).toBe("chatgpt/transcribe");
    });
  });
});

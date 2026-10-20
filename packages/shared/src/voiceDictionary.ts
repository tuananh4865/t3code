import type {
  VoiceDictionary,
  VoiceDictionaryEntry,
  VoiceSubscriptionProvider,
} from "@t3tools/contracts";

export const VOICE_DICTIONARY_MAX_ENTRIES = 100;

export const VOICE_SUBSCRIPTION_PROVIDERS = ["chatgpt", "grok"] as const;

const MIN_FUZZY_LENGTH = 4;

const DEFAULT_ALIASES: Readonly<Record<string, readonly string[]>> = {
  empryo: ["em prio", "embryo", "em pry o"],
  "t3 code": ["ti ba cốt", "t3 cốt", "t three code"],
  typescript: ["type script", "tai pờ scờ ríp"],
  pnpm: ["pi en pi em"],
  gemini: ["giê mi nai"],
  react: ["rì ách", "ri ac"],
  "effect-codex-app-server": ["ơ phếch cô đếch áp sơ vơ", "effect codex app server"],
  "hermes governance": ["hơ mẹt"],
  antigravity: ["an ti gra vi ti", "anti gravity"],
  supergrok: ["super grok", "gói super grok", "su pơ grốc"],
  grok: ["grốc", "grok ai"],
  "chatgpt plus": ["chat gpt plus", "chát gi pi ti plus"],
  "chatgpt pro": ["chat gpt pro", "chát gi pi ti pro"],
};

export const DEFAULT_VOICE_DICTIONARY_ENTRIES: readonly VoiceDictionaryEntry[] = [
  { term: "Empryo", aliases: [...DEFAULT_ALIASES["empryo"]!] },
  { term: "T3 Code", aliases: [...DEFAULT_ALIASES["t3 code"]!] },
  { term: "TypeScript", aliases: [...DEFAULT_ALIASES["typescript"]!] },
  { term: "pnpm", aliases: [...DEFAULT_ALIASES["pnpm"]!] },
  { term: "Gemini", aliases: [...DEFAULT_ALIASES["gemini"]!] },
  { term: "React", aliases: [...DEFAULT_ALIASES["react"]!] },
  {
    term: "effect-codex-app-server",
    aliases: [...DEFAULT_ALIASES["effect-codex-app-server"]!],
  },
  { term: "Hermes Governance", aliases: [...DEFAULT_ALIASES["hermes governance"]!] },
  { term: "Antigravity", aliases: [...DEFAULT_ALIASES["antigravity"]!] },
  { term: "SuperGrok", aliases: [...DEFAULT_ALIASES["supergrok"]!] },
  { term: "Grok", aliases: [...DEFAULT_ALIASES["grok"]!] },
  { term: "ChatGPT Plus", aliases: [...DEFAULT_ALIASES["chatgpt plus"]!] },
  { term: "ChatGPT Pro", aliases: [...DEFAULT_ALIASES["chatgpt pro"]!] },
];

export const CHATGPT_SUBSCRIPTION_DICTIONARY_ENTRIES: readonly VoiceDictionaryEntry[] = [
  { term: "ChatGPT Plus", aliases: [...DEFAULT_ALIASES["chatgpt plus"]!] },
  { term: "ChatGPT Pro", aliases: [...DEFAULT_ALIASES["chatgpt pro"]!] },
  { term: "ChatGPT Team", aliases: ["chat gpt team", "chát gi pi ti tim"] },
  { term: "OpenAI Codex", aliases: ["open ai codex", "âu pần ai cô đếch"] },
  ...DEFAULT_VOICE_DICTIONARY_ENTRIES,
];

export const GROK_SUBSCRIPTION_DICTIONARY_ENTRIES: readonly VoiceDictionaryEntry[] = [
  { term: "SuperGrok", aliases: ["super grok", "gói super grok", "su pơ grốc"] },
  { term: "Grok Heavy", aliases: ["grok heavy", "grốc he vi"] },
  { term: "X Premium+", aliases: ["x premium plus", "ích pri mi um plus"] },
  { term: "Grok Build", aliases: ["grok build", "grốc biu"] },
  { term: "xAI", aliases: ["x ai", "ích ai"] },
  { term: "Grok", aliases: ["grốc", "grok ai"] },
  ...DEFAULT_VOICE_DICTIONARY_ENTRIES,
];

export const VOICE_SUBSCRIPTION_DICTIONARIES: Readonly<
  Record<VoiceSubscriptionProvider, VoiceDictionary>
> = {
  chatgpt: {
    prompt:
      "The speaker is a ChatGPT subscriber (Plus, Pro, Team) using OpenAI Codex. Keep product and plan names exactly as spelled in the vocabulary.",
    entries: [...CHATGPT_SUBSCRIPTION_DICTIONARY_ENTRIES],
  },
  grok: {
    prompt:
      "The speaker is a Grok subscriber (SuperGrok, Grok Heavy, X Premium+) using Grok Build from xAI. Keep product and plan names exactly as spelled in the vocabulary.",
    entries: [...GROK_SUBSCRIPTION_DICTIONARY_ENTRIES],
  },
};

export function getSubscriptionVoiceDictionary(provider: VoiceSubscriptionProvider): VoiceDictionary {
  return VOICE_SUBSCRIPTION_DICTIONARIES[provider];
}

export const DEFAULT_VOICE_DICTIONARY: VoiceDictionary = {
  prompt: "",
  entries: [...DEFAULT_VOICE_DICTIONARY_ENTRIES],
};

export function withDefaultVoiceDictionary(
  dictionary?: VoiceDictionary | null,
  provider?: VoiceSubscriptionProvider,
): VoiceDictionary {
  const preset = provider ? VOICE_SUBSCRIPTION_DICTIONARIES[provider] : null;
  if (!dictionary && !preset) return DEFAULT_VOICE_DICTIONARY;
  const seen = new Set<string>();
  const entries: VoiceDictionaryEntry[] = [];
  for (const entry of [
    ...(dictionary?.entries ?? []),
    ...(preset?.entries ?? []),
    ...DEFAULT_VOICE_DICTIONARY_ENTRIES,
  ]) {
    const key = foldVoiceText(entry.term).trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
    if (entries.length >= VOICE_DICTIONARY_MAX_ENTRIES) break;
  }
  return {
    prompt: dictionary?.prompt || preset?.prompt || "",
    entries,
  };
}

/** One entry per line: `Term` or `Term: alias1, alias2`. */
export function parseVoiceDictionaryText(text: string): VoiceDictionaryEntry[] {
  const entries: VoiceDictionaryEntry[] = [];
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    const separator = line.indexOf(":");
    const term = (separator === -1 ? line : line.slice(0, separator)).trim();
    if (!term || seen.has(term.toLowerCase())) continue;
    seen.add(term.toLowerCase());
    const aliases =
      separator === -1
        ? []
        : line
            .slice(separator + 1)
            .split(",")
            .map((alias) => alias.trim())
            .filter(Boolean);
    entries.push({ term, aliases });
    if (entries.length === VOICE_DICTIONARY_MAX_ENTRIES) break;
  }
  return entries;
}

export function formatVoiceDictionaryText(entries: readonly VoiceDictionaryEntry[]): string {
  return entries
    .map(({ term, aliases }) => (aliases.length > 0 ? `${term}: ${aliases.join(", ")}` : term))
    .join("\n");
}

export function foldVoiceText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase();
}

const PHONETIC_TOKEN = /ngh|gh|ph|th|tr|ch|gi|ck|./gsu;
const PHONETIC_MAP: Readonly<Record<string, string>> = {
  ngh: "ng",
  gh: "g",
  ph: "f",
  th: "t",
  tr: "k",
  ch: "k",
  gi: "z",
  ck: "k",
  d: "z",
  r: "z",
  z: "z",
  c: "k",
  k: "k",
  q: "k",
  x: "s",
  s: "s",
  y: "i",
  w: "u",
};

export function phoneticKey(folded: string): string {
  return folded
    .replace(PHONETIC_TOKEN, (token) => PHONETIC_MAP[token] ?? token)
    .replace(/(.)\1+/gsu, "$1");
}

function damerauLevenshtein(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, (_, i) => {
    const row = new Array<number>(cols).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j < cols; j++) d[0]![j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, d[i - 2]![j - 2]! + 1);
      }
      d[i]![j] = value;
    }
  }
  return d[a.length]![b.length]!;
}

function fuzzyThreshold(length: number): number {
  return length >= 8 ? 2 : length >= 5 ? 1 : 0;
}

const WORD = /[\p{L}\p{N}]+/gu;
// Inline code, URLs, and anything path-like (a whitespace-delimited chunk containing "/").
const PROTECTED = /`[^`]*`|(?:https?:\/\/|www\.)\S+|\S*\/\S*/gu;
const HAS_DIACRITIC = /[\p{M}đ]/iu;

interface Variant {
  readonly term: string;
  readonly raw: string;
  readonly tokens: number;
  readonly key: string;
  readonly compact: string;
  readonly phonetic: string;
}

function makeVariant(term: string, raw: string): Variant | null {
  const words = foldVoiceText(raw).match(WORD);
  if (!words) return null;
  const compact = words.join("");
  return {
    term,
    raw,
    tokens: words.length,
    key: words.join(" "),
    compact,
    phonetic: phoneticKey(compact),
  };
}

function buildVariants(dictionary: VoiceDictionary): Variant[] {
  const variants: Variant[] = [];
  for (const entry of dictionary.entries.slice(0, VOICE_DICTIONARY_MAX_ENTRIES)) {
    const raws = [
      entry.term,
      ...entry.aliases,
      ...(DEFAULT_ALIASES[foldVoiceText(entry.term).trim()] ?? []),
    ];
    for (const raw of raws) {
      const variant = makeVariant(entry.term, raw);
      if (variant) variants.push(variant);
    }
  }
  return variants;
}

interface Token {
  readonly start: number;
  readonly end: number;
  readonly raw: string;
  readonly folded: string;
  readonly protected: boolean;
  taken: boolean;
}

function tokenize(text: string): Token[] {
  const ranges = Array.from(text.matchAll(PROTECTED), (m) => [m.index, m.index + m[0].length]);
  return Array.from(text.matchAll(WORD), (m) => {
    const start = m.index;
    const end = start + m[0].length;
    return {
      start,
      end,
      raw: m[0],
      folded: foldVoiceText(m[0]),
      protected: ranges.some(([from, to]) => start < to! && end > from!),
      taken: false,
    };
  });
}

function windowAt(text: string, tokens: Token[], from: number, count: number): Token[] | null {
  const window = tokens.slice(from, from + count);
  if (window.length < count) return null;
  for (let i = 0; i < window.length; i++) {
    const token = window[i]!;
    if (token.protected || token.taken) return null;
    if (i > 0 && !/^[\s-]+$/u.test(text.slice(window[i - 1]!.end, token.start))) return null;
  }
  return window;
}

function isUnsafeAccentMatch(window: Token[], variant: Variant): boolean {
  // "gõ" must not become "Go": a diacritic word only matches variants that carry one too.
  return (
    window.length === 1 &&
    HAS_DIACRITIC.test(window[0]!.raw.normalize("NFD")) &&
    !HAS_DIACRITIC.test(variant.raw.normalize("NFD"))
  );
}

export function normalizeTranscript(
  text: string,
  dictionary: VoiceDictionary = DEFAULT_VOICE_DICTIONARY,
): string {
  const variants = buildVariants(dictionary);
  if (variants.length === 0) return text;

  const byKey = new Map<string, Variant>();
  const byCompact = new Map<string, Variant>();
  for (const variant of variants) {
    if (!byKey.has(variant.key)) byKey.set(variant.key, variant);
    if (!byCompact.has(variant.compact)) byCompact.set(variant.compact, variant);
  }
  const maxTokens = Math.max(...variants.map((v) => v.tokens));
  const tokens = tokenize(text);
  const replacements: Array<{ start: number; end: number; text: string }> = [];

  const apply = (from: number, window: Token[], variant: Variant) => {
    for (const token of window) token.taken = true;
    replacements.push({ start: window[0]!.start, end: window.at(-1)!.end, text: variant.term });
    return from + window.length;
  };

  // Pass 1: longest exact n-gram, ignoring accents and spacing.
  for (let i = 0; i < tokens.length;) {
    let next = i + 1;
    for (let n = Math.min(maxTokens, tokens.length - i); n >= 1; n--) {
      const window = windowAt(text, tokens, i, n);
      if (!window) continue;
      const key = window.map((t) => t.folded).join(" ");
      const variant = byKey.get(key) ?? byCompact.get(key.replaceAll(" ", ""));
      if (variant && !isUnsafeAccentMatch(window, variant)) {
        next = apply(i, window, variant);
        break;
      }
    }
    i = next;
  }

  // Pass 2: phonetic / edit-distance match for long variants only, so "cat" never becomes "Codex".
  const fuzzy = variants.filter((v) => v.compact.length >= MIN_FUZZY_LENGTH);
  if (fuzzy.length > 0) {
    for (let i = 0; i < tokens.length;) {
      let next = i + 1;
      search: for (let n = Math.min(maxTokens, tokens.length - i); n >= 1; n--) {
        const window = windowAt(text, tokens, i, n);
        if (!window) continue;
        const compact = window.map((t) => t.folded).join("");
        if (compact.length < MIN_FUZZY_LENGTH) continue;
        const phonetic = phoneticKey(compact);
        for (const variant of fuzzy) {
          if (Math.abs(variant.compact.length - compact.length) > 2) continue;
          if (isUnsafeAccentMatch(window, variant)) continue;
          if (
            variant.phonetic === phonetic ||
            damerauLevenshtein(compact, variant.compact) <= fuzzyThreshold(variant.compact.length)
          ) {
            next = apply(i, window, variant);
            break search;
          }
        }
      }
      i = next;
    }
  }

  let output = text;
  for (const { start, end, text: replacement } of replacements.sort((a, b) => b.start - a.start)) {
    output = output.slice(0, start) + replacement + output.slice(end);
  }
  return output;
}

/** Suggests canonical dictionary terms for a misspelled word in spellcheck / editor menus. */
export function suggestVoiceDictionaryTerms(
  misspelledWord: string,
  dictionary?: VoiceDictionary | null,
  limit = 5,
): string[] {
  const words = foldVoiceText(misspelledWord).match(WORD);
  if (!words || limit <= 0) return [];
  const key = words.join(" ");
  const compact = words.join("");
  if (compact.length < 3) return [];
  const phonetic = phoneticKey(compact);
  const variants = buildVariants(withDefaultVoiceDictionary(dictionary));
  const bestByTerm = new Map<string, number>();

  for (const variant of variants) {
    if (variant.term === misspelledWord) continue;
    let score: number | null = null;
    if (variant.key === key || variant.compact === compact) {
      score = 0;
    } else if (
      Math.abs(variant.compact.length - compact.length) <= 2 &&
      variant.phonetic === phonetic
    ) {
      score = 1;
    } else if (Math.abs(variant.compact.length - compact.length) <= 2) {
      const distance = damerauLevenshtein(compact, variant.compact);
      if (distance <= Math.max(1, fuzzyThreshold(variant.compact.length))) {
        score = 2 + distance;
      }
    }
    if (score !== null) {
      const existing = bestByTerm.get(variant.term);
      if (existing === undefined || score < existing) {
        bestByTerm.set(variant.term, score);
      }
    }
  }

  return [...bestByTerm.entries()]
    .sort((a, b) => a[1] - b[1])
    .slice(0, limit)
    .map(([term]) => term);
}

export function buildRealtimeStartContext(dictionary: VoiceDictionary): {
  prompt: string;
  initialItems: Array<{ role: "developer"; text: string }>;
} {
  const lines = dictionary.entries
    .slice(0, VOICE_DICTIONARY_MAX_ENTRIES)
    .map(({ term, aliases }) => {
      const heard = [...aliases, ...(DEFAULT_ALIASES[foldVoiceText(term).trim()] ?? [])];
      return heard.length > 0 ? `- ${term} (may be heard as: ${heard.join(", ")})` : `- ${term}`;
    });
  const parts: string[] = [];
  if (lines.length > 0) {
    parts.push(
      `Custom vocabulary. When the user says one of these terms, or a mis-hearing of it, always write it exactly as spelled here:\n${lines.join("\n")}`,
    );
  }
  if (dictionary.prompt.length > 0) parts.push(dictionary.prompt);
  const prompt = parts.join("\n\n");
  return {
    prompt,
    initialItems: prompt.length > 0 ? [{ role: "developer", text: prompt }] : [],
  };
}

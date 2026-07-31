// Language tags → the English name of the language, for prompts.
//
// The models are told which language to write in by NAME, not by tag: "write in
// Chinese" is unambiguous to every provider, "write in zh-CN" is a tag they may
// or may not read as an instruction. The tags come from the SPA's speech-to-text
// picker (`kelabo-stt-lang`: en, zh, es, fr, de, ja, ko, multi) and, for hosts
// who set it elsewhere, occasionally a full BCP-47 tag.

const NAMES = {
  en: "English",
  zh: "Chinese",
  es: "Spanish",
  fr: "French",
  de: "German",
  ja: "Japanese",
  ko: "Korean",
  pt: "Portuguese",
  it: "Italian",
  ru: "Russian",
  nl: "Dutch",
  hi: "Hindi",
  ar: "Arabic",
  id: "Indonesian",
  th: "Thai",
  vi: "Vietnamese",
  tr: "Turkish",
  pl: "Polish",
  sv: "Swedish",
  uk: "Ukrainian",
};

// Scripts a bare language name would under-specify. Written out because "write
// in Chinese" to a Taiwanese host who set zh-TW should still mean Traditional.
const REGIONS = {
  "zh-tw": "Traditional Chinese",
  "zh-hk": "Traditional Chinese",
  "zh-hant": "Traditional Chinese",
  "zh-cn": "Simplified Chinese",
  "zh-hans": "Simplified Chinese",
  "pt-br": "Brazilian Portuguese",
};

/**
 * @param {string} tag - e.g. "en", "zh", "zh-TW", "multi"
 * @returns {string|null} the language name, or null when there is no single
 *   language to enforce ("multi", empty, or a tag we do not know — in which case
 *   the prompt falls back to "the language of the kelabo").
 */
export function languageName(tag) {
  const raw = String(tag ?? "").trim().toLowerCase();
  if (!raw || raw === "multi" || raw === "auto") return null;
  if (REGIONS[raw]) return REGIONS[raw];
  const base = raw.split(/[-_]/)[0];
  return NAMES[base] ?? null;
}

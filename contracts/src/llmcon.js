import { LLM_CON_MARKER } from "./constants.js";

/**
 * Format a caption for the agent: `[transcript] [Speaker] <text>`.
 * @param {string} speaker @param {string} text
 */
export function tagTranscript(speaker, text) {
  return `[transcript] [${speaker}] ${text}`;
}

/**
 * Parse an agent reply for the board gate.
 * A reply is board-bound only if its first non-empty line is exactly `[LLM_CON]`,
 * followed by `to: <name|all>` and `title: <one-liner>` header lines, then the body.
 * @param {string} raw
 * @returns {{isContribution:true, to:string, title:string, markdown:string}|{isContribution:false}}
 */
export function parseLlmCon(raw) {
  if (typeof raw !== "string") return { isContribution: false };
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  if (i >= lines.length || lines[i].trim() !== LLM_CON_MARKER) return { isContribution: false };
  i++;
  let to = "all";
  let title = "";
  let sawTo = false;
  let sawTitle = false;
  while (i < lines.length) {
    const m = lines[i].match(/^(to|title)\s*:\s*(.*)$/i);
    if (!m) break;
    if (m[1].toLowerCase() === "to") { to = m[2].trim() || "all"; sawTo = true; }
    if (m[1].toLowerCase() === "title") { title = m[2].trim(); sawTitle = true; }
    i++;
  }
  if (!sawTo && !sawTitle) return { isContribution: false };
  const markdown = lines.slice(i).join("\n").replace(/^\n+/, "").trimEnd();
  return { isContribution: true, to, title: title || markdown.split("\n")[0].slice(0, 80), markdown };
}

/**
 * Serialize a board-bound agent reply (inverse of parseLlmCon).
 * @param {{to:string, title:string, markdown:string}} c
 */
export function formatLlmCon({ to = "all", title = "", markdown = "" }) {
  return `${LLM_CON_MARKER}\nto: ${to}\ntitle: ${title}\n${markdown}`;
}

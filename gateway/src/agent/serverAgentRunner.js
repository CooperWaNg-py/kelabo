// Minutes JSON parsing shared by the server agent (MainAgent.summarize) and the
// dev-mode paths (archive.js / minutes.js) that parse an opencode-produced summary.
// The main/sub agent orchestration lives in mainAgent.js and subAgent.js.
//
// Two shapes reach this function: the current one, where topics/decisions/
// findings carry their substance as objects, and the original one, where they
// were plain strings. Both normalize to the object form so a record archived
// before the richer minutes still renders — and so an opencode session that
// answers in the old shape is not rejected.

export function parseMinutesJson(text, kelaboId, generatedBy) {
  const fallback = {
    kelaboId,
    topics: [],
    decisions: [],
    actionItems: [],
    openQuestions: [],
    findings: text ? [{ text: text.slice(0, 4000) }] : [],
    generatedAt: Date.now(),
    generatedBy,
  };
  if (!text) return fallback;
  try {
    const json = JSON.parse(text.replace(/```json|```/g, "").trim().match(/\{[\s\S]*\}/)?.[0] ?? "");
    return {
      kelaboId,
      ...(str(json.title) ? { title: str(json.title).slice(0, 80) } : {}),
      ...(str(json.summary) ? { summary: str(json.summary) } : {}),
      topics: topics(json.topics),
      decisions: decisions(json.decisions),
      actionItems: Array.isArray(json.actionItems)
        ? json.actionItems.map((a) =>
            typeof a === "string"
              ? { text: a }
              : {
                  text: str(a?.text),
                  ...(str(a?.owner) ? { owner: str(a.owner) } : {}),
                  ...(str(a?.due) ? { due: str(a.due) } : {}),
                }
          )
        : [],
      openQuestions: arr(json.openQuestions),
      findings: findings(json.findings),
      generatedAt: Date.now(),
      generatedBy,
    };
  } catch {
    return fallback;
  }
}

const str = (v) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v));
const arr = (v) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);

function topics(v) {
  if (!Array.isArray(v)) return [];
  return v
    .map((t) => {
      if (typeof t === "string") return { title: str(t) };
      const speakers = arr(t?.speakers);
      return {
        title: str(t?.title) || str(t?.name) || str(t?.detail).slice(0, 60),
        ...(str(t?.detail) ? { detail: str(t.detail) } : {}),
        ...(speakers.length ? { speakers } : {}),
      };
    })
    .filter((t) => t.title);
}

function decisions(v) {
  if (!Array.isArray(v)) return [];
  return v
    .map((d) =>
      typeof d === "string"
        ? { text: str(d) }
        : { text: str(d?.text) || str(d?.decision), ...(str(d?.rationale) ? { rationale: str(d.rationale) } : {}) }
    )
    .filter((d) => d.text);
}

function findings(v) {
  if (!Array.isArray(v)) return [];
  return v
    .map((f) => {
      if (typeof f === "string") return { text: str(f) };
      const sources = Array.isArray(f?.sources)
        ? f.sources
            .map((s) => (typeof s === "string" ? { title: s } : { title: str(s?.title) || str(s?.url), ...(str(s?.url) ? { url: str(s.url) } : {}) }))
            .filter((s) => s.title)
        : [];
      return { text: str(f?.text) || str(f?.finding), ...(sources.length ? { sources } : {}) };
    })
    .filter((f) => f.text);
}

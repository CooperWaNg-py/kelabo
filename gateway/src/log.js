export function log(event, fields = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}

export function logError(event, err, fields = {}) {
  log(event, { ...fields, error: err?.message ?? String(err), stack: err?.stack });
}

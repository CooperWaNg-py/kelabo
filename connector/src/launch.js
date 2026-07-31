// `kelabo opencode` / `kelabo claude` — start the coding agent correctly.
//
// Both runtimes need a launch flag that is easy to forget, impossible to
// remember and catastrophic to omit, in the same specific way: **without it
// every tool still works.** The agent joins the kelabo, posts to the board and
// reads it back — all of that is the tunnel — and simply never hears a word of
// transcript, which is indistinguishable from an assistant choosing to stay
// quiet. Telling people to type
//
//     opencode --port 4096
//     OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true opencode --port 4096
//     claude --dangerously-load-development-channels server:kelabo
//
// is asking them to get a silent failure right from memory, every time, on a
// flag whose own name tells them not to use it. So the launcher composes it.
//
// The composition is pure (`launchPlan`) and the spawning is a thin wrapper
// around it, because what the flags *are* is the part that can be wrong without
// anything visibly breaking, and the part a test can hold still.
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * A port nothing is listening on.
 *
 * Binding `0` makes the kernel pick one, and we hand that number to opencode
 * rather than keeping the socket — so there is a window between our close and
 * its bind in which something else could take it. That race is unavoidable
 * (opencode reads a number, it cannot inherit a descriptor) and is worth it:
 * the alternative is a fixed port, which collides *deterministically* the moment
 * a developer opens a second session. If the race is ever lost, opencode fails
 * loudly at startup with the port in the message, which is the good kind of
 * failure.
 */
export function freePort({ hostname = "127.0.0.1" } = {}) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, hostname, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Absolute path of a binary on PATH, or null. Absolute because we spawn it
 *  without a shell — which is what keeps a directory or an argument containing
 *  a space from being re-split by one. */
export function whichBin(bin, env = process.env) {
  const dirs = String(env.PATH || "").split(process.platform === "win32" ? ";" : ":");
  const names = process.platform === "win32" ? [`${bin}.cmd`, `${bin}.exe`, bin] : [bin];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const name of names) {
      const full = join(dir, name);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

/**
 * What to run, given a runtime row — pure.
 *
 * `extra` is forwarded verbatim and goes **last**, so a developer can still pass
 * `--model`, a project path, or `-p` to Claude Code, and can override anything
 * we chose. Ours come first precisely so they are the ones that lose an
 * argument fight: this launcher exists to supply a default nobody remembers, not
 * to take the CLI away from them.
 *
 * @param {object} row      a RUNTIMES entry
 * @param {{port?: number, extra?: string[], env?: object}} opts
 * @returns {{args: string[], env: object, display: string}}
 */
export function launchPlan(row, { port, extra = [], env = {} } = {}) {
  // `extra` goes to the row as well as onto the end, because a runtime may have
  // to *stand aside* rather than append: opencode binds a random port if
  // `--port` appears twice, so a developer's own `--port` has to suppress ours
  // rather than merely lose to it.
  const ctx = { port, extra };
  const args = [...(row.launch.args?.(ctx) ?? []), ...extra];
  const added = row.launch.env?.(ctx) ?? {};
  return {
    args,
    env: { ...env, ...added },
    // What gets echoed before the child starts. The env prefix is included
    // because it is part of what makes the session work, and a developer who
    // wants to reproduce this by hand needs to see it.
    //
    // Quoted, because this line is meant to be pasteable and the arguments are
    // not ours: `kelabo claude -p "two words"` spawns one argument and would
    // otherwise print as two, which is a line that does something different
    // from what just ran.
    display: [
      ...Object.entries(added).map(([k, v]) => `${k}=${shellQuote(v)}`),
      row.launch.bin,
      ...args,
    ]
      .map((part, i) => (i < Object.keys(added).length ? part : shellQuote(part)))
      .join(" "),
  };
}

/**
 * Split `kelabo opencode [ours] -- [theirs]` at the first `--`.
 *
 * Everything after it is handed to the runtime **verbatim and uninspected**,
 * including things that look like our own flags. That is the whole point of the
 * separator: `kelabo opencode -- --dry-run` runs opencode's `--dry-run`, not
 * ours, and stays correct if this CLI grows a flag tomorrow that collides with
 * one of theirs.
 *
 * Without a `--`, everything still forwards — `kelabo claude -p hi` works — but
 * a token we recognise is ours. Both forms exist because the short one is what
 * people type and the explicit one is what they need the moment the two
 * vocabularies overlap.
 */
export function splitForward(argv = []) {
  const at = argv.indexOf("--");
  if (at === -1) return { own: [...argv], forward: [], separated: false };
  return { own: argv.slice(0, at), forward: argv.slice(at + 1), separated: true };
}

/** Did the developer pass this flag themselves, in either spelling? */
export function hasFlag(args, name) {
  return args.some((a) => a === `--${name}` || a.startsWith(`--${name}=`));
}

/** Its value, from `--name v` or `--name=v`, or null. */
export function flagValue(args, name) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}`) return args[i + 1] ?? null;
    if (args[i].startsWith(`--${name}=`)) return args[i].slice(name.length + 3);
  }
  return null;
}

/** Enough quoting to be pasteable. Single quotes are literal in every POSIX
 *  shell; the `'\''` dance is the standard way to embed one. */
export function shellQuote(value) {
  const s = String(value);
  if (s === "") return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Start it, hand over the terminal, and exit with whatever it exits with.
 *
 * `stdio: "inherit"` because both runtimes are full-screen TUIs — anything else
 * and the developer gets a dead terminal. SIGINT is deliberately ignored in this
 * process while the child runs: Ctrl-C reaches the child through the shared
 * process group, and a parent that exits first would leave the TUI writing to a
 * terminal nobody owns.
 */
export function runChild(bin, args, env, { spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(bin, args, { stdio: "inherit", env });
    const ignore = () => {};
    process.on("SIGINT", ignore);
    process.on("SIGTERM", ignore);
    const done = (code) => {
      process.off("SIGINT", ignore);
      process.off("SIGTERM", ignore);
      resolve(code);
    };
    child.on("error", (err) => {
      process.off("SIGINT", ignore);
      process.off("SIGTERM", ignore);
      reject(err);
    });
    // A child killed by a signal has a null exit code; 128+n is the shell
    // convention and keeps `kelabo opencode && …` behaving like `opencode && …`.
    child.on("exit", (code, signal) => done(code ?? (signal ? 128 + (SIGNALS[signal] ?? 0) : 0)));
  });
}

const SIGNALS = { SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };

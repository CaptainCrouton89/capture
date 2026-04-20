/**
 * Capture — unified CLI for session management and CDP browser automation.
 *
 * Session commands (namespaced):
 *   capture session start [--url <url>]
 *   capture session stop <session-id>
 *   capture session list
 *   capture session view <session-id> [--filter screenshots|har|a11y]
 *   capture log <path> [--name label]
 *
 * CDP commands (top-level):
 *   capture detect              Detect CDP port
 *   capture exec <code>         Execute JS in a tab
 *   capture list                List browser tabs
 *   capture open <url>          Open URL in browser
 *   capture screenshot          Capture screenshot
 *   capture a11y                Get accessibility tree
 *   capture record              Passive HAR recording
 *   capture navigate <url>      Navigate + record HAR
 *   capture har create|read|delete  Manage HAR recordings
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawn } from "child_process";
import {
  createHarRecording,
  readHarRecording,
  deleteHarRecording,
} from "./har-manager.js";
import { cdpMain } from "./cdp.js";
import {
  getActiveSession,
  setActiveSession,
  clearActiveSession,
} from "./session-context.js";

const CAPTURE_ROOT = path.join(os.tmpdir(), "capture-sessions");

interface LogPid {
  pid: number;
  name: string;
  sourcePath: string;
}

interface Session {
  id: string;
  dir: string;
  harId: string | null;
  startedAt: string;
  url: string | null;
  targetId: string | null;
  stepCount: number;
  logPids: LogPid[];
}

interface BundleManifest {
  id: string;
  startedAt: string;
  stoppedAt: string;
  duration: number;
  url: string | null;
  screenshots: Array<{ name: string; path: string }>;
  har: { id: string; path: string; entryCount: number } | null;
  a11y: Array<{ name: string; path: string }>;
  logs: Array<{ name: string; path: string; lines: number }>;
  other: Array<{ name: string; path: string }>;
}

function sessionDir(id: string): string {
  return path.join(CAPTURE_ROOT, id);
}

function sessionMetaPath(id: string): string {
  return path.join(sessionDir(id), ".session.json");
}

function readSession(id: string): Session {
  const metaPath = sessionMetaPath(id);
  if (!fs.existsSync(metaPath)) {
    throw new Error(`No capture session found: ${id}`);
  }
  return JSON.parse(fs.readFileSync(metaPath, "utf-8")) as Session;
}

function generateId(): string {
  return `cap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

// ============================================================================
// Session Commands
// ============================================================================

async function start(args: string[]): Promise<void> {
  let url: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--url" && args[i + 1]) {
      url = args[++i];
    }
  }

  const id = generateId();
  const dir = sessionDir(id);
  fs.mkdirSync(path.join(dir, "shots"), { recursive: true });
  fs.mkdirSync(path.join(dir, "a11y"), { recursive: true });

  // Start HAR recording directly
  let harId: string | null = null;
  try {
    const harResult = createHarRecording();
    harId = harResult.id;
  } catch (err) {
    console.error(`Warning: could not start HAR recording: ${err instanceof Error ? err.message : err}`);
  }

  // Open tab if URL provided
  let targetId: string | null = null;
  if (url) {
    try {
      const { detectCdpPort, navigateAndWait } = await import('./cdp.js');
      const port = await detectCdpPort();
      const tab = await navigateAndWait(port, url);
      targetId = tab.id;
    } catch (err) {
      console.error(`Warning: could not open tab: ${err instanceof Error ? err.message : err}`);
    }
  }

  const session: Session = {
    id,
    dir,
    harId,
    startedAt: new Date().toISOString(),
    url,
    targetId,
    stepCount: 0,
    logPids: [],
  };
  fs.writeFileSync(sessionMetaPath(id), JSON.stringify(session, null, 2));

  // Set as active session for auto-defaults
  setActiveSession({
    sessionId: id,
    dir,
    harId,
    targetId,
    stepCount: 0,
  });

  // Output for agent consumption
  const result = {
    sessionId: id,
    bundleDir: dir,
    harId,
    targetId,
    shotsDir: path.join(dir, "shots"),
    a11yDir: path.join(dir, "a11y"),
  };
  console.log(JSON.stringify(result, null, 2));

  // Agent-friendly next steps on stderr
  console.error(`\nCapture session started: ${id}`);
  if (targetId) {
    console.error(`Tab opened — session context active. No need to pass --target or --har.`);
  }
  console.error(`\nWhen done: capture session stop ${id}`);
}

function logCommand(args: string[]): void {
  const sourcePath = args[0];
  if (!sourcePath) {
    console.error("Usage: capture log <path> [--name label] [--session <id>]");
    process.exit(1);
  }

  const resolved = path.resolve(sourcePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Log file not found: ${resolved}`);
  }

  let name: string | null = null;
  let sessionId: string | null = null;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--name" && args[i + 1]) name = args[++i];
    if (args[i] === "--session" && args[i + 1]) sessionId = args[++i];
  }

  if (!sessionId) {
    const active = getActiveSession();
    if (!active) {
      throw new Error("No active capture session. Start one or pass --session <id>.");
    }
    sessionId = active.sessionId;
  }

  const session = readSession(sessionId);
  name = name ?? path.basename(resolved, path.extname(resolved));

  const logsDir = path.join(session.dir, "logs");
  fs.mkdirSync(logsDir, { recursive: true });

  const destPath = path.join(logsDir, `${name}.log`);
  const outFd = fs.openSync(destPath, "a");

  const child = spawn(
    "sh",
    ["-c", `tail -f "${resolved}" | perl -MPOSIX -ne 'print strftime("%Y-%m-%dT%H:%M:%SZ",gmtime())." ".$_'`],
    { detached: true, stdio: ["ignore", outFd, "ignore"] },
  );
  child.unref();
  fs.closeSync(outFd);

  const pid = child.pid!;
  session.logPids.push({ pid, name, sourcePath: resolved });
  fs.writeFileSync(sessionMetaPath(session.id), JSON.stringify(session, null, 2));

  console.log(JSON.stringify({ name, sourcePath: resolved, destPath, pid }, null, 2));
}

async function stop(args: string[]): Promise<void> {
  const id = args[0];
  if (!id) {
    console.error("Usage: capture session stop <session-id>");
    process.exit(1);
  }

  const session = readSession(id);
  const stoppedAt = new Date().toISOString();
  const startMs = new Date(session.startedAt).getTime();
  const duration = Date.now() - startMs;

  // Kill log tailers
  for (const lp of session.logPids ?? []) {
    try { process.kill(-lp.pid, "SIGTERM"); } catch { /* already dead */ }
  }
  if (session.logPids?.length) {
    await new Promise((r) => setTimeout(r, 200));
  }

  // Collect screenshots
  const shotsDir = path.join(session.dir, "shots");
  const screenshots = fs.existsSync(shotsDir)
    ? fs.readdirSync(shotsDir)
        .filter((f) => f.endsWith(".png") || f.endsWith(".jpg"))
        .map((f) => ({ name: f, path: path.join(shotsDir, f) }))
    : [];

  // Collect a11y snapshots
  const a11yDir = path.join(session.dir, "a11y");
  const a11y = fs.existsSync(a11yDir)
    ? fs.readdirSync(a11yDir)
        .filter((f) => f.endsWith(".json") || f.endsWith(".txt"))
        .map((f) => ({ name: f, path: path.join(a11yDir, f) }))
    : [];

  // Collect HAR directly from har-manager
  let har: BundleManifest["har"] = null;
  if (session.harId) {
    try {
      const harData = readHarRecording(session.harId);
      if (harData) {
        const harPath = path.join(session.dir, "har.json");
        fs.writeFileSync(harPath, JSON.stringify(harData, null, 2));
        har = { id: session.harId, path: harPath, entryCount: harData.log.entries.length };
        // Clean up the HAR recording
        try { deleteHarRecording(session.harId); } catch { /* best effort */ }
      }
    } catch (err) {
      console.error(`Warning: could not read HAR: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Collect log files
  const logsDir = path.join(session.dir, "logs");
  const logs = fs.existsSync(logsDir)
    ? fs.readdirSync(logsDir)
        .filter((f) => f.endsWith(".log"))
        .map((f) => {
          const filePath = path.join(logsDir, f);
          const content = fs.readFileSync(filePath, "utf-8");
          const lines = content ? content.split("\n").filter(Boolean).length : 0;
          return { name: f, path: filePath, lines };
        })
    : [];

  // Collect anything else dropped in the session dir
  const knownDirs = new Set(["shots", "a11y", "logs"]);
  const knownFiles = new Set([".session.json", "har.json", "bundle.json"]);
  const other = fs.readdirSync(session.dir)
    .filter((f) => !knownDirs.has(f) && !knownFiles.has(f))
    .map((f) => ({ name: f, path: path.join(session.dir, f) }));

  // Clear active session context
  clearActiveSession();

  const manifest: BundleManifest = {
    id: session.id,
    startedAt: session.startedAt,
    stoppedAt,
    duration,
    url: session.url,
    screenshots,
    har,
    a11y,
    logs,
    other,
  };

  const bundlePath = path.join(session.dir, "bundle.json");
  fs.writeFileSync(bundlePath, JSON.stringify(manifest, null, 2));

  console.log(JSON.stringify({
    bundlePath,
    summary: {
      duration,
      screenshots: screenshots.length,
      harEntries: har?.entryCount ?? 0,
      a11ySnapshots: a11y.length,
      logFiles: logs.length,
      otherFiles: other.length,
    },
  }, null, 2));

  console.error(`\nBundle written: ${bundlePath}`);
  console.error(`Read it: capture session view ${id}`);
}

function list(): void {
  if (!fs.existsSync(CAPTURE_ROOT)) {
    console.log("[]");
    return;
  }

  const sessions = fs.readdirSync(CAPTURE_ROOT)
    .filter((d) => fs.existsSync(sessionMetaPath(d)))
    .map((d) => {
      const session = readSession(d);
      const hasBundled = fs.existsSync(path.join(session.dir, "bundle.json"));
      return { id: session.id, startedAt: session.startedAt, url: session.url, status: hasBundled ? "stopped" : "active" };
    });

  console.log(JSON.stringify(sessions, null, 2));
}

function view(args: string[]): void {
  const id = args[0];
  if (!id) {
    console.error("Usage: capture session view <session-id> [--filter screenshots|har|a11y]");
    process.exit(1);
  }

  const session = readSession(id);
  const bundlePath = path.join(session.dir, "bundle.json");

  if (!fs.existsSync(bundlePath)) {
    console.error(`Session ${id} hasn't been stopped yet. Run: capture session stop ${id}`);
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(bundlePath, "utf-8")) as BundleManifest;

  const filter = args.find((_, i) => args[i - 1] === "--filter");
  if (filter) {
    const section = manifest[filter as keyof BundleManifest];
    console.log(JSON.stringify(section, null, 2));
  } else {
    console.log(JSON.stringify(manifest, null, 2));
  }
}

async function sessionMain(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;

  switch (subcommand) {
    case "start": return start(rest);
    case "stop": return stop(rest);
    case "list": return list();
    case "view": return view(rest);
    default:
      console.log(`capture session — manage capture sessions

Sub-commands:
  start [--url <url>]             Start a session (opens tab, records HAR, sets active context)
  stop  <session-id>              Finalize and bundle artifacts (screenshots, HAR, a11y, logs)
  list                            List active and stopped sessions
  view  <id> [--filter section]   View bundle manifest; section = screenshots|har|a11y|logs

Why sessions: once started, every subsequent capture command auto-fills
--target (the tab) and --har (the recording). No manual flag threading.

Typical flow:
  1. capture session start --url http://localhost:3000
  2. Interact — no --target / --har needed:
       capture a11y --interactive
       capture click "Sign in"
       capture type "hi@me.com" --into "Email"
       capture screenshot
       capture navigate https://app.example.com/dashboard
       capture har read --filter-url /api
  3. capture session stop <session-id>
  4. capture session view <session-id>

Related:  capture log <path> [--name label]   Tail a log into the active session
See also: capture --help                      Full command list`);
  }
}

// ============================================================================
// CLI
// ============================================================================

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  if (command === "--version" || command === "-v" || command === "version") {
    // Version is injected at build time via esbuild's --define flag.
    // Falls back to reading package.json at runtime if not injected.
    const declared = (globalThis as { __CAPTURE_VERSION__?: string }).__CAPTURE_VERSION__;
    if (declared) {
      console.log(declared);
      return;
    }
    try {
      const pkgPath = path.resolve(__dirname, "..", "package.json");
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { version: string };
      console.log(pkg.version);
    } catch {
      console.log("unknown");
    }
    return;
  }

  switch (command) {
    case "session":
      return sessionMain(args);

    case "log":
      return logCommand(args);

    // CDP commands — delegate to cdp.ts
    case "detect":
    case "exec":
    case "open":
    case "reset-tab":
    case "screenshot":
    case "click":
    case "type":
    case "a11y":
    case "record":
    case "navigate":
    case "har":
    case "network":
    case "list":
      return cdpMain();

    default:
      console.log(`Capture — browser automation over CDP for validating UI features.

Most tasks start with a session. Once a session is active, every command
auto-fills --target (the tab) and --har (the recording) — don't thread
those flags yourself.

TYPICAL WORKFLOW

  1. Start a session (opens tab, starts HAR, marks it active):
       capture session start --url http://localhost:3000

  2. Interact — no --target / --har needed:
       capture a11y --interactive           See what's on the page
       capture click "Sign in"              Click by accessible name (auto-screenshots)
       capture type "hi@me.com" --into "Email"
       capture screenshot                   Save current state
       capture navigate https://...         Navigate within the session
       capture exec "document.title"        Run JS (supports await)
       capture har read --filter-url /api   Inspect recorded traffic

  3. Bundle and inspect:
       capture session stop  <session-id>
       capture session view  <session-id>

SESSION COMMANDS

  session start [--url <url>]              Start a session
  session stop  <session-id>               Finalize and bundle artifacts
  session list                             List active and stopped sessions
  session view  <id> [--filter section]    section = screenshots|har|a11y|logs
  log <path> [--name label]                Tail a log file into the active session

INTERACTION COMMANDS (work inside or outside a session)

  a11y [--interactive] [--json]            Accessibility tree (use this first to see elements)
  click "name" [--role <role>]             Click by accessible name
  type "text" [--into "Field"]             Type into focused element or named field
  screenshot [--out <path>] [--full-page]  Screenshot (viewport: desktop|desktop-wide|tablet|mobile)
  exec <code>  |  exec --file <path>       Evaluate JS; await is supported
  navigate <url> [--settle <ms>]           Navigate the current tab + record HAR

DIAGNOSTICS & ONE-OFFS (no session needed)

  detect                                   Find running CDP endpoints
  list                                     List open tabs across endpoints
  open <url> [--new]                       Open a URL, return its tab id
  reset-tab <url>                          Abandon a stuck tab, open fresh (updates session)
  record [--duration <secs>]               Passive HAR recording; parallel-safe capture
  network <offline|online>                 Toggle connectivity for a tab
  har create | read [id] | delete <id>     Manage standalone HAR recordings

TARGETING (only when NOT in a session, or picking a parallel tab)

  --target <tabId>   Exact id; a prefix of 8 chars is enough (preferred, parallel-safe)
  --url <pattern>    Fuzzy URL match against open tabs
                     NOTE: on \`session start\`, --url is a URL to OPEN, not a pattern.

HELP

  capture <command> --help       Per-command usage, e.g. capture click --help, capture har --help
  capture --version              Print version

PREREQ — a browser with CDP must be running:
  Arc                 enabled by default
  Chrome / Chromium   --remote-debugging-port=9222
  Electron apps       CDP exposed automatically
  Verify with:        capture detect`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

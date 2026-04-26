#!/usr/bin/env node
/**
 * Unified entry point. Dispatches based on argv[2]:
 *   (none) | --mcp        run MCP server (default)
 *   hook                  read stdin, compress, write stdout (UserPromptSubmit hook)
 *   install-hook          register hook in ~/.claude/settings.json
 *   uninstall-hook        remove hook from ~/.claude/settings.json
 *   stats                 print log totals
 *   enable | disable      flip master switch
 *   preset <name>         apply a preset
 *   set <key> <value>     manual config tweak
 *   config                print current config + paths + hook status
 *   reset                 delete config file (defaults restored)
 *   clean-cache [--days N] prune old image-cache dirs
 *   --help | -h           usage
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import {
  loadConfig, saveConfig, applyPreset, defaultConfig, configPath,
  PRESETS, SETTABLE_KEYS, coerceValue,
  type Config, type PresetName, type SettableKey,
} from "./config.js";

const HOME = process.env.HOME || os.homedir();
const SETTINGS_PATH = path.join(HOME, ".claude", "settings.json");
const LOG_FILE = path.join(HOME, ".claude", "dc-img-compress.log");
const IMAGE_CACHE_DIR = path.join(HOME, ".claude", "image-cache");

function hookCommand(): string {
  const self = fileURLToPath(import.meta.url);
  return `node ${self} hook`;
}

async function readJson<T>(p: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(p, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function writeJson(p: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(data, null, 2) + "\n");
}

interface HookEntry {
  type: string;
  command?: string;
  [k: string]: unknown;
}
interface HookGroup {
  hooks?: HookEntry[];
  [k: string]: unknown;
}
interface Settings {
  hooks?: { UserPromptSubmit?: Array<HookEntry | HookGroup>; [k: string]: unknown };
  [k: string]: unknown;
}

function isOurCommand(cmd: string): boolean {
  return /\bcli\.js\s+hook\b/.test(cmd) || /dc-img-compress.*\bhook\b/.test(cmd);
}

async function isHookInstalled(): Promise<boolean> {
  const settings = await readJson<Settings>(SETTINGS_PATH);
  const list = settings?.hooks?.UserPromptSubmit;
  if (!Array.isArray(list)) return false;
  return list.some((item) => {
    const e = item as HookEntry;
    if (e.type === "command" && typeof e.command === "string" && isOurCommand(e.command)) return true;
    const g = item as HookGroup;
    if (Array.isArray(g.hooks)) {
      return g.hooks.some((h) => h.type === "command" && typeof h.command === "string" && isOurCommand(h.command));
    }
    return false;
  });
}

async function installHook(): Promise<void> {
  const cmd = hookCommand();
  const settings: Settings = (await readJson<Settings>(SETTINGS_PATH)) ?? {};
  settings.hooks = settings.hooks ?? {};
  const list = (settings.hooks.UserPromptSubmit = settings.hooks.UserPromptSubmit ?? []);

  const already = list.some((item: HookEntry | HookGroup) => {
    const e = item as HookEntry;
    if (e.type === "command" && typeof e.command === "string" && isOurCommand(e.command)) return true;
    const g = item as HookGroup;
    if (Array.isArray(g.hooks)) {
      return g.hooks.some((h) => h.type === "command" && typeof h.command === "string" && isOurCommand(h.command));
    }
    return false;
  });

  if (already) {
    console.log(`[dc-img-compress] hook already installed in ${SETTINGS_PATH}`);
    return;
  }

  list.push({ hooks: [{ type: "command", command: cmd }] });
  await writeJson(SETTINGS_PATH, settings);
  console.log(`[dc-img-compress] installed hook in ${SETTINGS_PATH}`);
  console.log(`  command: ${cmd}`);
}

async function uninstallHook(): Promise<void> {
  const settings = await readJson<Settings>(SETTINGS_PATH);
  if (!settings?.hooks?.UserPromptSubmit) {
    console.log(`[dc-img-compress] no hooks to remove`);
    return;
  }
  const before = settings.hooks.UserPromptSubmit.length;
  settings.hooks.UserPromptSubmit = settings.hooks.UserPromptSubmit
    .map((item) => {
      const g = item as HookGroup;
      if (Array.isArray(g.hooks)) {
        const filtered = g.hooks.filter(
          (h) => !(h.type === "command" && typeof h.command === "string" && isOurCommand(h.command)),
        );
        if (filtered.length === 0) return null;
        return { ...g, hooks: filtered };
      }
      const e = item as HookEntry;
      if (e.type === "command" && typeof e.command === "string" && isOurCommand(e.command)) return null;
      return item;
    })
    .filter((x): x is HookEntry | HookGroup => x !== null);

  if (settings.hooks.UserPromptSubmit.length === 0) delete settings.hooks.UserPromptSubmit;
  if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;

  await writeJson(SETTINGS_PATH, settings);
  console.log(`[dc-img-compress] removed ${before - (settings.hooks?.UserPromptSubmit?.length ?? 0)} hook entries`);
}

async function showStats(): Promise<void> {
  let raw = "";
  try {
    raw = await fs.readFile(LOG_FILE, "utf8");
  } catch {
    console.log("No log file yet at " + LOG_FILE);
    return;
  }
  const lines = raw.split("\n").filter((l) => l.trim());
  const now = Date.now();
  const week = 7 * 24 * 60 * 60 * 1000;

  const totals = { files: 0, bytes_in: 0, bytes_out: 0, tokens_in: 0, tokens_out: 0 };
  const week7 = { files: 0, bytes_in: 0, bytes_out: 0, tokens_in: 0, tokens_out: 0 };
  let errors = 0;

  for (const line of lines) {
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.error) { errors++; continue; }
    const recent = e.ts && (now - new Date(e.ts).getTime() < week);
    for (const k of ["bytes_in", "bytes_out", "tokens_in", "tokens_out"] as const) {
      totals[k] += e[k] || 0;
      if (recent) week7[k] += e[k] || 0;
    }
    totals.files++;
    if (recent) week7.files++;
  }

  const fmt = (b: number) => `${(b / 1024 / 1024).toFixed(2)} MB`;
  console.log("dc-img-compress stats");
  console.log("---------------------");
  console.log(`Log: ${LOG_FILE}`);
  console.log(`Errors logged: ${errors}`);
  console.log("");
  console.log("All-time:");
  console.log(`  files compressed: ${totals.files}`);
  console.log(`  bytes saved:      ${fmt(totals.bytes_in - totals.bytes_out)} (${fmt(totals.bytes_in)} -> ${fmt(totals.bytes_out)})`);
  console.log(`  tokens saved:     ${totals.tokens_in - totals.tokens_out} (est)`);
  console.log("");
  console.log("Last 7 days:");
  console.log(`  files compressed: ${week7.files}`);
  console.log(`  bytes saved:      ${fmt(week7.bytes_in - week7.bytes_out)}`);
  console.log(`  tokens saved:     ${week7.tokens_in - week7.tokens_out} (est)`);
}

function summarize(cfg: Config): string {
  return `preset=${cfg.preset} max_dim=${cfg.max_dim} quality=${cfg.quality} threshold_kb=${cfg.threshold_kb} min_savings_pct=${cfg.min_savings_pct} format=${cfg.format}`;
}

async function cmdEnable(): Promise<void> {
  const cfg = await loadConfig();
  cfg.enabled = true;
  await saveConfig(cfg);
  console.log(`[dc-img-compress] enabled. ${summarize(cfg)}`);
}

async function cmdDisable(): Promise<void> {
  const cfg = await loadConfig();
  cfg.enabled = false;
  await saveConfig(cfg);
  console.log("[dc-img-compress] disabled. Hook installed but no-op until enabled.");
}

async function cmdPreset(name: string | undefined): Promise<void> {
  if (!name || !(name in PRESETS)) {
    console.error(`preset name required, one of: ${Object.keys(PRESETS).join(", ")}`);
    process.exit(1);
  }
  const before = await loadConfig();
  const after = applyPreset(before, name as PresetName);
  await saveConfig(after);
  console.log(`[dc-img-compress] applied preset '${name}'`);
  console.log(`  before: ${summarize(before)}`);
  console.log(`  after:  ${summarize(after)}`);
}

async function cmdSet(key: string | undefined, value: string | undefined): Promise<void> {
  if (!key || value === undefined) {
    console.error(`usage: dc-img-compress set <key> <value>\nkeys: ${SETTABLE_KEYS.join(", ")}`);
    process.exit(1);
  }
  if (!(SETTABLE_KEYS as readonly string[]).includes(key)) {
    console.error(`invalid key '${key}'. valid: ${SETTABLE_KEYS.join(", ")}`);
    process.exit(1);
  }
  const cfg = await loadConfig();
  const coerced = coerceValue(key as SettableKey, value);
  (cfg as any)[key] = coerced;
  cfg.preset = "custom";
  await saveConfig(cfg);
  console.log(`[dc-img-compress] set ${key}=${coerced} (preset=custom)`);
  console.log(JSON.stringify(cfg, null, 2));
}

async function cmdConfig(argv: string[]): Promise<void> {
  const cfg = await loadConfig();
  const installed = await isHookInstalled();
  const cp = configPath();
  let exists = true;
  try { await fs.stat(cp); } catch { exists = false; }
  const def = defaultConfig();
  const full = argv.includes("--full") || argv.includes("-f");

  const rows: Array<[string, string, string, string]> = [
    ["enabled",              String(def.enabled),              String((cfg as any).enabled),              "master switch; false=no-op"],
    ["preset",               def.preset,                       String((cfg as any).preset),               "extreme|aggressive|default|gentle|custom"],
    ["max_dim",              String(def.max_dim),              String((cfg as any).max_dim),              "longest edge px (1568 = Anthropic optimum)"],
    ["quality",              String(def.quality),              String((cfg as any).quality),              "JPEG/WebP quality 1-100"],
    ["threshold_kb",         String(def.threshold_kb),         String((cfg as any).threshold_kb),         "skip files <this KB"],
    ["min_savings_pct",      String(def.min_savings_pct),      String((cfg as any).min_savings_pct),      "discard if savings <%"],
    ["format",               def.format,                       String((cfg as any).format),               "preserve|webp"],
    ["scan_image_cache",     String(def.scan_image_cache),     String((cfg as any).scan_image_cache),     "scan ~/.claude/image-cache/<session>/"],
    ["scan_paths_in_prompt", String(def.scan_paths_in_prompt), String((cfg as any).scan_paths_in_prompt), "scan prompt for absolute paths"],
  ];

  const w = [
    Math.max(3, ...rows.map(r => r[0].length)),
    Math.max(7, ...rows.map(r => r[1].length)),
    Math.max(7, ...rows.map(r => r[2].length)),
    Math.max(11, ...rows.map(r => r[3].length)),
  ];
  const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - s.length));

  if (full) {
    const sep = `+${"-".repeat(w[0]+2)}+${"-".repeat(w[1]+2)}+${"-".repeat(w[2]+2)}+${"-".repeat(w[3]+2)}+`;
    console.log(sep);
    console.log(`| ${pad("KEY", w[0])} | ${pad("DEFAULT", w[1])} | ${pad("CURRENT", w[2])} | ${pad("DESCRIPTION", w[3])} |`);
    console.log(sep);
    for (const r of rows) {
      const cur = r[1] !== r[2] ? `${r[2]} *` : r[2];
      console.log(`| ${pad(r[0], w[0])} | ${pad(r[1], w[1])} | ${pad(cur, w[2])} | ${pad(r[3], w[3])} |`);
    }
    console.log(sep);
    console.log("(* = differs from default)");
    console.log("");
    console.log("Examples: preset extreme | set quality 70 | set max_dim 1280 | set format webp | disable | reset");
    console.log(`config: ${cp}${exists ? "" : " (defaults)"}  log: ${LOG_FILE}  hook: ${installed ? "installed" : "not-installed"}`);
    return;
  }

  // Compact mode (default) — fits under Claude Code Bash collapse threshold.
  // No borders, no header row, no blank lines. One line per key + 1 footer.
  for (const r of rows) {
    const cur = r[1] !== r[2] ? `${r[2]}*` : r[2];
    console.log(`${pad(r[0], w[0])}  ${pad(cur, Math.max(w[2], w[1]))}  ${r[3]}`);
  }
  console.log(`(${exists ? "config: " + cp : "defaults"}; hook: ${installed ? "on" : "off"}; --full for table)`);
}

async function cmdReset(): Promise<void> {
  const cp = configPath();
  try {
    await fs.unlink(cp);
    console.log(`[dc-img-compress] reset to defaults (deleted ${cp})`);
  } catch {
    console.log(`[dc-img-compress] no config file to delete; defaults already in effect`);
  }
}

async function cmdCleanCache(args: string[]): Promise<void> {
  let days = 7;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--days" && args[i + 1] !== undefined) {
      const n = Number(args[i + 1]);
      if (!Number.isFinite(n) || n < 0) {
        console.error(`--days must be a non-negative number`);
        process.exit(1);
      }
      days = n;
      i++;
    }
  }
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const safety = Date.now() - 60 * 60 * 1000; // skip dirs modified within last hour

  let entries: string[];
  try {
    entries = await fs.readdir(IMAGE_CACHE_DIR);
  } catch {
    console.log(`[dc-img-compress] no image-cache dir at ${IMAGE_CACHE_DIR}`);
    return;
  }

  let deleted = 0;
  let bytesFreed = 0;
  for (const name of entries) {
    const sub = path.join(IMAGE_CACHE_DIR, name);
    let st;
    try { st = await fs.stat(sub); } catch { continue; }
    if (!st.isDirectory()) continue;
    const mtime = st.mtimeMs;
    if (mtime > safety) continue; // skip current/recent session for safety
    if (mtime > cutoff) continue;

    // Sum sizes then remove.
    let dirBytes = 0;
    try {
      const files = await fs.readdir(sub);
      for (const f of files) {
        try {
          const fst = await fs.stat(path.join(sub, f));
          if (fst.isFile()) dirBytes += fst.size;
        } catch { /* skip */ }
      }
    } catch { /* skip */ }

    try {
      await fs.rm(sub, { recursive: true, force: true });
      deleted++;
      bytesFreed += dirBytes;
    } catch {
      // skip on error
    }
  }

  console.log(`[dc-img-compress] cleaned ${deleted} cache dir(s), freed ${(bytesFreed / 1024 / 1024).toFixed(2)} MB (older than ${days}d, current session preserved)`);
}

function showHelp(): void {
  console.log(`dc-img-compress — local image compression for Claude Code

Usage:
  Server:
    dc-img-compress                  Run MCP server (stdio) — default
    dc-img-compress --mcp            Same as above

  Setup:
    dc-img-compress install-hook     Register hook in ~/.claude/settings.json
    dc-img-compress uninstall-hook   Remove hook from ~/.claude/settings.json

  Control (config at ~/.claude/dc-img-compress.config.json):
    dc-img-compress enable           Enable the hook
    dc-img-compress disable          Disable hook (installed but no-op)
    dc-img-compress preset <name>    Apply preset: extreme | aggressive | default | gentle
    dc-img-compress set <key> <val>  Tweak: max_dim, quality, threshold_kb, min_savings_pct,
                                              format (preserve|webp), scan_image_cache,
                                              scan_paths_in_prompt
    dc-img-compress reset            Delete config file (defaults restored)

  Inspect:
    dc-img-compress config           Print current config + paths + hook status
    dc-img-compress stats            Show compression stats from log

  Maintenance:
    dc-img-compress clean-cache [--days N]   Prune old ~/.claude/image-cache dirs (default 7)

  Hook (internal):
    dc-img-compress hook             Used by Claude Code; reads JSON from stdin

  dc-img-compress --help             Show this help
`);
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  switch (cmd) {
    case undefined:
    case "--mcp": {
      const { runMcpServer } = await import("./mcp.js");
      await runMcpServer();
      return;
    }
    case "hook": {
      const { runHook } = await import("./hook.js");
      await runHook();
      return;
    }
    case "install-hook":
      return installHook();
    case "uninstall-hook":
      return uninstallHook();
    case "stats":
      return showStats();
    case "enable":
      return cmdEnable();
    case "disable":
      return cmdDisable();
    case "preset":
      return cmdPreset(process.argv[3]);
    case "set":
      return cmdSet(process.argv[3], process.argv[4]);
    case "config":
      return cmdConfig(process.argv.slice(3));
    case "reset":
      return cmdReset();
    case "clean-cache":
      return cmdCleanCache(process.argv.slice(3));
    case "--help":
    case "-h":
    case "help":
      return showHelp();
    default:
      console.error(`Unknown command: ${cmd}`);
      showHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

/**
 * Claude Code UserPromptSubmit hook.
 *
 * Reads JSON from stdin, finds absolute image paths in `prompt`, and
 * compresses each one in place (overwriting the original bytes) so that
 * when Claude Code subsequently reads those files it sees the smaller,
 * cheaper version.
 *
 * Why in-place instead of rewriting the prompt:
 * The UserPromptSubmit hook protocol (https://code.claude.com/docs/en/hooks)
 * does NOT expose a way to mutate the user's prompt text. Hooks may only
 * (a) add `additionalContext`, (b) block the prompt, or (c) emit stderr.
 * Since we cannot swap path strings, the only way to reduce token cost
 * for already-pasted images is to shrink the bytes at those paths.
 *
 * Fail-open: any error logs and exits 0 with no output. Never block.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import sharp from "sharp";
import { estimateImageTokens } from "./tokens.js";
import { loadConfig, type Config } from "./config.js";

const LOG_DIR = path.join(os.homedir(), ".claude");
const LOG_FILE = path.join(LOG_DIR, "dc-img-compress.log");

const IMG_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|tiff?)\b/i;
// Match absolute paths (POSIX/Windows) ending with image extension.
const PATH_RE =
  /(?:^|[\s'"`(<\[])((?:\/|[A-Za-z]:[\\/])[^\s'"`)<>\]]+?\.(?:png|jpe?g|webp|gif|bmp|tiff?))(?=$|[\s'"`)<>\],;:!?])/gi;

export interface LogEntry {
  ts: string;
  session_id?: string;
  input_path: string;
  output_path: string;
  bytes_in: number;
  bytes_out: number;
  tokens_in: number;
  tokens_out: number;
  savings_pct: number;
  in_place: boolean;
  error?: string;
}

async function appendLog(entry: Partial<LogEntry> & { ts?: string }): Promise<void> {
  try {
    await fs.mkdir(LOG_DIR, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
    await fs.appendFile(LOG_FILE, line);
  } catch {
    // never throw from logger
  }
}

function extractImagePaths(prompt: string): string[] {
  const found = new Set<string>();
  for (const m of prompt.matchAll(PATH_RE)) {
    if (m[1]) found.add(m[1]);
  }
  return [...found];
}

/**
 * Compress a single image in place. Honors config for dim cap, quality,
 * size threshold, savings threshold, and format mode.
 */
async function compressInPlace(
  filePath: string,
  sessionId: string | undefined,
  cfg: Config,
): Promise<{ ok: boolean; reason?: string; tokens_in?: number; tokens_out?: number }> {
  const skipBytes = cfg.threshold_kb * 1024;
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return { ok: false, reason: "missing" };
  }
  if (!stat.isFile()) return { ok: false, reason: "not-file" };
  if (stat.size < skipBytes) return { ok: false, reason: "too-small" };

  const buf = await fs.readFile(filePath);
  const meta = await sharp(buf, { failOn: "none" }).metadata();
  if (!meta.width || !meta.height || !meta.format) {
    return { ok: false, reason: "not-image" };
  }
  if (meta.width < cfg.max_dim && meta.height < cfg.max_dim) {
    return { ok: false, reason: "small-dims" };
  }

  const longest = Math.max(meta.width, meta.height);
  let pipeline = sharp(buf, { failOn: "none" });
  if (longest > cfg.max_dim) {
    pipeline = pipeline.resize({
      width: meta.width >= meta.height ? cfg.max_dim : undefined,
      height: meta.height > meta.width ? cfg.max_dim : undefined,
      fit: "inside",
      withoutEnlargement: true,
    });
  }

  const ext = path.extname(filePath).toLowerCase();
  if (cfg.format === "webp") {
    // Force webp bytes regardless of source ext (vision sniffs magic bytes).
    pipeline = pipeline.webp({ quality: cfg.quality });
  } else if (ext === ".jpg" || ext === ".jpeg") {
    pipeline = pipeline.jpeg({ quality: cfg.quality, mozjpeg: true });
  } else if (ext === ".png") {
    pipeline = pipeline.png({ compressionLevel: 9 });
  } else if (ext === ".webp") {
    pipeline = pipeline.webp({ quality: cfg.quality });
  } else {
    // gif/bmp/tiff/exotic: re-encode as webp bytes, keep extension
    pipeline = pipeline.webp({ quality: cfg.quality });
  }

  const { data: outBuf, info } = await pipeline.toBuffer({ resolveWithObject: true });

  // Honor configured min_savings_pct (e.g. 10 -> require 10% reduction).
  const savingsRatio = 1 - outBuf.length / buf.length;
  if (savingsRatio * 100 < cfg.min_savings_pct) {
    return { ok: false, reason: "no-savings" };
  }

  await fs.writeFile(filePath, outBuf);

  const tIn = estimateImageTokens(meta.width, meta.height);
  const tOut = estimateImageTokens(info.width, info.height);
  await appendLog({
    session_id: sessionId,
    input_path: filePath,
    output_path: filePath,
    bytes_in: buf.length,
    bytes_out: outBuf.length,
    tokens_in: tIn,
    tokens_out: tOut,
    savings_pct: Math.round(savingsRatio * 100),
    in_place: true,
  });

  return { ok: true, tokens_in: tIn, tokens_out: tOut };
}

async function readStdin(): Promise<string> {
  return await new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
    setTimeout(() => resolve(data), 400).unref();
  });
}

export async function runHook(): Promise<void> {
  const cfg = await loadConfig();
  if (cfg.enabled === false) {
    process.exit(0);
  }

  let raw = "";
  try {
    raw = await readStdin();
  } catch (err) {
    await appendLog({ input_path: "", output_path: "", bytes_in: 0, bytes_out: 0, tokens_in: 0, tokens_out: 0, savings_pct: 0, in_place: false, error: `stdin: ${(err as Error).message}` });
    process.exit(0);
  }

  if (!raw.trim()) process.exit(0);

  let input: { prompt?: string; session_id?: string };
  try {
    input = JSON.parse(raw);
  } catch (err) {
    await appendLog({ input_path: "", output_path: "", bytes_in: 0, bytes_out: 0, tokens_in: 0, tokens_out: 0, savings_pct: 0, in_place: false, error: `parse: ${(err as Error).message}` });
    process.exit(0);
  }

  const prompt = input.prompt ?? "";
  const sessionId = input.session_id;
  const paths = cfg.scan_paths_in_prompt ? extractImagePaths(prompt) : [];

  if (cfg.scan_image_cache && sessionId && /\[Image #\d+\]/i.test(prompt)) {
    const cacheDir = path.join(os.homedir(), ".claude", "image-cache", sessionId);
    try {
      const entries = await fs.readdir(cacheDir);
      for (const name of entries) {
        if (IMG_EXT_RE.test(name)) {
          const full = path.join(cacheDir, name);
          if (!paths.includes(full)) paths.push(full);
        }
      }
    } catch {
      // dir missing — ignore
    }
  }

  if (paths.length === 0) process.exit(0);

  let totalIn = 0;
  let totalOut = 0;
  let tokIn = 0;
  let tokOut = 0;
  let touched = 0;
  for (const p of paths) {
    try {
      const before = await fs.stat(p).then((s) => s.size).catch(() => 0);
      const r = await compressInPlace(p, sessionId, cfg);
      if (r.ok) {
        const after = await fs.stat(p).then((s) => s.size).catch(() => 0);
        totalIn += before;
        totalOut += after;
        tokIn += r.tokens_in ?? 0;
        tokOut += r.tokens_out ?? 0;
        touched++;
      }
    } catch (err) {
      await appendLog({
        session_id: sessionId,
        input_path: p,
        output_path: p,
        bytes_in: 0, bytes_out: 0, tokens_in: 0, tokens_out: 0, savings_pct: 0,
        in_place: true,
        error: (err as Error).message,
      });
    }
  }

  const skipped = paths.length - touched;
  if (paths.length > 0) {
    const saved = totalIn - totalOut;
    const pct = totalIn > 0 ? Math.round((saved / totalIn) * 100) : 0;
    const tokSaved = tokIn - tokOut;
    const msg = touched > 0
      ? `↓ ${touched} img · ${(saved / 1024).toFixed(0)}KB · ~${tokSaved} tok (${pct}%)${skipped > 0 ? ` · ${skipped} skipped` : ""}`
      : `· ${paths.length} img scanned, all skipped (small/already-compressed)`;
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: `[dc-img-cprs] ${msg}`,
        },
      }),
    );
  }
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runHook().catch(async (err) => {
    await appendLog({ input_path: "", output_path: "", bytes_in: 0, bytes_out: 0, tokens_in: 0, tokens_out: 0, savings_pct: 0, in_place: false, error: `fatal: ${(err as Error).message}` });
    process.exit(0);
  });
}

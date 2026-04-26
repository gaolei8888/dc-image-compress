/**
 * Runtime config for dc-img-compress hook + CLI.
 *
 * Persisted at ~/.claude/dc-img-compress.config.json. Both the hook
 * (read every invocation) and the CLI (read/write via subcommands)
 * share this module.
 *
 * Fail-soft: missing file -> defaults; malformed -> defaults + stderr warn.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

export type FormatMode = "preserve" | "webp";

export interface Config {
  enabled: boolean;
  preset: string;
  max_dim: number;
  quality: number;
  threshold_kb: number;
  min_savings_pct: number;
  format: FormatMode;
  scan_image_cache: boolean;
  scan_paths_in_prompt: boolean;
}

export type PresetName = "extreme" | "aggressive" | "default" | "gentle";

export const PRESETS: Record<PresetName, Pick<Config, "max_dim" | "quality" | "threshold_kb" | "min_savings_pct">> = {
  extreme:    { max_dim: 1024, quality: 70, threshold_kb: 100, min_savings_pct: 5 },
  aggressive: { max_dim: 1280, quality: 78, threshold_kb: 150, min_savings_pct: 8 },
  default:    { max_dim: 1568, quality: 85, threshold_kb: 200, min_savings_pct: 10 },
  gentle:     { max_dim: 1920, quality: 90, threshold_kb: 500, min_savings_pct: 15 },
};

export const SETTABLE_KEYS = [
  "max_dim", "quality", "threshold_kb", "min_savings_pct",
  "format", "scan_image_cache", "scan_paths_in_prompt",
] as const;
export type SettableKey = typeof SETTABLE_KEYS[number];

export function configPath(home: string = process.env.HOME || os.homedir()): string {
  return path.join(home, ".claude", "dc-img-compress.config.json");
}

export function defaultConfig(): Config {
  return {
    enabled: true,
    preset: "default",
    ...PRESETS.default,
    format: "preserve",
    scan_image_cache: true,
    scan_paths_in_prompt: true,
  };
}

export function applyPreset(cfg: Config, name: PresetName): Config {
  return { ...cfg, preset: name, ...PRESETS[name] };
}

export async function loadConfig(home?: string): Promise<Config> {
  const p = configPath(home);
  let raw: string;
  try {
    raw = await fs.readFile(p, "utf8");
  } catch {
    return defaultConfig();
  }
  try {
    const parsed = JSON.parse(raw) as Partial<Config>;
    return { ...defaultConfig(), ...parsed };
  } catch (err) {
    process.stderr.write(`[dc-img-compress] malformed config at ${p}: ${(err as Error).message}; using defaults\n`);
    return defaultConfig();
  }
}

export async function saveConfig(cfg: Config, home?: string): Promise<void> {
  const p = configPath(home);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(cfg, null, 2) + "\n");
}

export function coerceValue(key: SettableKey, value: string): Config[SettableKey] {
  switch (key) {
    case "max_dim":
    case "quality":
    case "threshold_kb":
    case "min_savings_pct": {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new Error(`${key} must be a number, got ${value}`);
      return n;
    }
    case "format":
      if (value !== "preserve" && value !== "webp") {
        throw new Error(`format must be "preserve" or "webp", got ${value}`);
      }
      return value;
    case "scan_image_cache":
    case "scan_paths_in_prompt": {
      if (value === "true" || value === "1" || value === "yes") return true;
      if (value === "false" || value === "0" || value === "no") return false;
      throw new Error(`${key} must be true/false, got ${value}`);
    }
  }
}

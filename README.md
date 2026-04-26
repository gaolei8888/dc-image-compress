# dc-img-compress

A tiny MCP server that compresses images locally before they're sent to Claude, so you stop paying vision tokens for 4000px screenshots.

It exposes two tools — `compress_image` and `compress_image_batch` — backed by [sharp](https://sharp.pixelplumbing.com/). Sharp ships prebuilt binaries, so no system dependencies are required.

## Why this saves tokens

Anthropic's vision pricing is roughly **`(width * height) / 750` tokens per image**. Anthropic's docs also note that images with a long edge over **1568px** are downscaled server-side anyway — meaning every pixel above that threshold is wasted bandwidth and, for the bytes you upload, wasted base64 cost. Compressing locally:

1. Caps the long edge at 1568px (configurable) — no upscaling.
2. Re-encodes to WebP/JPEG, often shrinking files 5-20x.
3. Reports estimated token savings so you can see the win.

That's why the default `max_dim` is **1568**.

## Install (Claude Code)

```bash
claude mcp add image-compress -- npx -y dc-img-compress
```

## Auto-compress on paste (UserPromptSubmit hook)

Optionally, register a Claude Code hook that compresses images **automatically** the moment you paste them, before they ever hit the model. One-line install:

```bash
npx -p dc-img-compress dc-img-cprs install-hook
```

(After publish — for local dev, `npm link` then `dc-img-cprs install-hook`.)

This adds an entry under `hooks.UserPromptSubmit` in `~/.claude/settings.json`. From then on, every time you submit a prompt, the hook scans for image paths and re-encodes any qualifying image **in place**.

**Two discovery sources** (both on by default):

1. **Image-cache scan** — when prompt contains `[Image #N]` markers (Claude Code's paste indicator), the hook reads `~/.claude/image-cache/<session_id>/` and processes every image there.
2. **Prompt path scan** — any absolute image path appearing as text in the prompt.

**Behavior:**

- Skips images smaller than **200 KB** or whose dimensions are both **< 1568 px** (no win to be had).
- Resizes the longest edge to **1568 px** and re-encodes at quality **85**, preserving the source format (PNG stays PNG, JPEG stays JPEG, etc.).
- Only commits the rewrite if it saves at least 10 % of the bytes.
- **Fails open**: if anything goes wrong, the hook exits 0 silently — your prompt is never blocked.
- Logs every action as one JSON line to `~/.claude/dc-img-compress.log`.
- Emits a brief savings line as `additionalContext` so you see results in chat:
  - `[dc-img-cprs] ↓ 1 img · 84KB · ~2183 tok (17%) · 8 skipped` — when something compressed
  - `[dc-img-cprs] · 3 img scanned, all skipped (small/already-compressed)` — when nothing eligible

**Why in-place?** The Claude Code `UserPromptSubmit` hook protocol does not support rewriting the prompt text itself, so we cannot swap a path string for a `.compressed.webp` sibling. Overwriting the temp-file bytes is the only way to deliver a smaller image to the model. (See [hooks reference](https://code.claude.com/docs/en/hooks).)

**Inspect savings:**

```bash
dc-img-cprs stats
```

**Uninstall:**

```bash
dc-img-cprs uninstall-hook
```

The hook is **opt-in** and entirely independent of the MCP server install above.

## Runtime control

Tune hook behavior on the fly without reinstalling:

| Command                                   | What it does                                                                |
| ----------------------------------------- | --------------------------------------------------------------------------- |
| `dc-img-cprs enable`                  | Master switch on; hook runs normally                                                  |
| `dc-img-cprs disable`                 | Master switch off; hook exits immediately, no work, no log                            |
| `dc-img-cprs preset <name>`           | Apply a tuning preset (see table below)                                               |
| `dc-img-cprs set <key> <value>`       | Tweak one field; flips `preset` to `"custom"`                                         |
| `dc-img-cprs config`                  | Compact config dump (key, current, description) — fits under Bash collapse threshold  |
| `dc-img-cprs config --full`           | Bordered table view with default/current diff column                                  |
| `dc-img-cprs reset`                   | Delete the config file (revert to built-in defaults)                                  |
| `dc-img-cprs stats`                   | Show all-time and last-7-day compression totals from log                              |
| `dc-img-cprs clean-cache [--days N]`  | Prune old `~/.claude/image-cache/<dir>/` entries (default 7 days)                     |

### Presets

| Preset       | max_dim | quality | threshold_kb | min_savings_pct |
| ------------ | ------- | ------- | ------------ | --------------- |
| `extreme`    | 1024    | 70      | 100          | 5               |
| `aggressive` | 1280    | 78      | 150          | 8               |
| `default`    | 1568    | 85      | 200          | 10              |
| `gentle`     | 1920    | 90      | 500          | 15              |

### Config file

`~/.claude/dc-img-compress.config.json`

```json
{
  "enabled": true,
  "preset": "default",
  "max_dim": 1568,
  "quality": 85,
  "threshold_kb": 200,
  "min_savings_pct": 10,
  "format": "preserve",
  "scan_image_cache": true,
  "scan_paths_in_prompt": true
}
```

- `enabled` — master switch. When `false`, the hook is a no-op.
- `format` — `"preserve"` keeps the source extension's encoder; `"webp"` forces webp bytes regardless of source ext (Claude vision sniffs magic bytes).
- `scan_image_cache` / `scan_paths_in_prompt` — toggle the two image-discovery sources independently.

Settable keys for `set`: `max_dim`, `quality`, `threshold_kb`, `min_savings_pct`, `format`, `scan_image_cache`, `scan_paths_in_prompt`. Manual edits set `preset: "custom"`. Missing or malformed config falls back to built-in defaults — the hook never throws.

### Cache cleanup

`dc-img-cprs clean-cache --days N` deletes pasted-image cache directories older than `N` days. To avoid clobbering an active session, dirs modified within the last hour are always skipped.

## Install (Claude Desktop)

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "image-compress": {
      "command": "npx",
      "args": ["-y", "dc-img-compress"]
    }
  }
}
```

## Install (OpenAI Codex CLI) — MCP only

Codex CLI ([github.com/openai/codex](https://github.com/openai/codex)) supports stdio MCP servers. Add to `~/.codex/config.toml`:

```toml
[mcp_servers.image-compress]
command = "npx"
args = ["-y", "-p", "dc-img-compress", "dc-img-cprs", "--mcp"]
```

Then ask Codex to call `compress_image` / `compress_image_batch` on any path before reading it.

**Auto-compress on paste is NOT supported on Codex today.** Codex stores pasted clipboard images at `${TMPDIR}/codex-clipboard-<random>.png` with no session subdirectory, so the hook cannot reliably scope to the current session. Tracking issue: [openai/codex#19385](https://github.com/openai/codex/issues/19385) (request for `$CODEX_HOME/image-cache/<session_id>/` parity with Claude Code).

Codex *does* support a `UserPromptSubmit` hook with the same `additionalContext` schema, so once the paste-cache layout is session-scoped upstream, auto-mode is a small patch away.

## Tools

### `compress_image`

| arg           | type                       | default                              | notes                                            |
| ------------- | -------------------------- | ------------------------------------ | ------------------------------------------------ |
| `path`        | string (required)          | —                                    | Absolute path to source image                    |
| `max_dim`     | number                     | `1568`                               | Longest edge cap; no upscaling                   |
| `format`      | `"webp" \| "jpeg" \| "png"` | `"webp"`                             | Output format                                    |
| `quality`     | number 1-100               | `85`                                 | Encoder quality (PNG: compressionLevel)          |
| `output_path` | string                     | `<dir>/<name>.compressed.<ext>`      | Absolute output path                             |

Returns JSON text content:

```json
{
  "input_path": "...",
  "output_path": "...",
  "input_bytes": 2438192,
  "output_bytes": 184320,
  "input_dims": { "width": 3840, "height": 2160 },
  "output_dims": { "width": 1568, "height": 882 },
  "ratio": 0.0756,
  "est_token_savings": { "before": 11059, "after": 1843, "saved": 9216 }
}
```

### `compress_image_batch`

Same options as above, but takes `paths: string[]`. Returns per-file results plus an `aggregate` block with total bytes saved and total estimated token savings.

## Behavior notes

- Source files are never overwritten unless `output_path` is explicitly set to the input path.
- If the image is already smaller than `max_dim`, it's not resized — but it's still re-encoded if `format` differs.
- Non-image files, missing files, and relative paths are rejected with clear errors.
- Token estimate uses Anthropic's published `(w*h)/750` heuristic. It's an estimate, not a guarantee.

## Local development

```bash
npm install
npm run build
npm start
```

## License

MIT — Lei Gao

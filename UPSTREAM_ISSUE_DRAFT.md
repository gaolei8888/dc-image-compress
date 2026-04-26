# Draft: Upstream issue for openai/codex

**Title:** Session-scoped paste-image cache directory (parity with Claude Code's `~/.claude/image-cache/<session_id>/`)

**Labels:** enhancement, hooks, tui

---

## Summary

Currently, when a user pastes a clipboard image into the Codex TUI, the image is written to a flat temp file:

```
${TMPDIR}/codex-clipboard-<random>.png
```

(Source: `codex-rs/tui/src/clipboard_paste.rs`, via `tempfile::Builder::prefix("codex-clipboard-").suffix(".png")` + `.keep()`.)

This works for the immediate attachment, but it **prevents `UserPromptSubmit` hooks from reliably enumerating the images that belong to the current session/turn**. Concretely:

- Multiple Codex instances running in parallel write into the same `/tmp` namespace.
- Hooks have no way to filter to "files this session pasted" without racy mtime heuristics.
- Stale `codex-clipboard-*.png` from prior crashed runs accumulate and pollute any scan.

## Proposal

Mirror Claude Code's layout:

```
${CODEX_HOME:-~/.codex}/image-cache/<session_id>/<n>.png
```

Where `<session_id>` is the same UUID already passed to `UserPromptSubmit` hooks (`session_id` field on stdin), and `<n>` is a monotonic counter per session.

## Why this matters

It unlocks an entire class of pre-submit image-processing hooks — specifically image compression to reduce vision token cost (see e.g. [dc-img-cprs](https://github.com/<your-username>/dc-img-compress), which already does this for Claude Code).

With session-scoped cache:

```bash
ls "$CODEX_HOME/image-cache/$session_id/"
```

…is sufficient for a hook to find every image attached to the current turn, compress them in place, and emit `additionalContext` reporting the savings — all before the image bytes are uploaded to the model.

Today, the hook either has to (a) scan all of `/tmp/codex-clipboard-*.png` with mtime heuristics (race-prone, breaks under parallel sessions) or (b) skip auto-mode entirely and require the user to invoke a tool manually.

## Backwards compatibility

- Existing consumers that read `codex-clipboard-*.png` from `/tmp` would break. Mitigation: dual-write for one release, or gate behind a config flag (`[tui] image_cache_dir = "session"` vs `"tmp"`).
- The image attachment path passed to the model can stay identical from the model's POV — only the on-disk location changes.

## Related

- `codex-rs/hooks/src/events/user_prompt_submit.rs` — already exposes `session_id` on hook stdin.
- #16486 — initial `UserPromptSubmit` hook feature.
- #19385 — broader Claude-Code-parity request.

## Acceptance criteria

- [ ] Pasted clipboard images land in `$CODEX_HOME/image-cache/<session_id>/<n>.png`.
- [ ] Directory is created lazily on first paste in a session.
- [ ] Stale session dirs are cleaned on next start (or via a `codex cache prune` subcommand) to avoid disk bloat.
- [ ] `<session_id>` matches the value sent to `UserPromptSubmit` hooks 1:1.
- [ ] Backwards-compat path documented (config flag or migration note).

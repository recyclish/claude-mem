# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Claude-mem is a Claude Code plugin providing persistent memory across sessions. It captures tool usage via lifecycle hooks, compresses observations using the Claude Agent SDK, and injects relevant context into future sessions.

## Commands

```bash
npm run build                 # esbuild bundle: plugin/scripts/*.cjs + viewer + npx CLI
npm run build-and-sync        # Build, sync to installed marketplace copy, restart worker (use during development)
npm run sync-marketplace      # Sync plugin/ to ~/.claude/plugins/marketplaces/thedotmack/

bun test                      # Run all tests
bun test tests/sqlite/        # Run a directory (also: test:agents, test:search, test:context, test:infra, test:server)
bun test tests/hook-lifecycle.test.ts        # Run a single test file
bun test -t "test name"       # Run tests matching a name

npm run worker:restart        # Restart worker daemon (also: start, stop, status)
npm run worker:logs           # Tail today's worker log (~/.claude-mem/logs/)
npm run queue                 # Inspect pending processing queue (queue:process to drain)
```

There is no separate lint step; TypeScript is checked at build time via esbuild/tsc config in `tsconfig.json`.

**Critical dev-loop detail**: Claude Code runs the *installed* plugin copy at `~/.claude/plugins/marketplaces/thedotmack/`, not this repo. Edits to `src/` have no effect until `npm run build-and-sync` runs.

## Architecture

The system is split into thin hooks (edge) and a long-lived worker daemon (processing):

**Hook layer** (`plugin/hooks/hooks.json`) — Claude Code lifecycle events (Setup, SessionStart, UserPromptSubmit, PreToolUse:Read, PostToolUse, Stop, SessionEnd) all shell out through `plugin/scripts/bun-runner.js` to `worker-service.cjs hook claude-code <hook-name>` (e.g. `context`, `session-init`, `observation`, `file-context`, `summarize`, `session-complete`). Hooks are intentionally thin: they POST to the worker and exit fast; AI processing happens asynchronously in the worker.

**Worker service** (`src/services/worker-service.ts`) — slim orchestrator (deliberately refactored from a 2000-line monolith; keep it that way) for an Express API on **port 37777**, run as a Bun-managed daemon. Delegates to:
- `src/services/server/` — HTTP server, middleware, error handling
- `src/services/infrastructure/` — PID files, health monitoring, graceful shutdown, daemon spawning
- `src/services/worker/` — business logic: `SDKAgent` (Claude Agent SDK compression), `GeminiAgent`/`OpenRouterAgent` (alternative backends), `SearchManager`, `SessionManager`, `SSEBroadcaster`, knowledge corpus (`worker/knowledge/`)
- `src/services/worker/http/routes/` — route handlers (Search, Session, Memory, Settings, Viewer, Logs, Corpus, Data)
- `src/supervisor/` — process registry, health checking, zombie prevention

**Database** (`src/services/sqlite/`) — SQLite3 at `~/.claude-mem/claude-mem.db`; schema changes go through `src/services/sqlite/migrations/`. **Chroma** (`src/services/sync/ChromaSync.ts`) mirrors records as vector embeddings (via uv-managed Python) for semantic search.

**Context injection** (`src/services/context/`) — `ContextBuilder` + formatters/sections compile stored observations into the context block injected at SessionStart.

**Viewer UI** (`src/ui/viewer/`) — React app served by the worker at http://localhost:37777, bundled into `plugin/ui/viewer.html` by `scripts/build-viewer.js` (invoked from the main build).

**Multi-platform integrations** (`src/services/integrations/`) — installers that wire claude-mem into other tools: Cursor (`cursor-hooks/`), Gemini CLI, Codex CLI, Windsurf, OpenClaw (`openclaw/`), OpenCode (`src/integrations/opencode-plugin/`). The build produces separate bundles for OpenClaw and OpenCode.

**Skills** (`plugin/skills/`) — `mem-search` (HTTP search API, auto-invoked for history questions), `make-plan`/`do` (plan orchestration), `smart-explore`, `knowledge-agent`, `timeline-report`, `version-bump`. Skills are source files shipped as-is, not build outputs.

**Modes** (`plugin/modes/*.json`) — per-language/persona prompt configurations for the compression agents.

**Build pipeline** (`scripts/build-hooks.js`) — esbuild bundles `worker-service.cjs`, `mcp-server.cjs`, and `context-generator.cjs` into `plugin/scripts/`, plus the npx CLI into `dist/`. A post-build step strips esbuild's hardcoded `__dirname` literals from CJS output (issue #1410) — don't rely on build-time `__dirname` in bundled code.

## Privacy Tags

- `<private>content</private>` — user-level privacy control, prevents storage.

Tag stripping happens at the hook layer (edge processing) before data reaches worker/database. See `src/utils/tag-stripping.ts`.

## Exit Code Strategy

Hooks follow Claude Code's hook contract:

- **Exit 0**: Success or graceful shutdown (Windows Terminal closes tabs)
- **Exit 1**: Non-blocking error (stderr shown to user, continues)
- **Exit 2**: Blocking error (stderr fed to Claude for processing)

**Philosophy**: Worker/hook errors exit with code 0 to prevent Windows Terminal tab accumulation. The wrapper/plugin layer handles restart logic. ERROR-level logging is maintained for diagnostics.

## File Locations

- **Source**: `src/` → **Built plugin**: `plugin/` → **Installed plugin**: `~/.claude/plugins/marketplaces/thedotmack/`
- **Settings**: `~/.claude-mem/settings.json` (auto-created with defaults on first run)
- **Database**: `~/.claude-mem/claude-mem.db`; **Chroma**: `~/.claude-mem/chroma/`; **Logs**: `~/.claude-mem/logs/`

## Requirements

- **Bun** (all platforms — auto-installed if missing; runs the worker and tests)
- **uv** (auto-installed if missing, provides Python for Chroma)
- Node.js >= 18

## Documentation

**Public docs**: https://docs.claude-mem.ai (Mintlify). Source in `docs/public/` (MDX; edit `docs.json` for navigation). Auto-deploys on push to main. Translated READMEs in `docs/i18n/` are generated via `npm run translate-readme` — don't hand-edit them.

## Pro Features Architecture

Clean separation between open-source core and optional Pro features:

- All worker API endpoints on localhost:37777 remain fully open and accessible
- Pro features are headless — no proprietary UI elements in this codebase; integration points are minimal (license-key settings, tunnel provisioning)
- Pro (external) extends rather than replaces core: an enhanced UI consumes the same localhost:37777 endpoints; access is gated by license validation, never by restricting core endpoints

## Important

Never edit the changelog — it's generated automatically.

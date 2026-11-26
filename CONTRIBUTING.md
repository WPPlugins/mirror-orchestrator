# Contributing to WPPlugins Mirror Orchestrator

Thank you for helping improve the WPPlugins mirror orchestrator!

## Prerequisites

- [Deno 2.x](https://deno.com/)
- `git`
- `svn` (Subversion CLI, required for `src/sync-plugin.ts`)

## Local Development

1. Clone the repository:
   ```bash
   git clone https://github.com/WPPlugins/mirror-orchestrator.git
   cd mirror-orchestrator
   ```
2. Run formatting, linting, type checks, and unit tests:
   ```bash
   deno fmt --check
   deno lint
   deno task check
   deno task test
   ```
3. Test safely in read-only `--dry-run` mode:
   ```bash
   deno task discover --dry-run
   deno task sync --slug akismet --dry-run
   ```

## Guidelines

- Keep dependencies zero-bloat: use Web APIs and `@std/*` modules only.
- Ensure every CLI script preserves `--dry-run` safety (no `state/` or GitHub
  write mutations).
- Add unit tests in `tests/` for any new parsing, filtering, or version-sorting
  logic.

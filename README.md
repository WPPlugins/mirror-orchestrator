# WPPlugins Mirror Orchestrator

Automated, serverless WordPress.org SVN-to-GitHub plugin mirror orchestrator targeting the `WPPlugins` GitHub organization. Built with **Deno (TypeScript, strict mode)** and designed to run entirely on **GitHub Actions** with zero external infrastructure.

## Architecture

1. **Discovery (`src/discover.ts`)**
   - Polls the global WordPress.org Trac revision stream (`plugins.trac.wordpress.org/log/?format=changelog`) since `state/cursor.json`'s `last_global_rev`.
   - Queries the WordPress.org Plugin Directory API (`browse=updated` and `browse=new`) so newly approved plugins are never missed.
   - Mixes in a bounded slice (`--backfill-limit`, default `25`) from `state/backfill-queue.json` to stay safely within GitHub's secondary rate limits.
2. **Per-Plugin Sync (`src/sync-plugin.ts`)**
   - Mints short-lived installation access tokens via `src/github-app.ts` using WebCrypto (`RS256` JWT signing).
   - Creates `WPPlugins/<slug>` if missing and syncs description, WordPress.org homepage, and the `wordpress-plugin` topic.
   - Compares `https://plugins.svn.wordpress.org/<slug>/tags/` against existing Git tags, exports missing tags in semver/chronological order, strips any files larger than `95 MB` (logged to `state/oversized.json`), commits with SVN revision/author metadata, and creates annotated Git tags.
   - Syncs `trunk/` onto `main` when newer changes exist and pushes `main` + `--tags`.
3. **Backfill (`src/backfill.ts`)**
   - Paginates the WordPress.org Plugin Directory API to populate `state/backfill-queue.json`.

## Local Usage

```bash
# Type-check all source files
deno task check

# Run unit tests
deno task test

# Dry-run discovery (read-only)
deno task discover --dry-run

# Dry-run single plugin sync (read-only)
deno task sync --slug akismet --dry-run
```

See [SETUP.md](./SETUP.md) for GitHub App creation and Actions configuration.

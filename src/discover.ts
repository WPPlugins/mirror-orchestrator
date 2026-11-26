import { parseArgs } from "@std/cli";
import {
  type CursorState,
  type DiscoverManifest,
  STATE_PATHS,
} from "./types.ts";
import {
  deduplicateSlugs,
  partitionIntoShards,
  readJsonFile,
} from "./utils.ts";
import { fetchTracUpdatesSince, queryWpPlugins } from "./wp-api.ts";

const DEFAULT_BACKFILL_LIMIT = 25;
const DEFAULT_MAX_SLUGS = 50; // Caps per-run fan-out to stay well under GitHub's 500/hr repo creation limit.
const DEFAULT_SHARDS = 6;

async function writeGithubOutputs(manifest: DiscoverManifest): Promise<void> {
  const outputPath = Deno.env.get("GITHUB_OUTPUT");
  if (!outputPath) return;

  const shards = partitionIntoShards(manifest.slugs, DEFAULT_SHARDS);
  const lines = [
    `slugs=${JSON.stringify(manifest.slugs)}`,
    `shards=${JSON.stringify(shards)}`,
    `has_slugs=${manifest.slugs.length > 0 ? "true" : "false"}`,
    `next_global_rev=${manifest.next_global_rev}`,
    `slug_count=${manifest.slugs.length}`,
  ];
  await Deno.writeTextFile(outputPath, `${lines.join("\n")}\n`, {
    append: true,
  });
}

async function main(): Promise<void> {
  const args = parseArgs(Deno.args, {
    boolean: ["dry-run"],
    string: ["backfill-limit", "max-slugs", "slugs"],
    default: {
      "dry-run": false,
      "backfill-limit": String(DEFAULT_BACKFILL_LIMIT),
      "max-slugs": String(DEFAULT_MAX_SLUGS),
    },
  });

  const dryRun = Boolean(args["dry-run"]);
  const backfillLimit = Math.max(
    0,
    Number.parseInt(String(args["backfill-limit"]), 10) ||
      DEFAULT_BACKFILL_LIMIT,
  );
  const parsedMaxSlugs = Number.parseInt(String(args["max-slugs"]), 10);
  const maxSlugs = Number.isNaN(parsedMaxSlugs)
    ? DEFAULT_MAX_SLUGS
    : Math.max(0, parsedMaxSlugs);

  const cursor = await readJsonFile<CursorState>(STATE_PATHS.cursor, {
    last_global_rev: 0,
    backfill_page: 1,
    last_run_at: null,
  });

  // Explicit slug override (e.g., from workflow_dispatch)
  if (args.slugs && String(args.slugs).trim().length > 0) {
    const manualSlugs = deduplicateSlugs([
      String(args.slugs)
        .split(",")
        .map((s) => s.trim()),
    ]);
    const manifest: DiscoverManifest = {
      slugs: manualSlugs,
      next_global_rev: cursor.last_global_rev,
      previous_global_rev: cursor.last_global_rev,
      sources: { trac: 0, wpApi: 0, backfill: 0 },
      generated_at: new Date().toISOString(),
      dry_run: dryRun,
    };
    await writeGithubOutputs(manifest);
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }

  console.error(
    `[discover] Reading Trac stream since r${cursor.last_global_rev} (dryRun=${dryRun})...`,
  );
  let tracResult = { latestRev: cursor.last_global_rev, slugs: [] as string[] };
  try {
    tracResult = await fetchTracUpdatesSince(cursor.last_global_rev);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[discover] WARNING: Trac stream unavailable (${msg}); falling back to WP.org Directory API + backfill queue.`,
    );
  }

  console.error(
    "[discover] Querying WP.org Plugin Directory (updated + new)...",
  );
  const [updatedRes, newRes] = await Promise.all([
    queryWpPlugins("updated", 1, 100),
    queryWpPlugins("new", 1, 100),
  ]);
  const wpApiSlugs = [
    ...updatedRes.plugins.map((p) => p.slug),
    ...newRes.plugins.map((p) => p.slug),
  ];

  const backfillQueue = await readJsonFile<string[]>(
    STATE_PATHS.backfillQueue,
    [],
  );
  const backfillSlice = backfillQueue.slice(0, backfillLimit);

  const combinedSlugs = deduplicateSlugs([
    tracResult.slugs,
    wpApiSlugs,
    backfillSlice,
  ]);
  const cappedSlugs = maxSlugs > 0
    ? combinedSlugs.slice(0, maxSlugs)
    : combinedSlugs;

  const manifest: DiscoverManifest = {
    slugs: cappedSlugs,
    next_global_rev: Math.max(cursor.last_global_rev, tracResult.latestRev),
    previous_global_rev: cursor.last_global_rev,
    sources: {
      trac: tracResult.slugs.length,
      wpApi: wpApiSlugs.length,
      backfill: backfillSlice.length,
    },
    generated_at: new Date().toISOString(),
    dry_run: dryRun,
  };

  await writeGithubOutputs(manifest);
  console.log(JSON.stringify(manifest, null, 2));
}

if (import.meta.main) {
  await main();
}

import { parseArgs } from "@std/cli";
import { STATE_PATHS, type CursorState } from "./types.ts";
import { deduplicateSlugs, readJsonFile, writeJsonFile } from "./utils.ts";
import { queryWpPlugins } from "./wp-api.ts";

async function main(): Promise<void> {
  const args = parseArgs(Deno.args, {
    boolean: ["dry-run", "reset"],
    string: ["pages", "consume"],
    default: {
      "dry-run": false,
      reset: false,
      pages: "3",
      consume: "0",
    },
  });

  const dryRun = Boolean(args["dry-run"]);
  const reset = Boolean(args.reset);
  const pagesToFetch = Math.max(1, Number.parseInt(String(args.pages), 10) || 3);
  const consumeCount = Math.max(0, Number.parseInt(String(args.consume), 10) || 0);

  const cursor = await readJsonFile<CursorState>(STATE_PATHS.cursor, {
    last_global_rev: 0,
    backfill_page: 1,
    last_run_at: null,
  });

  let queue = reset
    ? []
    : await readJsonFile<string[]>(STATE_PATHS.backfillQueue, []);

  // Optionally pop already-processed slugs from the front of the queue
  if (consumeCount > 0 && queue.length > 0) {
    queue = queue.slice(consumeCount);
  }

  let currentPage = reset ? 1 : Math.max(1, cursor.backfill_page);
  const fetchedSlugs: string[] = [];

  for (let i = 0; i < pagesToFetch; i++) {
    console.error(`[backfill] Fetching WP.org popular plugins page ${currentPage}...`);
    const res = await queryWpPlugins("popular", currentPage, 100);
    for (const plugin of res.plugins) {
      fetchedSlugs.push(plugin.slug);
    }
    currentPage = currentPage >= res.totalPages ? 1 : currentPage + 1;
  }

  const updatedQueue = deduplicateSlugs([queue, fetchedSlugs], {
    preserveOrder: true,
  });

  if (dryRun) {
    console.log(
      JSON.stringify(
        {
          dry_run: true,
          next_backfill_page: currentPage,
          added_candidates: fetchedSlugs.length,
          total_queue_length: updatedQueue.length,
          preview: updatedQueue.slice(0, 10),
        },
        null,
        2,
      ),
    );
    return;
  }

  await writeJsonFile(STATE_PATHS.backfillQueue, updatedQueue);
  cursor.backfill_page = currentPage;
  await writeJsonFile(STATE_PATHS.cursor, cursor);

  console.log(
    `[backfill] Queue updated: ${updatedQueue.length} slugs (next page: ${currentPage}).`,
  );
}

if (import.meta.main) {
  await main();
}

import { parseArgs } from "@std/cli";
import { syncPlugin } from "./sync-plugin.ts";

async function main(): Promise<void> {
  const args = parseArgs(Deno.args, {
    boolean: ["dry-run"],
    string: ["slugs-json", "max-tags"],
    default: {
      "dry-run": false,
      "max-tags": "25",
    },
  });

  const dryRun = Boolean(args["dry-run"]);
  const parsedMaxTags = Number.parseInt(String(args["max-tags"]), 10);
  const maxTags = Number.isNaN(parsedMaxTags) ? 25 : Math.max(0, parsedMaxTags);

  const rawJson = String(
    args["slugs-json"] ?? Deno.env.get("SHARD_SLUGS") ?? "[]",
  );
  const slugs = JSON.parse(rawJson) as string[];

  if (!Array.isArray(slugs) || slugs.length === 0) {
    console.log("[shard] No slugs assigned to this shard.");
    return;
  }

  console.log(
    `[shard] Processing ${slugs.length} plugin(s) (maxTags=${maxTags}, dryRun=${dryRun})...`,
  );

  const failures: Array<{ slug: string; error: string }> = [];

  for (const slug of slugs) {
    try {
      await syncPlugin(slug, dryRun, maxTags);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[shard] FAILED ${slug}: ${message}`);
      failures.push({ slug, error: message });
    }
  }

  console.log(
    `[shard] Completed: ${
      slugs.length - failures.length
    }/${slugs.length} succeeded.`,
  );

  if (failures.length > 0) {
    console.error(
      `[shard] Failed slugs: ${failures.map((f) => f.slug).join(", ")}`,
    );
    Deno.exit(1);
  }
}

if (import.meta.main) {
  await main();
}

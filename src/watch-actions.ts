import { parseArgs } from "@std/cli";
import { runCmd } from "./utils.ts";

interface WorkflowRunSummary {
  databaseId: number;
  status: string;
  conclusion: string | null;
  createdAt: string;
  url: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function checkAndTrigger(options: {
  repo: string;
  workflow: string;
  maxAgeMinutes: number;
  dryRun: boolean;
}): Promise<void> {
  const nowStr = new Date().toLocaleTimeString();
  const res = await runCmd("gh", [
    "run",
    "list",
    "-R",
    options.repo,
    "--workflow",
    options.workflow,
    "--limit",
    "5",
    "--json",
    "databaseId,status,conclusion,createdAt,url",
  ]);

  const runs = JSON.parse(res.stdout) as WorkflowRunSummary[];
  const active = runs.find((r) =>
    ["queued", "in_progress", "waiting", "pending"].includes(r.status)
  );

  if (active) {
    console.log(
      `[${nowStr}] Run #${active.databaseId} is ${active.status}; skipping.`,
    );
    return;
  }

  const latest = runs[0];
  if (latest) {
    const ageMs = Date.now() - Date.parse(latest.createdAt);
    const ageMin = Math.round(ageMs / 60_000);
    if (ageMs < options.maxAgeMinutes * 60_000) {
      console.log(
        `[${nowStr}] Latest run #${latest.databaseId} (${
          latest.conclusion ?? latest.status
        }) was ${ageMin}m ago (< ${options.maxAgeMinutes}m); skipping.`,
      );
      return;
    }
    console.log(
      `[${nowStr}] Latest run #${latest.databaseId} was ${ageMin}m ago (>= ${options.maxAgeMinutes}m).`,
    );
  } else {
    console.log(`[${nowStr}] No previous runs found for ${options.workflow}.`);
  }

  if (options.dryRun) {
    console.log(
      `[${nowStr}] [dry-run] Would trigger ${options.workflow} on ${options.repo}.`,
    );
    return;
  }

  await runCmd("gh", [
    "workflow",
    "run",
    options.workflow,
    "-R",
    options.repo,
  ]);
  console.log(
    `[${nowStr}] Triggered ${options.workflow} on ${options.repo}.`,
  );
}

async function main(): Promise<void> {
  const args = parseArgs(Deno.args, {
    boolean: ["dry-run", "once"],
    string: ["interval", "max-age", "repo", "workflow"],
    default: {
      "dry-run": false,
      once: false,
      interval: "5",
      "max-age": "20",
      repo: "WPPlugins/mirror-orchestrator",
      workflow: "mirror.yml",
    },
  });

  const intervalMinutes = Math.max(
    1,
    Number.parseInt(String(args.interval), 10) || 5,
  );
  const maxAgeMinutes = Math.max(
    1,
    Number.parseInt(String(args["max-age"]), 10) || 20,
  );
  const repo = String(args.repo);
  const workflow = String(args.workflow);
  const dryRun = Boolean(args["dry-run"]);
  const once = Boolean(args.once);

  console.log(
    `Watching ${repo} (${workflow}) every ${intervalMinutes}m (trigger if no run in ${maxAgeMinutes}m, dryRun=${dryRun})...`,
  );

  while (true) {
    try {
      await checkAndTrigger({ repo, workflow, maxAgeMinutes, dryRun });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${new Date().toLocaleTimeString()}] Error: ${msg}`);
    }

    if (once) break;
    await sleep(intervalMinutes * 60_000);
  }
}

if (import.meta.main) {
  await main();
}

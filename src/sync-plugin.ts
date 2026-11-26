import { parseArgs } from "@std/cli";
import { copy, ensureDir } from "@std/fs";
import { join } from "@std/path";
import { GitHubAppClient } from "./github-app.ts";
import { type ErrorsState, type OversizedState, STATE_PATHS } from "./types.ts";
import {
  diffMissingTags,
  filterOversizedFiles,
  readJsonFile,
  runCmd,
  writeJsonFile,
} from "./utils.ts";
import { fetchPluginInfo, formatRepoDescription } from "./wp-api.ts";

const SVN_BASE = "https://plugins.svn.wordpress.org";
const DEFAULT_MAX_TAGS = 25; // Caps tags exported per run for large histories; pass --max-tags 0 for unlimited.

interface SvnMetadata {
  revision: string;
  author: string;
  date: string;
}

async function getSvnMetadata(svnUrl: string): Promise<SvnMetadata> {
  const res = await runCmd("svn", ["info", "--xml", svnUrl], {
    allowFailure: true,
  });

  const revMatch = /<commit\s+revision="(\d+)">/.exec(res.stdout);
  const authorMatch = /<author>([^<]+)<\/author>/.exec(res.stdout);
  const dateMatch = /<date>([^<]+)<\/date>/.exec(res.stdout);

  return {
    revision: revMatch?.[1] ?? "0",
    author: authorMatch?.[1]?.trim() || "wordpressdotorg",
    date: dateMatch?.[1]?.trim() || new Date().toISOString(),
  };
}

async function listSvnTags(slug: string): Promise<string[]> {
  const res = await runCmd("svn", ["ls", `${SVN_BASE}/${slug}/tags/`], {
    allowFailure: true,
  });
  if (res.code !== 0) {
    return [];
  }
  return res.stdout
    .split(/\r?\n/)
    .map((line) => line.replace(/\/+$/, "").trim())
    .filter((line) => line.length > 0);
}

async function svnPathExists(svnUrl: string): Promise<boolean> {
  const res = await runCmd("svn", ["info", svnUrl], { allowFailure: true });
  return res.code === 0;
}

/** Clear all files/directories inside `repoDir` except `.git`. */
async function cleanWorkingTree(repoDir: string): Promise<void> {
  for await (const entry of Deno.readDir(repoDir)) {
    if (entry.name === ".git") continue;
    await Deno.remove(join(repoDir, entry.name), { recursive: true });
  }
}

/** Export an SVN URL into a staging dir and mirror it cleanly into `repoDir`. */
async function exportSvnToRepo(
  svnUrl: string,
  repoDir: string,
  stagingDir: string,
  label: string,
): Promise<{
  oversized: Awaited<ReturnType<typeof filterOversizedFiles>>;
  meta: SvnMetadata;
}> {
  await Deno.remove(stagingDir, { recursive: true }).catch(() => {});
  await ensureDir(stagingDir);

  await runCmd("svn", ["export", "--force", "--quiet", svnUrl, stagingDir]);
  const oversized = await filterOversizedFiles(stagingDir, label);

  await cleanWorkingTree(repoDir);
  for await (const entry of Deno.readDir(stagingDir)) {
    await copy(join(stagingDir, entry.name), join(repoDir, entry.name), {
      overwrite: true,
    });
  }

  const meta = await getSvnMetadata(svnUrl);
  return { oversized, meta };
}

async function hasWorkingTreeChanges(repoDir: string): Promise<boolean> {
  const status = await runCmd("git", ["status", "--porcelain"], {
    cwd: repoDir,
  });
  return status.stdout.trim().length > 0;
}

async function recordOversized(
  slug: string,
  records: Awaited<ReturnType<typeof filterOversizedFiles>>,
): Promise<void> {
  if (records.length === 0) return;
  const state = await readJsonFile<OversizedState>(STATE_PATHS.oversized, {});
  const existing = state[slug] ?? [];
  const seen = new Set(existing.map((r) => `${r.tagOrBranch}:${r.path}`));
  for (const rec of records) {
    const key = `${rec.tagOrBranch}:${rec.path}`;
    if (!seen.has(key)) {
      existing.push(rec);
      seen.add(key);
    }
  }
  state[slug] = existing;
  await writeJsonFile(STATE_PATHS.oversized, state);
}

async function recordError(
  slug: string,
  err: unknown,
  context: string,
): Promise<void> {
  const state = await readJsonFile<ErrorsState>(STATE_PATHS.errors, {});
  state[slug] = {
    message: err instanceof Error ? err.message : String(err),
    timestamp: new Date().toISOString(),
    context,
  };
  await writeJsonFile(STATE_PATHS.errors, state);
}

async function clearError(slug: string): Promise<void> {
  const state = await readJsonFile<ErrorsState>(STATE_PATHS.errors, {});
  if (slug in state) {
    delete state[slug];
    await writeJsonFile(STATE_PATHS.errors, state);
  }
}

export async function syncPlugin(
  slug: string,
  dryRun: boolean,
  maxTags = DEFAULT_MAX_TAGS,
): Promise<void> {
  const normalizedSlug = slug.trim().toLowerCase();
  if (!normalizedSlug) {
    throw new Error("Missing required --slug argument.");
  }

  const targetOrg = Deno.env.get("TARGET_ORG")?.trim() || "WPPlugins";
  const pluginInfo = await fetchPluginInfo(normalizedSlug);
  const description = formatRepoDescription(pluginInfo, normalizedSlug);
  const homepage = `https://wordpress.org/plugins/${normalizedSlug}/`;

  console.log(
    `[sync] Starting ${normalizedSlug} -> ${targetOrg}/${normalizedSlug} (dryRun=${dryRun})`,
  );

  let ghToken = "";
  let repoCreated = false;

  if (!dryRun) {
    const gh = GitHubAppClient.fromEnv(false);
    if (!gh) {
      throw new Error(
        "APP_ID and APP_PRIVATE_KEY environment variables are required unless --dry-run is set.",
      );
    }
    const ensured = await gh.ensureRepo(normalizedSlug, {
      description,
      homepage,
    });
    repoCreated = ensured.created;
    ghToken = await gh.getInstallationToken();
  }

  const workRoot = await Deno.makeTempDir({
    prefix: `wp-sync-${normalizedSlug}-`,
  });
  const repoDir = join(workRoot, "repo");
  const stagingDir = join(workRoot, "svn-export");

  try {
    const publicRemote =
      `https://github.com/${targetOrg}/${normalizedSlug}.git`;
    const authRemote = ghToken
      ? `https://x-access-token:${ghToken}@github.com/${targetOrg}/${normalizedSlug}.git`
      : publicRemote;

    let initializedFresh = false;
    if (!repoCreated) {
      const cloneRes = await runCmd(
        "git",
        ["clone", "--no-single-branch", authRemote, repoDir],
        { allowFailure: true },
      );
      if (cloneRes.code !== 0) {
        if (!dryRun) {
          throw new Error(
            `Failed to clone ${publicRemote}: ${cloneRes.stderr}`,
          );
        }
        initializedFresh = true;
      }
    } else {
      initializedFresh = true;
    }

    if (initializedFresh) {
      await ensureDir(repoDir);
      await runCmd("git", ["init", "-b", "main"], { cwd: repoDir });
    }

    await runCmd("git", ["config", "user.name", "WPPlugins Bot"], {
      cwd: repoDir,
    });
    await runCmd(
      "git",
      ["config", "user.email", "bot@wpplugins.github.io"],
      { cwd: repoDir },
    );

    // Ensure we're on main if it exists, or create orphan/main
    const hasHead = (
      await runCmd("git", ["rev-parse", "--verify", "HEAD"], {
        cwd: repoDir,
        allowFailure: true,
      })
    ).code === 0;

    if (hasHead) {
      await runCmd("git", ["checkout", "-B", "main"], { cwd: repoDir });
    }

    const gitTagsRes = await runCmd("git", ["tag", "-l"], { cwd: repoDir });
    const existingGitTags = gitTagsRes.stdout
      .split(/\r?\n/)
      .map((t) => t.trim())
      .filter(Boolean);

    const svnTags = await listSvnTags(normalizedSlug);
    const allMissingTags = diffMissingTags(svnTags, existingGitTags);
    const missingTags = maxTags > 0
      ? allMissingTags.slice(0, maxTags)
      : allMissingTags;

    console.log(
      `[sync] ${normalizedSlug}: ${svnTags.length} SVN tags, ${allMissingTags.length} missing (processing ${missingTags.length})`,
    );

    const allOversized: Awaited<ReturnType<typeof filterOversizedFiles>> = [];
    let pushedSomething = false;

    for (const tag of missingTags) {
      const tagUrl = `${SVN_BASE}/${normalizedSlug}/tags/${tag}`;
      console.log(`[sync] Exporting tag ${tag}...`);
      const { oversized, meta } = await exportSvnToRepo(
        tagUrl,
        repoDir,
        stagingDir,
        `tags/${tag}`,
      );
      allOversized.push(...oversized);

      await runCmd("git", ["add", "-A"], { cwd: repoDir });
      if (await hasWorkingTreeChanges(repoDir)) {
        const msg = `Release ${tag} (SVN r${meta.revision} by ${meta.author})`;
        await runCmd(
          "git",
          ["commit", "-m", msg, "--date", meta.date],
          { cwd: repoDir },
        );
        pushedSomething = true;
      }

      const tagCheck = await runCmd("git", ["rev-parse", "--verify", "HEAD"], {
        cwd: repoDir,
        allowFailure: true,
      });
      if (tagCheck.code === 0) {
        await runCmd(
          "git",
          [
            "tag",
            "-a",
            tag,
            "-m",
            `WordPress.org tag ${tag} (SVN r${meta.revision})`,
          ],
          { cwd: repoDir },
        );
        pushedSomething = true;
      }
    }

    // Sync trunk onto main
    const trunkUrl = `${SVN_BASE}/${normalizedSlug}/trunk`;
    if (await svnPathExists(trunkUrl)) {
      console.log(`[sync] Checking trunk for ${normalizedSlug}...`);
      const { oversized, meta } = await exportSvnToRepo(
        trunkUrl,
        repoDir,
        stagingDir,
        "trunk",
      );
      allOversized.push(...oversized);

      await runCmd("git", ["add", "-A"], { cwd: repoDir });
      if (await hasWorkingTreeChanges(repoDir)) {
        const msg = `Sync trunk (SVN r${meta.revision} by ${meta.author})`;
        await runCmd(
          "git",
          ["commit", "-m", msg, "--date", meta.date],
          { cwd: repoDir },
        );
        pushedSomething = true;
      } else {
        console.log(`[sync] ${normalizedSlug}: trunk already up to date.`);
      }
    } else {
      console.warn(
        `[sync] ${normalizedSlug}: no trunk directory found in SVN.`,
      );
    }

    if (allOversized.length > 0) {
      console.warn(
        `[sync] ${normalizedSlug}: skipped ${allOversized.length} file(s) > 95 MB.`,
      );
      if (!dryRun) {
        await recordOversized(normalizedSlug, allOversized);
      }
    }

    if (dryRun) {
      console.log(
        `[sync] Dry-run complete for ${normalizedSlug}. Skipping GitHub push and state mutation.`,
      );
      return;
    }

    if (pushedSomething) {
      console.log(`[sync] Pushing main and tags for ${normalizedSlug}...`);
      await runCmd("git", ["push", authRemote, "main", "--tags"], {
        cwd: repoDir,
      });
    }

    await clearError(normalizedSlug);
    console.log(`[sync] Finished ${normalizedSlug}.`);
  } catch (err) {
    if (!dryRun) {
      await recordError(normalizedSlug, err, "sync-plugin");
    }
    throw err;
  } finally {
    await Deno.remove(workRoot, { recursive: true }).catch(() => {});
  }
}

async function main(): Promise<void> {
  const args = parseArgs(Deno.args, {
    boolean: ["dry-run"],
    string: ["slug", "max-tags"],
    default: {
      "dry-run": false,
      "max-tags": String(DEFAULT_MAX_TAGS),
    },
  });

  if (!args.slug) {
    console.error(
      "Usage: deno task sync --slug <plugin-slug> [--max-tags <n>] [--dry-run]",
    );
    Deno.exit(1);
  }

  const parsedMaxTags = Number.parseInt(String(args["max-tags"]), 10);
  const maxTags = Number.isNaN(parsedMaxTags)
    ? DEFAULT_MAX_TAGS
    : Math.max(0, parsedMaxTags);
  await syncPlugin(String(args.slug), Boolean(args["dry-run"]), maxTags);
}

if (import.meta.main) {
  await main();
}

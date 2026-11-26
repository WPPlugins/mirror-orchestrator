import { ensureDir, walk } from "@std/fs";
import { dirname, relative } from "@std/path";
import type { OversizedFileRecord } from "./types.ts";

/** GitHub rejects individual blobs >= 100 MB; cap at 95 MB for safety. */
export const MAX_GITHUB_FILE_BYTES = 95 * 1024 * 1024;

const SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

/** Validate and deduplicate plugin slugs deterministically. */
export function deduplicateSlugs(
  sources: ReadonlyArray<ReadonlyArray<string>>,
  options: { preserveOrder?: boolean } = {},
): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];

  for (const list of sources) {
    for (const raw of list) {
      const slug = raw.trim().toLowerCase();
      if (!slug || !SLUG_PATTERN.test(slug) || seen.has(slug)) {
        continue;
      }
      seen.add(slug);
      ordered.push(slug);
    }
  }

  return options.preserveOrder ? ordered : ordered.sort();
}

/** Parse a version-like tag string into core segments and optional prerelease segments. */
function parseVersionParts(tag: string): {
  core: Array<number | string>;
  pre: Array<number | string>;
} {
  const cleaned = tag.replace(/^v/i, "").trim().split("+")[0];
  const dashIdx = cleaned.indexOf("-");
  const coreStr = dashIdx === -1 ? cleaned : cleaned.slice(0, dashIdx);
  const preStr = dashIdx === -1 ? "" : cleaned.slice(dashIdx + 1);

  const tokenize = (s: string): Array<number | string> =>
    s
      .split(/[.\-_]+/)
      .filter((part) => part.length > 0)
      .map((part) =>
        /^\d+$/.test(part) ? Number.parseInt(part, 10) : part.toLowerCase()
      );

  return {
    core: tokenize(coreStr),
    pre: preStr ? tokenize(preStr) : [],
  };
}

function compareSegments(
  segA: Array<number | string>,
  segB: Array<number | string>,
): number {
  const maxLen = Math.max(segA.length, segB.length);
  for (let i = 0; i < maxLen; i++) {
    const partA = segA[i];
    const partB = segB[i];

    if (partA === undefined) return -1;
    if (partB === undefined) return 1;

    if (typeof partA === "number" && typeof partB === "number") {
      if (partA !== partB) return partA - partB;
      continue;
    }

    if (typeof partA === "number") return -1;
    if (typeof partB === "number") return 1;

    if (partA !== partB) return partA < partB ? -1 : 1;
  }
  return 0;
}

/** Compare two version tags in ascending semver/natural order. */
export function compareVersionTags(a: string, b: string): number {
  const parsedA = parseVersionParts(a);
  const parsedB = parseVersionParts(b);

  const coreCmp = compareSegments(parsedA.core, parsedB.core);
  if (coreCmp !== 0) return coreCmp;

  // A version without prerelease is greater than one with a prerelease.
  if (parsedA.pre.length === 0 && parsedB.pre.length > 0) return 1;
  if (parsedA.pre.length > 0 && parsedB.pre.length === 0) return -1;
  if (parsedA.pre.length > 0 && parsedB.pre.length > 0) {
    const preCmp = compareSegments(parsedA.pre, parsedB.pre);
    if (preCmp !== 0) return preCmp;
  }

  return a.localeCompare(b);
}

/** Return SVN tags missing from existing Git tags, sorted oldest-to-newest. */
export function diffMissingTags(
  svnTags: ReadonlyArray<string>,
  gitTags: ReadonlyArray<string>,
): string[] {
  const existing = new Set(gitTags.map((t) => t.trim()));
  const missing = svnTags
    .map((t) => t.replace(/\/+$/, "").trim())
    .filter((t) => t.length > 0 && !existing.has(t));

  return Array.from(new Set(missing)).sort(compareVersionTags);
}

/**
 * Scan a directory for files exceeding `maxBytes` (default 95 MB), remove them
 * so GitHub pushes never fail, and return records of the skipped files.
 */
export async function filterOversizedFiles(
  rootDir: string,
  tagOrBranch: string,
  maxBytes = MAX_GITHUB_FILE_BYTES,
): Promise<OversizedFileRecord[]> {
  const removed: OversizedFileRecord[] = [];
  const now = new Date().toISOString();

  for await (
    const entry of walk(rootDir, {
      includeDirs: false,
      followSymlinks: false,
      skip: [/^\.git([\\/]|$)/, /[\\/]\.git([\\/]|$)/],
    })
  ) {
    const stat = await Deno.stat(entry.path);
    if (stat.size > maxBytes) {
      const relPath = relative(rootDir, entry.path).replace(/\\/g, "/");
      await Deno.remove(entry.path);
      removed.push({
        path: relPath,
        sizeBytes: stat.size,
        tagOrBranch,
        recordedAt: now,
      });
    }
  }

  return removed;
}

export async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  try {
    const text = await Deno.readTextFile(path);
    return JSON.parse(text) as T;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      return fallback;
    }
    throw err;
  }
}

export async function writeJsonFile(
  path: string,
  data: unknown,
): Promise<void> {
  await ensureDir(dirname(path));
  await Deno.writeTextFile(path, `${JSON.stringify(data, null, 2)}\n`);
}

export interface CmdResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function runCmd(
  cmd: string,
  args: string[],
  options: {
    cwd?: string;
    env?: Record<string, string>;
    allowFailure?: boolean;
  } = {},
): Promise<CmdResult> {
  const command = new Deno.Command(cmd, {
    args,
    cwd: options.cwd,
    env: options.env,
    stdout: "piped",
    stderr: "piped",
  });

  const output = await command.output();
  const stdout = new TextDecoder().decode(output.stdout);
  const stderr = new TextDecoder().decode(output.stderr);

  if (output.code !== 0 && !options.allowFailure) {
    throw new Error(
      `Command failed (${output.code}): ${cmd} ${args.join(" ")}\n${
        stderr.trim() || stdout.trim()
      }`,
    );
  }

  return { code: output.code, stdout, stderr };
}

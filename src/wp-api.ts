import type { WpPluginInfo } from "./types.ts";

const TRAC_LOG_BASE = "https://plugins.trac.wordpress.org/log/";
const WP_API_BASE = "https://api.wordpress.org/plugins/info/1.2/";
const USER_AGENT = "WPPlugins-Mirror-Orchestrator/1.0";

export interface TracLogResult {
  latestRev: number;
  oldestRev: number;
  slugs: string[];
}

const SLUG_REGEX = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * Parse a WordPress.org Trac `?format=changelog` response.
 * Extracts all touched plugin slugs and the min/max revision numbers seen.
 */
export function parseTracChangelog(
  changelogText: string,
  minExclusiveRev = 0,
): TracLogResult {
  let latestRev = 0;
  let oldestRev = Number.MAX_SAFE_INTEGER;
  const slugSet = new Set<string>();

  // Trac changelog lines look like:
  //   * [3184920] my-plugin/trunk/readme.txt: Update tested up to
  // or:
  //   * [3184920] my-plugin/tags/1.2.0/: Tagging 1.2.0
  const lineRegex = /^\s*\*\s+\[(\d+)\]\s+([^\s:]+)(?::|$)/;

  for (const rawLine of changelogText.split(/\r?\n/)) {
    const match = lineRegex.exec(rawLine);
    if (!match) continue;

    const rev = Number.parseInt(match[1], 10);
    if (Number.isNaN(rev)) continue;

    if (rev > latestRev) latestRev = rev;
    if (rev < oldestRev) oldestRev = rev;

    if (rev <= minExclusiveRev) {
      continue;
    }

    const changedPath = match[2].replace(/^\/+/, "");
    const firstSegment = changedPath.split("/")[0]?.trim();
    if (
      firstSegment &&
      SLUG_REGEX.test(firstSegment) &&
      firstSegment !== "assets" &&
      firstSegment !== "trunk" &&
      firstSegment !== "tags" &&
      firstSegment !== "branches"
    ) {
      slugSet.add(firstSegment);
    }
  }

  return {
    latestRev,
    oldestRev: oldestRev === Number.MAX_SAFE_INTEGER ? 0 : oldestRev,
    slugs: Array.from(slugSet).sort(),
  };
}

async function fetchTextWithRetry(url: string, retries = 3): Promise<string> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const resp = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
    });
    if (resp.ok) {
      return await resp.text();
    }
    if (attempt === retries || (resp.status < 500 && resp.status !== 429)) {
      throw new Error(`HTTP ${resp.status} fetching ${url}`);
    }
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
  throw new Error(`Exhausted retries for ${url}`);
}

/**
 * Fetch the global Trac revision stream starting from HEAD down to `sinceRev`
 * (exclusive), paginating in chunks of 250 revisions.
 */
export async function fetchTracUpdatesSince(
  sinceRev: number,
  options: { maxPages?: number; limit?: number } = {},
): Promise<{ latestRev: number; slugs: string[] }> {
  const limit = options.limit ?? 250;
  const maxPages = options.maxPages ?? (sinceRev > 0 ? 15 : 1);

  let latestRev = sinceRev;
  let currentRevParam = "HEAD";
  const allSlugs = new Set<string>();

  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({
      format: "changelog",
      limit: String(limit),
    });
    if (currentRevParam === "HEAD") {
      params.set("stop_rev", sinceRev > 0 ? String(sinceRev) : "HEAD");
    } else {
      params.set("rev", currentRevParam);
      if (sinceRev > 0) {
        params.set("stop_rev", String(sinceRev));
      }
    }

    const url = `${TRAC_LOG_BASE}?${params.toString()}`;
    const text = await fetchTextWithRetry(url);
    const parsed = parseTracChangelog(text, sinceRev);

    if (parsed.latestRev > latestRev) {
      latestRev = parsed.latestRev;
    }
    for (const slug of parsed.slugs) {
      allSlugs.add(slug);
    }

    if (
      parsed.oldestRev === 0 ||
      sinceRev <= 0 ||
      parsed.oldestRev <= sinceRev + 1
    ) {
      break;
    }

    const nextRev = parsed.oldestRev - 1;
    if (String(nextRev) === currentRevParam) {
      break;
    }
    currentRevParam = String(nextRev);
  }

  return {
    latestRev,
    slugs: Array.from(allSlugs).sort(),
  };
}

interface WpQueryResponse {
  info?: {
    page: number;
    pages: number;
    results: number;
  };
  plugins?: Array<{
    slug: string;
    name?: string;
    version?: string;
    short_description?: string;
    homepage?: string;
    last_updated?: string;
  }>;
}

/**
 * Query the WordPress.org Plugin Directory API (`query_plugins`).
 */
export async function queryWpPlugins(
  browse: "updated" | "new" | "popular",
  page = 1,
  perPage = 100,
): Promise<{ plugins: WpPluginInfo[]; totalPages: number }> {
  const params = new URLSearchParams({
    action: "query_plugins",
    "request[browse]": browse,
    "request[page]": String(page),
    "request[per_page]": String(perPage),
    "request[fields][short_description]": "1",
    "request[fields][sections]": "0",
    "request[fields][description]": "0",
    "request[fields][versions]": "0",
    "request[fields][screenshots]": "0",
    "request[fields][banners]": "0",
    "request[fields][icons]": "0",
  });

  const url = `${WP_API_BASE}?${params.toString()}`;
  const raw = await fetchTextWithRetry(url);
  const data = JSON.parse(raw) as WpQueryResponse;

  const plugins: WpPluginInfo[] = (data.plugins ?? [])
    .filter((p) => Boolean(p.slug))
    .map((p) => ({
      slug: p.slug,
      name: p.name ?? p.slug,
      version: p.version ?? "",
      short_description: p.short_description,
      homepage: p.homepage,
      last_updated: p.last_updated,
    }));

  return {
    plugins,
    totalPages: data.info?.pages ?? 1,
  };
}

/**
 * Fetch metadata for a single plugin from the WordPress.org Plugin Directory API.
 */
export async function fetchPluginInfo(
  slug: string,
): Promise<WpPluginInfo | null> {
  const params = new URLSearchParams({
    action: "plugin_information",
    "request[slug]": slug,
    "request[fields][short_description]": "1",
    "request[fields][sections]": "0",
    "request[fields][versions]": "0",
  });

  const url = `${WP_API_BASE}?${params.toString()}`;
  const resp = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
  });

  if (resp.status === 404) return null;
  if (!resp.ok) {
    throw new Error(`WP.org API error (${resp.status}) for ${slug}`);
  }

  const data = (await resp.json()) as {
    error?: string;
    slug?: string;
    name?: string;
    version?: string;
    short_description?: string;
    homepage?: string;
    last_updated?: string;
  };

  if (data.error || !data.slug) {
    return null;
  }

  return {
    slug: data.slug,
    name: data.name ?? slug,
    version: data.version ?? "",
    short_description: data.short_description,
    homepage: data.homepage,
    last_updated: data.last_updated,
  };
}

/** Sanitize a WordPress plugin description for GitHub's 350-char limit. */
export function formatRepoDescription(
  info: WpPluginInfo | null,
  slug: string,
): string {
  const raw = info?.short_description || info?.name ||
    `WordPress.org plugin mirror for ${slug}`;
  const clean = raw
    .replace(/<[^>]*>/g, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (clean.length <= 350) return clean;
  return `${clean.slice(0, 347)}...`;
}

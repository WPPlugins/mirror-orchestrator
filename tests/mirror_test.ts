import { assertEquals, assertGreater } from "@std/assert";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import {
  deduplicateSlugs,
  diffMissingTags,
  filterOversizedFiles,
} from "../src/utils.ts";
import { parseTracChangelog } from "../src/wp-api.ts";

Deno.test("parseTracChangelog extracts slugs and revision bounds", () => {
  const sample = `
2026-11-26  author1

\t* [3200105] akismet/trunk/akismet.php: Fix edge case
\t* [3200104] woocommerce/tags/9.4.1/readme.txt: Tag 9.4.1
\t* [3200103] akismet/trunk/readme.txt: Bump tested up to
\t* [3200100] old-plugin/trunk/index.php: Should be ignored below minExclusiveRev
`;

  const parsed = parseTracChangelog(sample, 3200100);
  assertEquals(parsed.latestRev, 3200105);
  assertEquals(parsed.oldestRev, 3200100);
  assertEquals(parsed.slugs, ["akismet", "woocommerce"]);
});

Deno.test("deduplicateSlugs normalizes, validates, and deduplicates", () => {
  const result = deduplicateSlugs([
    ["akismet", "Akismet", "invalid slug!", ""],
    ["woocommerce", "jetpack", "akismet"],
  ]);
  assertEquals(result, ["akismet", "jetpack", "woocommerce"]);
});

Deno.test("diffMissingTags filters existing tags and sorts semver ascending", () => {
  const svnTags = ["1.10.0/", "1.2.0/", "1.0.0", "2.0.0-beta.1", "2.0.0"];
  const gitTags = ["1.0.0"];
  const missing = diffMissingTags(svnTags, gitTags);
  assertEquals(missing, ["1.2.0", "1.10.0", "2.0.0-beta.1", "2.0.0"]);
});

Deno.test("filterOversizedFiles removes files exceeding threshold and keeps smaller files", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "wp-filter-test-" });
  try {
    const subDir = join(tempDir, "assets");
    await ensureDir(subDir);

    const smallFile = join(tempDir, "readme.txt");
    const largeFile = join(subDir, "bundle.bin");

    await Deno.writeFile(smallFile, new Uint8Array(128));
    await Deno.writeFile(largeFile, new Uint8Array(2048));

    const removed = await filterOversizedFiles(tempDir, "tags/1.0.0", 1024);
    assertEquals(removed.length, 1);
    assertEquals(removed[0].path, "assets/bundle.bin");
    assertGreater(removed[0].sizeBytes, 1024);

    // Small file must remain; large file must be deleted
    const smallStat = await Deno.stat(smallFile);
    assertEquals(smallStat.size, 128);

    let largeExists = true;
    try {
      await Deno.stat(largeFile);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) {
        largeExists = false;
      } else {
        throw err;
      }
    }
    assertEquals(largeExists, false);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

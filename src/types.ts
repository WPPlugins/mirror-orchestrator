/** Shared state and manifest types for the WPPlugins mirror orchestrator. */

export interface CursorState {
  last_global_rev: number;
  backfill_page: number;
  last_run_at: string | null;
}

export interface OversizedFileRecord {
  path: string;
  sizeBytes: number;
  tagOrBranch: string;
  recordedAt: string;
}

export type OversizedState = Record<string, OversizedFileRecord[]>;

export interface ErrorRecord {
  message: string;
  timestamp: string;
  context?: string;
}

export type ErrorsState = Record<string, ErrorRecord>;

export interface DiscoverManifest {
  slugs: string[];
  next_global_rev: number;
  previous_global_rev: number;
  sources: {
    trac: number;
    wpApi: number;
    backfill: number;
  };
  generated_at: string;
  dry_run: boolean;
}

export interface WpPluginInfo {
  slug: string;
  name: string;
  version: string;
  short_description?: string;
  homepage?: string;
  last_updated?: string;
}

export const STATE_PATHS = {
  cursor: "state/cursor.json",
  oversized: "state/oversized.json",
  errors: "state/errors.json",
  backfillQueue: "state/backfill-queue.json",
} as const;

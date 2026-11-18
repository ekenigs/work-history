import { existsSync, readFileSync } from 'node:fs'

import { backfill } from './backfill.ts'
import type { LoadedConfig } from './config.ts'
import { emailPattern, outputPath } from './config.ts'
import { UsageError } from './errors.ts'
import { parseCursor, today, yesterday } from './helpers.ts'
import type { CollectOptions, CollectRecord, Mode } from './types.ts'
import { update } from './update.ts'

const DAY = /^\d{4}-\d{2}-\d{2}$/u
const SECTION = /^## /mu

export interface RunArgs {
  /** Read all history even when the log has a cursor. */
  full: boolean
  since?: string | undefined
  until?: string | undefined
  repos: readonly string[]
}

/** The window of a run and how it reads it. */
export interface Run extends CollectOptions {
  mode: Mode
}

/**
 * The cursor in the log, or null when there is no log yet. A log that has
 * project sections but no valid cursor has lost it: a backfill would add all
 * history to a log in use, so the run needs `--since` or `--full` to say so.
 */
function readCursor(loaded: LoadedConfig, explicit: boolean): string | null {
  const file = outputPath(loaded)
  if (!existsSync(file)) {
    return null
  }
  const markdown = readFileSync(file, 'utf8')
  const cursor = parseCursor(markdown)
  if (cursor === null && !explicit && SECTION.test(markdown)) {
    throw new UsageError(
      `${file} has entries but no valid <!-- last-scanned: YYYY-MM-DD --> cursor; put the cursor back, or pass --since or --full`,
    )
  }
  return cursor
}

/**
 * Picks the mode and fills in the window. A log with a cursor gets an update
 * from that cursor; a log with none, or a run with `full`, gets a backfill
 * from 1970-01-01. The window ends at yesterday (UTC) at the latest: the
 * cursor moves to `until` and the next run starts after it, so a day still in
 * progress would lose whatever lands later that day.
 */
export function resolveRun(loaded: LoadedConfig, args: RunArgs): Run {
  const cursor = args.full ? null : readCursor(loaded, args.since !== undefined)
  const until = args.until ?? yesterday()
  const since = args.since ?? cursor ?? '1970-01-01'
  if (!DAY.test(since) || !DAY.test(until)) {
    throw new UsageError('--since and --until must be YYYY-MM-DD')
  }
  if (until >= today()) {
    throw new UsageError(`--until must be before today (${today()} UTC); that day is not over yet`)
  }
  return { mode: cursor === null ? 'backfill' : 'update', since, until, repos: args.repos }
}

/** Runs one collection and returns its records in output order, the `run` record last. */
export function collect(loaded: LoadedConfig, run: Run): CollectRecord[] {
  const { config } = loaded
  const records =
    run.mode === 'backfill'
      ? backfill(config, run, emailPattern(config.emails))
      : update(config, run)
  return [
    ...records,
    { type: 'run', mode: run.mode, since: run.since, until: run.until, warnings: [] },
  ]
}

export function toJsonl(records: readonly CollectRecord[]): string {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
}

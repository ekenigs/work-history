import { existsSync, readFileSync } from 'node:fs'

import { backfill } from './backfill.ts'
import type { LoadedConfig } from './config.ts'
import { emailPattern, outputPath } from './config.ts'
import { UsageError } from './errors.ts'
import { parseCursor, today, yesterday } from './helpers.ts'
import type { CollectOptions, CollectRecord, Mode } from './types.ts'
import { update } from './update.ts'

const DAY = /^\d{4}-\d{2}-\d{2}$/u

export interface CollectArgs {
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

function readCursor(loaded: LoadedConfig): string | null {
  const file = outputPath(loaded)
  return existsSync(file) ? parseCursor(readFileSync(file, 'utf8')) : null
}

/**
 * Picks the mode and fills in the window. A log with a cursor gets an update
 * from that cursor; a log with none, or a run with `full`, gets a backfill
 * from 1970-01-01. The window ends at yesterday (UTC) at the latest: the
 * cursor moves to `until` and the next run starts after it, so a day still in
 * progress would lose whatever lands later that day.
 */
export function resolveRun(loaded: LoadedConfig, args: CollectArgs): Run {
  const cursor = args.full ? null : readCursor(loaded)
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

/** Runs one collection and returns its records in output order. */
export function collect(loaded: LoadedConfig, run: Run): CollectRecord[] {
  const { config } = loaded
  return run.mode === 'backfill'
    ? backfill(config, run, emailPattern(config.emails))
    : update(config, run)
}

export function toJsonl(records: readonly CollectRecord[]): string {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
}

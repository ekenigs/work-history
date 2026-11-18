import { existsSync, readFileSync } from 'node:fs'

import { backfill } from './backfill.ts'
import type { LoadedConfig } from './config.ts'
import { emailPattern, outputPath } from './config.ts'
import { UsageError } from './errors.ts'
import { parseCursor, today } from './helpers.ts'
import { monthly } from './monthly.ts'
import type { CollectOptions, CollectRecord, Mode } from './types.ts'

const DAY = /^\d{4}-\d{2}-\d{2}$/u

export interface CollectArgs {
  mode: Mode
  since?: string | undefined
  until?: string | undefined
  repos: readonly string[]
}

function cursorSince(loaded: LoadedConfig): string {
  const file = outputPath(loaded)
  const cursor = existsSync(file) ? parseCursor(readFileSync(file, 'utf8')) : null
  if (cursor === null) {
    throw new UsageError(
      `no <!-- last-scanned: YYYY-MM-DD --> cursor in ${file}; pass --since or run backfill first`,
    )
  }
  return cursor
}

/** Fills in the window: backfill starts at 1970-01-01, monthly at the output file's cursor. */
export function resolveOptions(loaded: LoadedConfig, args: CollectArgs): CollectOptions {
  const until = args.until ?? today()
  const since = args.since ?? (args.mode === 'backfill' ? '1970-01-01' : cursorSince(loaded))
  if (!DAY.test(since) || !DAY.test(until)) {
    throw new UsageError('--since and --until must be YYYY-MM-DD')
  }
  return { since, until, repos: args.repos }
}

/** Runs one collection and returns its records in output order. */
export function collect(loaded: LoadedConfig, args: CollectArgs): CollectRecord[] {
  const opts = resolveOptions(loaded, args)
  const { config } = loaded
  return args.mode === 'backfill'
    ? backfill(config, opts, emailPattern(config.emails))
    : monthly(config, opts)
}

export function toJsonl(records: readonly CollectRecord[]): string {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
}

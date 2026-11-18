#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import type { ParseArgsConfig } from 'node:util'
import { parseArgs } from 'node:util'

import { collect, toJsonl } from './collect.ts'
import { CONFIG_FILE, loadConfig } from './config.ts'
import { UsageError } from './errors.ts'
import { ghAuthenticated } from './exec.ts'
import { init } from './init.ts'

const USAGE = `Usage:
  work-history init [--config <file>] [--yes]
  work-history collect <backfill|monthly> [options]

Commands:
  init      Create or update ${CONFIG_FILE} with a guided setup.
  collect   Print your changes as JSONL for an agent to write up.

Collect options:
  --since YYYY-MM-DD   Start of the window, exclusive. Default: 1970-01-01 for
                       backfill; the cursor in the output file for monthly.
  --until YYYY-MM-DD   End of the window, inclusive. Default: yesterday (UTC),
                       the last complete day.
  --repo owner/name    Limit to a repo; repeatable. Skips the new-project scan.
  --out <file>         Write JSONL to a file instead of stdout.

Common options:
  --config <file>      Config file. Default: ./${CONFIG_FILE}
  -y, --yes            init only: accept detected values without prompts.
  -h, --help           Show this help.
  -v, --version        Show the version.
`

const EXIT_USAGE = 2

const PARSE_CONFIG = {
  allowPositionals: true,
  strict: true,
  options: {
    since: { type: 'string' },
    until: { type: 'string' },
    repo: { type: 'string', multiple: true },
    out: { type: 'string' },
    config: { type: 'string' },
    yes: { type: 'boolean', short: 'y' },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
  },
} as const satisfies ParseArgsConfig

type Args = ReturnType<typeof parseArgs<typeof PARSE_CONFIG>>

function version(): string {
  const pkg: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  return typeof pkg === 'object' && pkg !== null && 'version' in pkg ? String(pkg.version) : ''
}

function runCollect(args: Args): void {
  const [, mode] = args.positionals
  if (mode !== 'backfill' && mode !== 'monthly') {
    throw new UsageError('collect needs a mode: backfill or monthly')
  }
  const loaded = loadConfig(args.values.config ?? CONFIG_FILE)
  if (!ghAuthenticated()) {
    throw new UsageError('gh is not installed or not signed in; run `gh auth login`')
  }
  const text = toJsonl(
    collect(loaded, {
      mode,
      since: args.values.since,
      until: args.values.until,
      repos: args.values.repo ?? [],
    }),
  )
  if (args.values.out === undefined) {
    process.stdout.write(text)
  } else {
    writeFileSync(args.values.out, text)
  }
}

async function main(argv: readonly string[]): Promise<void> {
  const args = parseArgs({ ...PARSE_CONFIG, args: [...argv] })
  const [command] = args.positionals
  if (args.values.version === true) {
    process.stdout.write(`${version()}\n`)
  } else if (args.values.help === true || command === undefined) {
    process.stdout.write(USAGE)
  } else if (command === 'init') {
    await init({ configPath: args.values.config ?? CONFIG_FILE, yes: args.values.yes === true })
  } else if (command === 'collect') {
    runCollect(args)
  } else {
    throw new UsageError(`unknown command: ${command}`)
  }
}

/** Node's parseArgs throws TypeErrors with an ERR_PARSE_ARGS_* code. */
function isArgError(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('ERR_PARSE_ARGS')
  )
}

function report(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`work-history: ${message}\n`)
  if (error instanceof UsageError || isArgError(error)) {
    process.stderr.write('Run `work-history --help` for usage.\n')
    process.exitCode = EXIT_USAGE
  } else {
    process.exitCode = 1
  }
}

try {
  await main(process.argv.slice(2))
} catch (error) {
  report(error)
}

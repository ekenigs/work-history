#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { ParseArgsConfig } from 'node:util'
import { parseArgs } from 'node:util'

import type { Run } from './collect.ts'
import { collect, resolveRun, toJsonl } from './collect.ts'
import type { LoadedConfig } from './config.ts'
import { CONFIG_FILE, loadConfig, outputPath } from './config.ts'
import { UsageError } from './errors.ts'
import { ghAuthenticated } from './exec.ts'
import { init } from './init.ts'
import type { RenderResult } from './render.ts'
import { render } from './render.ts'

const USAGE = `Usage:
  work-history init [--config <file>] [--yes]
  work-history sync [options]

Commands:
  init   Create or update ${CONFIG_FILE} with a guided setup.
  sync   Print your changes as JSONL for an agent to write up. The first run
         reads all your history: GitHub and your local clones. Once your log
         has a cursor, a run reads the approved repos on GitHub from there.

Sync options:
  --full               Read all your history again, even when the log has a
                       cursor.
  --no-agent           Write your changes into the log directly, one line each,
                       with no agent. Only approved repos get entries.
  --since YYYY-MM-DD   Start of the window, exclusive. Default: the cursor in the
                       log, or 1970-01-01 with none or with --full.
  --until YYYY-MM-DD   End of the window, inclusive. Default: yesterday (UTC),
                       the last complete day.
  --repo owner/name    Limit to a repo; repeatable. Skips the new-project scan.
  --out <file>         Write the JSONL to a file instead of stdout. Not with
                       --no-agent.

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
    full: { type: 'boolean' },
    'no-agent': { type: 'boolean' },
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

function loadFor(args: Args): LoadedConfig {
  const loaded = loadConfig(args.values.config ?? CONFIG_FILE)
  if (!ghAuthenticated()) {
    throw new UsageError('gh is not installed or not signed in; run `gh auth login`')
  }
  return loaded
}

/** Resolves the run and says on stderr which kind it is, since the log decides. */
function runFor(loaded: LoadedConfig, args: Args): Run {
  const run = resolveRun(loaded, {
    full: args.values.full === true,
    since: args.values.since,
    until: args.values.until,
    repos: args.values.repo ?? [],
  })
  const kind = run.mode === 'backfill' ? 'full sync' : 'sync from the cursor'
  process.stderr.write(`work-history: ${kind}, ${run.since} to ${run.until}\n`)
  return run
}

function runCollect(args: Args): void {
  const loaded = loadFor(args)
  const text = toJsonl(collect(loaded, runFor(loaded, args)))
  if (args.values.out === undefined) {
    process.stdout.write(text)
  } else {
    writeFileSync(args.values.out, text)
  }
}

function renderSummary(result: RenderResult, file: string): string {
  const lines = [
    `Added ${String(result.added)} entries to ${file} and scanned through ${result.until}.`,
    ...result.projects.map((repo) => `  ${repo}`),
  ]
  if (result.unsorted.length > 0) {
    lines.push(
      'Repos with your work on neither list; add each to approved or ignored in the config:',
      ...result.unsorted.map((repo) => `  ${repo}`),
    )
  }
  if (result.warnings.length > 0) {
    lines.push(`Warnings: ${result.warnings.join(', ')}`)
  }
  return `${lines.join('\n')}\n`
}

function runNoAgent(args: Args): void {
  if (args.values.out !== undefined) {
    throw new UsageError('--out does not go with --no-agent, which writes to the log in the config')
  }
  const loaded = loadFor(args)
  const records = collect(loaded, runFor(loaded, args))
  const file = outputPath(loaded)
  const result = render(
    existsSync(file) ? readFileSync(file, 'utf8') : null,
    records,
    loaded.config,
  )
  writeFileSync(file, result.markdown)
  process.stdout.write(renderSummary(result, file))
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
  } else if (command === 'sync') {
    if (args.values['no-agent'] === true) {
      runNoAgent(args)
    } else {
      runCollect(args)
    }
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

// The gh helpers take the result type from the caller: the gh query fixes the shape.
/* oxlint-disable typescript/no-unnecessary-type-parameters */
import { execFileSync } from 'node:child_process'

/** 1 GiB: `git log` over a large repo is big. */
const MAX_BUFFER = 1_073_741_824

export function run(cmd: string, args: readonly string[], cwd?: string): string {
  return execFileSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** Like `run`, but null when the command fails or is missing. */
export function tryRun(cmd: string, args: readonly string[], cwd?: string): string | null {
  try {
    return run(cmd, args, cwd)
  } catch {
    return null
  }
}

/**
 * Parses JSON whose shape a `gh` query fixes (its GraphQL selection or `--jq`
 * filter), so the result is trusted to match `T`.
 */
export function parseJsonAs<T>(text: string): T {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- shape fixed by the gh query
  return JSON.parse(text) as T
}

export function ghJson<T>(path: string): T | null {
  const out = tryRun('gh', ['api', path])
  return out === null ? null : parseJsonAs<T>(out)
}

/** Paginated `gh api`, one JSON value per `jq` result. */
export function ghLines<T>(path: string, jq: string): T[] {
  const out = tryRun('gh', ['api', '--paginate', path, '--jq', `${jq} | @json`])
  if (out === null) {
    return []
  }
  return out
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => parseJsonAs<T>(line))
}

export function graphql<T>(query: string, vars: Readonly<Record<string, string>>): T {
  const args = ['api', 'graphql', '-f', `query=${query}`]
  for (const [key, value] of Object.entries(vars)) {
    args.push('-f', `${key}=${value}`)
  }
  return parseJsonAs<{ data: T }>(run('gh', args)).data
}

export function ghAuthenticated(): boolean {
  return tryRun('gh', ['auth', 'status']) !== null
}

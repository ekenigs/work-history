import { execFileSync } from 'node:child_process'

/** 1 GiB: `git log` over a large repo is big. */
const MAX_BUFFER = 1_073_741_824

/** HTTP statuses GitHub answers with when the thing asked for is not there. */
export const FORBIDDEN = 403
export const NOT_FOUND = 404
export const CONFLICT = 409
export const UNPROCESSABLE = 422

/** Statuses that mean "not there or out of reach" for a single repo. */
const UNREACHABLE: readonly number[] = [FORBIDDEN, NOT_FOUND]

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
  return JSON.parse(text) as T
}

function stderrOf(error: unknown): string {
  return typeof error === 'object' && error !== null && 'stderr' in error
    ? String(error.stderr).trim()
    : ''
}

/**
 * True when gh's error output reports one of the `missing` HTTP statuses.
 * A rate limit is never "missing", whatever its status: the data is there.
 */
export function isMissing(stderr: string, missing: readonly number[]): boolean {
  return (
    !/rate limit/iu.test(stderr) &&
    missing.some((status) => stderr.includes(`(HTTP ${String(status)})`))
  )
}

/** True when gh failed because GitHub timed out (502 or 504), as it does on a search that is too heavy. */
export function isTimeout(error: unknown): boolean {
  return /HTTP 50[24]/u.test(stderrOf(error))
}

/**
 * `gh api <path>`. Null when GitHub answers with a `missing` status; any other
 * failure (rate limit, network, server error) throws, so a run never passes
 * off partial data as complete.
 */
function ghApi(path: string, flags: readonly string[], missing: readonly number[]): string | null {
  try {
    return run('gh', ['api', ...flags, path])
  } catch (error) {
    const stderr = stderrOf(error)
    if (isMissing(stderr, missing)) {
      return null
    }
    const reason = stderr === '' && error instanceof Error ? error.message : stderr
    throw new Error(`gh api ${path} failed: ${reason}`, { cause: error })
  }
}

/** One JSON response; null when GitHub answers with a `missing` status. */
export function ghJson<T>(path: string, missing: readonly number[] = UNREACHABLE): T | null {
  const out = ghApi(path, [], missing)
  return out === null ? null : parseJsonAs<T>(out)
}

/** One response reduced by a `jq` filter to a single JSON value. */
export function ghPick<T>(path: string, jq: string): T | null {
  const out = ghApi(path, ['--jq', `${jq} | @json`], UNREACHABLE)
  return out === null ? null : parseJsonAs<T>(out)
}

/** Paginated `gh api`, one JSON value per `jq` result; empty on a `missing` status. */
export function ghLines<T>(
  path: string,
  jq: string,
  missing: readonly number[] = UNREACHABLE,
): T[] {
  const out = ghApi(path, ['--paginate', '--jq', `${jq} | @json`], missing)
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

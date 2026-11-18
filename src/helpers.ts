import type { Change, RepoRecord, Role } from './types.ts'

const BODY_LIMIT = 4000
const DAY_LENGTH = 10

export function emailRegex(pattern: string): RegExp {
  return new RegExp(`^(?:${pattern})$`, 'iu')
}

export function isOwnEmail(email: string, pattern: string): boolean {
  return emailRegex(pattern).test(email.trim())
}

/** True when a commit message has a Co-authored-by trailer with one of the user's emails. */
export function hasCoAuthorTrailer(message: string, pattern: string): boolean {
  return new RegExp(String.raw`^\s*co-authored-by:[^\n<]*<(?:${pattern})>\s*$`, 'imu').test(message)
}

const PR_SUFFIX = /\s*\(#(?<number>\d+)\)\s*$/u

/** PR number from a squash subject: the trailing `(#N)`; with `(#1985) (#2882)` the last wins. */
export function extractPrNumber(subject: string): number | null {
  const found = PR_SUFFIX.exec(subject)?.groups?.['number']
  return found === undefined ? null : Number(found)
}

/** Subject without its trailing PR reference. */
export function stripPrSuffix(subject: string): string {
  return subject.replace(PR_SUFFIX, '').trim()
}

/** Drops HTML comments and `X-by:` trailers, trims, and cuts at 4000 chars. */
export function cleanBody(body: string | null | undefined): string {
  if (body === null || body === undefined || body === '') {
    return ''
  }
  const out = body
    .replaceAll('\r\n', '\n')
    .replaceAll(/<!--[\s\S]*?-->/gu, '')
    .split('\n')
    .filter((line) => !/^\s*[A-Za-z][A-Za-z-]*-by:\s.*$/u.test(line))
    .join('\n')
    .replaceAll(/\n{3,}/gu, '\n\n')
    .trim()
  return out.slice(0, BODY_LIMIT)
}

/** The calendar day (YYYY-MM-DD) of an ISO date. */
export function isoDay(date: string): string {
  return date.slice(0, DAY_LENGTH)
}

/** Reads `<!-- last-scanned: YYYY-MM-DD -->`; null when absent or malformed. */
export function parseCursor(markdown: string): string | null {
  const day = /<!--\s*last-scanned:\s*(?<day>\d{4}-\d{2}-\d{2})\s*-->/u.exec(markdown)?.groups?.[
    'day'
  ]
  if (day === undefined) {
    return null
  }
  const date = new Date(`${day}T00:00:00Z`)
  return Number.isNaN(date.getTime()) || isoDay(date.toISOString()) !== day ? null : day
}

/** Applies the aliases map; keys are exact `owner/name` or `owner/*`. */
export function resolveAlias(repo: string, aliases: Readonly<Record<string, string>>): string {
  const exact = aliases[repo]
  if (exact !== undefined) {
    return exact
  }
  const [owner, name] = repo.split('/')
  const wild = aliases[`${owner ?? ''}/*`]
  return wild !== undefined && name !== undefined ? wild.replace('*', name) : repo
}

/** `git@github.com:owner/name.git` or `https://github.com/owner/name(.git)` to `owner/name`. */
export function repoFromRemoteUrl(url: string): string | null {
  const groups = /github\.com[:/](?<owner>[^/\s]+)\/(?<name>[^/\s]+?)(?:\.git)?\/?$/u.exec(
    url.trim(),
  )?.groups
  const owner = groups?.['owner']
  const name = groups?.['name']
  return owner === undefined || name === undefined ? null : `${owner}/${name}`
}

export function today(): string {
  return isoDay(new Date().toISOString())
}

/** `since < date <= until`, compared on the calendar day. */
export function inWindow(date: string, since: string, until: string): boolean {
  const day = isoDay(date)
  return day > since && day <= until
}

export function byDate(a: Change, b: Change): number {
  return a.date.localeCompare(b.date)
}

/** Repo record stats from its changes. */
export function summarize(
  changes: readonly Change[],
): Pick<RepoRecord, 'first' | 'last' | 'counts'> {
  const counts: Record<Role, number> = { author: 0, 'co-author': 0 }
  const days = changes.map((change) => isoDay(change.date)).toSorted()
  for (const change of changes) {
    counts[change.role] += 1
  }
  return { first: days.at(0) ?? null, last: days.at(-1) ?? null, counts }
}

/** Groups changes by repo, keeping their order. */
export function groupByRepo(changes: readonly Change[]): Map<string, Change[]> {
  const groups = new Map<string, Change[]>()
  for (const change of changes) {
    groups.set(change.repo, [...(groups.get(change.repo) ?? []), change])
  }
  return groups
}

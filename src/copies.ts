import { tryRun } from './exec.ts'
import type { LocalRepo } from './local.ts'

/** Shared commits below this count are a coincidence, unless they are all the smaller repo has. */
const MIN_SHARED = 3

/** Two repos that hold copies of the same commits. `likelySource` is the one with more of them. */
export interface CopyPair {
  likelySource: string
  other: string
  shared: number
}

/**
 * One key per commit by the user: author time and subject. Both survive a
 * rewrite that changes the hash (a subtree split, a cherry-pick, a sync bot).
 */
export function ownCommitKeys(repo: LocalRepo, pattern: string): string[] {
  const refs = repo.refs.length > 0 ? repo.refs : ['HEAD']
  const args = ['log', '--no-merges', '--format=%at %s', ...refs, '-E', '-i', `--author=${pattern}`]
  return (tryRun('git', args, repo.absPath) ?? '').split('\n').filter((line) => line !== '')
}

/** The user's commit keys per repo; several clones of one repo are merged. */
export function keysByRepo(repos: readonly LocalRepo[], pattern: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const repo of repos) {
    const keys = out.get(repo.repo) ?? new Set<string>()
    for (const key of ownCommitKeys(repo, pattern)) {
      keys.add(key)
    }
    out.set(repo.repo, keys)
  }
  return out
}

function sharedCount(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let count = 0
  for (const key of a) {
    if (b.has(key)) {
      count += 1
    }
  }
  return count
}

/**
 * Pairs of repos that share the user's commits. Each repo is paired at most
 * once with a larger one, the largest it shares enough commits with, so three
 * copies of one history give two pairs that point at the same source.
 */
export function findCopies(keys: ReadonlyMap<string, ReadonlySet<string>>): CopyPair[] {
  const repos = [...keys]
    .filter(([, own]) => own.size > 0)
    .toSorted(([a, aKeys], [b, bKeys]) => bKeys.size - aKeys.size || a.localeCompare(b))
  const pairs: CopyPair[] = []
  for (const [index, [repo, own]] of repos.entries()) {
    const match = repos
      .slice(0, index)
      .map(([name, other]) => ({ name, shared: sharedCount(own, other) }))
      .find(({ shared }) => shared >= MIN_SHARED || shared === own.size)
    if (match !== undefined) {
      pairs.push({ likelySource: match.name, other: repo, shared: match.shared })
    }
  }
  return pairs
}

/**
 * The `canonical` map after the user's choice for one pair: `source` is the
 * repo the work counts under, or null when the two are counted separately.
 */
export function withChoice(
  canonical: Readonly<Record<string, string>>,
  pair: CopyPair,
  source: string | null,
): Record<string, string> {
  const between = new Set([pair.likelySource, pair.other])
  const out = Object.fromEntries(
    Object.entries(canonical).filter(([copy, main]) => !(between.has(copy) && between.has(main))),
  )
  if (source !== null) {
    out[source === pair.other ? pair.likelySource : pair.other] = source
  }
  return out
}

/** The choice the config already holds for a pair; undefined when it has none. */
export function currentChoice(
  canonical: Readonly<Record<string, string>>,
  pair: CopyPair,
): string | undefined {
  if (canonical[pair.other] === pair.likelySource) {
    return pair.likelySource
  }
  return canonical[pair.likelySource] === pair.other ? pair.other : undefined
}

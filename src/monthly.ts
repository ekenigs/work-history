import type { Config } from './config.ts'
import { dedupe } from './dedupe.ts'
import type { CommitHit } from './github.ts'
import {
  branchCommits,
  commitExists,
  mergedPrs,
  repoInfo,
  repoKeys,
  searchCommits,
} from './github.ts'
import { byDate, repoKey, summarize } from './helpers.ts'
import type { Change, CollectOptions, CollectRecord, NewProjectRecord } from './types.ts'

const SHORT_SHA = 9

interface RunContext {
  cfg: Config
  opts: CollectOptions
  prs: readonly Change[]
}

/**
 * Keys of the repos on either list. Approved repos also count under GitHub's
 * current name, so a renamed repo is not a new project.
 */
function knownRepos(cfg: Config): Set<string> {
  return new Set([
    ...cfg.ignored.map((repo) => repoKey(repo)),
    ...cfg.approved.flatMap((repo) => repoKeys(repo)),
  ])
}

function inRepo(change: Change, repo: string): Change {
  return { ...change, repo }
}

/** A fork's commit counts only if it is not already in its parent. */
function isOwnWork(hit: CommitHit): boolean {
  const parent = repoInfo(hit.repo)?.parent?.full_name
  return parent === undefined || !commitExists(parent, hit.sha)
}

/** Merged PRs or own commits in repos on neither list. */
function newProjects({ cfg, opts, prs }: RunContext): NewProjectRecord[] {
  const known = knownRepos(cfg)
  const isNew = (item: { repo: string }): boolean => !known.has(repoKey(item.repo))
  const evidence = new Map<string, string[]>()
  const add = (repo: string, line: string): void => {
    evidence.set(repo, [...(evidence.get(repo) ?? []), line])
  }
  for (const change of prs.filter((pr) => isNew(pr))) {
    add(change.repo, `PR #${String(change.pr)}: ${change.title}`)
  }
  const hits = searchCommits(cfg.login, opts.since, opts.until)
  for (const hit of hits.filter((item) => isNew(item) && isOwnWork(item))) {
    add(hit.repo, `commit ${hit.sha.slice(0, SHORT_SHA)}: ${hit.msg}`)
  }
  return [...evidence]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([repo, lines]) => ({ type: 'new-project', repo, evidence: lines }))
}

function repoChanges({ cfg, opts, prs }: RunContext, repo: string): CollectRecord[] {
  const info = repoInfo(repo)
  const keys = new Set(repoKeys(repo))
  // PRs carry GitHub's spelling of the repo; the records use the config's.
  const list = prs
    .filter((change) => keys.has(repoKey(change.repo)))
    .map((change) => inRepo(change, repo))
  if (info !== null) {
    list.push(...branchCommits({ repo, login: cfg.login, branch: info.default_branch, ...opts }))
  }
  const merged = dedupe(list).toSorted((a, b) => byDate(a, b))
  if (merged.length === 0 && info !== null) {
    return []
  }
  return [
    {
      type: 'repo',
      repo,
      canonical: cfg.canonical[repo] ?? null,
      localPath: null,
      branches: info === null ? [] : [info.default_branch],
      description: info?.description ?? null,
      ...summarize(merged),
      warnings: info === null ? ['github-404'] : [],
    },
    ...merged,
  ]
}

/**
 * GitHub-only run over the `approved` repos plus new-project candidates, or
 * over `opts.repos` alone: a run limited to some repos reads nothing else.
 */
export function monthly(cfg: Config, opts: CollectOptions): CollectRecord[] {
  const limited = opts.repos.length > 0
  const targets = limited ? opts.repos : cfg.approved
  const prs = mergedPrs(cfg.login, opts)
  return [
    ...(limited ? [] : newProjects({ cfg, opts, prs })),
    ...targets.toSorted().flatMap((repo) => repoChanges({ cfg, opts, prs }, repo)),
    { type: 'run', mode: 'monthly', since: opts.since, until: opts.until, warnings: [] },
  ]
}

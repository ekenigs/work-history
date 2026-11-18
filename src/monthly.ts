import type { Config } from './config.ts'
import { dedupe } from './dedupe.ts'
import { branchCommits, commitExists, mergedPrs, repoInfo, searchCommits } from './github.ts'
import { byDate, summarize } from './helpers.ts'
import type { Change, CollectOptions, CollectRecord, NewProjectRecord } from './types.ts'

const SHORT_SHA = 9

interface RunContext {
  cfg: Config
  opts: CollectOptions
  prs: readonly Change[]
}

/** Merged PRs or own commits in repos on neither list. */
function newProjects({ cfg, opts, prs }: RunContext): NewProjectRecord[] {
  const known = new Set([...cfg.approved, ...cfg.ignored, ...opts.repos])
  const evidence = new Map<string, string[]>()
  const add = (repo: string, line: string): void => {
    evidence.set(repo, [...(evidence.get(repo) ?? []), line])
  }
  for (const change of prs.filter((pr) => !known.has(pr.repo))) {
    add(change.repo, `PR #${String(change.pr)}: ${change.title}`)
  }
  for (const hit of searchCommits(cfg.login, opts.since).filter((item) => !known.has(item.repo))) {
    const parent = repoInfo(hit.repo)?.parent?.full_name
    // A fork counts only if the commit is not already in its parent.
    if (parent === undefined || !commitExists(parent, hit.sha)) {
      add(hit.repo, `commit ${hit.sha.slice(0, SHORT_SHA)}: ${hit.msg}`)
    }
  }
  return [...evidence]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([repo, lines]) => ({ type: 'new-project', repo, evidence: lines }))
}

function repoChanges({ cfg, opts, prs }: RunContext, repo: string): CollectRecord[] {
  const info = repoInfo(repo)
  const list = prs.filter((change) => change.repo === repo)
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

/** GitHub-only run over the `approved` repos (or `opts.repos`), plus new-project candidates. */
export function monthly(cfg: Config, opts: CollectOptions): CollectRecord[] {
  const targets = opts.repos.length > 0 ? opts.repos : cfg.approved
  const prs = mergedPrs(cfg.login, opts.since, opts.until)
  return [
    ...newProjects({ cfg, opts, prs }),
    ...targets.toSorted().flatMap((repo) => repoChanges({ cfg, opts, prs }, repo)),
    { type: 'run', mode: 'monthly', since: opts.since, until: opts.until, warnings: [] },
  ]
}

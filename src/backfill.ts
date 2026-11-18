import type { Config } from './config.ts'
import { dedupe } from './dedupe.ts'
import { branchCommits, mergedPrs, reachableRepos, repoInfo } from './github.ts'
import { byDate, groupByRepo, repoKey, summarize } from './helpers.ts'
import { localChanges, localRepos, noGitRecord, readmeLine } from './local.ts'
import type { Change, CollectOptions, CollectRecord, RepoRecord } from './types.ts'

interface RepoMeta {
  localPath: string | null
  branches: string[]
  warnings: string[]
  description: string | null
  fork: boolean
}

function newMeta(localPath: string | null): RepoMeta {
  return { localPath, branches: [], warnings: [], description: null, fork: false }
}

/** The local clone's branches without their remote prefix, or the GitHub default branch. */
function branchesToRead(meta: RepoMeta, defaultBranch: string): string[] {
  const local = meta.branches.map((branch) => branch.replace(/^[^/]+\//u, ''))
  return local.length > 0 ? local : [defaultBranch]
}

class Backfill {
  public readonly changes: Change[] = []
  public readonly meta = new Map<string, RepoMeta>()
  private readonly names = new Map<string, string>()
  private readonly cfg: Config
  private readonly opts: CollectOptions

  public constructor(cfg: Config, opts: CollectOptions) {
    this.cfg = cfg
    this.opts = opts
  }

  public wants(repo: string): boolean {
    return (
      this.opts.repos.length === 0 ||
      this.opts.repos.some((wanted) => repoKey(wanted) === repoKey(repo))
    )
  }

  /** The first spelling seen of a repo: a git remote and GitHub can differ in case. */
  public nameOf(repo: string): string {
    const known = this.names.get(repoKey(repo))
    if (known !== undefined) {
      return known
    }
    this.names.set(repoKey(repo), repo)
    return repo
  }

  public metaFor(repo: string, localPath: string | null = null): RepoMeta {
    const name = this.nameOf(repo)
    const existing = this.meta.get(name)
    if (existing !== undefined) {
      return existing
    }
    const created = newMeta(localPath)
    this.meta.set(name, created)
    return created
  }

  public readLocal(pattern: string): void {
    for (const local of localRepos(this.cfg.backfill).filter((item) => this.wants(item.repo))) {
      const repo = this.nameOf(local.repo)
      const meta = this.metaFor(repo, local.absPath)
      meta.branches.push(...local.refs.map((ref) => ref.replace('refs/remotes/', '')))
      meta.warnings.push(...local.warnings.filter((warning) => !meta.warnings.includes(warning)))
      this.changes.push(...localChanges({ ...local, repo }, { pattern, ...this.opts }))
    }
  }

  public readPrs(): void {
    for (const change of mergedPrs(this.cfg.login, this.opts)) {
      if (this.wants(change.repo)) {
        this.changes.push({ ...change, repo: this.nameOf(change.repo) })
        this.metaFor(change.repo)
      }
    }
    // Own repos without PRs still count for direct pushes.
    for (const repo of reachableRepos().filter((name) => this.wants(name))) {
      this.metaFor(repo)
    }
  }

  /** Direct pushes per repo, plus descriptions and fork flags. */
  public readCommits(): void {
    for (const [repo, meta] of this.meta) {
      this.readRepoCommits(repo, meta)
    }
  }

  private readRepoCommits(repo: string, meta: RepoMeta): void {
    const info = repoInfo(repo)
    const fallback = meta.localPath === null ? null : readmeLine(meta.localPath)
    if (info === null) {
      meta.warnings.push('github-404')
      meta.description = fallback
      return
    }
    meta.fork = info.fork
    meta.description = info.description ?? fallback
    for (const branch of branchesToRead(meta, info.default_branch)) {
      this.changes.push(...branchCommits({ repo, login: this.cfg.login, branch, ...this.opts }))
    }
  }
}

function repoRecords(
  cfg: Config,
  meta: ReadonlyMap<string, RepoMeta>,
  changes: readonly Change[],
): CollectRecord[] {
  const byRepo = groupByRepo(dedupe(changes))
  const records: CollectRecord[] = []
  for (const repo of [...meta.keys()].toSorted()) {
    const list = (byRepo.get(repo) ?? []).toSorted((a, b) => byDate(a, b))
    const info = meta.get(repo) ?? newMeta(null)
    // Forks count only with the user's own commits; a GitHub repo the user never touched is dropped.
    if (list.length > 0 || (!info.fork && info.localPath !== null)) {
      records.push(
        {
          type: 'repo',
          repo,
          canonical: cfg.canonical[repo] ?? null,
          localPath: info.localPath,
          branches: info.branches,
          description: info.description,
          ...summarize(list),
          warnings: list.length === 0 ? [...info.warnings, 'no-own-commits'] : info.warnings,
        } satisfies RepoRecord,
        ...list,
      )
    }
  }
  return records
}

/** Every repo the user touched, from local clones and GitHub. */
export function backfill(cfg: Config, opts: CollectOptions, pattern: string): CollectRecord[] {
  const run = new Backfill(cfg, opts)
  run.readLocal(pattern)
  run.readPrs()
  run.readCommits()
  return [
    ...repoRecords(cfg, run.meta, run.changes),
    ...cfg.backfill.noGit.map((folder) => noGitRecord(folder)),
    { type: 'run', mode: 'backfill', since: opts.since, until: opts.until, warnings: [] },
  ]
}

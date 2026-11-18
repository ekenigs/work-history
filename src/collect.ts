// Work-history collector. Gathers the user's changes (merged PRs and commits that
// belong to no PR) from local git clones (backfill only) and GitHub, dedupes them,
// and prints JSONL for the agent that writes work-history.md.
//
//   node tools/work-history/collect.ts backfill|monthly [--since YYYY-MM-DD]
//     [--until YYYY-MM-DD] [--repo owner/name ...] [--out file]
//
// Read-only: never fetches, never edits work-history.md or config.json.

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

// ---------- types ----------

export type Role = 'author' | 'co-author'

export interface Config {
  login: string
  emailPattern: string
  projectsRoot: string
  localFolders: string[]
  noGit: string[]
  remote: Record<string, string>
  branches: Record<string, string[]>
  aliases: Record<string, string>
  approved: string[]
  ignored: string[]
}

export interface Change {
  type: 'change'
  repo: string
  kind: 'pr' | 'commit'
  date: string
  pr: number | null
  sha: string | null
  role: Role
  title: string
  body: string
  sources: string[]
  size: { additions: number; deletions: number; files: number } | null
}

export interface RepoRecord {
  type: 'repo'
  repo: string
  localPath: string | null
  branches: string[]
  description: string | null
  first: string | null
  last: string | null
  counts: Record<Role, number>
  warnings: string[]
}

// ---------- pure helpers (unit-tested) ----------

export function emailRegex(pattern: string): RegExp {
  return new RegExp(`^(?:${pattern})$`, 'i')
}

export function isOwnEmail(email: string, pattern: string): boolean {
  return emailRegex(pattern).test(email.trim())
}

/** True when a commit message has a Co-authored-by trailer with one of the user's emails. */
export function hasCoAuthorTrailer(message: string, pattern: string): boolean {
  const re = new RegExp(`^\\s*co-authored-by:[^\\n<]*<(?:${pattern})>\\s*$`, 'im')
  return re.test(message)
}

const PR_SUFFIX = /\s*\(#(\d+)\)\s*$/

/** PR number from a squash subject: the trailing `(#N)`; with `(#1985) (#2882)` the last wins. */
export function extractPrNumber(subject: string): number | null {
  const m = subject.match(PR_SUFFIX)
  return m ? Number(m[1]) : null
}

/** Subject without its trailing PR reference. */
export function stripPrSuffix(subject: string): string {
  return subject.replace(PR_SUFFIX, '').trim()
}

/** Drops HTML comments and `X-by:` trailers, trims, and cuts at 4000 chars. */
export function cleanBody(body: string | null | undefined): string {
  if (!body) return ''
  const out = body
    .replace(/\r\n/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    .filter((line) => !/^\s*[A-Za-z][A-Za-z-]*-by:\s.*$/.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return out.length > 4000 ? out.slice(0, 4000) : out
}

/** Reads `<!-- last-scanned: YYYY-MM-DD -->`; null when absent or malformed. */
export function parseCursor(markdown: string): string | null {
  const m = markdown.match(/<!--\s*last-scanned:\s*(\d{4}-\d{2}-\d{2})\s*-->/)
  if (!m) return null
  const d = new Date(`${m[1]}T00:00:00Z`)
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== m[1] ? null : m[1]
}

/** Applies the aliases map; keys are exact `owner/name` or `owner/*`. */
export function resolveAlias(repo: string, aliases: Record<string, string>): string {
  if (aliases[repo]) return aliases[repo]
  const [owner, name] = repo.split('/')
  const wild = aliases[`${owner}/*`]
  if (wild && name) return wild.replace('*', name)
  return repo
}

/** `git@github.com:owner/name.git` or `https://github.com/owner/name(.git)` -> `owner/name`. */
export function repoFromRemoteUrl(url: string): string | null {
  const m = url.trim().match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/)
  return m ? `${m[1]}/${m[2]}` : null
}

/** `since < date <= until`, compared on the calendar day (YYYY-MM-DD). */
export function inWindow(date: string, since: string, until: string): boolean {
  const day = date.slice(0, 10)
  return day > since && day <= until
}

const DAY_MS = 86_400_000
const normTitle = (t: string) => t.toLowerCase().replace(/\s+/g, ' ').trim()

/**
 * Merges changes into one record per change. Keys: commit SHA first, then
 * repo + PR number. A PR number alone is not unique: a repo can restart its
 * numbering (a renamed or recreated repo), so a PR-number match only
 * merges when it is the same change:
 * - two commits: same subject (one squash commit on several branches);
 * - a commit and a GitHub PR record: same title, or the commit is no older
 *   than a day before the merge (the squash commit and its later copies).
 * PR data (title/body/date) wins over commit data; sources and the stronger
 * role (author over co-author) are kept.
 */
export function dedupe(changes: Change[]): Change[] {
  const out: Change[] = []
  const bySha = new Map<string, Change>()
  const byPr = new Map<string, Change[]>()
  const prKey = (c: Change) => (c.pr == null ? null : `${c.repo}#${c.pr}`)
  const fromPrSearch = (c: Change) => c.sources.includes('github-pr')

  interface Group {
    titles: Set<string>
    prDate: string | null
    latestCommit: string | null
  }
  const groups = new Map<Change, Group>()
  const note = (g: Group, c: Change) => {
    g.titles.add(normTitle(c.title))
    if (fromPrSearch(c)) g.prDate = c.date
    else if (!g.latestCommit || c.date > g.latestCommit) g.latestCommit = c.date
  }
  const notBefore = (date: string, ref: string) => Date.parse(date) >= Date.parse(ref) - DAY_MS
  const sameChange = (existing: Change, c: Change): boolean => {
    const g = groups.get(existing)!
    if (g.titles.has(normTitle(c.title))) return true
    if (fromPrSearch(c))
      return g.prDate != null || (g.latestCommit != null && notBefore(g.latestCommit, c.date))
    return g.prDate != null && notBefore(c.date, g.prDate)
  }
  const index = (c: Change) => {
    if (c.sha) bySha.set(c.sha, c)
    const k = prKey(c)
    if (!k) return
    const list = byPr.get(k) ?? []
    if (!list.includes(c)) list.push(c)
    byPr.set(k, list)
  }

  for (const c of changes) {
    const k = prKey(c)
    const existing =
      (c.sha ? bySha.get(c.sha) : undefined) ??
      (k ? byPr.get(k)?.find((e) => sameChange(e, c)) : undefined)
    if (!existing) {
      const copy = { ...c, sources: [...c.sources] }
      out.push(copy)
      const g: Group = { titles: new Set(), prDate: null, latestCommit: null }
      note(g, copy)
      groups.set(copy, g)
      index(copy)
      continue
    }
    note(groups.get(existing)!, c)
    if (c.sha) bySha.set(c.sha, existing) // every member SHA finds the merged change
    const prWins = fromPrSearch(c) && !fromPrSearch(existing)
    if (prWins) {
      existing.kind = 'pr'
      existing.title = c.title
      existing.date = c.date
      existing.body = c.body || existing.body
      existing.size = c.size ?? existing.size
    } else {
      existing.body = existing.body || c.body
      existing.size = existing.size ?? c.size
    }
    if (existing.pr == null && c.pr != null) existing.pr = c.pr
    if (existing.sha == null && c.sha != null) existing.sha = c.sha
    if (c.role === 'author') existing.role = 'author'
    if (existing.pr != null) existing.kind = 'pr'
    for (const s of c.sources) if (!existing.sources.includes(s)) existing.sources.push(s)
    index(existing)
  }
  return out
}

/** Repo record stats from its changes. */
export function summarize(changes: Change[]): Pick<RepoRecord, 'first' | 'last' | 'counts'> {
  const counts: Record<Role, number> = { author: 0, 'co-author': 0 }
  let first: string | null = null
  let last: string | null = null
  for (const c of changes) {
    counts[c.role]++
    const d = c.date.slice(0, 10)
    if (!first || d < first) first = d
    if (!last || d > last) last = d
  }
  return { first, last, counts }
}

// ---------- process helpers ----------

function run(cmd: string, args: string[], cwd?: string): string {
  return execFileSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 1 << 30,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function tryRun(cmd: string, args: string[], cwd?: string): string | null {
  try {
    return run(cmd, args, cwd)
  } catch {
    return null
  }
}

function ghJson<T>(path: string): T | null {
  const out = tryRun('gh', ['api', path])
  return out ? (JSON.parse(out) as T) : null
}

function ghLines<T>(path: string, jq: string): T[] {
  const out = tryRun('gh', ['api', '--paginate', path, '--jq', `${jq} | @json`])
  if (!out) return []
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T)
}

function graphql<T>(query: string, vars: Record<string, string>): T {
  const args = ['api', 'graphql', '-f', `query=${query}`]
  for (const [k, v] of Object.entries(vars)) args.push('-f', `${k}=${v}`)
  return JSON.parse(run('gh', args)).data as T
}

// ---------- GitHub ----------

interface GhRepoInfo {
  full_name: string
  description: string | null
  default_branch: string
  fork: boolean
  parent?: { full_name: string }
}

const repoInfoCache = new Map<string, GhRepoInfo | null>()
function repoInfo(repo: string): GhRepoInfo | null {
  if (!repoInfoCache.has(repo)) repoInfoCache.set(repo, ghJson<GhRepoInfo>(`repos/${repo}`))
  return repoInfoCache.get(repo)!
}

interface PrNode {
  number: number
  title: string
  body: string
  mergedAt: string
  additions: number
  deletions: number
  changedFiles: number
  mergeCommit: { oid: string } | null
  repository: { nameWithOwner: string }
}

const PR_QUERY = `query($q:String!,$after:String){search(query:$q,type:ISSUE,first:100,after:$after){
  issueCount pageInfo{hasNextPage endCursor}
  nodes{... on PullRequest{number title body mergedAt additions deletions changedFiles
    mergeCommit{oid} repository{nameWithOwner}}}}}`

function searchMergedPrs(login: string, since: string, until: string): PrNode[] {
  const q = `author:${login} is:pr is:merged merged:${since}..${until} sort:created-asc`
  const nodes: PrNode[] = []
  let after: string | null = null
  for (;;) {
    const vars: Record<string, string> = { q }
    if (after) vars.after = after
    const data = graphql<{
      search: {
        issueCount: number
        pageInfo: { hasNextPage: boolean; endCursor: string }
        nodes: PrNode[]
      }
    }>(PR_QUERY, vars)
    if (data.search.issueCount > 1000) {
      throw new Error(`PR search returned ${data.search.issueCount} results; split the window`)
    }
    nodes.push(...data.search.nodes.filter((n) => n && n.number))
    if (!data.search.pageInfo.hasNextPage) break
    after = data.search.pageInfo.endCursor
  }
  return nodes
}

function prToChange(n: PrNode): Change {
  return {
    type: 'change',
    repo: n.repository.nameWithOwner,
    kind: 'pr',
    date: n.mergedAt,
    pr: n.number,
    sha: n.mergeCommit?.oid ?? null,
    role: 'author',
    title: n.title.trim(),
    body: cleanBody(n.body),
    sources: ['github-pr'],
    size: { additions: n.additions, deletions: n.deletions, files: n.changedFiles },
  }
}

interface GhCommit {
  sha: string
  date: string
  message: string
  authorType: string | null
  parents: number
}

function githubCommits(repo: string, login: string, branch: string, since: string): Change[] {
  const sinceIso = `${since}T23:59:59Z`
  const path = `repos/${repo}/commits?author=${login}&sha=${encodeURIComponent(branch)}&since=${sinceIso}&per_page=100`
  const rows = ghLines<GhCommit>(
    path,
    '.[] | {sha, date: .commit.committer.date, message: .commit.message, authorType: .author.type, parents: (.parents | length)}',
  )
  return rows
    .filter((r) => r.parents <= 1 && r.authorType !== 'Bot')
    .map((r) => {
      const [subject, ...rest] = r.message.split('\n')
      return {
        type: 'change',
        repo,
        kind: extractPrNumber(subject) == null ? 'commit' : 'pr',
        date: r.date,
        pr: extractPrNumber(subject),
        sha: r.sha,
        role: 'author',
        title: stripPrSuffix(subject),
        body: cleanBody(rest.join('\n')),
        sources: ['github-commit'],
        size: null,
      } satisfies Change
    })
}

// ---------- local git ----------

interface LocalRepo {
  relPath: string
  absPath: string
  repo: string
  refs: string[]
  warnings: string[]
}

function expandHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p
}

function findGitDirs(dir: string, depth: number): string[] {
  if (depth < 0 || !existsSync(dir)) return []
  if (existsSync(join(dir, '.git'))) return [dir]
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.')) {
      out.push(...findGitDirs(join(dir, e.name), depth - 1))
    }
  }
  return out
}

function refExists(cwd: string, ref: string): boolean {
  return tryRun('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd) != null
}

function resolveLocalRefs(cwd: string, override: string[] | undefined): string[] {
  if (override) {
    return override
      .map((b) => [`refs/remotes/origin/${b}`, `refs/remotes/${b}`].find((r) => refExists(cwd, r)))
      .filter((r): r is string => !!r)
  }
  const head = tryRun('git', ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], cwd)?.trim()
  const candidates = [head, 'refs/remotes/origin/main', 'refs/remotes/origin/master']
  const found = candidates.find((r) => r && refExists(cwd, r))
  return found ? [found] : []
}

function localRepos(cfg: Config, root: string): LocalRepo[] {
  const repos: LocalRepo[] = []
  for (const folder of cfg.localFolders) {
    if (cfg.noGit.includes(folder)) continue
    for (const abs of findGitDirs(join(root, folder), 3)) {
      const relPath = relative(root, abs)
      const warnings: string[] = []
      const originUrl = tryRun('git', ['remote', 'get-url', 'origin'], abs) ?? ''
      const raw = cfg.remote[relPath] ?? repoFromRemoteUrl(originUrl) ?? relPath
      const repo = resolveAlias(raw, cfg.aliases)
      const refs = resolveLocalRefs(abs, cfg.branches[relPath])
      const fetchHead = join(abs, '.git', 'FETCH_HEAD')
      const yearAgo = Date.now() - 365 * 24 * 3600 * 1000
      if (!existsSync(fetchHead) || statSync(fetchHead).mtimeMs < yearAgo)
        warnings.push('stale-clone')
      if (refs.length === 0) warnings.push('no-default-ref')
      repos.push({ relPath, absPath: abs, repo, refs, warnings })
    }
  }
  return repos
}

const FS = '\x1f'
const RS = '\x1e'
const END = '\x1d'

function localChanges(r: LocalRepo, pattern: string, since: string, until: string): Change[] {
  if (r.refs.length === 0) return []
  const fmt = `${RS}%H${FS}%ae${FS}%cI${FS}%s${FS}%B${END}`
  const base = ['log', '--no-merges', '--shortstat', `--format=${fmt}`, ...r.refs]
  const byAuthor = tryRun('git', [...base, '-E', '-i', `--author=${pattern}`], r.absPath) ?? ''
  const byTrailer =
    tryRun('git', [...base, '-E', '-i', `--grep=^co-authored-by:.*<(${pattern})>`], r.absPath) ?? ''
  const seen = new Set<string>()
  const out: Change[] = []
  for (const chunk of (byAuthor + byTrailer).split(RS)) {
    if (!chunk.trim()) continue
    const [head, stat = ''] = chunk.split(END)
    const [sha, email, date, subject, message] = head.split(FS)
    if (seen.has(sha)) continue
    seen.add(sha)
    let role: Role
    if (isOwnEmail(email, pattern)) role = 'author'
    else if (hasCoAuthorTrailer(message, pattern)) role = 'co-author'
    else continue
    if (!inWindow(date, since, until)) continue
    const files = Number(stat.match(/(\d+) files? changed/)?.[1] ?? 0)
    const additions = Number(stat.match(/(\d+) insertions?/)?.[1] ?? 0)
    const deletions = Number(stat.match(/(\d+) deletions?/)?.[1] ?? 0)
    const pr = extractPrNumber(subject)
    out.push({
      type: 'change',
      repo: r.repo,
      kind: pr == null ? 'commit' : 'pr',
      date,
      pr,
      sha,
      role,
      title: stripPrSuffix(subject),
      body: cleanBody(message.split('\n').slice(1).join('\n')),
      sources: ['local'],
      size: { additions, deletions, files },
    })
  }
  return out
}

function readmeLine(dir: string): string | null {
  const readme = readdirSync(dir).find((f) => /^readme(\.md)?$/i.test(f))
  if (!readme) return null
  const line = readFileSync(join(dir, readme), 'utf8')
    .split('\n')
    .map((l) => l.replace(/^#+\s*/, '').trim())
    .find((l) => l && !l.startsWith('<') && !l.startsWith('!['))
  return line ?? null
}

function noGitRecord(root: string, folder: string): RepoRecord {
  const dir = join(root, folder)
  let first: string | null = null
  let last: string | null = null
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else {
        const day = new Date(statSync(p).mtimeMs).toISOString().slice(0, 10)
        if (!first || day < first) first = day
        if (!last || day > last) last = day
      }
    }
  }
  if (existsSync(dir)) walk(dir)
  let description = existsSync(dir) ? readmeLine(dir) : null
  const pkg = join(dir, 'package.json')
  if (existsSync(pkg))
    description = JSON.parse(readFileSync(pkg, 'utf8')).description ?? description
  return {
    type: 'repo',
    repo: `local:${folder}`,
    localPath: dir,
    branches: [],
    description,
    first,
    last,
    counts: { author: 0, 'co-author': 0 },
    warnings: ['no-git'],
  }
}

// ---------- modes ----------

interface Options {
  mode: 'backfill' | 'monthly'
  since: string
  until: string
  repos: string[]
}

function backfill(cfg: Config, opts: Options): unknown[] {
  const root = expandHome(cfg.projectsRoot)
  const warnings: string[] = []
  const changes: Change[] = []
  const meta = new Map<
    string,
    { localPath: string | null; branches: string[]; warnings: string[]; dir?: string }
  >()
  const want = (repo: string) => opts.repos.length === 0 || opts.repos.includes(repo)

  // Local clones.
  for (const r of localRepos(cfg, root)) {
    if (!want(r.repo)) continue
    const m = meta.get(r.repo) ?? {
      localPath: r.absPath,
      branches: [],
      warnings: [],
      dir: r.absPath,
    }
    m.branches.push(...r.refs.map((ref) => ref.replace('refs/remotes/', '')))
    for (const w of r.warnings) if (!m.warnings.includes(w)) m.warnings.push(w)
    meta.set(r.repo, m)
    changes.push(...localChanges(r, cfg.emailPattern, opts.since, opts.until))
  }

  // GitHub PRs.
  for (const n of searchMergedPrs(cfg.login, opts.since, opts.until)) {
    const c = prToChange(n)
    if (!want(c.repo)) continue
    changes.push(c)
    if (!meta.has(c.repo)) meta.set(c.repo, { localPath: null, branches: [], warnings: [] })
  }

  // Own repos without PRs still count for direct pushes.
  const own = ghLines<{ full_name: string }>(
    'user/repos?affiliation=owner,collaborator,organization_member&per_page=100',
    '.[] | {full_name}',
  )
  for (const { full_name } of own) {
    if (want(full_name) && !meta.has(full_name))
      meta.set(full_name, { localPath: null, branches: [], warnings: [] })
  }

  // GitHub direct pushes per repo, plus descriptions.
  const descriptions = new Map<string, string | null>()
  const forks = new Set<string>()
  for (const [repo, m] of meta) {
    const info = repoInfo(repo)
    if (!info) {
      m.warnings.push('github-404')
      descriptions.set(repo, m.dir ? readmeLine(m.dir) : null)
      continue
    }
    if (info.fork) forks.add(repo)
    descriptions.set(repo, info.description ?? (m.dir ? readmeLine(m.dir) : null))
    const localBranches = m.branches.map((b) => b.replace(/^[^/]+\//, ''))
    const ghBranches = localBranches.length ? localBranches : [info.default_branch]
    for (const b of ghBranches) {
      changes.push(
        ...githubCommits(repo, cfg.login, b, opts.since).filter((c) =>
          inWindow(c.date, opts.since, opts.until),
        ),
      )
    }
  }

  const merged = dedupe(changes)
  const records: unknown[] = []
  const byRepo = new Map<string, Change[]>()
  for (const c of merged) byRepo.set(c.repo, [...(byRepo.get(c.repo) ?? []), c])

  for (const repo of [...meta.keys()].sort()) {
    const list = (byRepo.get(repo) ?? []).sort((a, b) => a.date.localeCompare(b.date))
    const m = meta.get(repo)!
    // Forks count only with the user's own commits; repos with nothing are reported, not dropped.
    if (forks.has(repo) && list.length === 0) continue
    const w = [...m.warnings]
    if (list.length === 0) w.push('no-own-commits')
    if (list.length === 0 && !m.localPath) continue // accessible GitHub repo the user never touched
    records.push({
      type: 'repo',
      repo,
      localPath: m.localPath,
      branches: m.branches,
      description: descriptions.get(repo) ?? null,
      ...summarize(list),
      warnings: w,
    } satisfies RepoRecord)
    records.push(...list)
  }

  for (const folder of cfg.noGit) records.push(noGitRecord(root, folder))
  records.push({ type: 'run', mode: 'backfill', since: opts.since, until: opts.until, warnings })
  return records
}

function monthly(cfg: Config, opts: Options): unknown[] {
  const warnings: string[] = []
  const known = new Set([...cfg.approved, ...cfg.ignored])
  const targets = opts.repos.length ? opts.repos : cfg.approved
  const changes: Change[] = []
  const prs = searchMergedPrs(cfg.login, opts.since, opts.until).map(prToChange)
  const records: unknown[] = []

  // New projects: merged PRs or own commits in repos on neither list.
  const evidence = new Map<string, string[]>()
  for (const c of prs) {
    if (!known.has(c.repo) && !opts.repos.includes(c.repo)) {
      evidence.set(c.repo, [...(evidence.get(c.repo) ?? []), `PR #${c.pr}: ${c.title}`])
    }
  }
  const commitHits = ghLines<{ repo: string; sha: string; msg: string }>(
    `search/commits?q=${encodeURIComponent(`author:${cfg.login} committer-date:>${opts.since}`)}&per_page=100`,
    '.items[] | {repo: .repository.full_name, sha, msg: (.commit.message | split("\\n")[0])}',
  )
  for (const h of commitHits) {
    if (known.has(h.repo) || opts.repos.includes(h.repo)) continue
    const info = repoInfo(h.repo)
    if (info?.fork && info.parent) {
      // A fork counts only if the commit is not already in its parent.
      if (ghJson(`repos/${info.parent.full_name}/commits/${h.sha}`)) continue
    }
    evidence.set(h.repo, [...(evidence.get(h.repo) ?? []), `commit ${h.sha.slice(0, 9)}: ${h.msg}`])
  }
  for (const [repo, ev] of [...evidence].sort())
    records.push({ type: 'new-project', repo, evidence: ev })

  for (const repo of [...targets].sort()) {
    const info = repoInfo(repo)
    const repoWarnings: string[] = []
    const list: Change[] = prs.filter((c) => c.repo === repo)
    if (!info) repoWarnings.push('github-404')
    else
      list.push(
        ...githubCommits(repo, cfg.login, info.default_branch, opts.since).filter((c) =>
          inWindow(c.date, opts.since, opts.until),
        ),
      )
    const merged = dedupe(list).sort((a, b) => a.date.localeCompare(b.date))
    if (merged.length === 0 && repoWarnings.length === 0) continue
    records.push({
      type: 'repo',
      repo,
      localPath: null,
      branches: info ? [info.default_branch] : [],
      description: info?.description ?? null,
      ...summarize(merged),
      warnings: repoWarnings,
    } satisfies RepoRecord)
    records.push(...merged)
  }
  records.push({ type: 'run', mode: 'monthly', since: opts.since, until: opts.until, warnings })
  return records
}

// ---------- CLI ----------

function fail(msg: string): never {
  process.stderr.write(`collect: ${msg}\n`)
  process.exit(2)
}

function main(): void {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      since: { type: 'string' },
      until: { type: 'string' },
      repo: { type: 'string', multiple: true },
      out: { type: 'string' },
    },
  })
  const mode = positionals[0]
  if (mode !== 'backfill' && mode !== 'monthly')
    fail('usage: collect.ts backfill|monthly [--since] [--until] [--repo] [--out]')

  const here = dirname(fileURLToPath(import.meta.url))
  const cfg = JSON.parse(readFileSync(join(here, 'config.json'), 'utf8')) as Config
  if (tryRun('gh', ['auth', 'status']) == null) fail('gh is not authenticated')

  const date = /^\d{4}-\d{2}-\d{2}$/
  const until = values.until ?? new Date().toISOString().slice(0, 10)
  let since = values.since
  if (!since) {
    if (mode === 'backfill') since = '1970-01-01'
    else {
      const file = join(here, '..', '..', 'work-history.md')
      since =
        (existsSync(file) ? parseCursor(readFileSync(file, 'utf8')) : null) ??
        fail('no readable <!-- last-scanned: YYYY-MM-DD --> cursor in work-history.md')
    }
  }
  if (!date.test(since) || !date.test(until)) fail('--since/--until must be YYYY-MM-DD')

  const opts: Options = { mode, since, until, repos: values.repo ?? [] }
  const records = mode === 'backfill' ? backfill(cfg, opts) : monthly(cfg, opts)
  const text = records.map((r) => JSON.stringify(r)).join('\n') + '\n'
  if (values.out) writeFileSync(values.out, text)
  else process.stdout.write(text)
}

if (import.meta.main) main()

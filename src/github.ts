import {
  CONFLICT,
  FORBIDDEN,
  ghJson,
  ghLines,
  ghPick,
  graphql,
  isTimeout,
  NOT_FOUND,
  UNPROCESSABLE,
} from './exec.ts'
import {
  addDays,
  cleanBody,
  extractPrNumber,
  inWindow,
  repoKey,
  splitWindow,
  stripPrSuffix,
} from './helpers.ts'
import type { Change, CollectOptions } from './types.ts'

/** GitHub's search API stops at 1000 results: 10 pages of 100. */
const SEARCH_LIMIT = 1000
const SEARCH_PAGES = 10
/** A branch that is gone or out of reach (403, 404) or a repo with no commits (409). */
const NO_COMMITS: readonly number[] = [FORBIDDEN, NOT_FOUND, CONFLICT]
/** GitHub answers 422 for a SHA a repo does not have. */
const NO_SUCH_COMMIT: readonly number[] = [NOT_FOUND, UNPROCESSABLE]

export interface GhRepoInfo {
  full_name: string
  description: string | null
  default_branch: string
  fork: boolean
  parent?: { full_name: string }
}

const repoInfoCache = new Map<string, GhRepoInfo | null>()

/** `repos/<repo>`, cached; null when the repo is gone or out of reach. */
export function repoInfo(repo: string): GhRepoInfo | null {
  const cached = repoInfoCache.get(repoKey(repo))
  if (cached !== undefined) {
    return cached
  }
  const info = ghJson<GhRepoInfo>(`repos/${repo}`)
  repoInfoCache.set(repoKey(repo), info)
  return info
}

/**
 * The config's spelling of a repo plus GitHub's current one, as keys. They
 * differ in case, or in name once a repo is renamed and GitHub redirects.
 */
export function repoKeys(repo: string): string[] {
  return [repoKey(repo), repoKey(repoInfo(repo)?.full_name ?? repo)]
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

interface PrSearch {
  search: {
    issueCount: number
    pageInfo: { hasNextPage: boolean; endCursor: string }
    nodes: (PrNode | Record<string, never>)[]
  }
}

const PR_QUERY = `query($searchQuery:String!,$after:String){search(query:$searchQuery,type:ISSUE,first:100,after:$after){
  issueCount pageInfo{hasNextPage endCursor}
  nodes{... on PullRequest{number title body mergedAt additions deletions changedFiles
    mergeCommit{oid} repository{nameWithOwner}}}}}`

function isPrNode(node: PrNode | Record<string, never>): node is PrNode {
  return 'number' in node
}

function prToChange(node: PrNode): Change {
  return {
    type: 'change',
    repo: node.repository.nameWithOwner,
    kind: 'pr',
    date: node.mergedAt,
    pr: node.number,
    sha: node.mergeCommit?.oid ?? null,
    role: 'author',
    title: node.title.trim(),
    body: cleanBody(node.body),
    sources: ['github-pr'],
    size: { additions: node.additions, deletions: node.deletions, files: node.changedFiles },
  }
}

interface PrPage {
  nodes: PrNode[]
  /** The cursor of the next page, or null on the last one. */
  after: string | null
}

/** The search result; null when GitHub times out on it, which a smaller date range avoids. */
function prSearchPage(vars: Readonly<Record<string, string>>): PrSearch['search'] | null {
  try {
    return graphql<PrSearch>(PR_QUERY, vars).search
  } catch (error) {
    if (isTimeout(error)) {
      return null
    }
    throw error
  }
}

/** One page of the merged-PR search; null when the search holds more than GitHub returns. */
function prPage(query: string, cursor: string | null): PrPage | null {
  const search = prSearchPage(
    cursor === null ? { searchQuery: query } : { searchQuery: query, after: cursor },
  )
  if (search === null || search.issueCount > SEARCH_LIMIT) {
    return null
  }
  return {
    nodes: search.nodes.filter((node) => isPrNode(node)),
    after: search.pageInfo.hasNextPage ? search.pageInfo.endCursor : null,
  }
}

/** Every page of one merged-PR search; null when it holds more than GitHub returns. */
function prSearch(query: string): PrNode[] | null {
  const nodes: PrNode[] = []
  let after: string | null = null
  do {
    const page = prPage(query, after)
    if (page === null) {
      return null
    }
    nodes.push(...page.nodes)
    ;({ after } = page)
  } while (after !== null)
  return nodes
}

/**
 * The user's PRs merged after `since` and up to `until`: across all of GitHub,
 * or in `repos` only when the run is limited to some. A window with more PRs
 * than one search returns is read in smaller date ranges.
 */
export function mergedPrs(login: string, window: CollectOptions): Change[] {
  const scopes = window.repos.length > 0 ? window.repos.map((repo) => ` repo:${repo}`) : ['']
  return scopes
    .flatMap((scope) =>
      splitWindow(addDays(window.since, 1), window.until, (from, to) =>
        prSearch(`author:${login}${scope} is:pr is:merged merged:${from}..${to} sort:created-asc`),
      ),
    )
    .map((node) => prToChange(node))
    .filter((change) => inWindow(change.date, window.since, window.until))
}

interface GhCommit {
  sha: string
  date: string
  message: string
  authorType: string | null
  parents: number
}

function commitToChange(repo: string, commit: GhCommit): Change {
  const [subject = '', ...rest] = commit.message.split('\n')
  const pr = extractPrNumber(subject)
  return {
    type: 'change',
    repo,
    kind: pr === null ? 'commit' : 'pr',
    date: commit.date,
    pr,
    sha: commit.sha,
    role: 'author',
    title: stripPrSuffix(subject),
    body: cleanBody(rest.join('\n')),
    sources: ['github-commit'],
    size: null,
  }
}

export interface CommitQuery {
  repo: string
  login: string
  branch: string
  since: string
  until: string
}

/** The user's non-merge, non-bot commits on one branch, inside the window. */
export function branchCommits(query: CommitQuery): Change[] {
  const params = new URLSearchParams({
    author: query.login,
    sha: query.branch,
    since: `${query.since}T23:59:59Z`,
    per_page: '100',
  })
  const rows = ghLines<GhCommit>(
    `repos/${query.repo}/commits?${params.toString()}`,
    '.[] | {sha, date: .commit.committer.date, message: .commit.message, authorType: .author.type, parents: (.parents | length)}',
    NO_COMMITS,
  )
  return rows
    .filter((row) => row.parents <= 1 && row.authorType !== 'Bot')
    .map((row) => commitToChange(query.repo, row))
    .filter((change) => inWindow(change.date, query.since, query.until))
}

/**
 * Repos the user owns, collaborates on, or can reach through an org. The
 * listing carries what `repoInfo` needs, so it fills the cache; a fork is left
 * out because the listing does not name its parent.
 */
export function reachableRepos(): string[] {
  const rows = ghLines<GhRepoInfo>(
    'user/repos?affiliation=owner,collaborator,organization_member&per_page=100',
    '.[] | {full_name, description, default_branch, fork}',
  )
  for (const row of rows.filter((item) => !item.fork)) {
    repoInfoCache.set(repoKey(row.full_name), row)
  }
  return rows.map((row) => row.full_name)
}

export interface CommitHit {
  repo: string
  sha: string
  msg: string
}

interface CommitPage {
  total: number
  items: CommitHit[]
}

const COMMIT_PAGE_JQ = String.raw`{total: .total_count, items: [.items[] | {repo: .repository.full_name, sha, msg: (.commit.message | split("\n")[0])}]}`

/** Every page of one commit search; null when it holds more than GitHub returns. */
function commitSearch(search: string): CommitHit[] | null {
  const hits: CommitHit[] = []
  for (let page = 1; page <= SEARCH_PAGES; page += 1) {
    const result = ghPick<CommitPage>(
      `search/commits?q=${encodeURIComponent(search)}&per_page=100&page=${String(page)}`,
      COMMIT_PAGE_JQ,
    )
    if (result === null || result.total > SEARCH_LIMIT) {
      return null
    }
    hits.push(...result.items)
    if (result.items.length === 0 || hits.length >= result.total) {
      break
    }
  }
  return hits
}

/** Commit search hits authored by the user after `since` and up to `until`. */
export function searchCommits(login: string, since: string, until: string): CommitHit[] {
  return splitWindow(addDays(since, 1), until, (from, to) =>
    commitSearch(`author:${login} committer-date:${from}..${to}`),
  )
}

export function commitExists(repo: string, sha: string): boolean {
  return ghJson<unknown>(`repos/${repo}/commits/${sha}`, NO_SUCH_COMMIT) !== null
}

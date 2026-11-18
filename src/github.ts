import { ghJson, ghLines, graphql } from './exec.ts'
import { cleanBody, extractPrNumber, inWindow, stripPrSuffix } from './helpers.ts'
import type { Change } from './types.ts'

/** GitHub's search API stops at 1000 results. */
const SEARCH_LIMIT = 1000

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
  const cached = repoInfoCache.get(repo)
  if (cached !== undefined) {
    return cached
  }
  const info = ghJson<GhRepoInfo>(`repos/${repo}`)
  repoInfoCache.set(repo, info)
  return info
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

/** One page of the merged-PR search; `after` is the cursor of the next page or null. */
function prPage(query: string, cursor: string | null): { nodes: PrNode[]; after: string | null } {
  const vars: Record<string, string> =
    cursor === null ? { searchQuery: query } : { searchQuery: query, after: cursor }
  const { search } = graphql<PrSearch>(PR_QUERY, vars)
  if (search.issueCount > SEARCH_LIMIT) {
    throw new Error(`PR search returned ${String(search.issueCount)} results; split the window`)
  }
  return {
    nodes: search.nodes.filter((node) => isPrNode(node)),
    after: search.pageInfo.hasNextPage ? search.pageInfo.endCursor : null,
  }
}

/** The user's merged PRs in the window, across all of GitHub. */
export function mergedPrs(login: string, since: string, until: string): Change[] {
  const query = `author:${login} is:pr is:merged merged:${since}..${until} sort:created-asc`
  const nodes: PrNode[] = []
  let after: string | null = null
  do {
    const page = prPage(query, after)
    nodes.push(...page.nodes)
    ;({ after } = page)
  } while (after !== null)
  return nodes.map((node) => prToChange(node))
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
  )
  return rows
    .filter((row) => row.parents <= 1 && row.authorType !== 'Bot')
    .map((row) => commitToChange(query.repo, row))
    .filter((change) => inWindow(change.date, query.since, query.until))
}

/** Repos the user owns, collaborates on, or can reach through an org. */
export function reachableRepos(): string[] {
  return ghLines<{ full_name: string }>(
    'user/repos?affiliation=owner,collaborator,organization_member&per_page=100',
    '.[] | {full_name}',
  ).map((row) => row.full_name)
}

export interface CommitHit {
  repo: string
  sha: string
  msg: string
}

/** Commit search hits authored by the user after `since`. */
export function searchCommits(login: string, since: string): CommitHit[] {
  const search = encodeURIComponent(`author:${login} committer-date:>${since}`)
  return ghLines<CommitHit>(
    `search/commits?q=${search}&per_page=100`,
    String.raw`.items[] | {repo: .repository.full_name, sha, msg: (.commit.message | split("\n")[0])}`,
  )
}

export function commitExists(repo: string, sha: string): boolean {
  return ghJson<unknown>(`repos/${repo}/commits/${sha}`) !== null
}

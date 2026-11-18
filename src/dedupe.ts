import type { Change } from './types.ts'

const DAY_MS = 86_400_000

interface Group {
  titles: Set<string>
  prDate: string | null
  latestCommit: string | null
}

function normTitle(title: string): string {
  return title.toLowerCase().replaceAll(/\s+/gu, ' ').trim()
}

function fromPrSearch(change: Change): boolean {
  return change.sources.includes('github-pr')
}

function notBefore(date: string, ref: string): boolean {
  return Date.parse(date) >= Date.parse(ref) - DAY_MS
}

function prKey(change: Change): string | null {
  return change.pr === null ? null : `${change.repo}#${String(change.pr)}`
}

function note(group: Group, change: Change): void {
  group.titles.add(normTitle(change.title))
  if (fromPrSearch(change)) {
    group.prDate = change.date
  } else if (group.latestCommit === null || change.date > group.latestCommit) {
    group.latestCommit = change.date
  }
}

/** Copies title, body, date and size from a GitHub PR record over commit data. */
function takePrData(target: Change, pr: Change): void {
  target.kind = 'pr'
  target.title = pr.title
  target.date = pr.date
  target.body = pr.body === '' ? target.body : pr.body
  target.size = pr.size ?? target.size
}

function fillGaps(target: Change, change: Change): void {
  target.body = target.body === '' ? change.body : target.body
  target.size ??= change.size
}

function mergeIds(target: Change, change: Change): void {
  if (target.pr === null && change.pr !== null) {
    target.pr = change.pr
  }
  if (target.sha === null && change.sha !== null) {
    target.sha = change.sha
  }
  if (change.role === 'author') {
    target.role = 'author'
  }
  if (target.pr !== null) {
    target.kind = 'pr'
  }
  for (const source of change.sources.filter((item) => !target.sources.includes(item))) {
    target.sources.push(source)
  }
}

class Deduper {
  public readonly out: Change[] = []
  private readonly bySha = new Map<string, Change>()
  private readonly byPr = new Map<string, Change[]>()
  private readonly groups = new Map<Change, Group>()

  public add(change: Change): void {
    const existing = this.lookup(change)
    if (existing === undefined) {
      this.addNew(change)
    } else {
      this.merge(existing, change)
    }
  }

  private group(change: Change): Group {
    const group = this.groups.get(change)
    if (group === undefined) {
      throw new Error('dedupe: a kept change has no group')
    }
    return group
  }

  private lookup(change: Change): Change | undefined {
    const bySha = change.sha === null ? undefined : this.bySha.get(change.sha)
    if (bySha !== undefined) {
      return bySha
    }
    const key = prKey(change)
    return key === null
      ? undefined
      : this.byPr.get(key)?.find((candidate) => this.sameChange(candidate, change))
  }

  private sameChange(existing: Change, change: Change): boolean {
    const group = this.group(existing)
    if (group.titles.has(normTitle(change.title))) {
      return true
    }
    if (fromPrSearch(change)) {
      return (
        group.prDate !== null ||
        (group.latestCommit !== null && notBefore(group.latestCommit, change.date))
      )
    }
    return group.prDate !== null && notBefore(change.date, group.prDate)
  }

  private index(change: Change): void {
    if (change.sha !== null) {
      this.bySha.set(change.sha, change)
    }
    const key = prKey(change)
    if (key === null) {
      return
    }
    const list = this.byPr.get(key) ?? []
    if (!list.includes(change)) {
      list.push(change)
    }
    this.byPr.set(key, list)
  }

  private addNew(change: Change): void {
    const copy = { ...change, sources: [...change.sources] }
    const group: Group = { titles: new Set(), prDate: null, latestCommit: null }
    this.out.push(copy)
    this.groups.set(copy, group)
    note(group, copy)
    this.index(copy)
  }

  private merge(existing: Change, change: Change): void {
    note(this.group(existing), change)
    if (change.sha !== null) {
      // Every member SHA finds the merged change.
      this.bySha.set(change.sha, existing)
    }
    if (fromPrSearch(change) && !fromPrSearch(existing)) {
      takePrData(existing, change)
    } else {
      fillGaps(existing, change)
    }
    mergeIds(existing, change)
    this.index(existing)
  }
}

/**
 * Merges changes into one record per change. Keys: commit SHA first, then
 * repo + PR number. A PR number alone is not unique: a repo can restart its
 * numbering (a renamed or recreated repo), so a PR-number match only merges
 * when it is the same change:
 * - two commits: same subject (one squash commit on several branches);
 * - a commit and a GitHub PR record: same title, or the commit is no older
 *   than a day before the merge (the squash commit and its later copies).
 * PR data (title/body/date) wins over commit data; sources and the stronger
 * role (author over co-author) are kept.
 */
export function dedupe(changes: readonly Change[]): Change[] {
  const deduper = new Deduper()
  for (const change of changes) {
    deduper.add(change)
  }
  return deduper.out
}

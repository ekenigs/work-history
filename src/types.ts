/** Whether the user wrote a change or appears only in a `Co-authored-by` trailer. */
export type Role = 'author' | 'co-author'

export type Mode = 'backfill' | 'monthly'

export interface ChangeSize {
  additions: number
  deletions: number
  files: number
}

/** One merged PR, or one commit that belongs to no PR. */
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
  size: ChangeSize | null
}

/** Precedes the changes of one repo. */
export interface RepoRecord {
  type: 'repo'
  repo: string
  /** The repo these changes count under, when `canonical` in the config maps this one. */
  canonical: string | null
  localPath: string | null
  branches: string[]
  description: string | null
  first: string | null
  last: string | null
  counts: Record<Role, number>
  warnings: string[]
}

/** A repo on neither the `approved` nor the `ignored` list with the user's work in the window. */
export interface NewProjectRecord {
  type: 'new-project'
  repo: string
  evidence: string[]
}

/** The last record of every run. */
export interface RunRecord {
  type: 'run'
  mode: Mode
  since: string
  until: string
  warnings: string[]
}

export type CollectRecord = Change | RepoRecord | NewProjectRecord | RunRecord

export interface CollectOptions {
  since: string
  until: string
  /** Limits the run to these repos; empty means every repo the mode covers. */
  repos: readonly string[]
}

import type { Config } from './config.ts'
import { isoDay } from './helpers.ts'
import type { Change, CollectRecord, RepoRecord, RunRecord } from './types.ts'

const MONTH_LENGTH = 7
const SHORT_SHA = 7
const TITLE = '# Work history'
const CURSOR = /<!--\s*last-scanned:\s*(?<day>\d{4}-\d{2}-\d{2})\s*-->/u
const HEADING_REPO = /\((?<repo>[\w.-]+\/[\w.-]+)\)\s*$/u
const RANGE = /(?<start>\d{4}-\d{2})(?: → (?<end>\d{4}-\d{2}))?\.\s*$/u

/**
 * Changes that are never worth an entry: dependency bumps, merge commits,
 * work-in-progress and fixup commits, and formatting or lint passes.
 */
const NOISE =
  /^(?:(?:chore|build|fix)\(deps(?:-dev)?\)|bump |update dependenc|merge (?:branch|pull request|remote-tracking)|wip\b|fixup!|squash!|(?:run )?(?:format|lint|prettier)\b)/iu

export interface RenderResult {
  markdown: string
  /** Entries added this run. */
  added: number
  /** Projects that got entries, newest first. */
  projects: string[]
  /** Repos with work in the window that are on neither list. */
  unsorted: string[]
  until: string
  warnings: string[]
}

interface Section {
  repo: string | null
  lines: string[]
}

interface Project {
  repo: string
  description: string | null
  changes: Change[]
}

function month(date: string): string {
  return date.slice(0, MONTH_LENGTH)
}

function escapeMarkdown(text: string): string {
  return text.replaceAll(/[\\*[\]<]/gu, String.raw`\$&`)
}

function changeUrl(change: Change): string {
  return change.kind === 'pr' && change.pr !== null
    ? `https://github.com/${change.repo}/pull/${String(change.pr)}`
    : `https://github.com/${change.repo}/commit/${change.sha ?? ''}`
}

function changeRef(change: Change): string {
  const label =
    change.kind === 'pr' && change.pr !== null
      ? `#${String(change.pr)}`
      : `\`${(change.sha ?? '').slice(0, SHORT_SHA)}\``
  return `[${label}](${changeUrl(change)})`
}

/** One line per change: `- **<title>** (YYYY-MM). <ref>; +A/−D lines across F files.` */
export function entryLine(change: Change): string {
  const size =
    change.size === null
      ? ''
      : `; +${String(change.size.additions)}/−${String(change.size.deletions)} lines across ${String(change.size.files)} ${change.size.files === 1 ? 'file' : 'files'}`
  const co = change.role === 'co-author' ? ' _(co)_' : ''
  return `- **${escapeMarkdown(change.title.trim())}** (${month(change.date)}). ${changeRef(change)}${size}.${co}`
}

export function isNoise(change: Change): boolean {
  return NOISE.test(change.title.trim())
}

function splitSections(markdown: string): { head: string[]; sections: Section[] } {
  const head: string[] = []
  const sections: Section[] = []
  for (const line of markdown.split('\n')) {
    if (line.startsWith('## ')) {
      sections.push({ repo: HEADING_REPO.exec(line)?.groups?.['repo'] ?? null, lines: [line] })
    } else {
      ;(sections.at(-1)?.lines ?? head).push(line)
    }
  }
  return { head, sections }
}

function trimBlank(lines: readonly string[]): string[] {
  const out = [...lines]
  while (out.length > 0 && out.at(-1)?.trim() === '') {
    out.pop()
  }
  return out
}

function setCursor(head: readonly string[], until: string): string[] {
  const index = head.findIndex((line) => CURSOR.test(line))
  const current = index === -1 ? null : (CURSOR.exec(head[index] ?? '')?.groups?.['day'] ?? null)
  const cursor = `<!-- last-scanned: ${current !== null && current > until ? current : until} -->`
  if (index !== -1) {
    return head.with(index, cursor)
  }
  const lines = trimBlank(head)
  return lines.length === 0 ? [TITLE, '', cursor] : [...lines, '', cursor]
}

function formatRange(start: string, end: string): string {
  return start === end ? `${start}.` : `${start} → ${end}.`
}

function widenRange(lines: readonly string[], first: string, last: string): string[] {
  const index = lines.findIndex((line, at) => at > 0 && line.trim() !== '')
  const line = lines[index]
  const range = line === undefined || line.startsWith('- ') ? null : RANGE.exec(line)
  if (range?.groups === undefined) {
    return [...lines]
  }
  const start = range.groups['start'] ?? first
  const end = range.groups['end'] ?? start
  const merged = formatRange(start < first ? start : first, end > last ? end : last)
  return lines.with(index, line?.replace(RANGE, merged) ?? '')
}

function addEntries(section: Section, project: Project, entries: readonly string[]): Section {
  const months = project.changes.map((change) => month(change.date)).toSorted()
  const lines = widenRange(section.lines, months[0] ?? '', months.at(-1) ?? '')
  const firstEntry = lines.findIndex((line) => line.startsWith('- '))
  if (firstEntry === -1) {
    return { repo: section.repo, lines: [...trimBlank(lines), '', ...entries, ''] }
  }
  return { repo: section.repo, lines: lines.toSpliced(firstEntry, 0, ...entries) }
}

function newSection(project: Project, entries: readonly string[]): Section {
  const months = project.changes.map((change) => month(change.date)).toSorted()
  const name = project.repo.split('/').at(-1) ?? project.repo
  const description = project.description?.trim() ?? ''
  const range = formatRange(months[0] ?? '', months.at(-1) ?? '')
  return {
    repo: project.repo,
    lines: [
      `## ${name} (${project.repo})`,
      '',
      description === '' ? range : `${description.replace(/\.?$/u, '.')} ${range}`,
      '',
      ...entries,
      '',
    ],
  }
}

function addToProject(
  projects: Map<string, Project>,
  config: Config,
  { owner, change }: { owner: RepoRecord; change: Change },
): void {
  const target = config.canonical[owner.repo] ?? owner.repo
  if (!config.approved.includes(target) && !config.approved.includes(owner.repo)) {
    return
  }
  const project = projects.get(target) ?? { repo: target, description: null, changes: [] }
  if (owner.repo === target) {
    project.description = owner.description
  }
  project.changes.push(change)
  projects.set(target, project)
}

/** Groups the changes of approved repos under their project, the canonical repo for copies. */
function projectsOf(records: readonly CollectRecord[], config: Config): Map<string, Project> {
  const projects = new Map<string, Project>()
  let owner: RepoRecord | null = null
  for (const record of records) {
    if (record.type === 'repo') {
      owner = record
    } else if (record.type === 'change' && owner !== null) {
      addToProject(projects, config, { owner, change: record })
    }
  }
  return projects
}

function unsortedRepos(records: readonly CollectRecord[], config: Config): string[] {
  const known = new Set([...config.approved, ...config.ignored])
  const repos = records.flatMap((record) => {
    if (record.type === 'new-project') {
      return [record.repo]
    }
    if (record.type !== 'repo' || record.counts.author + record.counts['co-author'] === 0) {
      return []
    }
    const target = config.canonical[record.repo] ?? record.repo
    return known.has(target) || known.has(record.repo) ? [] : [record.repo]
  })
  return [...new Set(repos)].toSorted()
}

/** The entries a project gets this run: new to the log, not noise, one per title and day. */
function freshEntries(project: Project, markdown: string): { changes: Change[]; lines: string[] } {
  const seen = new Set<string>()
  const changes = project.changes
    .filter((change) => !isNoise(change) && !markdown.includes(changeUrl(change)))
    .toSorted((a, b) => b.date.localeCompare(a.date))
    .filter((change) => {
      // Copies of one change in a canonical repo and its mirror count once.
      const key = `${change.title.trim().toLowerCase()}\n${isoDay(change.date)}`
      const isNew = !seen.has(key)
      seen.add(key)
      return isNew
    })
  return { changes, lines: changes.map((change) => entryLine(change)) }
}

function runRecord(records: readonly CollectRecord[]): RunRecord {
  const run = records.findLast((record) => record.type === 'run')
  if (run === undefined) {
    throw new Error('the collected records have no run record')
  }
  return run
}

interface Touched {
  section: Section
  last: string
  added: number
}

/** Adds a project's fresh entries to its section, taking the section out of `sections`. */
function place(sections: Section[], project: Project, source: string): Touched | null {
  const fresh = freshEntries(project, source)
  if (fresh.lines.length === 0) {
    return null
  }
  const scoped = { ...project, changes: fresh.changes }
  const index = sections.findIndex((section) => section.repo === project.repo)
  const [existing] = index === -1 ? [] : sections.splice(index, 1)
  return {
    section:
      existing === undefined
        ? newSection(scoped, fresh.lines)
        : addEntries(existing, scoped, fresh.lines),
    last: fresh.changes[0]?.date ?? '',
    added: fresh.lines.length,
  }
}

function joinLog(head: readonly string[], sections: readonly Section[]): string {
  const top = trimBlank(head).join('\n')
  const body = sections.map((section) => trimBlank(section.lines).join('\n')).join('\n\n')
  return `${body === '' ? top : `${top}\n\n${body}`}\n`
}

/**
 * Writes collected records into the log without an agent: one line per change
 * under its project, projects with new entries first, and the cursor moved to
 * the run's `until`. Only `approved` repos get entries. A change already
 * linked from the log is skipped, so a repeated run adds nothing twice.
 */
export function render(
  markdown: string | null,
  records: readonly CollectRecord[],
  config: Config,
): RenderResult {
  const run = runRecord(records)
  const source = markdown ?? ''
  const { head, sections } = splitSections(source)
  const touched = [...projectsOf(records, config).values()]
    .flatMap((project) => place(sections, project, source) ?? [])
    .toSorted((a, b) => b.last.localeCompare(a.last))
  return {
    markdown: joinLog(setCursor(head, run.until), [
      ...touched.map((entry) => entry.section),
      ...sections,
    ]),
    added: touched.reduce((sum, entry) => sum + entry.added, 0),
    projects: touched.map((entry) => entry.section.repo ?? ''),
    unsorted: unsortedRepos(records, config),
    until: run.until,
    warnings: run.warnings,
  }
}

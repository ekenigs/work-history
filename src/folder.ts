import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

import { isoDay } from './helpers.ts'
import { entries, isScannable, resolveDir } from './local.ts'
import type { RepoRecord } from './types.ts'

/** A file's text; null when it is missing, a folder, or unreadable. */
function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/** First prose line of a folder's README. */
export function readmeLine(dir: string): string | null {
  const readme = entries(dir).find(
    (entry) => !entry.isDirectory() && /^readme(?:\.md)?$/iu.test(entry.name),
  )
  const text = readme === undefined ? null : readText(path.join(dir, readme.name))
  if (text === null) {
    return null
  }
  const line = text
    .split('\n')
    .map((row) => row.replace(/^#+\s*/u, '').trim())
    .find((row) => row !== '' && !row.startsWith('<') && !row.startsWith('!['))
  return line ?? null
}

/** The day a file last changed; none for a dangling link or a file that cannot be read. */
function modifiedDay(file: string): string[] {
  try {
    return [isoDay(new Date(statSync(file).mtimeMs).toISOString())]
  } catch {
    return []
  }
}

function fileDays(dir: string): string[] {
  return entries(dir)
    .filter((entry) => isScannable(entry.name))
    .flatMap((entry) => {
      const file = path.join(dir, entry.name)
      return entry.isDirectory() ? fileDays(file) : modifiedDay(file)
    })
}

/** A package.json's content; null when it is missing or not JSON. */
function parsePackage(text: string | null): unknown {
  try {
    return text === null ? null : JSON.parse(text)
  } catch {
    return null
  }
}

function packageDescription(dir: string): string | null {
  const parsed = parsePackage(readText(path.join(dir, 'package.json')))
  const description =
    typeof parsed === 'object' && parsed !== null && 'description' in parsed
      ? parsed.description
      : null
  return typeof description === 'string' ? description : null
}

/** A folder without git, dated by its files. */
export function noGitRecord(folder: string): RepoRecord {
  const dir = resolveDir(folder)
  const exists = existsSync(dir)
  const days = exists ? fileDays(dir).toSorted() : []
  return {
    type: 'repo',
    repo: `local:${folder}`,
    canonical: null,
    localPath: dir,
    branches: [],
    description: exists ? (packageDescription(dir) ?? readmeLine(dir)) : null,
    first: days.at(0) ?? null,
    last: days.at(-1) ?? null,
    counts: { author: 0, 'co-author': 0 },
    warnings: ['no-git'],
  }
}

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vite-plus/test'

import { emptyBackfill } from './config.ts'
import { localRepos } from './local.ts'

/** Runs `body` with a new temp folder, removed afterwards. */
function inTemp(body: (root: string) => void): void {
  const made = mkdtempSync(path.join(tmpdir(), 'work-history-'))
  try {
    body(realpathSync(made))
  } finally {
    rmSync(made, { recursive: true, force: true })
  }
}

/** A folder that the scan takes for a clone with no remote. */
function clone(root: string, dir: string): string {
  const full = path.join(root, dir)
  mkdirSync(path.join(full, '.git'), { recursive: true })
  return full
}

/** The scanned clones, as path under `root` to name. */
function namesIn(root: string, folders: readonly string[]): Record<string, string> {
  const repos = localRepos({
    ...emptyBackfill(),
    folders: folders.map((dir) => path.join(root, dir)),
  })
  return Object.fromEntries(repos.map((repo) => [path.relative(root, repo.absPath), repo.repo]))
}

describe(localRepos, () => {
  it('names a clone with no remote by its path under the scanned folder', () => {
    inTemp((root) => {
      clone(root, 'code/acme/monorepo')
      expect(namesIn(root, ['code'])).toStrictEqual({ 'code/acme/monorepo': 'acme/monorepo' })
    })
  })

  it('gives the same names in whatever order overlapping folders are listed', () => {
    inTemp((root) => {
      clone(root, 'code/acme/monorepo')
      const names = { 'code/acme/monorepo': 'acme/monorepo' }
      expect(namesIn(root, ['code/acme', 'code'])).toStrictEqual(names)
      expect(namesIn(root, ['code', 'code/acme'])).toStrictEqual(names)
    })
  })

  it('tells apart clones with the same name in different folders', () => {
    inTemp((root) => {
      clone(root, 'a/tool')
      clone(root, 'b/tool')
      expect(namesIn(root, ['a', 'b'])).toStrictEqual({ 'a/tool': 'tool', 'b/tool': 'b/tool' })
    })
  })

  it('reads a clone once and skips noGit folders', () => {
    inTemp((root) => {
      const dir = clone(root, 'code/tool')
      const cfg = { ...emptyBackfill(), folders: [dir, dir, path.join(root, 'code')] }
      expect(localRepos(cfg).map((repo) => repo.repo)).toStrictEqual(['tool'])
      expect(localRepos({ ...cfg, folders: [dir], noGit: [dir] })).toStrictEqual([])
    })
  })
})

import { describe, expect, it } from 'vite-plus/test'

import { emailPattern } from './config.ts'
import {
  cleanBody,
  extractPrNumber,
  hasCoAuthorTrailer,
  inWindow,
  isOwnEmail,
  parseCursor,
  repoFromRemoteUrl,
  resolveAlias,
  stripPrSuffix,
  summarize,
} from './helpers.ts'
import { change } from './test-fixtures.ts'

const PATTERN = String.raw`ada@work\.example|ada@old-job\.example|ada\.?lovelace@mail\.example`

describe('email matching', () => {
  it.each([
    'ada@work.example',
    'ada@old-job.example',
    'ada.lovelace@mail.example',
    'adalovelace@mail.example',
    'Ada@Work.Example',
  ])('matches own email %s', (email) => {
    expect(isOwnEmail(email, PATTERN)).toBe(true)
  })

  it.each([
    'bob@work.example',
    'ada@elsewhere.example',
    'adaXlovelace@mail.example',
    'notada@work.example',
    'ada@work.example.evil',
  ])('rejects other email %s', (email) => {
    expect(isOwnEmail(email, PATTERN)).toBe(false)
  })

  it('escapes emails from the config into an exact pattern', () => {
    const pattern = emailPattern(['ada+gh@work.example', 'ada@old-job.example'])
    expect(isOwnEmail('ada+gh@work.example', pattern)).toBe(true)
    expect(isOwnEmail('ada@old-job.example', pattern)).toBe(true)
    expect(isOwnEmail('adaagh@work.example', pattern)).toBe(false)
    expect(isOwnEmail('ada@workXexample', pattern)).toBe(false)
  })
})

describe('co-author trailers', () => {
  it('finds the user among several trailers', () => {
    const message =
      'Squash (#12)\n\n* stuff\n\nCo-authored-by: ada <ada@work.example>\nCo-authored-by: Bob <bob@work.example>'
    expect(hasCoAuthorTrailer(message, PATTERN)).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(
      hasCoAuthorTrailer('x\n\nco-authored-by: Ada Lovelace <ada@old-job.example>', PATTERN),
    ).toBe(true)
  })

  it('ignores other people and emails in prose', () => {
    expect(hasCoAuthorTrailer('x\n\nCo-authored-by: Bob <bob@work.example>', PATTERN)).toBe(false)
    expect(hasCoAuthorTrailer('mentions ada@work.example in prose', PATTERN)).toBe(false)
  })
})

describe('pr references in subjects', () => {
  it.each([
    ['Added file search (#440)', 440],
    ['fix: thing (#1985) (#2882)', 2882],
    ['Read data (#219) (#221)', 221],
    ['Refs #12 in the middle', null],
    ['No number', null],
  ])('extracts the trailing number from %j', (subject, expected) => {
    expect(extractPrNumber(subject)).toBe(expected)
  })

  it('strips only the last reference', () => {
    expect(stripPrSuffix('Added file search (#440)')).toBe('Added file search')
    expect(stripPrSuffix('fix: thing (#1985) (#2882)')).toBe('fix: thing (#1985)')
  })
})

describe(cleanBody, () => {
  it('strips HTML comments and trailers', () => {
    const body =
      '<!-- template -->\nReal text\n\nCo-authored-by: a <a@b.c>\nSigned-off-by: x <x@y.z>'
    expect(cleanBody(body)).toBe('Real text')
  })

  it('handles empty bodies and caps the length', () => {
    expect(cleanBody(null)).toBe('')
    expect(cleanBody('a'.repeat(5000))).toHaveLength(4000)
  })
})

describe(parseCursor, () => {
  it.each([
    ['# Work history\n<!-- last-scanned: 2026-11-13 -->\n', '2026-11-13'],
    ['<!--last-scanned:2026-01-31-->', '2026-01-31'],
    ['<!-- last-scanned: 2026-02-30 -->', null],
    ['no cursor', null],
  ])('reads %j', (markdown, expected) => {
    expect(parseCursor(markdown)).toBe(expected)
  })
})

describe('repo names', () => {
  const aliases = { 'old-org/*': 'new-org/*', 'old/x': 'new/y' }

  it('applies exact and wildcard aliases', () => {
    expect(resolveAlias('old-org/app', aliases)).toBe('new-org/app')
    expect(resolveAlias('old/x', aliases)).toBe('new/y')
    expect(resolveAlias('someone/tool', aliases)).toBe('someone/tool')
  })

  it.each([
    ['git@github.com:acme/ui.git', 'acme/ui'],
    ['https://github.com/octocat/octocat.github.io.git', 'octocat/octocat.github.io'],
    ['https://github.com/a/b', 'a/b'],
    ['git@gitlab.com:a/b.git', null],
  ])('reads %s', (url, expected) => {
    expect(repoFromRemoteUrl(url)).toBe(expected)
  })
})

describe(inWindow, () => {
  it('is since < day <= until on calendar days', () => {
    expect(inWindow('2026-10-31T22:00:00Z', '2026-10-31', '2026-11-30')).toBe(false)
    expect(inWindow('2026-11-01T00:00:00+02:00', '2026-10-31', '2026-11-30')).toBe(true)
    expect(inWindow('2026-11-30T23:59:59Z', '2026-10-31', '2026-11-30')).toBe(true)
    expect(inWindow('2026-12-01T00:00:00Z', '2026-10-31', '2026-11-30')).toBe(false)
  })
})

describe(summarize, () => {
  it('counts roles and finds the date range', () => {
    const summary = summarize([
      change({ date: '2026-01-05T00:00:00Z', role: 'co-author' }),
      change({ date: '2025-03-01T00:00:00Z' }),
    ])
    expect(summary).toStrictEqual({
      first: '2025-03-01',
      last: '2026-01-05',
      counts: { author: 1, 'co-author': 1 },
    })
  })

  it('has no range without changes', () => {
    expect(summarize([])).toStrictEqual({
      first: null,
      last: null,
      counts: { author: 0, 'co-author': 0 },
    })
  })
})

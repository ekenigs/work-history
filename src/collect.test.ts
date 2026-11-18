import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type Change,
  cleanBody,
  dedupe,
  extractPrNumber,
  hasCoAuthorTrailer,
  inWindow,
  isOwnEmail,
  parseCursor,
  repoFromRemoteUrl,
  resolveAlias,
  stripPrSuffix,
  summarize,
} from './collect.ts';

const PATTERN = 'ada@work\\.example|ada@old-job\\.example|ada\\.?lovelace@mail\\.example';

test('own emails match, other people and lookalikes do not', () => {
  for (const e of ['ada@work.example', 'ada@old-job.example', 'ada.lovelace@mail.example', 'adalovelace@mail.example', 'Ada@Work.Example']) {
    assert.ok(isOwnEmail(e, PATTERN), e);
  }
  for (const e of ['bob@work.example', 'ada@elsewhere.example', 'adaXlovelace@mail.example', 'notada@work.example', 'ada@work.example.evil']) {
    assert.ok(!isOwnEmail(e, PATTERN), e);
  }
});

test('co-author trailer matching', () => {
  const msg = 'Squash (#12)\n\n* stuff\n\nCo-authored-by: ada <ada@work.example>\nCo-authored-by: Bob <bob@work.example>';
  assert.ok(hasCoAuthorTrailer(msg, PATTERN));
  assert.ok(hasCoAuthorTrailer('x\n\nco-authored-by: Ada Lovelace <ada@old-job.example>', PATTERN));
  assert.ok(!hasCoAuthorTrailer('x\n\nCo-authored-by: Bob <bob@work.example>', PATTERN));
  assert.ok(!hasCoAuthorTrailer('mentions ada@work.example in prose', PATTERN));
});

test('PR number extraction: trailing (#N), last one wins', () => {
  assert.equal(extractPrNumber('Added file search (#440)'), 440);
  assert.equal(extractPrNumber('fix: thing (#1985) (#2882)'), 2882);
  assert.equal(extractPrNumber('Read Gender (#219) (#221)'), 221);
  assert.equal(extractPrNumber('Refs #12 in the middle'), null);
  assert.equal(extractPrNumber('No number'), null);
  assert.equal(stripPrSuffix('Added file search (#440)'), 'Added file search');
  assert.equal(stripPrSuffix('fix: thing (#1985) (#2882)'), 'fix: thing (#1985)');
});

test('cleanBody strips HTML comments and trailers and caps length', () => {
  const body = '<!-- template -->\nReal text\n\nCo-authored-by: a <a@b.c>\nSigned-off-by: x <x@y.z>';
  assert.equal(cleanBody(body), 'Real text');
  assert.equal(cleanBody(null), '');
  assert.equal(cleanBody('a'.repeat(5000)).length, 4000);
});

test('cursor parsing', () => {
  assert.equal(parseCursor('# Work history\n<!-- last-scanned: 2026-11-13 -->\n'), '2026-11-13');
  assert.equal(parseCursor('<!--last-scanned:2026-01-31-->'), '2026-01-31');
  assert.equal(parseCursor('<!-- last-scanned: 2026-02-30 -->'), null);
  assert.equal(parseCursor('no cursor'), null);
});

test('alias and remote resolution', () => {
  const aliases = { 'old-org/*': 'new-org/*', 'old/x': 'new/y' };
  assert.equal(resolveAlias('old-org/app', aliases), 'new-org/app');
  assert.equal(resolveAlias('old/x', aliases), 'new/y');
  assert.equal(resolveAlias('someone/tool', aliases), 'someone/tool');
  assert.equal(repoFromRemoteUrl('git@github.com:acme/ui.git'), 'acme/ui');
  assert.equal(repoFromRemoteUrl('https://github.com/octocat/octocat.github.io.git'), 'octocat/octocat.github.io');
  assert.equal(repoFromRemoteUrl('https://github.com/a/b'), 'a/b');
  assert.equal(repoFromRemoteUrl('git@gitlab.com:a/b.git'), null);
});

test('window is since < day <= until', () => {
  assert.ok(!inWindow('2026-10-31T22:00:00Z', '2026-10-31', '2026-11-30'));
  assert.ok(inWindow('2026-11-01T00:00:00+02:00', '2026-10-31', '2026-11-30'));
  assert.ok(inWindow('2026-11-30T23:59:59Z', '2026-10-31', '2026-11-30'));
  assert.ok(!inWindow('2026-12-01T00:00:00Z', '2026-10-31', '2026-11-30'));
});

const base = (o: Partial<Change>): Change => ({
  type: 'change',
  repo: 'o/r',
  kind: 'commit',
  date: '2026-01-02T00:00:00Z',
  pr: null,
  sha: null,
  role: 'author',
  title: 't',
  body: '',
  sources: ['local'],
  size: null,
  ...o,
});

test('dedupe merges PR and its squash commit by SHA, PR data wins', () => {
  const local = base({ sha: 'abc', pr: 5, kind: 'pr', title: 'Short', body: 'commit body', role: 'co-author', date: '2026-01-01T10:00:00Z' });
  const pr = base({ sha: 'abc', pr: 5, kind: 'pr', title: 'Long PR title', body: 'pr body', sources: ['github-pr'], date: '2026-01-01T09:00:00Z', size: { additions: 1, deletions: 2, files: 3 } });
  const out = dedupe([local, pr]);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'Long PR title');
  assert.equal(out[0].body, 'pr body');
  assert.equal(out[0].role, 'author');
  assert.deepEqual(out[0].sources, ['local', 'github-pr']);
});

test('dedupe falls back to repo + PR number, keeps unrelated commits apart', () => {
  const a = base({ sha: 'aaa', pr: 7, kind: 'pr', title: 'Squash' });
  const b = base({ sha: 'bbb', pr: 7, kind: 'pr', title: 'PR', sources: ['github-pr'] });
  const c = base({ sha: 'ccc', title: 'Direct push' });
  const d = base({ repo: 'o/other', sha: 'ddd', pr: 7, kind: 'pr' });
  const out = dedupe([a, b, c, d]);
  assert.equal(out.length, 3);
  assert.equal(out[0].title, 'PR');
  assert.deepEqual(out[0].sources, ['local', 'github-pr']);
});

test('dedupe keeps commits apart that reuse a PR number for a different change', () => {
  // A repo that restarts its PR numbering has two PRs behind #13 and #607.
  const old13 = base({ repo: 'o/dapp', sha: '02b596c3', pr: 13, kind: 'pr', title: 'Workflow with steps', date: '2023-07-10T00:00:00Z' });
  const new13 = base({ repo: 'o/dapp', sha: '893847ee', pr: 13, kind: 'pr', title: 'Updated XCM-SDK packages', date: '2024-06-20T00:00:00Z' });
  const ghCopy = base({ repo: 'o/dapp', sha: '02b596c3', pr: 13, kind: 'pr', title: 'Workflow with steps', sources: ['github-commit'], date: '2023-07-10T00:00:00Z' });
  const out = dedupe([old13, new13, ghCopy]);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((c) => c.title), ['Workflow with steps', 'Updated XCM-SDK packages']);
  assert.deepEqual(out[0].sources, ['local', 'github-commit']);
});

test('dedupe collapses one PR whose squash commit sits on several branches', () => {
  const main = base({ sha: 's1', pr: 42, kind: 'pr', title: 'Add login', date: '2025-01-01T10:00:00Z' });
  const release = base({ sha: 's2', pr: 42, kind: 'pr', title: 'add  login ', date: '2025-01-03T10:00:00Z' });
  const gh = base({ sha: 's3', pr: 42, kind: 'pr', title: 'Add login', sources: ['github-commit'], date: '2025-01-04T10:00:00Z' });
  assert.equal(dedupe([main, release, gh]).length, 1);
});

test('a GitHub PR record joins its own squash commit, not an older PR with the same number', () => {
  const older = base({ repo: 'o/dapp', sha: 'd3558d0e', pr: 607, kind: 'pr', title: 'HRMP Channels', date: '2024-05-14T00:00:00Z' });
  const squash = base({ repo: 'o/dapp', sha: 'n607', pr: 607, kind: 'pr', title: 'Fix fees', date: '2025-02-01T12:00:05Z' });
  const pr = base({ repo: 'o/dapp', sha: 'other-branch-sha', pr: 607, kind: 'pr', title: 'Fix fee display', sources: ['github-pr'], date: '2025-02-01T12:00:00Z' });
  for (const order of [[older, squash, pr], [pr, older, squash]]) {
    const out = dedupe(order).sort((a, b) => a.date.localeCompare(b.date));
    assert.equal(out.length, 2);
    assert.equal(out[0].title, 'HRMP Channels');
    assert.deepEqual(out[0].sources, ['local']);
    assert.equal(out[1].title, 'Fix fee display');
    assert.deepEqual(out[1].sources.sort(), ['github-pr', 'local']);
  }
});

test('summarize counts roles and date range', () => {
  const s = summarize([
    base({ date: '2025-03-01T00:00:00Z' }),
    base({ date: '2026-01-05T00:00:00Z', role: 'co-author' }),
  ]);
  assert.deepEqual(s, { first: '2025-03-01', last: '2026-01-05', counts: { author: 1, 'co-author': 1 } });
});

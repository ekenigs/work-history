import { copyFileSync, existsSync, mkdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { CANCEL_SYMBOL } from '@clack/prompts'
import {
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  multiselect,
  note,
  outro,
  select,
  text,
} from '@clack/prompts'

import type { BackfillConfig, Config } from './config.ts'
import {
  DEFAULT_OUTPUT,
  emailPattern,
  emptyBackfill,
  isEmail,
  isFullPath,
  isLogin,
} from './config.ts'
import type { CopyPair } from './copies.ts'
import { currentChoice, findCopies, keysByRepo, withChoice } from './copies.ts'
import { CancelledError, UsageError } from './errors.ts'
import { ghAuthenticated } from './exec.ts'
import type { Answers, Detected } from './init-config.ts'
import {
  checkedConfig,
  detect,
  nextSteps,
  readExisting,
  serialize,
  splitList,
} from './init-config.ts'
import { expandHome, localRepos } from './local.ts'

/** The folder offered for clones when the config names none and it exists. */
const USUAL_CLONES = '~/Projects'

/** `canonical` only takes `owner/name`; a clone with no GitHub remote has none. */
const REPO = /^[\w.-]+\/[\w.-]+$/u
/** The answer that counts the two repos of a pair separately. */
const SEPARATE = ''

export interface InitOptions {
  configPath: string
  /** Accept detected and existing values without prompting. */
  yes: boolean
}

/** Unwraps a prompt result, turning Ctrl-C into an exception. */
function answered<T>(value: T | typeof CANCEL_SYMBOL): T {
  if (isCancel(value)) {
    throw new CancelledError()
  }
  return value
}

const SKILL_SOURCE = fileURLToPath(new URL('../skills/work-history/SKILL.md', import.meta.url))

/** Copies the skill into `.agents/skills` and links it from `.claude/skills`. */
export function installSkill(root: string): string[] {
  const agentsDir = path.join(root, '.agents', 'skills', 'work-history')
  const claudeLink = path.join(root, '.claude', 'skills', 'work-history')
  const skillFile = path.join(agentsDir, 'SKILL.md')
  mkdirSync(agentsDir, { recursive: true })
  copyFileSync(SKILL_SOURCE, skillFile)
  if (existsSync(claudeLink)) {
    return [skillFile]
  }
  mkdirSync(path.dirname(claudeLink), { recursive: true })
  symlinkSync(path.relative(path.dirname(claudeLink), agentsDir), claudeLink, 'dir')
  return [skillFile, claudeLink]
}

function defaults(existing: Config | null, detected: Detected): Answers {
  return {
    login: existing?.login ?? detected.login ?? '',
    emails: existing?.emails ?? detected.emails,
    output: existing?.output ?? DEFAULT_OUTPUT,
    canonical: existing?.canonical ?? {},
    backfill: existing?.backfill ?? emptyBackfill(),
  }
}

function validEmails(value: string | undefined): string | undefined {
  return splitList(value ?? '').every((email) => isEmail(email))
    ? undefined
    : 'Each entry must be an email'
}

async function pickEmails(choices: readonly string[], known: readonly string[]): Promise<string[]> {
  if (choices.length === 0) {
    return []
  }
  return answered(
    await multiselect({
      message: 'Which emails do you commit with? (you can add others next)',
      options: choices.map((email) => ({ value: email, label: email })),
      initialValues: known.length > 0 ? known : choices,
      required: false,
    }),
  )
}

async function askEmails(known: readonly string[], detected: readonly string[]): Promise<string[]> {
  const picked = await pickEmails([...new Set([...known, ...detected])], known)
  const extra = answered(
    await text({
      message: 'Any other commit emails? (comma separated, optional)',
      placeholder: 'me@old-job.example',
      validate: validEmails,
    }),
  )
  return [...new Set([...picked, ...splitList(extra)])]
}

function isFolder(dir: string): boolean {
  try {
    return statSync(expandHome(dir)).isDirectory()
  } catch {
    return false
  }
}

function validFolders(value: string | undefined): string | undefined {
  const folders = splitList(value ?? '')
  const relative = folders.find((folder) => !isFullPath(folder))
  if (relative !== undefined) {
    return `${relative} is not a full path; start it with / or ~`
  }
  const missing = folders.find((folder) => !isFolder(folder))
  return missing === undefined ? undefined : `${missing} is not a folder`
}

/** The folders to offer: the config's, or the usual one when it exists. */
function knownFolders(backfill: BackfillConfig): string[] {
  return backfill.folders.length === 0 && isFolder(USUAL_CLONES) ? [USUAL_CLONES] : backfill.folders
}

async function askFolders(backfill: BackfillConfig): Promise<BackfillConfig> {
  const answer = answered(
    await text({
      message: 'Folders that hold your local clones (comma separated, optional)',
      placeholder: '~/Projects, ~/work',
      initialValue: knownFolders(backfill).join(', '),
      validate: validFolders,
    }),
  )
  return { ...backfill, folders: splitList(answer) }
}

/** The pairs of GitHub repos in the local clones that share the user's commits. */
function detectCopies(backfill: BackfillConfig, emails: readonly string[]): CopyPair[] {
  const repos = localRepos(backfill)
  if (repos.length === 0 || emails.length === 0) {
    return []
  }
  log.step(`Comparing your commits in ${String(repos.length)} local clones`)
  return findCopies(keysByRepo(repos, emailPattern(emails))).filter(
    (pair) => REPO.test(pair.likelySource) && REPO.test(pair.other),
  )
}

async function askPair(pair: CopyPair, preset: string): Promise<string | null> {
  const { likelySource, other, shared } = pair
  const answer = answered(
    await select({
      message: `${other} and ${likelySource} share ${String(shared)} of your commits. Count that work under:`,
      options: [
        { value: likelySource, label: likelySource },
        { value: other, label: other },
        { value: SEPARATE, label: 'Both: they are separate work' },
      ],
      initialValue: preset,
    }),
  )
  return answer === SEPARATE ? null : answer
}

/** Asks which repo each detected pair counts under; mappings for other repos are kept. */
async function askCopies(
  start: Answers,
  pairs: readonly CopyPair[],
  firstRun: boolean,
): Promise<Record<string, string>> {
  let { canonical } = start
  for (const pair of pairs) {
    const preset = currentChoice(canonical, pair) ?? (firstRun ? pair.likelySource : SEPARATE)
    // oxlint-disable-next-line no-await-in-loop -- the prompts are asked one after another
    canonical = withChoice(canonical, pair, await askPair(pair, preset))
  }
  return canonical
}

function validLogin(value: string | undefined): string | undefined {
  return isLogin((value ?? '').trim()) ? undefined : 'Enter a GitHub login, such as octocat'
}

async function ask(start: Answers, detected: Detected, firstRun: boolean): Promise<Answers> {
  const login = answered(
    await text({ message: 'GitHub login', initialValue: start.login, validate: validLogin }),
  )
  const emails = await askEmails(start.emails, detected.emails)
  const output = answered(
    await text({
      message: 'Work-history file (relative to the config)',
      initialValue: start.output,
      defaultValue: DEFAULT_OUTPUT,
    }),
  )
  const backfill = await askFolders(start.backfill)
  const canonical = await askCopies(start, detectCopies(backfill, emails), firstRun)
  return { login: login.trim(), emails, output: output.trim(), canonical, backfill }
}

function checkAnswers(answers: Answers): void {
  if (answers.login === '') {
    throw new UsageError(
      'no GitHub login detected; sign in with `gh auth login` or run init without --yes',
    )
  }
  if (answers.emails.length === 0) {
    throw new UsageError(
      'no commit email detected; set `git config user.email` or run init without --yes',
    )
  }
}

async function wantSkill(yes: boolean): Promise<boolean> {
  if (yes) {
    return true
  }
  return answered(
    await confirm({
      message: 'Install the agent skill into .agents/skills (linked from .claude/skills)?',
      initialValue: true,
    }),
  )
}

function shown(file: string): string {
  return path.relative(process.cwd(), file)
}

async function gather(
  file: string,
  yes: boolean,
): Promise<{ existing: Config | null; answers: Answers }> {
  if (!ghAuthenticated()) {
    log.warn('gh is not installed or not signed in. `sync` needs it: run `gh auth login`.')
  }
  const existing = readExisting(file)
  if (existing !== null) {
    log.info(`Updating ${shown(file)}`)
  }
  const detected = detect(path.dirname(file))
  const start = defaults(existing, detected)
  const answers = yes ? start : await ask(start, detected, existing === null)
  checkAnswers(answers)
  return { existing, answers }
}

async function setup(options: InitOptions): Promise<void> {
  const file = path.resolve(options.configPath)
  const { existing, answers } = await gather(file, options.yes)
  const config = checkedConfig(file, existing, answers)
  const withSkill = await wantSkill(options.yes)
  writeFileSync(file, serialize(config))
  log.success(`Wrote ${shown(file)}`)
  const skillFiles = withSkill ? installSkill(path.dirname(file)) : []
  for (const written of skillFiles) {
    log.success(`Wrote ${shown(written)}`)
  }
  note(nextSteps(withSkill), 'Next steps')
}

/** Guided setup of the config file and, optionally, the agent skill. */
export async function init(options: InitOptions): Promise<void> {
  intro('work-history init')
  try {
    await setup(options)
    outro('Done')
  } catch (error) {
    if (!(error instanceof CancelledError)) {
      throw error
    }
    cancel('Cancelled; nothing was written.')
    process.exitCode = 1
  }
}

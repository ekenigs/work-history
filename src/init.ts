import { copyFileSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
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
  text,
} from '@clack/prompts'

import type { Config } from './config.ts'
import { DEFAULT_OUTPUT, isEmail, isLogin } from './config.ts'
import { CancelledError, UsageError } from './errors.ts'
import { ghAuthenticated } from './exec.ts'
import type { Answers, Detected } from './init-config.ts'
import {
  detect,
  formatCanonical,
  parseCanonical,
  readExisting,
  serialize,
  splitList,
  checkedConfig,
} from './init-config.ts'

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
      message: 'Which emails do you commit with?',
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

function canonicalError(value: string | undefined): string | undefined {
  const parsed = parseCanonical(value ?? '')
  return typeof parsed === 'string' ? parsed : undefined
}

async function askCanonical(
  current: Readonly<Record<string, string>>,
): Promise<Record<string, string>> {
  const answer = answered(
    await text({
      message:
        'Do some repos carry copies of another repo’s commits? Map each copy to its source (optional)',
      placeholder: 'acme/ui=acme/monorepo, acme/docs=acme/monorepo',
      initialValue: formatCanonical(current),
      validate: canonicalError,
    }),
  )
  const parsed = parseCanonical(answer)
  return typeof parsed === 'string' ? {} : parsed
}

function validLogin(value: string | undefined): string | undefined {
  return isLogin((value ?? '').trim()) ? undefined : 'Enter a GitHub login, such as octocat'
}

async function ask(start: Answers, detected: Detected): Promise<Answers> {
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
  const canonical = await askCanonical(start.canonical)
  return { login: login.trim(), emails, output: output.trim(), canonical }
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
    log.warn('gh is not installed or not signed in. `collect` needs it: run `gh auth login`.')
  }
  const existing = readExisting(file)
  if (existing !== null) {
    log.info(`Updating ${shown(file)}`)
  }
  const detected = detect(path.dirname(file))
  const start = defaults(existing, detected)
  const answers = yes ? start : await ask(start, detected)
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
  note(
    [
      'All history, once:  work-history collect backfill --out backfill.jsonl',
      'Every month:        ask your agent to run the work-history skill',
    ].join('\n'),
    'Next steps',
  )
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

/** Bad command-line input; the CLI exits with code 2 and points at `--help`. */
export class UsageError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

/** A config file that is missing, unreadable or invalid. */
export class ConfigError extends UsageError {
  public readonly issues: readonly string[]

  public constructor(file: string, issues: readonly string[]) {
    super(`${file} is not a valid config:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`)
    this.name = 'ConfigError'
    this.issues = issues
  }
}

/** The user pressed Ctrl-C in a prompt. */
export class CancelledError extends Error {
  public constructor() {
    super('cancelled')
    this.name = 'CancelledError'
  }
}

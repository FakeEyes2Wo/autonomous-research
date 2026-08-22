import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { nowIso } from './utils.js'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export class Logger {
  private readonly file?: string

  constructor(runDir?: string) {
    if (runDir) this.file = join(runDir, 'logs', 'run.log')
  }

  private async write(level: LogLevel, message: string): Promise<void> {
    const line = `[${nowIso()}] [${level.toUpperCase()}] ${message}`
    console.log(line)
    if (!this.file) return
    try {
      await mkdir(join(this.file, '..'), { recursive: true })
      await appendFile(this.file, `${line}\n`, 'utf8')
    } catch (error) {
      console.error(`[logger] failed to write log file: ${String(error)}`)
    }
  }

  debug(message: string): void {
    void this.write('debug', message)
  }

  info(message: string): void {
    void this.write('info', message)
  }

  warn(message: string): void {
    void this.write('warn', message)
  }

  error(message: string, error?: unknown): void {
    const detail = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
    void this.write('error', `${message}${detail ? `\n${detail}` : ''}`)
  }
}

export function createLogger(runDir?: string): Logger {
  return new Logger(runDir)
}

import pino, { type Logger as PinoLogger, type Level } from "pino";
import type { LogLevel } from "../../core/types/common.ts";

export type Logger = PinoLogger;

export interface LoggerOptions {
  level: LogLevel;
  /** When true, log to a file at `data/runner.log` (used when TUI is active). */
  fileMode?: boolean;
  filePath?: string;
  /** Pretty-print to stdout (for dev). */
  pretty?: boolean;
}

/** Create a root logger. */
export function createRootLogger(opts: LoggerOptions): Logger {
  const baseConfig: pino.LoggerOptions = {
    level: opts.level as Level,
    base: undefined, // omit pid/hostname
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  if (opts.fileMode && opts.filePath) {
    return pino(baseConfig, pino.destination({ dest: opts.filePath, sync: false }));
  }

  if (opts.pretty) {
    return pino({
      ...baseConfig,
      transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss.l" } },
    });
  }

  return pino(baseConfig);
}

/** Create a child logger with bound context. */
export function childLogger(parent: Logger, context: Record<string, unknown>): Logger {
  return parent.child(context);
}

import type { LogLevel } from "../config.ts";

export interface LogFields {
  [key: string]: unknown;
}

export interface Logger {
  debug(fields: LogFields | string, message?: string): void;
  info(fields: LogFields | string, message?: string): void;
  warn(fields: LogFields | string, message?: string): void;
  error(fields: LogFields | string, message?: string): void;
  child(bindings: LogFields): Logger;
}

const levels: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

const normalize = (fields: LogFields | string, message?: string): LogFields => {
  if (typeof fields === "string") {
    return { message: fields };
  }
  return message ? { ...fields, message } : fields;
};

export const createLogger = (level: LogLevel = "info", bindings: LogFields = {}): Logger => {
  const emit = (entryLevel: LogLevel, fields: LogFields | string, message?: string): void => {
    if (levels[entryLevel] < levels[level]) {
      return;
    }
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level: entryLevel,
      ...bindings,
      ...normalize(fields, message)
    });
    const stream = entryLevel === "error" ? process.stderr : process.stdout;
    stream.write(`${line}\n`);
  };

  return {
    debug: (fields, message) => emit("debug", fields, message),
    info: (fields, message) => emit("info", fields, message),
    warn: (fields, message) => emit("warn", fields, message),
    error: (fields, message) => emit("error", fields, message),
    child: (nextBindings) => createLogger(level, { ...bindings, ...nextBindings })
  };
};

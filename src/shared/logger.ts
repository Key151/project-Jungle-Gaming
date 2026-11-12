/**
 * Logger estruturado (JSON lines) no stdout.
 *
 * Regra importante: NÃO logamos payloads financeiros completos nem dados
 * sensíveis. Logamos identificadores (transactionId, walletId, providerId,
 * messageId), status e códigos de falha — suficiente para diagnóstico.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  [key: string]: unknown;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export class StructuredLogger {
  private readonly base: LogFields;

  constructor(base: LogFields = {}, private readonly minLevel: LogLevel = 'info') {
    this.base = base;
  }

  child(fields: LogFields): StructuredLogger {
    return new StructuredLogger({ ...this.base, ...fields }, this.minLevel);
  }

  debug(message: string, fields?: LogFields): void {
    this.write('debug', message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.write('info', message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.write('warn', message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.write('error', message, fields);
  }

  private write(level: LogLevel, message: string, fields?: LogFields): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;

    const payload: LogFields = {
      ts: new Date().toISOString(),
      level,
      message,
      ...this.base,
      ...(fields ?? {}),
    };

    // `error` pode ser uma Error: serializamos de forma segura.
    if (payload.error instanceof Error) {
      payload.error = {
        name: payload.error.name,
        message: payload.error.message,
        stack: payload.error.stack,
      };
    }

    const line = JSON.stringify(payload, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    );

    if (level === 'error') process.stderr.write(line + '\n');
    else process.stdout.write(line + '\n');
  }
}

export const rootLogger = new StructuredLogger(
  { service: 'wagering-processor' },
  (process.env['LOG_LEVEL'] as LogLevel) ?? 'info',
);

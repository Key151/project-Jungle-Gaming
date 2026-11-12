/**
 * Log em JSON (uma linha por evento).
 *
 * Regra: não logamos valores de dinheiro nem payload completo.
 * Logamos identificadores (transactionId, walletId, providerId, messageId),
 * status e código de falha - é o que serve para diagnosticar.
 */
export type LogLevel = 'info' | 'warn' | 'error';

export class AppLogger {
  constructor(private readonly context: string) {}

  info(message: string, fields: Record<string, unknown> = {}): void {
    this.write('info', message, fields);
  }

  warn(message: string, fields: Record<string, unknown> = {}): void {
    this.write('warn', message, fields);
  }

  error(message: string, fields: Record<string, unknown> = {}): void {
    this.write('error', message, fields);
  }

  private write(level: LogLevel, message: string, fields: Record<string, unknown>): void {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      context: this.context,
      message,
      ...fields,
    });

    if (level === 'error') console.error(line);
    else console.log(line);
  }
}

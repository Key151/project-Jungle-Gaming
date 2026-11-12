import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { Response } from 'express';
import { EntityManager } from '@mikro-orm/core';
import { SqsService } from '../messaging/sqs.service';
import { rawExecute } from '../db/raw-sql';

/**
 * Health checks - SEM autenticação (o enunciado exige que fiquem abertos).
 */
@Controller('health')
export class HealthController {
  constructor(
    private readonly em: EntityManager,
    private readonly sqs: SqsService,
  ) {}

  /** Liveness: o processo está vivo? (não depende de dependências externas) */
  @Get('live')
  live() {
    return {
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }

  /** Readiness: PostgreSQL e SQS estão alcançáveis? */
  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const [database, queueReachable] = await Promise.all([
      this.checkDatabase(),
      this.sqs.isReachable(),
    ]);

    const queue = { ok: queueReachable, latencyMs: 0 };
    const ready = database.ok && queue.ok;
    if (!ready) {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
    }

    return {
      status: ready ? 'ok' : 'degraded',
      checks: {
        postgres: database,
        sqs: queue,
      },
      timestamp: new Date().toISOString(),
    };
  }

  private async checkDatabase(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const startedAt = Date.now();
    try {
      await rawExecute<unknown>(this.em, 'SELECT 1', [], 'get');
      return { ok: true, latencyMs: Date.now() - startedAt };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: (error as Error).message,
      };
    }
  }
}

import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { newCorrelationId, runWithCorrelation } from '../../../shared/correlation';

/**
 * Correlation id por requisição: usa o header `x-correlation-id` quando o
 * cliente envia, senão gera um. O id volta na resposta e aparece nos logs
 * estruturados.
 */
@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const header = req.header('x-correlation-id');
    const correlationId = header && header.trim() !== '' ? header : newCorrelationId();

    res.setHeader('x-correlation-id', correlationId);
    runWithCorrelation(correlationId, () => next());
  }
}

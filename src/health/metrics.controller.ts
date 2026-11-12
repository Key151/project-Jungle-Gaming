import { Controller, Get, Header } from '@nestjs/common';
import { MetricsService } from '../common/metrics';

/**
 * Métricas no formato texto do Prometheus (simplificado).
 * São métricas por instância — ver ARCHITECTURE.md para a limitação.
 */
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  render(): string {
    return this.metrics.render();
  }
}

/**
 * Bootstrap da aplicação.
 *
 * - `reflect-metadata` precisa ser importado ANTES do Nest/MikroORM
 *   (imports são avaliados na ordem em que aparecem no arquivo).
 * - A aplicação sobe com o Nest (framework obrigatório) sobre o runtime Bun.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { DomainExceptionFilter } from './interfaces/http/domain-exception.filter';
import { rootLogger } from './shared/logger';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  // Validação de payload: whitelist remove campos desconhecidos e
  // forbidNonWhitelisted rejeita o request — payload inválido = 400.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      validateCustomDecorators: true,
    }),
  );

  // Tradução consistente de erros para status HTTP.
  app.useGlobalFilters(new DomainExceptionFilter());

  // Graceful shutdown: SIGTERM/SIGINT fecha o servidor HTTP e espera os
  // workers terminarem a mensagem em andamento.
  app.enableShutdownHooks();

  const port = Number(process.env['PORT'] ?? 3000);
  await app.listen(port, '0.0.0.0');

  rootLogger.info('wagering processor started', { port });
}

bootstrap().catch((error) => {
  rootLogger.error('failed to start application', { error });
  process.exit(1);
});

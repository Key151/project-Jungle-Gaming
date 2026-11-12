import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';

import { MetricsService } from './shared/metrics';
import { WagerTransactionProcessor } from './application/wagering/wager-transaction.processor';
import { WageringService } from './application/wagering/wagering.service';
import { WalletService } from './application/wallet/wallet.service';

import { WalletEntity } from './infrastructure/persistence/entities/wallet.entity';
import { WalletLedgerEntryEntity } from './infrastructure/persistence/entities/wallet-ledger-entry.entity';
import { WagerTransactionEntity } from './infrastructure/persistence/entities/wager-transaction.entity';
import { InboxMessageEntity } from './infrastructure/persistence/entities/inbox-message.entity';
import { OutboxMessageEntity } from './infrastructure/persistence/entities/outbox-message.entity';

import { SqsService } from './infrastructure/messaging/sqs.service';
import { OutboxPublisher } from './infrastructure/messaging/outbox-publisher';
import { SqsWagerConsumer } from './infrastructure/messaging/sqs-wager-consumer';
import { PendingReferenceWorker } from './infrastructure/messaging/pending-reference-worker';

import { WalletsController } from './interfaces/http/controllers/wallets.controller';
import { WageringController } from './interfaces/http/controllers/wagering.controller';
import { HealthController } from './interfaces/http/controllers/health.controller';
import { MetricsController } from './interfaces/http/controllers/metrics.controller';
import { CorrelationMiddleware } from './interfaces/http/middleware/correlation.middleware';

@Module({
  imports: [
    MikroOrmModule.forRoot({
      driver: PostgreSqlDriver,
      dbName: process.env['POSTGRES_DB'] ?? 'jungle',
      user: process.env['POSTGRES_USER'] ?? 'jungle',
      password: process.env['POSTGRES_PASSWORD'] ?? 'jungle',
      host: process.env['POSTGRES_HOST'] ?? 'localhost',
      port: Number(process.env['POSTGRES_PORT'] ?? 5432),
      entities: [
        WalletEntity,
        WalletLedgerEntryEntity,
        WagerTransactionEntity,
        InboxMessageEntity,
        OutboxMessageEntity,
      ],
      debug: process.env['MIKRO_ORM_DEBUG'] === 'true',
      // O schema é gerenciado pelas migrations SQL versionadas (ver /migrations).
      migrations: { disable: true } as never,
    }),
  ],
  controllers: [
    WalletsController,
    WageringController,
    HealthController,
    MetricsController,
  ],
  providers: [
    MetricsService,
    WagerTransactionProcessor,
    WageringService,
    WalletService,
    SqsService,
    OutboxPublisher,
    SqsWagerConsumer,
    PendingReferenceWorker,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes('*');
  }
}

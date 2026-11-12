import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';

import { MetricsService } from './common/metrics';
import { WageringService } from './wagering/wager-transaction.service';
import { WalletService } from './wallet/wallet.service';

import { WalletEntity } from './wallet/wallet.entity';
import { WalletLedgerEntryEntity } from './wallet/wallet-ledger-entry.entity';
import { WagerTransactionEntity } from './wagering/wager-transaction.entity';
import { InboxMessageEntity } from './messaging/inbox-message.entity';
import { OutboxMessageEntity } from './messaging/outbox-message.entity';

import { SqsService } from './messaging/sqs.service';
import { OutboxPublisher } from './messaging/outbox.publisher';
import { SqsWagerConsumer } from './messaging/sqs.consumer';
import { PendingReferenceWorker } from './messaging/pending-reference.worker';

import { WalletsController } from './wallet/wallet.controller';
import { WageringController } from './wagering/wagering.controller';
import { HealthController } from './health/health.controller';
import { MetricsController } from './health/metrics.controller';
import { CorrelationMiddleware } from './common/correlation.middleware';

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

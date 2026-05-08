import { Module, OnModuleInit } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ClsModule } from 'nestjs-cls';
import { KyselyModule } from 'nestjs-kysely';
import { ZodSerializerInterceptor, ZodValidationPipe } from 'nestjs-zod';
import { randomUUID } from 'node:crypto';
import { loadConfig } from 'src/config';
import { controllers } from 'src/controllers';
import { AuthGuard } from 'src/middleware/auth.guard';
import { ErrorInterceptor } from 'src/middleware/error.interceptor';
import { GlobalExceptionFilter } from 'src/middleware/global-exception.filter';
import { LoggingInterceptor } from 'src/middleware/logging.interceptor';
import { JobName } from 'src/enum';
import { repositories } from 'src/repositories';
import { JobRepository } from 'src/repositories/job.repository';
import { services } from 'src/services';
import { getKyselyConfig } from 'src/utils/database';

const config = loadConfig();

const middleware = [
  { provide: APP_FILTER, useClass: GlobalExceptionFilter },
  { provide: APP_PIPE, useClass: ZodValidationPipe },
  { provide: APP_INTERCEPTOR, useClass: ZodSerializerInterceptor },
  { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
  { provide: APP_INTERCEPTOR, useClass: ErrorInterceptor },
  { provide: APP_GUARD, useClass: AuthGuard },
];

@Module({
  imports: [
    ClsModule.forRoot({
      global: true,
      middleware: { mount: true, generateId: true, idGenerator: () => randomUUID() },
    }),
    KyselyModule.forRoot(getKyselyConfig(config.database)),
  ],
  controllers: [...controllers],
  providers: [...repositories, ...services, GlobalExceptionFilter, ...middleware],
})
export class AppModule implements OnModuleInit {
  constructor(private readonly jobRepository: JobRepository) {}

  async onModuleInit(): Promise<void> {
    // Discover @OnJob handlers across all registered services and register them
    // with pg-boss. Throws StartupError if any JobName lacks a handler.
    await this.jobRepository.setup(services);

    // Periodic banking sync: every 6h matches the typical PSD2 background-
    // access cap (4 calls/day/account). On-demand syncs from the admin UI
    // pass PSU-IP-Address and are exempt.
    await this.jobRepository.schedule(JobName.BankingSyncAll, '0 */6 * * *', {});
    // GC abandoned auths once a day; cheap, doesn't need to run with the
    // sync — they're independent concerns.
    await this.jobRepository.schedule(JobName.BankingSweepStalePending, '0 4 * * *', {});
    // Wise reconcile every 4h — catches missed transfers#state-change
    // webhooks. Wise is much more lenient on call quotas than PSD2 ASPSPs
    // so we can poll relatively aggressively.
    await this.jobRepository.schedule(JobName.WiseReconcile, '0 */4 * * *', {});
  }
}

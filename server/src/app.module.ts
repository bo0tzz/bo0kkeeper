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
  }
}

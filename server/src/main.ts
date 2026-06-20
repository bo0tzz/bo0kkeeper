import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { applyCommonAppConfig, serveWebStatic } from 'src/app.common';
import { AppModule } from 'src/app.module';
import { loadConfig } from 'src/config';
import { APP_NAME, APP_VERSION } from 'src/constants';
import { runMigrations } from 'src/utils/migrations';

async function bootstrap() {
  const config = loadConfig();
  process.title = `${APP_NAME}-server`;
  new Logger(APP_NAME).log(`${APP_NAME}-server starting (version=${APP_VERSION})`);

  // Run migrations before Nest instantiates — many onModuleInit hooks
  // (JobRepository.setup, SettingsService.ensureInitialized) read schema
  // that the migrations create. Failure here aborts the boot, k8s sees
  // unhealthy, no traffic served.
  await runMigrations(config.database);

  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  applyCommonAppConfig(app);

  const logger = new Logger(APP_NAME);
  if (config.webDistDir) {
    const webDist = resolve(config.webDistDir);
    if (!existsSync(join(webDist, 'index.html'))) {
      throw new Error(`WEB_DIST_DIR points to ${webDist} but no index.html found there.`);
    }
    serveWebStatic(app, webDist);
    logger.log(`Serving SvelteKit static build from ${webDist}`);
  }

  await app.listen(config.port, config.host);
  logger.log(`${APP_NAME}-server listening on ${config.host}:${config.port}`);
}

void bootstrap();

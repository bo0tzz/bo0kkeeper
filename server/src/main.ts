import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { applyCommonAppConfig } from 'src/app.common';
import { AppModule } from 'src/app.module';
import { loadConfig } from 'src/config';
import { APP_NAME } from 'src/constants';

async function bootstrap() {
  const config = loadConfig();
  process.title = `${APP_NAME}-server`;

  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  applyCommonAppConfig(app);

  await app.listen(config.port, config.host);
  new Logger(APP_NAME).log(`${APP_NAME}-server listening on ${config.host}:${config.port}`);
}

void bootstrap();

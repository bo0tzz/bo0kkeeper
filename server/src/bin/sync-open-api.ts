/**
 * Boot a minimal NestJS app, generate the OpenAPI spec from the controller +
 * Zod-DTO metadata, and write it to disk. Consumed downstream by oazapfts to
 * generate the typed TypeScript SDK in `open-api/typescript-sdk/`.
 *
 * See `open-api/bin/generate-open-api.sh` for the full pipeline.
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from 'src/app.module';
import { useSwagger } from 'src/utils/swagger';

async function main() {
  const app = await NestFactory.create(AppModule, { logger: false });
  useSwagger(app, { write: true });
  await app.close();
  console.log('OpenAPI spec written to server-openapi-specs.json');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

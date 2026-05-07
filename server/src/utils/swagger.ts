import { type INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type SwaggerDocumentOptions } from '@nestjs/swagger';
import { patchNestJsSwagger } from 'nestjs-zod';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { APP_NAME } from 'src/constants';

// Make NestJS Swagger understand Zod DTOs natively. Idempotent.
patchNestJsSwagger();

/**
 * Mount the Swagger UI at /api/docs and (optionally) write the generated OpenAPI
 * spec to disk for SDK codegen. Called by `bin/sync-open-api.ts`.
 */
export function useSwagger(app: INestApplication, { write }: { write: boolean }) {
  const config = new DocumentBuilder()
    .setTitle(`${APP_NAME} API`)
    .setDescription(`${APP_NAME} HTTP API`)
    .setVersion('0.1.0')
    .addCookieAuth('bo0kkeeper.id_token')
    .addServer('/api')
    .build();

  const options: SwaggerDocumentOptions = {
    operationIdFactory: (_controllerKey: string, methodKey: string) => methodKey,
  };

  const document = SwaggerModule.createDocument(app, config, options);

  SwaggerModule.setup('/api/docs', app, document);

  if (write) {
    writeFileSync(resolve(process.cwd(), 'server-openapi-specs.json'), JSON.stringify(document, null, 2));
  }
}

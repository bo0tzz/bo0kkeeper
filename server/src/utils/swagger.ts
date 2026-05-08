import { type INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type SwaggerDocumentOptions } from '@nestjs/swagger';
import { cleanupOpenApiDoc } from 'nestjs-zod';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { APP_NAME } from 'src/constants';

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

  const rawDocument = SwaggerModule.createDocument(app, config, options);
  // nestjs-zod 5: post-process the doc to inline Zod DTO schemas correctly.
  const document = cleanupOpenApiDoc(rawDocument);

  SwaggerModule.setup('/api/docs', app, document);

  if (write) {
    writeFileSync(resolve(process.cwd(), 'server-openapi-specs.json'), JSON.stringify(document, null, 2));
  }
}

import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { ZodSerializationException, ZodValidationException } from 'nestjs-zod';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter<Error> {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  constructor(private readonly cls: ClsService) {}

  catch(error: Error, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const correlationId = this.cls.getId();
    const { status, body } = this.fromError(error, correlationId);
    if (!response.headersSent) {
      if (correlationId) {
        response.setHeader('X-Correlation-Id', correlationId);
      }
      response.status(status).json({ ...body, statusCode: status, correlationId: correlationId ?? undefined });
    }
  }

  private fromError(error: Error, correlationId: string | undefined) {
    if (error instanceof ZodValidationException || error instanceof ZodSerializationException) {
      const zodError = error.getZodError() as { issues?: unknown[] };
      return {
        status: error instanceof ZodSerializationException ? 500 : 400,
        body: {
          message: error instanceof ZodSerializationException ? 'Response serialization failed' : 'Validation failed',
          errors: zodError.issues ?? [],
        },
      };
    }

    const prefix = correlationId ? `[${correlationId}] ` : '';
    this.logger.error(`${prefix}Unhandled exception: ${error}`, error instanceof Error ? error.stack : undefined);

    if (error instanceof HttpException) {
      const status = error.getStatus();
      let body = error.getResponse();
      if (typeof body === 'string') {
        body = { message: body };
      }
      return { status, body };
    }

    return {
      status: 500,
      body: { message: 'Internal server error' },
    };
  }
}

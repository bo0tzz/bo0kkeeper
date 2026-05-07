import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { Response } from 'express';
import { ZodSerializationException, ZodValidationException } from 'nestjs-zod';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter<Error> {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(error: Error, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const { status, body } = this.fromError(error);
    if (!response.headersSent) {
      response.status(status).json({ ...body, statusCode: status });
    }
  }

  private fromError(error: Error) {
    if (error instanceof ZodValidationException || error instanceof ZodSerializationException) {
      return {
        status: error instanceof ZodSerializationException ? 500 : 400,
        body: {
          message: error instanceof ZodSerializationException ? 'Response serialization failed' : 'Validation failed',
          errors: error.getZodError().issues,
        },
      };
    }

    this.logger.error(`Unhandled exception: ${error}`, error instanceof Error ? error.stack : undefined);

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

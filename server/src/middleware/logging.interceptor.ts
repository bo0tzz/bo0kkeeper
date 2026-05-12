import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Request, Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { finalize, Observable } from 'rxjs';

const maxArrayLength = 100;
// JSON.stringify calls the replacer recursively across every key, so nested
// secret keys are redacted too. Kept as substring matches to catch variants
// (`api_key`, `apiKey`, `refresh_token`, `Authorization`, …) without listing
// each one.
const SENSITIVE_KEY_PATTERNS = [
  'password',
  'token',
  'secret',
  'apikey',
  'api_key',
  'authorization',
  'cookie',
  'credential',
  'private_key',
  'privatekey',
];
const replacer = (key: string, value: unknown) => {
  const lowered = key.toLowerCase().replaceAll(/[\W_]/g, '');
  for (const pattern of SENSITIVE_KEY_PATTERNS) {
    if (lowered.includes(pattern.replaceAll(/[\W_]/g, ''))) {
      return '********';
    }
  }
  if (Array.isArray(value) && value.length > maxArrayLength) {
    return [...value.slice(0, maxArrayLength), `...and ${value.length - maxArrayLength} more`];
  }
  return value;
};

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(LoggingInterceptor.name);

  constructor(private readonly cls: ClsService) {}

  intercept(context: ExecutionContext, next: CallHandler<any>): Observable<any> {
    const handler = context.switchToHttp();
    const req = handler.getRequest<Request>();
    const res = handler.getResponse<Response>();

    const { method, ip, url } = req;
    const start = performance.now();

    // Echo the correlation id back so clients can quote it in bug reports.
    const correlationId = this.cls.getId();
    if (correlationId) {
      res.setHeader('X-Correlation-Id', correlationId);
    }

    return next.handle().pipe(
      finalize(() => {
        const duration = (performance.now() - start).toFixed(2);
        const { statusCode } = res;
        const prefix = correlationId ? `[${correlationId}] ` : '';
        this.logger.debug(`${prefix}${method} ${url} ${statusCode} ${duration}ms ${ip}`);
        if (req.body && Object.keys(req.body).length > 0) {
          this.logger.verbose(`${prefix}${JSON.stringify(req.body, replacer)}`);
        }
      }),
    );
  }
}

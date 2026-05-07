import { HttpError } from '@oazapfts/runtime';

export type ApiExceptionResponse = {
  message: string;
  error?: string;
  statusCode: number;
  errors?: unknown[];
  correlationId?: string;
};

export interface ApiHttpError extends HttpError {
  data: ApiExceptionResponse;
}

export function isHttpError(error: unknown): error is ApiHttpError {
  return error instanceof HttpError;
}

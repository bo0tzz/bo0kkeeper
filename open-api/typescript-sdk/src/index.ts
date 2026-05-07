import { defaults } from './fetch-client.js';

export * from './fetch-client.js';
export * from './fetch-errors.js';

export type InitOptions = {
  baseUrl: string;
  headers?: Record<string, string>;
};

export const init = ({ baseUrl, headers }: InitOptions) => {
  defaults.baseUrl = baseUrl;
  if (headers) {
    defaults.headers = { ...(defaults.headers ?? {}), ...headers };
  }
};

export const getBaseUrl = () => defaults.baseUrl;

export const setBaseUrl = (baseUrl: string) => {
  defaults.baseUrl = baseUrl;
};

export const setHeader = (key: string, value: string) => {
  defaults.headers = defaults.headers || {};
  defaults.headers[key] = value;
};

export const setHeaders = (headers: Record<string, string>) => {
  defaults.headers = defaults.headers || {};
  for (const [key, value] of Object.entries(headers)) {
    defaults.headers[key] = value;
  }
};

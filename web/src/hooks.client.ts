import type { HandleClientError } from '@sveltejs/kit';

const DEFAULT_MESSAGE = 'Something went wrong. Check the server logs.';

export const handleError: HandleClientError = ({ error, status, message }) => {
  const result = {
    message: (error as Error)?.message || message || DEFAULT_MESSAGE,
    code: status,
  };
  console.error('[hooks.client]', result.message, error);
  return result;
};

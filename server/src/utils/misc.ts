/**
 * Convert a handler method name into a default error message.
 *
 * @example
 * routeToErrorMessage('getInvoice') // → 'Failed to get invoice'
 */
export const routeToErrorMessage = (methodName: string): string =>
  'Failed to ' + methodName.replaceAll(/[A-Z]+/g, (letter) => ` ${letter.toLowerCase()}`);

/** Reverse-lookup an enum value to its declared key. */
export const getKeyByValue = (object: Record<string, unknown>, value: unknown) =>
  Object.keys(object).find((key) => object[key] === value);

/** Enumerate the own callable methods of an object instance (excluding accessors and `constructor`). */
export const getMethodNames = (instance: object): string[] => {
  const ctx = Object.getPrototypeOf(instance) as object;
  const methods: string[] = [];
  for (const property of Object.getOwnPropertyNames(ctx)) {
    if (property === 'constructor') {
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(ctx, property);
    if (!descriptor || descriptor.get || descriptor.set) {
      continue;
    }
    const handler = (instance as Record<string, unknown>)[property];
    if (typeof handler !== 'function') {
      continue;
    }
    methods.push(property);
  }
  return methods;
};

export class StartupError extends Error {}

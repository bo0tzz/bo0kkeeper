export const APP_NAME = 'bo0kkeeper';

/**
 * Build identifier baked into the Docker image as `APP_VERSION` (set by
 * CI from the release tag or commit SHA). Unset in local dev → `dev`.
 * Surfaced in startup logs + `GET /api/system/info` so prod can be
 * uniquely identified vs. what the operator expects to be running.
 */
export const APP_VERSION = process.env.APP_VERSION ?? 'dev';

export const MetadataKey = {
  AuthRoute: 'bo0kkeeper.auth.route',
  JobConfig: 'bo0kkeeper.job.config',
} as const;

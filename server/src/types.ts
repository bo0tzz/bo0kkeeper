import { JobName } from 'src/enum';

/** Identity for the currently authenticated user, derived from a verified ID token. */
export type AuthUser = {
  /** OIDC `sub` claim — stable user identifier from the IDP. */
  sub: string;
  /** Email claim if present. */
  email?: string;
  /** Display name claim if present. */
  name?: string;
};

/**
 * Discriminated union of every job's payload shape, keyed by JobName.
 *
 * As we add jobs in later phases, extend `JobItemMap` so that producers
 * (`jobRepository.queue(name, data)`) and consumers (`@OnJob` handlers) get
 * end-to-end typed payloads.
 */
type JobItemMap = {
  [JobName.WiseTransferStateChange]: { eventId: string };
  [JobName.ProcessPaperlessDocument]: { eventId: string };
};

/** Producer-side: `data` shape for a given job name. */
export type JobOf<T extends JobName> = T extends keyof JobItemMap ? JobItemMap[T] : never;

/** Discriminated job tuple — used by the dispatcher and tests. */
export type JobItem = {
  [K in JobName]: { name: K; data: JobOf<K> };
}[JobName];

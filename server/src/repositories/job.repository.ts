import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ModuleRef, Reflector } from '@nestjs/core';
import { type Job, PgBoss } from 'pg-boss';
import { loadConfig } from 'src/config';
import { MetadataKey } from 'src/constants';
import { JobConfig } from 'src/decorators';
import { JobName, QueueName } from 'src/enum';
import { JobItem, JobOf } from 'src/types';
import { getKeyByValue, getMethodNames, StartupError } from 'src/utils/misc';

type JobMapItem = {
  jobName: JobName;
  queueName: QueueName;
  handler: (data: unknown) => Promise<void>;
  label: string;
};

/**
 * Owns the pg-boss lifecycle and the discovery/registration of @OnJob handlers.
 *
 * Discovery is deliberately strict: at startup, every `JobName` enum value must
 * be backed by exactly one `@OnJob({ name })` handler somewhere in the registered
 * services. Missing or duplicate handlers throw `StartupError` and abort boot —
 * we'd rather fail at process start than silently drop work in production.
 */
@Injectable()
export class JobRepository implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JobRepository.name);
  private readonly handlers = new Map<JobName, JobMapItem>();
  private boss: PgBoss | null = null;

  constructor(private readonly moduleRef: ModuleRef) {}

  async onModuleInit(): Promise<void> {
    const config = loadConfig();
    const dbUrl =
      config.database.connectionType === 'url'
        ? config.database.url
        : `postgres://${config.database.username}:${config.database.password}@${config.database.host}:${config.database.port}/${config.database.database}`;
    this.boss = new PgBoss({ connectionString: dbUrl });
    this.boss.on('error', (error) => this.logger.error(`pg-boss error: ${error}`, error.stack));
    await this.boss.start();
    this.logger.log('pg-boss started');
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.boss) {
      return;
    }

    await this.boss.stop({ graceful: true, timeout: 5000 });
    this.boss = null;
  }

  /**
   * Discover @OnJob handlers across the given service classes, validate one-and-only-one
   * handler per JobName, and register each with pg-boss.
   *
   * Call from AppModule.onModuleInit AFTER this.boss has started.
   */
  async setup(services: (new (...args: any[]) => any)[]): Promise<void> {
    if (!this.boss) {
      throw new StartupError('JobRepository.setup called before pg-boss started');
    }
    const reflector = this.moduleRef.get(Reflector, { strict: false });

    for (const Service of services) {
      const instance = this.moduleRef.get<object>(Service, { strict: false });
      for (const methodName of getMethodNames(instance)) {
        const handler = (instance as Record<string, unknown>)[methodName] as (data: unknown) => Promise<void>;
        const config = reflector.get<JobConfig | undefined>(MetadataKey.JobConfig, handler);
        if (!config) {
          continue;
        }

        const { name: jobName, queue: queueName } = config;
        const label = `${Service.name}.${methodName}`;

        if (this.handlers.has(jobName)) {
          const jobKey = getKeyByValue(JobName, jobName) ?? jobName;
          const existing = this.handlers.get(jobName);
          throw new StartupError(`Duplicate handler for JobName.${jobKey}: ${label} conflicts with ${existing?.label}`);
        }

        this.handlers.set(jobName, { jobName, queueName, label, handler: handler.bind(instance) });
        this.logger.verbose(`Registered job handler: ${jobName} → ${label}`);
      }
    }

    // Every declared JobName must have a handler.
    for (const [jobKey, jobName] of Object.entries(JobName)) {
      if (!this.handlers.has(jobName as unknown as JobName)) {
        throw new StartupError(
          `Missing handler for JobName.${jobKey} ("${jobName}"). Add an @OnJob({ name: JobName.${jobKey}, queue: ... }) handler.`,
        );
      }
    }

    // Register each handler with pg-boss as a single-job queue.
    for (const [jobName, item] of this.handlers) {
      const queueName = jobName as unknown as string;
      await this.boss.createQueue(queueName);
      await this.boss.work(queueName, async (jobs: Job[]) => {
        for (const job of jobs) {
          await item.handler(job.data);
        }
      });
    }
  }

  /** Enqueue a job. Producer side. */
  async queue<T extends JobName>(name: T, data: JobOf<T>): Promise<string | null> {
    if (!this.boss) {
      throw new Error('JobRepository.queue called before pg-boss started');
    }
    return await this.boss.send(name as unknown as string, data as object);
  }

  /** Enqueue many jobs at once. */
  async queueAll(items: JobItem[]): Promise<void> {
    if (!this.boss) {
      throw new Error('JobRepository.queueAll called before pg-boss started');
    }
    await Promise.all(items.map((item) => this.boss!.send(item.name as unknown as string, item.data as object)));
  }

  /**
   * Register a cron schedule for `name`. Idempotent — calling with the same
   * (name, cron) replaces the existing entry. Used at boot for periodic jobs
   * like banking-sync; ad-hoc enqueues still go through `queue()`.
   */
  async schedule<T extends JobName>(name: T, cron: string, data: JobOf<T>): Promise<void> {
    if (!this.boss) {
      throw new Error('JobRepository.schedule called before pg-boss started');
    }
    await this.boss.schedule(name as unknown as string, cron, data as object);
    this.logger.log(`Scheduled ${name as unknown as string} on cron "${cron}"`);
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { OnJob } from 'src/decorators';
import { EventSource, JobName, QueueName, WiseTransferState } from 'src/enum';
import { EventRepository } from 'src/repositories/event.repository';
import { WiseApiError, WiseApiRepository } from 'src/repositories/wise-api.repository';
import { WiseTransferRepository, WiseTransferRow } from 'src/repositories/wise-transfer.repository';

/**
 * Belt-and-braces for missed `transfers#state-change` webhooks.
 *
 * For each non-terminal `wise_transfer`, GET its current state from Wise.
 * If it differs from what we have in the DB, apply the same state-update
 * the webhook handler would. We don't synthesize an event row — the only
 * thing the event log gives us that this doesn't is a per-transition
 * audit trail, and reconciliation is by definition catching transitions
 * we lost. We log the discrepancy at WARN so missed webhooks are visible.
 *
 * Cron-only entry point: there's no admin button. Wise webhooks are
 * normally reliable enough that this is a once-a-few-hours sweep, not
 * something the user needs to drive.
 */
@Injectable()
export class WiseReconcileService {
  private readonly logger = new Logger(WiseReconcileService.name);

  constructor(
    private readonly wiseTransferRepository: WiseTransferRepository,
    private readonly wiseApi: WiseApiRepository,
    private readonly eventRepository: EventRepository,
  ) {}

  @OnJob({ name: JobName.WiseReconcile, queue: QueueName.Default })
  async handleReconcile(): Promise<void> {
    await this.reconcileAll();
  }

  async reconcileAll(): Promise<{ checked: number; updated: number; missing: number }> {
    const rows = await this.wiseTransferRepository.findReconcilable();
    let updated = 0;
    let missing = 0;
    for (const row of rows) {
      const r = await this.reconcileOne(row);
      if (r === 'updated') {
        updated += 1;
      } else if (r === 'missing') {
        missing += 1;
      }
    }
    this.logger.log(`wise reconcile: ${rows.length} checked, ${updated} updated, ${missing} missing`);
    await this.eventRepository.recordAction({
      source: EventSource.System,
      eventType: 'wise.reconcile.completed',
      payload: { checked: rows.length, updated, missing },
    });
    return { checked: rows.length, updated, missing };
  }

  private async reconcileOne(row: WiseTransferRow): Promise<'unchanged' | 'updated' | 'missing' | 'error'> {
    const wiseId = Number.parseInt(row.wiseTransferId, 10);
    if (Number.isNaN(wiseId)) {
      // Sandbox uses numeric ids; non-numeric is a manual fixture row we can ignore.
      return 'unchanged';
    }
    let upstream;
    try {
      upstream = await this.wiseApi.getTransfer(wiseId);
    } catch (error) {
      if (error instanceof WiseApiError && error.status === 404) {
        // Transfer disappeared upstream — log and move on; don't churn on it next tick.
        this.logger.warn(`wise transfer ${row.wiseTransferId} returned 404; skipping`);
        return 'missing';
      }
      this.logger.error(`reconcile failed for ${row.wiseTransferId}: ${(error as Error).message}`);
      return 'error';
    }
    if (upstream.state === row.state) {
      return 'unchanged';
    }
    this.logger.warn(
      `wise transfer ${row.wiseTransferId}: local=${row.state} upstream=${upstream.state} (likely missed webhook)`,
    );
    await this.wiseTransferRepository.updateState(row.wiseTransferId, upstream.state as WiseTransferState, new Date());
    return 'updated';
  }
}

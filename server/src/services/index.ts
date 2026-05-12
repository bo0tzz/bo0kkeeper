import { BankMatcherService } from 'src/services/bank-matcher.service';
import { BankingSessionService } from 'src/services/banking-session.service';
import { BankingSyncService } from 'src/services/banking-sync.service';
import { BookkeepingExportService } from 'src/services/bookkeeping-export.service';
import { ExpensePipelineService } from 'src/services/expense-pipeline.service';
import { InvoiceComposerService } from 'src/services/invoice-composer.service';
import { QuarterlyAggregatorService } from 'src/services/quarterly-aggregator.service';
import { SettingsService } from 'src/services/settings.service';
import { SheetWriterService } from 'src/services/sheet-writer.service';
import { SystemHealthService } from 'src/services/system-health.service';
import { WebhookService } from 'src/services/webhook.service';
import { WiseDraftService } from 'src/services/wise-draft.service';
import { WiseEventService } from 'src/services/wise-event.service';
import { WiseReconcileService } from 'src/services/wise-reconcile.service';

export const services = [
  BankingSessionService,
  BankingSyncService,
  BankMatcherService,
  BookkeepingExportService,
  ExpensePipelineService,
  InvoiceComposerService,
  QuarterlyAggregatorService,
  SettingsService,
  SheetWriterService,
  SystemHealthService,
  WebhookService,
  WiseDraftService,
  WiseEventService,
  WiseReconcileService,
];

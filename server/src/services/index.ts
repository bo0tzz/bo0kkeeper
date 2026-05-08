import { AuthService } from 'src/services/auth.service';
import { BankMatcherService } from 'src/services/bank-matcher.service';
import { BankingSessionService } from 'src/services/banking-session.service';
import { EnableBankingApiService } from 'src/services/enable-banking-api.service';
import { ExpensePipelineService } from 'src/services/expense-pipeline.service';
import { InvoiceComposerService } from 'src/services/invoice-composer.service';
import { PaperlessService } from 'src/services/paperless.service';
import { QuarterlyAggregatorService } from 'src/services/quarterly-aggregator.service';
import { RenderService } from 'src/services/render.service';
import { SheetWriterService } from 'src/services/sheet-writer.service';
import { SheetsService } from 'src/services/sheets.service';
import { WebhookService } from 'src/services/webhook.service';
import { WiseApiService } from 'src/services/wise-api.service';
import { WiseDraftService } from 'src/services/wise-draft.service';
import { WiseEventService } from 'src/services/wise-event.service';

export const services = [
  AuthService,
  BankingSessionService,
  BankMatcherService,
  EnableBankingApiService,
  ExpensePipelineService,
  InvoiceComposerService,
  PaperlessService,
  QuarterlyAggregatorService,
  RenderService,
  SheetsService,
  SheetWriterService,
  WebhookService,
  WiseApiService,
  WiseDraftService,
  WiseEventService,
];

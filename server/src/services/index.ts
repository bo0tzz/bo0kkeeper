import { AuthService } from 'src/services/auth.service';
import { InvoiceComposerService } from 'src/services/invoice-composer.service';
import { PaperlessService } from 'src/services/paperless.service';
import { RenderService } from 'src/services/render.service';
import { SheetsService } from 'src/services/sheets.service';
import { WebhookService } from 'src/services/webhook.service';
import { WiseApiService } from 'src/services/wise-api.service';
import { WiseDraftService } from 'src/services/wise-draft.service';
import { WiseEventService } from 'src/services/wise-event.service';

export const services = [
  AuthService,
  InvoiceComposerService,
  PaperlessService,
  RenderService,
  SheetsService,
  WebhookService,
  WiseApiService,
  WiseDraftService,
  WiseEventService,
];

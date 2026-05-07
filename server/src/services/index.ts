import { AuthService } from 'src/services/auth.service';
import { WebhookService } from 'src/services/webhook.service';
import { WiseApiService } from 'src/services/wise-api.service';
import { WiseDraftService } from 'src/services/wise-draft.service';
import { WiseEventService } from 'src/services/wise-event.service';

export const services = [AuthService, WebhookService, WiseApiService, WiseDraftService, WiseEventService];

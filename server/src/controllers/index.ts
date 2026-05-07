import { AuthController } from 'src/controllers/auth.controller';
import { EventsController } from 'src/controllers/events.controller';
import { HealthController } from 'src/controllers/health.controller';
import { WebhookController } from 'src/controllers/webhook.controller';

export const controllers = [AuthController, EventsController, HealthController, WebhookController];

import { AuthController } from 'src/controllers/auth.controller';
import { ClientsController } from 'src/controllers/clients.controller';
import { EventsController } from 'src/controllers/events.controller';
import { HealthController } from 'src/controllers/health.controller';
import { WebhookController } from 'src/controllers/webhook.controller';
import { WiseController } from 'src/controllers/wise.controller';

export const controllers = [
  AuthController,
  ClientsController,
  EventsController,
  HealthController,
  WebhookController,
  WiseController,
];

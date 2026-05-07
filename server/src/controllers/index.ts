import { AggregatorController } from 'src/controllers/aggregator.controller';
import { AuthController } from 'src/controllers/auth.controller';
import { ClientsController } from 'src/controllers/clients.controller';
import { EventsController } from 'src/controllers/events.controller';
import { ExpensesController } from 'src/controllers/expenses.controller';
import { HealthController } from 'src/controllers/health.controller';
import { WebhookController } from 'src/controllers/webhook.controller';
import { WiseController } from 'src/controllers/wise.controller';

export const controllers = [
  AggregatorController,
  AuthController,
  ClientsController,
  EventsController,
  ExpensesController,
  HealthController,
  WebhookController,
  WiseController,
];

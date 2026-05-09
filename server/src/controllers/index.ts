import { AggregatorController } from 'src/controllers/aggregator.controller';
import { AuthController } from 'src/controllers/auth.controller';
import { BankingController } from 'src/controllers/banking.controller';
import { ClientsController } from 'src/controllers/clients.controller';
import { EventsController } from 'src/controllers/events.controller';
import { ExpensesController } from 'src/controllers/expenses.controller';
import { HealthController } from 'src/controllers/health.controller';
import { InvoicesController } from 'src/controllers/invoices.controller';
import { SettingsController } from 'src/controllers/settings.controller';
import { SystemController } from 'src/controllers/system.controller';
import { TransactionsController } from 'src/controllers/transactions.controller';
import { WebhookController } from 'src/controllers/webhook.controller';
import { WiseController } from 'src/controllers/wise.controller';

export const controllers = [
  AggregatorController,
  AuthController,
  BankingController,
  ClientsController,
  EventsController,
  ExpensesController,
  HealthController,
  InvoicesController,
  SettingsController,
  SystemController,
  TransactionsController,
  WebhookController,
  WiseController,
];

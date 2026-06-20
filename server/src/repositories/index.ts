import { AppSettingsRepository } from 'src/repositories/app-settings.repository';
import { BankTransactionRepository } from 'src/repositories/bank-transaction.repository';
import { BankingSessionRepository } from 'src/repositories/banking-session.repository';
import { ClientRepository } from 'src/repositories/client.repository';
import { EnableBankingRepository } from 'src/repositories/enable-banking.repository';
import { EventRepository } from 'src/repositories/event.repository';
import { ExpenseRepository } from 'src/repositories/expense.repository';
import { HealthRepository } from 'src/repositories/health.repository';
import { InvoiceRepository } from 'src/repositories/invoice.repository';
import { JobRepository } from 'src/repositories/job.repository';
import { OidcRepository } from 'src/repositories/oidc.repository';
import { PaperlessRepository } from 'src/repositories/paperless.repository';
import { PeriodCloseRepository } from 'src/repositories/period-close.repository';
import { SheetsRepository } from 'src/repositories/sheets.repository';
import { TypstRepository } from 'src/repositories/typst.repository';
import { WiseApiRepository } from 'src/repositories/wise-api.repository';
import { WiseTransferRepository } from 'src/repositories/wise-transfer.repository';

export const repositories = [
  AppSettingsRepository,
  BankTransactionRepository,
  BankingSessionRepository,
  ClientRepository,
  EnableBankingRepository,
  EventRepository,
  ExpenseRepository,
  HealthRepository,
  InvoiceRepository,
  JobRepository,
  OidcRepository,
  PaperlessRepository,
  PeriodCloseRepository,
  SheetsRepository,
  TypstRepository,
  WiseApiRepository,
  WiseTransferRepository,
];

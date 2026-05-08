import { BankTransactionRepository } from 'src/repositories/bank-transaction.repository';
import { BankingSessionRepository } from 'src/repositories/banking-session.repository';
import { ClientRepository } from 'src/repositories/client.repository';
import { EventRepository } from 'src/repositories/event.repository';
import { ExpenseRepository } from 'src/repositories/expense.repository';
import { InvoiceRepository } from 'src/repositories/invoice.repository';
import { JobRepository } from 'src/repositories/job.repository';
import { WiseTransferRepository } from 'src/repositories/wise-transfer.repository';

export const repositories = [
  BankTransactionRepository,
  BankingSessionRepository,
  ClientRepository,
  EventRepository,
  ExpenseRepository,
  InvoiceRepository,
  JobRepository,
  WiseTransferRepository,
];

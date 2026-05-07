import { BankTransactionRepository } from 'src/repositories/bank-transaction.repository';
import { ClientRepository } from 'src/repositories/client.repository';
import { EventRepository } from 'src/repositories/event.repository';
import { InvoiceRepository } from 'src/repositories/invoice.repository';
import { JobRepository } from 'src/repositories/job.repository';
import { WiseTransferRepository } from 'src/repositories/wise-transfer.repository';

export const repositories = [
  BankTransactionRepository,
  ClientRepository,
  EventRepository,
  InvoiceRepository,
  JobRepository,
  WiseTransferRepository,
];

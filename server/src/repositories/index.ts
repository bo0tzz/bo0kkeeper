import { ClientRepository } from 'src/repositories/client.repository';
import { EventRepository } from 'src/repositories/event.repository';
import { JobRepository } from 'src/repositories/job.repository';
import { WiseTransferRepository } from 'src/repositories/wise-transfer.repository';

export const repositories = [ClientRepository, EventRepository, JobRepository, WiseTransferRepository];

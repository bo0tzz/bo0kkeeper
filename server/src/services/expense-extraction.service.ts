import { Injectable, Logger } from '@nestjs/common';
import { OnJob } from 'src/decorators';
import { ExpenseStatus, JobName, QueueName } from 'src/enum';
import { ExpenseRepository, ExpenseUpdate } from 'src/repositories/expense.repository';
import { LlmRepository } from 'src/repositories/llm.repository';
import { PaperlessRepository } from 'src/repositories/paperless.repository';
import { SettingsService } from 'src/services/settings.service';
import { JobOf } from 'src/types';
import {
  EXPENSE_EXTRACT_MAX_CHARS,
  EXPENSE_EXTRACT_TEMPLATE,
  renderFieldDescriptions,
  toExpensePrefill,
} from 'src/utils/expense-extraction';
import { btwInGross } from 'src/utils/money';

/**
 * Prefills freshly ingested paperless expenses from the document text with
 * the local extraction model, so review is checking values instead of typing
 * them. The BTW amount is derived from the total and rate rather than read
 * off the receipt; the vendor is only filled when ingest left it empty.
 */
@Injectable()
export class ExpenseExtractionService {
  private readonly logger = new Logger(ExpenseExtractionService.name);

  constructor(
    private readonly expenseRepository: ExpenseRepository,
    private readonly llmRepository: LlmRepository,
    private readonly paperlessRepository: PaperlessRepository,
    private readonly settingsService: SettingsService,
  ) {}

  @OnJob({ name: JobName.ExtractExpenseFields, queue: QueueName.Default })
  async handleExtractExpenseFields({ expenseId }: JobOf<JobName.ExtractExpenseFields>): Promise<void> {
    const expense = await this.expenseRepository.findById(expenseId);
    if (!expense?.paperlessDocId || expense.status !== ExpenseStatus.PendingReview) {
      return;
    }

    const document = await this.paperlessRepository.getDocument(expense.paperlessDocId);
    const text = document.content.slice(0, EXPENSE_EXTRACT_MAX_CHARS);
    if (!text.trim()) {
      this.logger.log(`No text on paperless ${expense.paperlessDocId}; nothing to extract for expense ${expense.id}`);
      return;
    }

    const { ownNames, fieldDescriptions } = await this.settingsService.getExpenseExtraction();
    const started = Date.now();
    const output = await this.llmRepository.extract({
      template: EXPENSE_EXTRACT_TEMPLATE,
      descriptions: renderFieldDescriptions(fieldDescriptions),
      text,
    });
    const prefill = toExpensePrefill(output, ownNames);
    if (expense.vendor) {
      delete prefill.vendor;
    }

    const patch: ExpenseUpdate = { prefilled: prefill };
    if (prefill.vendor) {
      patch.vendor = prefill.vendor;
    }
    if (prefill.expenseDate) {
      patch.expenseDate = prefill.expenseDate;
    }
    if (prefill.btwRateBps !== undefined) {
      patch.btwRateBps = prefill.btwRateBps;
    }
    if (prefill.amountMinor !== undefined) {
      patch.amountMinor = BigInt(prefill.amountMinor);
      if (prefill.btwRateBps !== undefined) {
        patch.btwMinor = btwInGross(patch.amountMinor, prefill.btwRateBps);
      }
    }

    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    const fields = Object.keys(prefill);
    if (fields.length === 0) {
      this.logger.log(`Extraction found nothing usable for expense ${expense.id} (${elapsed}s)`);
      return;
    }
    const updated = await this.expenseRepository.applyPrefill(expense.id, patch);
    if (updated) {
      this.logger.log(`Prefilled ${fields.join(', ')} on expense ${expense.id} (${elapsed}s)`);
    } else {
      this.logger.log(`Expense ${expense.id} changed during extraction; keeping the operator's values`);
    }
  }
}

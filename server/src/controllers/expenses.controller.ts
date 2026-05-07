import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Authenticated } from 'src/decorators';
import {
  ExpenseApproveDto,
  ExpenseRejectDto,
  ExpenseResponseDto,
  ExpenseUpdateDto,
  ListExpensesQueryDto,
  ListExpensesResponseDto,
  mapExpense,
} from 'src/dtos/expense.dto';
import { ExpenseRepository, ExpenseUpdate } from 'src/repositories/expense.repository';

@ApiTags('Expenses')
@Controller('/api/expenses')
export class ExpensesController {
  constructor(private readonly expenseRepository: ExpenseRepository) {}

  @Get()
  @Authenticated()
  async listExpenses(@Query() query: ListExpensesQueryDto): Promise<ListExpensesResponseDto> {
    const page = await this.expenseRepository.findMany({
      status: query.status,
      locationClass: query.locationClass,
      from: query.from,
      to: query.to,
      limit: query.limit,
      offset: query.offset,
    });
    return {
      items: page.items.map((row) => mapExpense(row)),
      total: page.total,
      hasMore: page.hasMore,
    } as ListExpensesResponseDto;
  }

  @Get(':id')
  @Authenticated()
  async getExpense(@Param('id', ParseUUIDPipe) id: string): Promise<ExpenseResponseDto> {
    const row = await this.expenseRepository.findById(id);
    if (!row) {
      throw new NotFoundException();
    }
    return mapExpense(row);
  }

  /**
   * Patch a pending expense without changing its status — used while reviewing
   * (filling in amount, BTW split, category) before the user commits to approve.
   */
  @Patch(':id')
  @Authenticated()
  async updateExpense(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ExpenseUpdateDto,
  ): Promise<ExpenseResponseDto> {
    const row = await this.expenseRepository.update(id, dto as unknown as ExpenseUpdate);
    if (!row) {
      throw new NotFoundException();
    }
    return mapExpense(row);
  }

  /**
   * Approve a pending expense. Body fields are merged in atomically with the
   * status flip, so the UI can submit "save + approve" in a single request.
   */
  @Post(':id/approve')
  @Authenticated()
  async approveExpense(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ExpenseApproveDto,
  ): Promise<ExpenseResponseDto> {
    const row = await this.expenseRepository.approve(id, dto as unknown as ExpenseUpdate);
    if (!row) {
      throw new NotFoundException();
    }
    return mapExpense(row);
  }

  /** Reject the expense (paperless doc was misclassified, isn't a business expense, etc). */
  @Post(':id/reject')
  @Authenticated()
  async rejectExpense(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ExpenseRejectDto,
  ): Promise<ExpenseResponseDto> {
    const row = await this.expenseRepository.reject(id, dto.notes);
    if (!row) {
      throw new NotFoundException();
    }
    return mapExpense(row);
  }
}

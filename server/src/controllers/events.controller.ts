import { Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApiQueryFromDto, Authenticated } from 'src/decorators';
import { EventResponseDto, ListEventsQueryDto, ListEventsResponseDto, mapEvent } from 'src/dtos/event.dto';
import { EventSource } from 'src/enum';
import { EventRepository } from 'src/repositories/event.repository';

@ApiTags('Events')
@Controller('/api/events')
export class EventsController {
  constructor(private readonly eventRepository: EventRepository) {}

  @Get()
  @Authenticated()
  @ApiQueryFromDto(ListEventsQueryDto)
  async listEvents(@Query() query: ListEventsQueryDto): Promise<ListEventsResponseDto> {
    const page = await this.eventRepository.findMany({
      source: query.source,
      eventType: query.eventType,
      status: query.status,
      since: query.since,
      limit: query.limit,
      offset: query.offset,
    });
    return {
      items: page.items.map((event) => mapEvent(event)),
      total: page.total,
      hasMore: page.hasMore,
    } as ListEventsResponseDto;
  }

  @Get(':id')
  @Authenticated()
  async getEvent(@Param('id', ParseUUIDPipe) id: string): Promise<EventResponseDto | { message: string }> {
    const event = await this.eventRepository.findById(id);
    if (!event) {
      return { message: 'Event not found' };
    }
    return mapEvent(event);
  }

  /**
   * Drop an event out of the pending inbox without acting on it. Records a
   * `system/event.dismissed` audit event so the reason survives in history.
   * Common case: Wise `balances#credit` below the transfer minimum (e.g. a
   * 41-cent cashback) — leave the balance to accumulate; dismiss the event
   * so it stops cluttering the inbox.
   */
  @Post(':id/dismiss')
  @Authenticated()
  async dismissEvent(@Param('id', ParseUUIDPipe) id: string): Promise<EventResponseDto> {
    const event = await this.eventRepository.findById(id);
    if (!event) {
      throw new NotFoundException('Event not found');
    }
    await this.eventRepository.markSkipped(id);
    await this.eventRepository.recordAction({
      source: EventSource.System,
      eventType: 'event.dismissed',
      payload: {
        dismissedEventId: id,
        dismissedSource: event.source,
        dismissedType: event.eventType,
      },
      correlationId: event.correlationId ?? undefined,
    });
    const refreshed = await this.eventRepository.findById(id);
    return mapEvent(refreshed!);
  }
}

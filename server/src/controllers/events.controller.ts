import { Controller, Get, Param, Query } from '@nestjs/common';
import { Authenticated } from 'src/decorators';
import { EventResponseDto, ListEventsQueryDto, ListEventsResponseDto, mapEvent } from 'src/dtos/event.dto';
import { EventRepository } from 'src/repositories/event.repository';
import { UUIDParamDto } from 'src/validation';

@Controller('/api/events')
export class EventsController {
  constructor(private readonly eventRepository: EventRepository) {}

  @Get()
  @Authenticated()
  async list(@Query() query: ListEventsQueryDto): Promise<ListEventsResponseDto> {
    const page = await this.eventRepository.findMany({
      source: query.source,
      eventType: query.eventType,
      status: query.status,
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
  async getOne(@Param() { id }: UUIDParamDto): Promise<EventResponseDto | { message: string }> {
    const event = await this.eventRepository.findById(id);
    if (!event) {
      return { message: 'Event not found' };
    }
    return mapEvent(event);
  }
}

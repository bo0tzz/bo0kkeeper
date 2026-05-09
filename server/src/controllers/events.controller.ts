import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApiQueryFromDto, Authenticated } from 'src/decorators';
import { EventResponseDto, ListEventsQueryDto, ListEventsResponseDto, mapEvent } from 'src/dtos/event.dto';
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
}

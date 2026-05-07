import { Body, Controller, Delete, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Authenticated } from 'src/decorators';
import { ClientCreateDto, ClientResponseDto, ClientUpdateDto, mapClient } from 'src/dtos/client.dto';
import { ClientRepository } from 'src/repositories/client.repository';

@ApiTags('Clients')
@Controller('/api/clients')
export class ClientsController {
  constructor(private readonly clientRepository: ClientRepository) {}

  @Get()
  @Authenticated()
  async listClients(): Promise<ClientResponseDto[]> {
    const clients = await this.clientRepository.findAll();
    return clients.map((c) => mapClient(c));
  }

  @Get(':id')
  @Authenticated()
  async getClient(@Param('id', ParseUUIDPipe) id: string): Promise<ClientResponseDto> {
    const client = await this.clientRepository.findById(id);
    if (!client) {
      throw new NotFoundException();
    }
    return mapClient(client);
  }

  @Post()
  @Authenticated()
  async createClient(@Body() dto: ClientCreateDto): Promise<ClientResponseDto> {
    const client = await this.clientRepository.create(dto as unknown as Parameters<ClientRepository['create']>[0]);
    return mapClient(client);
  }

  @Patch(':id')
  @Authenticated()
  async updateClient(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ClientUpdateDto): Promise<ClientResponseDto> {
    const client = await this.clientRepository.update(id, dto as unknown as Parameters<ClientRepository['update']>[1]);
    if (!client) {
      throw new NotFoundException();
    }
    return mapClient(client);
  }

  @Delete(':id')
  @Authenticated()
  async deleteClient(@Param('id', ParseUUIDPipe) id: string): Promise<{ deleted: boolean }> {
    await this.clientRepository.delete(id);
    return { deleted: true };
  }
}

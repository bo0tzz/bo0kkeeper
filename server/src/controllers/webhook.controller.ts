import { Body, Controller, Headers, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { PaperlessWebhookDto, WiseWebhookDto } from 'src/dtos/webhook.dto';
import { WebhookService } from 'src/services/webhook.service';

type RawRequest = Request & { rawBody?: string };

@ApiTags('Webhooks')
@Controller('/api/webhooks')
export class WebhookController {
  constructor(private readonly webhookService: WebhookService) {}

  /**
   * Wise webhook endpoint. RSA-SHA256-signed bodies are verified before ingestion.
   * The handler is intentionally minimal — verify, idempotent INSERT, return 200.
   * Side effects (drafting transfers, generating invoices, writing the sheet) live
   * in pg-boss job handlers that run downstream of the events row.
   */
  @Post('wise')
  @HttpCode(HttpStatus.OK)
  async ingestWiseWebhook(
    @Req() req: RawRequest,
    @Body() body: WiseWebhookDto,
    @Headers('x-signature-sha256') signature: string | undefined,
    @Headers('x-delivery-id') deliveryId: string | undefined,
  ) {
    this.webhookService.verifyWiseSignature(req.rawBody ?? '', signature);
    const result = await this.webhookService.ingestWiseEvent(body, deliveryId);
    return { ingested: result.ingested };
  }

  /**
   * Paperless-ngx workflow webhook endpoint. paperless-ngx fires a "Webhook"
   * action on document consumption with a JSON body containing the document
   * id (and whatever extra fields the workflow template includes). Auth is a
   * shared bearer token; the workflow is configured to send it.
   */
  @Post('paperless')
  @HttpCode(HttpStatus.OK)
  async ingestPaperlessWebhook(
    @Body() body: PaperlessWebhookDto,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-delivery-id') deliveryId: string | undefined,
  ) {
    this.webhookService.verifyPaperlessAuthorization(authorization);
    const result = await this.webhookService.ingestPaperlessEvent(body, deliveryId);
    return { ingested: result.ingested };
  }
}

import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController } from 'src/controllers/health.controller';
import { HealthRepository } from 'src/repositories/health.repository';
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('HealthController', () => {
  let controller: HealthController;
  let pingSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    pingSpy = vi.fn();
    controller = new HealthController({ ping: pingSpy } as unknown as HealthRepository);
  });

  it('GET /api/health returns ok unconditionally (liveness)', () => {
    expect(controller.getHealth()).toEqual({ status: 'ok' });
  });

  it('GET /api/health/ready returns ok when DB ping succeeds', async () => {
    pingSpy.mockResolvedValue(void 0);
    await expect(controller.getReady()).resolves.toEqual({ status: 'ok' });
    expect(pingSpy).toHaveBeenCalledOnce();
  });

  it('GET /api/health/ready throws 503 with reason when DB ping fails', async () => {
    pingSpy.mockRejectedValue(new Error('connection refused'));
    const result = controller.getReady();
    await expect(result).rejects.toBeInstanceOf(ServiceUnavailableException);
    try {
      await result;
    } catch (error) {
      expect((error as ServiceUnavailableException).getResponse()).toMatchObject({
        status: 'not_ready',
        reason: 'connection refused',
      });
    }
  });
});

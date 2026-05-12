import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController } from 'src/controllers/health.controller';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Spy that `sql\`SELECT 1\`.execute()` resolves through. Replaced per test
// for ok/fail cases.
const executeSpy = vi.fn();

vi.mock('kysely', async () => {
  const actual = await vi.importActual<typeof import('kysely')>('kysely');
  return {
    ...actual,
    // sql is a tag function; readiness only uses `sql`...`.execute(db)`, so
    // return the bare shape it expects.
    sql: () => ({ execute: () => executeSpy() }),
  };
});

describe('HealthController', () => {
  let controller: HealthController;

  beforeEach(() => {
    executeSpy.mockReset();
    controller = new HealthController({} as never);
  });

  it('GET /api/health returns ok unconditionally (liveness)', () => {
    expect(controller.getHealth()).toEqual({ status: 'ok' });
  });

  it('GET /api/health/ready returns ok when DB ping succeeds', async () => {
    executeSpy.mockResolvedValue({ rows: [{ '?column?': 1 }] });
    await expect(controller.getReady()).resolves.toEqual({ status: 'ok' });
    expect(executeSpy).toHaveBeenCalledOnce();
  });

  it('GET /api/health/ready throws 503 with reason when DB ping fails', async () => {
    executeSpy.mockRejectedValue(new Error('connection refused'));
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

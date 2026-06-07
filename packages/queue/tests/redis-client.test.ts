/**
 * Unit tests for `createRedisClient` — option-mapping coverage without
 * an actual Redis instance.
 *
 * `ioredis` and `@winback/config` are vi.mock'd so each test asserts the
 * argument shape passed to the Redis constructor without opening a TCP
 * connection. Real-connection tests land in step 5 with Docker Redis.
 *
 * Four tests, one per critical mapping:
 *   1. BullMQ-required options always applied
 *   2. TLS options set correctly for rediss:// URLs
 *   3. TLS options ABSENT for redis:// URLs (even when flag is true)
 *   4. connectionName plumbed through for CLIENT LIST visibility
 */

import { getRedisConfig, type RedisConfig } from '@winback/config';
import { Redis } from 'ioredis';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';


import { createRedisClient } from '../src/redis-client.js';

vi.mock('@winback/config', () => ({
  getRedisConfig: vi.fn(),
}));

vi.mock('ioredis', () => ({
  Redis: vi.fn(),
}));

const getRedisConfigMock = vi.mocked(getRedisConfig);
// Cast RedisMock to a typed Mock with the ioredis constructor signature
// (vi.mocked alone infers `mock.calls[0]` as `[]` because the real
// Redis class's typed constructor overloads don't reach the mock layer).
// The cast at the import site centralises the typing so every access site
// gets `[url, options]` instead of `[]`.
const RedisMock = vi.mocked(Redis) as unknown as Mock<
  (url: string, options?: Record<string, unknown>) => unknown
>;

function configFixture(overrides?: Partial<RedisConfig>): RedisConfig {
  return {
    REDIS_URL: 'redis://localhost:6380',
    REDIS_TLS_REJECT_UNAUTHORIZED: true,
    ...overrides,
  };
}

beforeEach(() => {
  RedisMock.mockClear();
  getRedisConfigMock.mockReset();
});

describe('createRedisClient', () => {
  it('1. applies BullMQ-required options (maxRetriesPerRequest=null, enableReadyCheck=false)', () => {
    getRedisConfigMock.mockReturnValue(configFixture());

    createRedisClient('test.client');

    expect(RedisMock).toHaveBeenCalledTimes(1);
    const call = RedisMock.mock.calls[0];
    expect(call).toBeDefined();
    const [url, options] = call as [string, Record<string, unknown>];
    expect(url).toBe('redis://localhost:6380');
    expect(options).toMatchObject({
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
  });

  it('2. sets TLS options for rediss:// URLs with rejectUnauthorized from config', () => {
    getRedisConfigMock.mockReturnValue(
      configFixture({
        REDIS_URL: 'rediss://managed.example.com:6380',
        REDIS_TLS_REJECT_UNAUTHORIZED: true,
      }),
    );

    createRedisClient('test.tls');

    const options = RedisMock.mock.calls[0]?.[1] as { tls?: { rejectUnauthorized: boolean } };
    expect(options.tls).toEqual({ rejectUnauthorized: true });
  });

  it('3. does NOT set TLS for redis:// URLs (even when flag is true)', () => {
    getRedisConfigMock.mockReturnValue(
      configFixture({
        REDIS_URL: 'redis://plain.example.com:6380',
        // Flag is true but the URL is plaintext — TLS options must be
        // absent. Otherwise ioredis would attempt a TLS handshake on a
        // plaintext socket, which fails opaquely.
        REDIS_TLS_REJECT_UNAUTHORIZED: true,
      }),
    );

    createRedisClient('test.plaintext');

    const options = RedisMock.mock.calls[0]?.[1] as { tls?: unknown };
    expect(options.tls).toBeUndefined();
  });

  it('4. sets connectionName for Redis CLIENT LIST visibility', () => {
    getRedisConfigMock.mockReturnValue(configFixture());

    createRedisClient('worker.outbox-drain');

    const options = RedisMock.mock.calls[0]?.[1] as { connectionName?: string };
    expect(options.connectionName).toBe('worker.outbox-drain');
  });
});

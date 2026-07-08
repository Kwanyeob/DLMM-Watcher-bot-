import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Fake Connection whose getLatestBlockhash we flip between resolving/rejecting
// to simulate a live vs. dropped RPC connection, without touching real network.
const instances: Array<{ getLatestBlockhash: ReturnType<typeof vi.fn> }> = [];

vi.mock('@solana/web3.js', () => ({
  Connection: vi.fn().mockImplementation(() => {
    const conn = { getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: 'ok' }) };
    instances.push(conn);
    return conn;
  }),
}));

import { ReliableWebSocket } from './ReliableWebSocket';

describe('ReliableWebSocket resilience', () => {
  beforeEach(() => {
    instances.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('replays every registered subscriber on the new connection after a heartbeat failure', async () => {
    const ws = new ReliableWebSocket('http://rpc.test', 'ws://rpc.test');
    expect(instances).toHaveLength(1);

    const subA = vi.fn().mockResolvedValue(undefined);
    const subB = vi.fn().mockResolvedValue(undefined);
    ws.register('position-detector', subA);
    ws.register('position-watcher', subB);

    // register() replays immediately against the current connection
    expect(subA).toHaveBeenCalledTimes(1);
    expect(subB).toHaveBeenCalledTimes(1);

    // Simulate the RPC connection dropping: the next heartbeat check fails.
    instances[0].getLatestBlockhash.mockRejectedValue(new Error('connection lost'));

    // Heartbeat runs every 20s and detects the failure, kicking off reconnect(1).
    await vi.advanceTimersByTimeAsync(20_000);
    // reconnect(1) backs off for 1s (2^0 * 1000ms) before creating a new connection.
    await vi.advanceTimersByTimeAsync(1_000);

    expect(instances).toHaveLength(2);
    expect(subA).toHaveBeenCalledTimes(2);
    expect(subB).toHaveBeenCalledTimes(2);

    ws.destroy();
  });

  it('backs off exponentially and keeps retrying until a connection succeeds', async () => {
    const ws = new ReliableWebSocket('http://rpc.test', 'ws://rpc.test');
    const sub = vi.fn().mockResolvedValue(undefined);
    ws.register('watcher', sub);

    instances[0].getLatestBlockhash.mockRejectedValue(new Error('down'));
    await vi.advanceTimersByTimeAsync(20_000); // heartbeat fires -> reconnect(1) scheduled

    // Make the first two reconnect attempts fail during re-subscription,
    // and let the third succeed.
    let reconnectAttempt = 0;
    sub.mockImplementation(() => {
      reconnectAttempt += 1;
      if (reconnectAttempt <= 2) return Promise.reject(new Error('resubscribe failed'));
      return Promise.resolve();
    });

    // attempt 1: 1s backoff, then subscriber throws -> attempt 2 scheduled
    await vi.advanceTimersByTimeAsync(1_000);
    // attempt 2: 2s backoff, then subscriber throws -> attempt 3 scheduled
    await vi.advanceTimersByTimeAsync(2_000);
    // attempt 3: 4s backoff, subscriber finally succeeds
    await vi.advanceTimersByTimeAsync(4_000);

    expect(reconnectAttempt).toBe(3);
    // 1 initial + 3 reconnect attempts = 4 Connection instantiations
    expect(instances.length).toBeGreaterThanOrEqual(4);

    ws.destroy();
  });
});

import { Connection, Commitment } from '@solana/web3.js';
import { logger } from '../utils/logger';

type Subscriber = (conn: Connection) => Promise<void>;

const sleep = (ms: number) => new Promise<void>(res => setTimeout(res, ms));

export class ReliableWebSocket {
  private connection: Connection;
  private subscribers: Map<string, Subscriber> = new Map();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private isReconnecting = false;
  private readonly commitment: Commitment = 'confirmed';

  constructor(
    private readonly rpcEndpoint: string,
    private readonly wsEndpoint: string,
  ) {
    this.connection = this.createConnection();
    this.startHeartbeat();
    logger.info(`🔌 WebSocket initialized`);
    logger.debug(`   WS: ${wsEndpoint.replace(/api-key=[^&]+/, 'api-key=***')}`);
  }

  getConnection(): Connection {
    return this.connection;
  }

  /**
   * Register a subscriber that will be replayed on every reconnect.
   * Called immediately with the current connection on registration.
   */
  register(key: string, subscriber: Subscriber): void {
    this.subscribers.set(key, subscriber);
    subscriber(this.connection).catch(err =>
      logger.error(`Subscriber '${key}' failed on registration: ${err}`),
    );
  }

  destroy(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    logger.info('WebSocket destroyed');
  }

  private createConnection(): Connection {
    return new Connection(this.rpcEndpoint, {
      wsEndpoint: this.wsEndpoint,
      commitment: this.commitment,
    });
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(async () => {
      try {
        await this.connection.getLatestBlockhash(this.commitment);
        logger.debug('💓 Heartbeat OK');
      } catch {
        logger.warn('💔 Heartbeat failed — triggering reconnect');
        void this.reconnect(1);
      }
    }, 20_000);
  }

  private async reconnect(attempt: number): Promise<void> {
    if (this.isReconnecting) return;
    this.isReconnecting = true;

    const delay = Math.min(1_000 * 2 ** (attempt - 1), 30_000);
    logger.info(`🔄 Reconnect attempt #${attempt} in ${delay / 1_000}s...`);
    await sleep(delay);

    try {
      this.connection = this.createConnection();
      logger.info('🔌 New connection established — re-subscribing...');

      for (const [key, subscriber] of this.subscribers) {
        await subscriber(this.connection);
        logger.info(`  ✅ Re-subscribed: ${key}`);
      }

      this.isReconnecting = false;
      logger.info('✅ Reconnect complete');
    } catch (err) {
      this.isReconnecting = false;
      logger.error(`Reconnect attempt #${attempt} failed: ${err}`);
      await this.reconnect(attempt + 1);
    }
  }
}

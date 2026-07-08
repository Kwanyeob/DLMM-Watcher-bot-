import { config } from './config';
import { logger } from './utils/logger';
import { ReliableWebSocket } from './websocket/ReliableWebSocket';
import { PositionDetector } from './detector/PositionDetector';
import { PositionWatcher } from './watcher/PositionWatcher';
import { StateDB } from './db/StateDB';
import {
  startPythFeed,
  classifyQuoteToken,
  ensureTokenTracked,
  setJupiterUpdateHandler,
} from './price/TieredPriceFeed';
import { RiskEngine, CloseReason } from './engine/RiskEngine';
import { TransactionExecutor } from './executor/TransactionExecutor';
import { TelegramBot } from './bot/TelegramBot';

async function main(): Promise<void> {
  logger.info('='.repeat(60));
  logger.info('  DLMM Watcher Bot — Step 2: Position Watcher');
  logger.info('='.repeat(60));
  logger.info(`Wallet : ${config.walletAddress}`);
  logger.info(`RPC    : ${config.rpcEndpoint.replace(/api-key=[^&]+/, 'api-key=***')}`);
  logger.info('');

  // Persistence
  const db = new StateDB();

  // WebSocket manager (single Connection shared by detector + watcher)
  const ws = new ReliableWebSocket(config.rpcEndpoint, config.wsEndpoint);
  const connection = ws.getConnection();

  // Executor ref declared here so the RiskEngine callback can close over it
  // (watcher must exist before executor, executor before any trigger fires — safe because setup is sync)
  let executor: TransactionExecutor;

  const riskEngine = new RiskEngine(db, async (pos, reason: CloseReason) => {
    await executor.close(pos, reason);
  });

  // Price feeds — re-run SL/TP checks on every price tick, not just on-chain pool events,
  // so a quote-token price move alone (e.g. SOL/USD) can still trigger a close.
  const recheckAllPositions = (): void => {
    for (const pos of db.getAll()) riskEngine.check(pos.address);
  };
  startPythFeed(recheckAllPositions);
  setJupiterUpdateHandler(recheckAllPositions);

  const watcher  = new PositionWatcher(connection, db, config.walletAddress, riskEngine);
  executor = new TransactionExecutor(connection, config.walletKeypair, db, watcher);

  const telegramBot = new TelegramBot(db, riskEngine);
  watcher.setBot(telegramBot);
  executor.setBot(telegramBot);
  telegramBot.launch();

  const detector = new PositionDetector(
    connection,
    config.walletAddress,
    pos => watcher.onPositionDetected(pos),
  );

  // Register both with ReliableWebSocket — replayed in order on every reconnect
  ws.register('position-detector', conn => detector.subscribe(conn));
  ws.register('position-watcher',  conn => watcher.subscribe(conn));

  // Restore positions from a previous session — ensure price feeds and SL/TP defaults are applied
  for (const pos of db.getAll()) {
    const typeB = classifyQuoteToken(pos.tokenMintB);
    ensureTokenTracked(pos.tokenMintB, typeB);

    if (pos.slPercent === null && pos.tpPercent === null && pos.minRatioA === null && pos.minRatioB === null) {
      if (
        config.defaultSlPercent !== null ||
        config.defaultTpPercent !== null ||
        config.defaultMinRatioA !== null ||
        config.defaultMinRatioB !== null
      ) {
        db.update(pos.address, {
          slPercent: config.defaultSlPercent,
          tpPercent: config.defaultTpPercent,
          minRatioA: config.defaultMinRatioA,
          minRatioB: config.defaultMinRatioB,
        });
      }
    }
  }

  logger.info('✅ Bot is running.');
  logger.info('   Open a DLMM position on Meteora to see the entry snapshot.');
  logger.info('   Press Ctrl+C to stop.');
  logger.info('');

  process.on('SIGINT', () => {
    logger.info('Shutting down...');
    telegramBot.stop();
    ws.destroy();
    process.exit(0);
  });
}

main().catch(err => {
  logger.error('Fatal error:', err);
  process.exit(1);
});

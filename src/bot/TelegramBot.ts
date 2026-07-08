import { Telegraf, Markup } from 'telegraf';
import { PositionState } from '../types';
import { StateDB } from '../db/StateDB';
import { RiskEngine, CloseReason } from '../engine/RiskEngine';
import { classifyQuoteToken, getQuoteTokenUsdPrice } from '../price/TieredPriceFeed';
import { config } from '../config';
import { logger } from '../utils/logger';
import { fmtPrice } from '../utils/format';

// Interfaces instead of direct imports to avoid circular dependencies
interface IPositionWatcher {
  removePosition(address: string): Promise<void>;
  addPositionByAddress(address: string): Promise<void>;
}

interface ITransactionExecutor {
  close(pos: PositionState, reason: CloseReason): Promise<void>;
}

type SettableType = 'sl' | 'tp' | 'ratioA' | 'ratioB';

interface PendingInput {
  posAddress: string;
  type: SettableType;
}

export class TelegramBot {
  private static readonly SL_TP_PRESETS = [5, 10, 15, 20, 25];
  // Delta buttons shrink as the value gets smaller so you can fine-tune all the way down to MIN_PCT.
  private static readonly SL_TP_DELTA_TIERS: Array<{ upTo: number; deltas: number[] }> = [
    { upTo: 1,        deltas: [-0.1, -0.05, 0.05, 0.1] },
    { upTo: 5,        deltas: [-1, -0.5, 0.5, 1] },
    { upTo: Infinity, deltas: [-5, -1, 1, 5] },
  ];
  private static readonly MIN_PCT = 0.05;
  private static readonly MAX_PCT = 90;

  private readonly bot: Telegraf;
  private watcher?: IPositionWatcher;
  private executor?: ITransactionExecutor;
  private readonly pending = new Map<number, PendingInput>();
  private panicPending = false;
  private panicTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly db: StateDB,
    private readonly riskEngine: RiskEngine,
  ) {
    this.bot = new Telegraf(config.telegramBotToken);
    this.registerHandlers();
  }

  setWatcher(watcher: IPositionWatcher): void { this.watcher = watcher; }
  setExecutor(executor: ITransactionExecutor): void { this.executor = executor; }

  launch(): void {
    this.bot.launch();
    logger.info('✅ Telegram bot started (long-polling)');
  }

  stop(): void {
    this.bot.stop();
  }

  // ─── Outbound notifications ──────────────────────────────────────────────

  notifyNewPosition(pos: PositionState): void {
    const msg = this.formatNewPosition(pos);
    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('📉 Set SL', `sl:${pos.address}`),
        Markup.button.callback('📈 Set TP', `tp:${pos.address}`),
      ],
      [
        Markup.button.callback(`⚖️ Min ${pos.tokenSymbolA}%`, `ra:${pos.address}`),
        Markup.button.callback(`⚖️ Min ${pos.tokenSymbolB}%`, `rb:${pos.address}`),
      ],
      [Markup.button.callback('🙈 Ignore', `ignore:${pos.address}`)],
    ]);
    this.send(msg, { reply_markup: keyboard.reply_markup }).catch(err =>
      logger.error(`TelegramBot.notifyNewPosition error: ${err}`),
    );
  }

  notifyPositionClosed(
    pos: PositionState,
    reason: CloseReason,
    signature: string,
    finalPnl: number,
    receivedA: number,
    receivedB: number,
    finalUsd: number,
  ): void {
    const emoji = reason === 'tp' ? '✅' : reason === 'sl' ? '🔴' : reason === 'skew' ? '🟡' : '🔒';
    const label = reason === 'tp' ? 'Take Profit Hit' : reason === 'sl' ? 'Stop Loss Hit' :
      reason === 'skew' ? 'Skew Exit' : 'Manual Close';
    const pnlStr = this.fmtPct(finalPnl);
    const msg =
      `${emoji} *Position Closed — ${label}*\n\n` +
      `Pool: \`${this.esc(pos.tokenSymbolA)}/${this.esc(pos.tokenSymbolB)}\`  \\[\\#${pos.shortId}\\]\n` +
      `Final Value: *\\$${this.esc(finalUsd.toFixed(4))}*  │  Final PnL: *${pnlStr}*\n` +
      `Received: ${this.esc(receivedA.toFixed(6))} ${this.esc(pos.tokenSymbolA)} \\+ ` +
      `${this.esc(receivedB.toFixed(6))} ${this.esc(pos.tokenSymbolB)}\n` +
      `[View on Solscan](https://solscan\\.io/tx/${this.esc(signature)})`;
    this.send(msg).catch(err =>
      logger.error(`TelegramBot.notifyPositionClosed error: ${err}`),
    );
  }

  notifyWarning(msg: string): void {
    this.send(`⚠️ ${this.esc(msg)}`).catch(err =>
      logger.error(`TelegramBot notifyWarning send error: ${err}`),
    );
  }

  notifyError(msg: string): void {
    this.send(`❌ ${this.esc(msg)}`).catch(err =>
      logger.error(`TelegramBot notifyError send error: ${err}`),
    );
  }

  // ─── Handler registration ─────────────────────────────────────────────────

  private registerHandlers(): void {
    const { bot } = this;

    // /start
    bot.command('start', ctx => {
      if (!this.guard(ctx.from?.id)) return;
      const count = this.db.getAll().length;
      ctx.reply(
        `👁 *DLMM Watcher Bot*\n\n` +
        `Currently watching *${count}* position${count !== 1 ? 's' : ''}\\.\n\n` +
        `*Commands:*\n` +
        `/status — current positions \\& PnL\n` +
        `/set \\<id\\> sl \\<pct\\> — set stop loss\n` +
        `/set \\<id\\> tp \\<pct\\> — set take profit\n` +
        `/set \\<id\\> mina \\<pct\\> — min % of value tokenA may fall to\n` +
        `/set \\<id\\> minb \\<pct\\> — min % of value tokenB may fall to\n` +
        `/close \\<id\\> — close position manually\n` +
        `/add \\<address\\> — register existing position\n` +
        `/remove \\<id\\> — stop watching \\(keeps position on\\-chain\\)\n` +
        `/panic — emergency close all\n\n` +
        `_Tip: /status has tap buttons for SL/TP/ratio/Close — no typing needed\\._`,
        { parse_mode: 'MarkdownV2' },
      );
    });

    // /status
    bot.command('status', ctx => {
      if (!this.guard(ctx.from?.id)) return;
      const positions = this.db.getAll();
      if (positions.length === 0) {
        ctx.reply('No positions currently being watched\\.', { parse_mode: 'MarkdownV2' });
        return;
      }
      ctx.reply(this.formatStatus(positions), {
        parse_mode: 'MarkdownV2',
        reply_markup: this.buildStatusKeyboard(positions).reply_markup,
      });
    });

    // /set <id> sl|tp|mina|minb <pct>
    bot.command('set', ctx => {
      if (!this.guard(ctx.from?.id)) return;
      const parts = ctx.message.text.trim().split(/\s+/);
      if (parts.length !== 4) {
        ctx.reply(
          'Usage: `/set <id> sl <pct>`, `/set <id> tp <pct>`, `/set <id> mina <pct>` or `/set <id> minb <pct>`',
          { parse_mode: 'MarkdownV2' },
        );
        return;
      }
      const [, rawId, rawType, rawPct] = parts;
      const shortId = parseInt(rawId, 10);
      const pct = parseFloat(rawPct);
      const type = rawType.toLowerCase();
      const validTypes = ['sl', 'tp', 'mina', 'minb'];

      if (isNaN(shortId) || isNaN(pct) || pct <= 0 || !validTypes.includes(type)) {
        ctx.reply('Invalid arguments\\. Example: `/set 1 sl 10`', { parse_mode: 'MarkdownV2' });
        return;
      }
      const pos = this.db.getByShortId(shortId);
      if (!pos) { ctx.reply(`Position \\#${shortId} not found\\.`, { parse_mode: 'MarkdownV2' }); return; }

      if (type === 'sl') {
        this.db.update(pos.address, { slPercent: pct });
        ctx.reply(
          `✅ SL set to ${this.fmtPct(-pct)} for \\#${shortId} ${this.esc(pos.tokenSymbolA)}/${this.esc(pos.tokenSymbolB)}`,
          { parse_mode: 'MarkdownV2' },
        );
      } else if (type === 'tp') {
        this.db.update(pos.address, { tpPercent: pct });
        ctx.reply(
          `✅ TP set to ${this.fmtPct(pct)} for \\#${shortId} ${this.esc(pos.tokenSymbolA)}/${this.esc(pos.tokenSymbolB)}`,
          { parse_mode: 'MarkdownV2' },
        );
      } else if (type === 'mina') {
        this.db.update(pos.address, { minRatioA: pct });
        ctx.reply(
          `✅ Min ${this.esc(pos.tokenSymbolA)}% set to ${this.esc(this.fmtStep(pct))}% for \\#${shortId} ${this.esc(pos.tokenSymbolA)}/${this.esc(pos.tokenSymbolB)}`,
          { parse_mode: 'MarkdownV2' },
        );
      } else {
        this.db.update(pos.address, { minRatioB: pct });
        ctx.reply(
          `✅ Min ${this.esc(pos.tokenSymbolB)}% set to ${this.esc(this.fmtStep(pct))}% for \\#${shortId} ${this.esc(pos.tokenSymbolA)}/${this.esc(pos.tokenSymbolB)}`,
          { parse_mode: 'MarkdownV2' },
        );
      }
    });

    // /close <id>
    bot.command('close', async ctx => {
      if (!this.guard(ctx.from?.id)) return;
      const parts = ctx.message.text.trim().split(/\s+/);
      if (parts.length !== 2 || isNaN(parseInt(parts[1], 10))) {
        ctx.reply('Usage: `/close <id>`', { parse_mode: 'MarkdownV2' });
        return;
      }
      const shortId = parseInt(parts[1], 10);
      const pos = this.db.getByShortId(shortId);
      if (!pos) { ctx.reply(`Position \\#${shortId} not found\\.`, { parse_mode: 'MarkdownV2' }); return; }
      if (pos.isClosing) { ctx.reply(`\\#${shortId} is already being closed\\.`, { parse_mode: 'MarkdownV2' }); return; }
      if (!this.executor) { ctx.reply('Executor not ready\\.', { parse_mode: 'MarkdownV2' }); return; }

      ctx.reply(
        `⚡ Closing \\#${shortId} ${this.esc(pos.tokenSymbolA)}/${this.esc(pos.tokenSymbolB)}…`,
        { parse_mode: 'MarkdownV2' },
      );
      this.db.update(pos.address, { isClosing: true });
      try {
        await this.executor.close(pos, 'manual');
      } catch (err) {
        this.db.update(pos.address, { isClosing: false });
        ctx.reply(`❌ Close failed: ${this.esc(String(err))}`, { parse_mode: 'MarkdownV2' });
      }
    });

    // /remove <id>
    bot.command('remove', async ctx => {
      if (!this.guard(ctx.from?.id)) return;
      const parts = ctx.message.text.trim().split(/\s+/);
      if (parts.length !== 2 || isNaN(parseInt(parts[1], 10))) {
        ctx.reply('Usage: `/remove <id>`', { parse_mode: 'MarkdownV2' });
        return;
      }
      const shortId = parseInt(parts[1], 10);
      const pos = this.db.getByShortId(shortId);
      if (!pos) { ctx.reply(`Position \\#${shortId} not found\\.`, { parse_mode: 'MarkdownV2' }); return; }
      if (!this.watcher) { ctx.reply('Watcher not ready\\.', { parse_mode: 'MarkdownV2' }); return; }

      await this.watcher.removePosition(pos.address);
      ctx.reply(
        `🗑 Stopped watching \\#${shortId} ${this.esc(pos.tokenSymbolA)}/${this.esc(pos.tokenSymbolB)} \\(position remains on\\-chain\\)\\.`,
        { parse_mode: 'MarkdownV2' },
      );
    });

    // /add <address>
    bot.command('add', async ctx => {
      if (!this.guard(ctx.from?.id)) return;
      const parts = ctx.message.text.trim().split(/\s+/);
      if (parts.length !== 2) {
        ctx.reply('Usage: `/add <positionAddress>`', { parse_mode: 'MarkdownV2' });
        return;
      }
      const address = parts[1];
      if (!this.watcher) { ctx.reply('Watcher not ready\\.', { parse_mode: 'MarkdownV2' }); return; }
      if (this.db.getAll().length >= 10) {
        ctx.reply('⚠️ Max 10 positions reached\\.', { parse_mode: 'MarkdownV2' });
        return;
      }
      ctx.reply(
        `⏳ Registering \`${this.esc(address.slice(0, 8))}\\.\\.\\.\`…`,
        { parse_mode: 'MarkdownV2' },
      );
      try {
        await this.watcher.addPositionByAddress(address);
      } catch (err) {
        ctx.reply(`❌ Failed to add position: ${this.esc(String(err))}`, { parse_mode: 'MarkdownV2' });
      }
    });

    // /panic [confirm]
    bot.command('panic', ctx => {
      if (!this.guard(ctx.from?.id)) return;
      const parts = ctx.message.text.trim().split(/\s+/);

      if (parts[1] === 'confirm') {
        if (!this.panicPending) {
          ctx.reply('No pending panic\\. Send `/panic` first\\.', { parse_mode: 'MarkdownV2' });
          return;
        }
        this.clearPanicTimer();
        void this.executePanic();
        return;
      }

      const count = this.db.getAll().filter(p => !p.isClosing).length;
      if (count === 0) {
        ctx.reply('No active positions to close\\.', { parse_mode: 'MarkdownV2' });
        return;
      }

      this.panicPending = true;
      this.panicTimer = setTimeout(() => {
        this.panicPending = false;
        this.send('⚠️ Panic cancelled \\(timed out\\)\\.').catch(() => {});
      }, 30_000);

      ctx.reply(
        `⚠️ *PANIC MODE*\n\n` +
        `This will close *${count}* position${count !== 1 ? 's' : ''}\\.\n\n` +
        `Send \`/panic confirm\` within 30 seconds to proceed\\.`,
        { parse_mode: 'MarkdownV2' },
      );
    });

    // Inline button: sl:<address>, tp:<address>, ra:<address> or rb:<address> — opens the tap-to-adjust stepper
    bot.action(/^(sl|tp|ra|rb):(.+)$/, ctx => {
      if (!this.guard(ctx.from?.id)) { ctx.answerCbQuery(); return; }
      const raw = ctx.match[1];
      const type: SettableType =
        raw === 'sl' ? 'sl' : raw === 'tp' ? 'tp' : raw === 'ra' ? 'ratioA' : 'ratioB';
      const address = ctx.match[2];
      const pos = this.db.getByAddress(address);
      if (!pos) { ctx.answerCbQuery('Position no longer tracked'); return; }

      const current =
        type === 'sl' ? pos.slPercent ?? config.defaultSlPercent ?? 10
        : type === 'tp' ? pos.tpPercent ?? config.defaultTpPercent ?? 15
        : type === 'ratioA' ? pos.minRatioA ?? config.defaultMinRatioA ?? 20
        : pos.minRatioB ?? config.defaultMinRatioB ?? 20;

      ctx.answerCbQuery();
      this.renderStepper(ctx, pos, type, current);
    });

    // Stepper preset/fine-tune buttons: sv:<s|t|a|b>:<address>:<value>
    bot.action(/^sv:(s|t|a|b):([^:]+):(-?[\d.]+)$/, ctx => {
      if (!this.guard(ctx.from?.id)) { ctx.answerCbQuery(); return; }
      const type = this.codeToType(ctx.match[1]);
      const address = ctx.match[2];
      const value = this.clampPct(parseFloat(ctx.match[3]));
      const pos = this.db.getByAddress(address);
      if (!pos) { ctx.answerCbQuery('Position no longer tracked'); return; }

      ctx.answerCbQuery();
      this.renderStepper(ctx, pos, type, value);
    });

    // Stepper confirm: sc:<s|t|a|b>:<address>:<value>
    bot.action(/^sc:(s|t|a|b):([^:]+):(-?[\d.]+)$/, ctx => {
      if (!this.guard(ctx.from?.id)) { ctx.answerCbQuery(); return; }
      const type = this.codeToType(ctx.match[1]);
      const address = ctx.match[2];
      const value = this.clampPct(parseFloat(ctx.match[3]));
      const pos = this.db.getByAddress(address);
      if (!pos) { ctx.answerCbQuery('Position no longer tracked'); return; }

      if (type === 'sl') this.db.update(address, { slPercent: value });
      else if (type === 'tp') this.db.update(address, { tpPercent: value });
      else if (type === 'ratioA') this.db.update(address, { minRatioA: value });
      else this.db.update(address, { minRatioB: value });

      ctx.answerCbQuery('Saved');
      const label =
        type === 'sl' ? 'SL' : type === 'tp' ? 'TP'
        : type === 'ratioA' ? `Min ${pos.tokenSymbolA}%` : `Min ${pos.tokenSymbolB}%`;
      const pct = type === 'sl' ? this.fmtPct(-value) : type === 'tp' ? this.fmtPct(value) : `${this.esc(this.fmtStep(value))}%`;
      ctx.editMessageText(
        `✅ ${this.esc(label)} set to ${pct} for \\#${pos.shortId} ${this.esc(pos.tokenSymbolA)}/${this.esc(pos.tokenSymbolB)}`,
        { parse_mode: 'MarkdownV2' },
      ).catch(() => {});
    });

    // Stepper custom input fallback: su:<s|t|a|b>:<address>
    bot.action(/^su:(s|t|a|b):(.+)$/, ctx => {
      if (!this.guard(ctx.from?.id)) { ctx.answerCbQuery(); return; }
      const type = this.codeToType(ctx.match[1]);
      const address = ctx.match[2];
      const pos = this.db.getByAddress(address);
      if (!pos) { ctx.answerCbQuery('Position no longer tracked'); return; }

      const fromId = ctx.from?.id;
      if (fromId === undefined) { ctx.answerCbQuery(); return; }

      this.pending.set(fromId, { posAddress: address, type });
      ctx.answerCbQuery();
      const label =
        type === 'sl' ? 'SL' : type === 'tp' ? 'TP'
        : type === 'ratioA' ? `Min ${pos.tokenSymbolA}%` : `Min ${pos.tokenSymbolB}%`;
      const example = type === 'sl' ? '\\-10%' : type === 'tp' ? '\\+10%' : '10 means 10%';
      ctx.editMessageText(
        `Enter ${this.esc(label)} value for \\#${pos.shortId} ` +
        `${this.esc(pos.tokenSymbolA)}/${this.esc(pos.tokenSymbolB)}\n` +
        `_\\(e\\.g\\. ${example}\\)_`,
        { parse_mode: 'MarkdownV2' },
      ).catch(() => {});
    });

    // Generic cancel: cx:<address>
    bot.action(/^cx:.+$/, ctx => {
      ctx.answerCbQuery('Cancelled');
      ctx.editMessageText('❌ Cancelled\\.', { parse_mode: 'MarkdownV2' }).catch(() => {});
    });

    // Inline button: ignore:<address>
    bot.action(/^ignore:.+$/, ctx => {
      ctx.answerCbQuery('Ignored');
      ctx.editMessageReplyMarkup(undefined);
    });

    // Close confirm step: cl:<address>
    bot.action(/^cl:(.+)$/, ctx => {
      if (!this.guard(ctx.from?.id)) { ctx.answerCbQuery(); return; }
      const address = ctx.match[1];
      const pos = this.db.getByAddress(address);
      if (!pos) { ctx.answerCbQuery('Position no longer tracked'); return; }
      if (pos.isClosing) { ctx.answerCbQuery('Already closing'); return; }

      ctx.answerCbQuery();
      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('✅ Confirm Close', `clc:${address}`),
          Markup.button.callback('❌ Cancel', `cx:${address}`),
        ],
      ]);
      ctx.editMessageText(
        `⚠️ Close \\#${pos.shortId} ${this.esc(pos.tokenSymbolA)}/${this.esc(pos.tokenSymbolB)} now\\?`,
        { parse_mode: 'MarkdownV2', reply_markup: keyboard.reply_markup },
      ).catch(() => {});
    });

    // Close execute: clc:<address>
    bot.action(/^clc:(.+)$/, async ctx => {
      if (!this.guard(ctx.from?.id)) { ctx.answerCbQuery(); return; }
      const address = ctx.match[1];
      const pos = this.db.getByAddress(address);
      if (!pos) { ctx.answerCbQuery('Position no longer tracked'); return; }
      if (pos.isClosing) { ctx.answerCbQuery('Already closing'); return; }
      if (!this.executor) { ctx.answerCbQuery('Executor not ready'); return; }

      ctx.answerCbQuery();
      await ctx.editMessageText(
        `⚡ Closing \\#${pos.shortId} ${this.esc(pos.tokenSymbolA)}/${this.esc(pos.tokenSymbolB)}…`,
        { parse_mode: 'MarkdownV2' },
      ).catch(() => {});

      this.db.update(pos.address, { isClosing: true });
      try {
        await this.executor.close(pos, 'manual');
      } catch (err) {
        this.db.update(pos.address, { isClosing: false });
        this.send(`❌ Close failed for \\#${pos.shortId}: ${this.esc(String(err))}`).catch(() => {});
      }
    });

    // Free text → SL/TP pending input handler
    bot.on('text', ctx => {
      if (!this.guard(ctx.from?.id)) return;
      if (ctx.message.text.startsWith('/')) return;

      const fromId = ctx.from?.id;
      if (fromId === undefined) return;
      const pend = this.pending.get(fromId);
      if (!pend) return;

      const pct = parseFloat(ctx.message.text.trim());
      if (isNaN(pct) || pct <= 0) {
        ctx.reply('Please enter a positive number \\(e\\.g\\. 10\\)\\.', { parse_mode: 'MarkdownV2' });
        return;
      }

      const pos = this.db.getByAddress(pend.posAddress);
      this.pending.delete(fromId);

      if (!pos) { ctx.reply('Position no longer tracked\\.', { parse_mode: 'MarkdownV2' }); return; }

      if (pend.type === 'sl') {
        this.db.update(pos.address, { slPercent: pct });
        ctx.reply(
          `✅ SL set to ${this.fmtPct(-pct)} for \\#${pos.shortId} ${this.esc(pos.tokenSymbolA)}/${this.esc(pos.tokenSymbolB)}`,
          { parse_mode: 'MarkdownV2' },
        );
      } else if (pend.type === 'tp') {
        this.db.update(pos.address, { tpPercent: pct });
        ctx.reply(
          `✅ TP set to ${this.fmtPct(pct)} for \\#${pos.shortId} ${this.esc(pos.tokenSymbolA)}/${this.esc(pos.tokenSymbolB)}`,
          { parse_mode: 'MarkdownV2' },
        );
      } else if (pend.type === 'ratioA') {
        this.db.update(pos.address, { minRatioA: pct });
        ctx.reply(
          `✅ Min ${this.esc(pos.tokenSymbolA)}% set to ${this.esc(this.fmtStep(pct))}% for \\#${pos.shortId} ${this.esc(pos.tokenSymbolA)}/${this.esc(pos.tokenSymbolB)}`,
          { parse_mode: 'MarkdownV2' },
        );
      } else {
        this.db.update(pos.address, { minRatioB: pct });
        ctx.reply(
          `✅ Min ${this.esc(pos.tokenSymbolB)}% set to ${this.esc(this.fmtStep(pct))}% for \\#${pos.shortId} ${this.esc(pos.tokenSymbolA)}/${this.esc(pos.tokenSymbolB)}`,
          { parse_mode: 'MarkdownV2' },
        );
      }
    });
  }

  // ─── Panic execution ──────────────────────────────────────────────────────

  private async executePanic(): Promise<void> {
    const positions = this.db.getAll().filter(p => !p.isClosing);
    if (positions.length === 0) {
      this.send('No active positions to close\\.').catch(() => {});
      return;
    }

    this.send(
      `🚨 *PANIC* — closing ${positions.length} position${positions.length !== 1 ? 's' : ''}…`,
    ).catch(() => {});

    if (!this.executor) {
      this.send('❌ Executor not ready\\.').catch(() => {});
      return;
    }

    for (const pos of positions) {
      this.db.update(pos.address, { isClosing: true });
      try {
        await this.executor.close(pos, 'manual');
      } catch (err) {
        this.db.update(pos.address, { isClosing: false });
        logger.error(`Panic close failed for #${pos.shortId}: ${err}`);
        this.send(
          `❌ Failed to close \\#${pos.shortId} ` +
          `${this.esc(pos.tokenSymbolA)}/${this.esc(pos.tokenSymbolB)}: ${this.esc(String(err))}`,
        ).catch(() => {});
      }
    }
  }

  private clearPanicTimer(): void {
    if (this.panicTimer) {
      clearTimeout(this.panicTimer);
      this.panicTimer = undefined;
    }
    this.panicPending = false;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private async send(text: string, extra?: object): Promise<void> {
    await this.bot.telegram.sendMessage(config.telegramChatId, text, {
      parse_mode: 'MarkdownV2',
      ...extra,
    } as any);
  }

  private guard(fromId: number | undefined): boolean {
    if (fromId === undefined) return false;
    return fromId.toString() === config.telegramChatId;
  }

  /** Escape special MarkdownV2 characters */
  private esc(text: string): string {
    return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, c => '\\' + c);
  }

  /** Format a percentage with proper MarkdownV2 escaping for sign and decimal point */
  private fmtPct(p: number, decimals = 2): string {
    const sign = p >= 0 ? '\\+' : '\\-';
    return `${sign}${this.esc(Math.abs(p).toFixed(decimals))}%`;
  }

  private clampPct(v: number): number {
    return Math.min(TelegramBot.MAX_PCT, Math.max(TelegramBot.MIN_PCT, v));
  }

  /** Single-char callback-data code → settable type (keeps callback_data short) */
  private codeToType(code: string): SettableType {
    return code === 's' ? 'sl' : code === 't' ? 'tp' : code === 'a' ? 'ratioA' : 'ratioB';
  }

  /** Format a stepper magnitude without trailing zeros (e.g. 10 not 10.00, 12.5 stays 12.5, 0.05 stays 0.05) */
  private fmtStep(v: number): string {
    const s = v.toFixed(2);
    return s.replace(/\.?0+$/, '') || '0';
  }

  /** Delta buttons shrink as the value gets smaller so fine-tuning near MIN_PCT is possible */
  private getDeltas(value: number): number[] {
    const tier = TelegramBot.SL_TP_DELTA_TIERS.find(t => value <= t.upTo);
    return tier?.deltas ?? TelegramBot.SL_TP_DELTA_TIERS[TelegramBot.SL_TP_DELTA_TIERS.length - 1].deltas;
  }

  private buildStatusKeyboard(positions: PositionState[]) {
    const rows = positions.flatMap(pos => [
      [
        Markup.button.callback(`📉 #${pos.shortId} SL`, `sl:${pos.address}`),
        Markup.button.callback(`📈 #${pos.shortId} TP`, `tp:${pos.address}`),
        Markup.button.callback(`❌ #${pos.shortId} Close`, `cl:${pos.address}`),
      ],
      [
        Markup.button.callback(`⚖️ #${pos.shortId} Min ${pos.tokenSymbolA}%`, `ra:${pos.address}`),
        Markup.button.callback(`⚖️ #${pos.shortId} Min ${pos.tokenSymbolB}%`, `rb:${pos.address}`),
      ],
    ]);
    return Markup.inlineKeyboard(rows);
  }

  /** Renders the tap-to-adjust SL/TP/ratio stepper (presets + fine-tune + confirm/custom/cancel) */
  private renderStepper(ctx: any, pos: PositionState, type: SettableType, value: number): void {
    const t = type === 'sl' ? 's' : type === 'tp' ? 't' : type === 'ratioA' ? 'a' : 'b';
    const label =
      type === 'sl' ? 'Stop Loss' : type === 'tp' ? 'Take Profit'
      : type === 'ratioA' ? `Min ${pos.tokenSymbolA}% of value` : `Min ${pos.tokenSymbolB}% of value`;
    const emoji = type === 'sl' ? '📉' : type === 'tp' ? '📈' : '⚖️';

    const text =
      `${emoji} *${this.esc(label)}* — \\#${pos.shortId} ${this.esc(pos.tokenSymbolA)}/${this.esc(pos.tokenSymbolB)}\n\n` +
      `Value: *${this.esc(this.fmtStep(value))}%*`;

    const presetRow = TelegramBot.SL_TP_PRESETS.map(p =>
      Markup.button.callback(`${p}%`, `sv:${t}:${pos.address}:${p}`),
    );
    const deltaRow = this.getDeltas(value).map(d => {
      const next = this.clampPct(value + d);
      const deltaLabel = d > 0 ? `+${this.fmtStep(d)}` : `-${this.fmtStep(-d)}`;
      return Markup.button.callback(deltaLabel, `sv:${t}:${pos.address}:${this.fmtStep(next)}`);
    });
    const keyboard = Markup.inlineKeyboard([
      presetRow,
      deltaRow,
      [Markup.button.callback(`✅ Confirm ${this.fmtStep(value)}%`, `sc:${t}:${pos.address}:${this.fmtStep(value)}`)],
      [
        Markup.button.callback('✏️ Custom', `su:${t}:${pos.address}`),
        Markup.button.callback('❌ Cancel', `cx:${pos.address}`),
      ],
    ]);

    ctx
      .editMessageText(text, { parse_mode: 'MarkdownV2', reply_markup: keyboard.reply_markup })
      .catch(() =>
        ctx.reply(text, { parse_mode: 'MarkdownV2', reply_markup: keyboard.reply_markup }),
      );
  }

  // ─── Formatters ───────────────────────────────────────────────────────────

  private formatNewPosition(pos: PositionState): string {
    const binPrice = (id: number) =>
      Math.pow(1 + pos.binStep / 10_000, id) * Math.pow(10, pos.decimalA - pos.decimalB);
    const lowerPrice = binPrice(pos.binIdLower);
    const upperPrice = binPrice(pos.binIdUpper);
    const lowerPct = ((lowerPrice / pos.lbPairPrice) - 1) * 100;
    const upperPct = ((upperPrice / pos.lbPairPrice) - 1) * 100;
    const sl = pos.slPercent !== null ? this.fmtPct(-pos.slPercent) : 'not set';
    const tp = pos.tpPercent !== null ? this.fmtPct(pos.tpPercent) : 'not set';
    const minA = pos.minRatioA !== null ? `${this.esc(this.fmtStep(pos.minRatioA))}%` : '–';
    const minB = pos.minRatioB !== null ? `${this.esc(this.fmtStep(pos.minRatioB))}%` : '–';

    return (
      `🆕 *New DLMM Position Detected\\!*\n\n` +
      `Pool: \`${this.esc(pos.tokenSymbolA)}/${this.esc(pos.tokenSymbolB)}\`  \\[\\#${pos.shortId}\\]\n` +
      `Entry Value: *\\$${this.esc(pos.entryTotalUsd.toFixed(4))}*\n` +
      `Range: \`${this.esc(fmtPrice(lowerPrice))}\` \\(${this.fmtPct(lowerPct)}\\) → ` +
      `\`${this.esc(fmtPrice(upperPrice))}\` \\(${this.fmtPct(upperPct)}\\)\n` +
      `Amounts: ${this.esc(pos.entryAmountA.toFixed(6))} ${this.esc(pos.tokenSymbolA)} \\+ ` +
      `${this.esc(pos.entryAmountB.toFixed(6))} ${this.esc(pos.tokenSymbolB)}\n` +
      `Ratio: ${this.esc(pos.tokenSymbolA)} ${this.esc(pos.entryRatioA.toFixed(1))}% / ` +
      `${this.esc(pos.tokenSymbolB)} ${this.esc(pos.entryRatioB.toFixed(1))}%\n` +
      `SL/TP: ${sl} / ${tp}  │  Min ${this.esc(pos.tokenSymbolA)}/${this.esc(pos.tokenSymbolB)}: ${minA} / ${minB}`
    );
  }

  private formatStatus(positions: PositionState[]): string {
    const lines: string[] = [`📊 *Active Positions \\(${positions.length}\\)*\n`];

    for (const pos of positions) {
      const typeB  = classifyQuoteToken(pos.tokenMintB);
      const priceB = getQuoteTokenUsdPrice(pos.tokenMintB, typeB) ?? pos.entryPriceB;
      const pnlInclFee = this.riskEngine.calculatePnL(pos, priceB, true);
      const pnlExclFee = this.riskEngine.calculatePnL(pos, priceB, false);
      const priceA = pos.lbPairPrice * priceB;
      const totalUsd =
        (pos.currentAmountA + pos.feeA) * priceA +
        (pos.currentAmountB + pos.feeB) * priceB;

      const sl = pos.slPercent !== null ? this.fmtPct(-pos.slPercent) : 'not set';
      const tp = pos.tpPercent !== null ? this.fmtPct(pos.tpPercent) : 'not set';
      const closing = pos.isClosing ? ' \\[CLOSING\\]' : '';

      const myLiqUsd = pos.currentAmountA * priceA + pos.currentAmountB * priceB;
      const currentRatioA = myLiqUsd > 0 ? (pos.currentAmountA * priceA / myLiqUsd) * 100 : pos.entryRatioA;
      const currentRatioB = 100 - currentRatioA;
      const minA = pos.minRatioA !== null ? `${this.esc(this.fmtStep(pos.minRatioA))}%` : '–';
      const minB = pos.minRatioB !== null ? `${this.esc(this.fmtStep(pos.minRatioB))}%` : '–';

      const binPrice = (id: number) =>
        Math.pow(1 + pos.binStep / 10_000, id) * Math.pow(10, pos.decimalA - pos.decimalB);
      const lowerPct = ((binPrice(pos.binIdLower) / pos.lbPairPrice) - 1) * 100;
      const upperPct = ((binPrice(pos.binIdUpper) / pos.lbPairPrice) - 1) * 100;

      lines.push(
        `\\#${pos.shortId} *${this.esc(pos.tokenSymbolA)}/${this.esc(pos.tokenSymbolB)}*${closing}\n` +
        `   Entry: \\$${this.esc(pos.entryTotalUsd.toFixed(4))}  │  Value: \\$${this.esc(totalUsd.toFixed(4))}\n` +
        `   PnL incl fee: *${this.fmtPct(pnlInclFee)}*  │  excl fee: *${this.fmtPct(pnlExclFee)}*\n` +
        `   SL/TP: ${sl} / ${tp}\n` +
        `   Ratio: ${this.esc(pos.tokenSymbolA)} ${this.esc(currentRatioA.toFixed(1))}% / ` +
        `${this.esc(pos.tokenSymbolB)} ${this.esc(currentRatioB.toFixed(1))}% ` +
        `\\(entry ${this.esc(pos.entryRatioA.toFixed(0))}/${this.esc(pos.entryRatioB.toFixed(0))}\\)\n` +
        `   Min: ${this.esc(pos.tokenSymbolA)}≥${minA} · ${this.esc(pos.tokenSymbolB)}≥${minB}\n` +
        `   Range: \\(${this.fmtPct(lowerPct)}\\) → \\(${this.fmtPct(upperPct)}\\)`,
      );
    }
    return lines.join('\n');
  }
}

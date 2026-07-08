# Manual QA Checklist

These two acceptance criteria depend on real network/wallet state and can't be
proven by a unit test — run them by hand before trusting a new deploy with
real funds. (`ReliableWebSocket`'s reconnect/backoff *logic* is covered by
`src/websocket/ReliableWebSocket.test.ts`; this checklist only covers what
that test can't reach.)

## 1. WebSocket disconnect & recovery

1. Start the bot with at least one position being watched.
2. Cut network access to the process (e.g. disable Wi-Fi/adapter, or block the
   Helius WS host in the firewall) for ~15-20s, then restore it.
3. Confirm in the logs:
   - `💔 Heartbeat failed — triggering reconnect`
   - `🔌 New connection established — re-subscribing...`
   - `✅ Re-subscribed: position-detector` and `✅ Re-subscribed: position-watcher`
4. Confirm PnL updates resume (new `[lbPairChange]` / `[RiskEngine]` log lines
   appear again) without restarting the process.

## 2. `/panic` with multiple positions

1. Have ≥2 real positions being watched (`/status` shows both).
2. Send `/panic`, confirm the bot lists the correct count and asks for
   `/panic confirm`.
3. Send `/panic confirm`.
4. Confirm both positions receive a close attempt (check logs for
   `⚡ [#n] Closing — reason: MANUAL` for each), and that a failure on one
   position doesn't stop the other from being attempted.
5. Confirm `/status` afterwards shows 0 positions (or only the one that
   genuinely failed, with a Telegram error notification explaining why).

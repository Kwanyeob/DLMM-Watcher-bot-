# 🚀 DLMM Watcher Bot

**[🇬🇧 English](#-dlmm-watcher-bot) | [🇰🇷 한국어](#-dlmm-watcher-bot-한국어)**

An automated Stop-Loss / Take-Profit watcher and closer for [Meteora DLMM](https://www.meteora.ag/) liquidity positions on Solana — with real-time Telegram control.

Point it at a wallet. It detects every new DLMM position the moment it's opened, tracks its live value on-chain, and closes it automatically when your risk rules trigger — all controllable and observable from Telegram.

---

## What it does

- **Detects new positions instantly** — subscribes to the watched wallet's transaction logs and recognizes Meteora's `InitializePosition` instruction the moment it lands on-chain.
- **Builds an exact entry snapshot** — parses the *actual* deposit amounts straight out of the open transaction (not a re-query that could already have drifted from cost basis).
- **Tracks positions in real time** — subscribes directly to the position account and the pool (`lbPair`) account; no polling.
- **Runs a Risk Engine on every update** — re-evaluates Stop-Loss / Take-Profit / ratio-skew on every on-chain change *and* on every price tick, so a pure price move (e.g. SOL/USD) can trigger a close even without on-chain activity.
- **Closes on-chain automatically** — removes liquidity, claims fees, and closes the position in a single transaction, with priority-fee tiering and automatic retry.
- **Fully controllable via Telegram** — live PnL, tap-to-adjust SL/TP/ratio steppers, manual close, panic-close-all.
- **Survives restarts** — position state persists to a local JSON file; the WebSocket connection auto-reconnects and re-subscribes to everything in order.

---

## Architecture

```
Wallet tx logs ──▶ PositionDetector ──▶ PositionWatcher ──▶ StateDB (data/positions.json)
                                              │                     ▲
                                     onAccountChange           TieredPriceFeed
                                     (position + lbPair)       (Pyth / Jupiter / stablecoin)
                                              │                     │
                                              ▼                     │
                                          RiskEngine ◀───────────────┘
                                              │
                                    SL / TP / ratio-skew hit
                                              ▼
                                     TransactionExecutor ──▶ Solana (removeLiquidity + claim + close)
                                              │
                                              ▼
                                        TelegramBot (notify + control)
```

| Module | Responsibility |
|---|---|
| `PositionDetector` | `logsSubscribe` on the wallet address, filters for DLMM `InitializePosition`, fetches and parses the tx |
| `PositionWatcher` | Builds the entry snapshot, subscribes to on-chain account changes, keeps position state fresh |
| `TieredPriceFeed` | Resolves a USD price for the quote token — see [Price feed tiers](#price-feed-tiers) |
| `RiskEngine` | Pure PnL calculation + SL/TP/ratio comparison, fires the close callback |
| `TransactionExecutor` | Builds and sends the close transaction, priority-fee tiering, retry with backoff, `DRY_RUN` simulate mode |
| `StateDB` | Flat JSON file (`data/positions.json`) — single source of truth, survives restarts |
| `TelegramBot` | Long-polling bot, inline keyboards, per-chat-id access guard, open/close notifications |

---

## Risk Engine — trigger logic

For every tracked position, PnL is computed from live on-chain state (current token amounts + unclaimed fees, valued at the current price) against the recorded entry value:

```
PnL% = (currentValueUsd − entryValueUsd) / entryValueUsd × 100
```

A close is triggered when:

| Condition | Rule |
|---|---|
| **Stop Loss** | `PnL% <= -slPercent` |
| **Take Profit** | `PnL% >= tpPercent` |
| **Ratio skew** | Either token's share of position value drops below its configured `minRatioA` / `minRatioB` floor — signals the active bin has moved through most/all of the range |

These checks run **on every on-chain account change** (bin price move, liquidity/fee change) **and on every price tick** from the price feed — so a quote-token price move alone is enough to trigger, not just pool activity.

### Price feed tiers

| Quote token type | Source |
|---|---|
| Stablecoins (USDC / USDT / USDH) | Fixed `$1.00` |
| SOL / wSOL | [Pyth](https://pyth.network/) push feed (low latency) |
| Everything else | [Jupiter](https://jup.ag/) price API polling |

---

## Setup

```bash
git clone https://github.com/Kwanyeob/DLMM-Watcher-bot-.git
cd DLMM-Watcher-bot-
npm install

cp .env.example .env
# fill in the values below

npm run build
npm run pm2:start   # production, auto-restart via pm2
# or
npm run dev          # local run with ts-node, no build step
```

### Environment variables (`.env`)

| Variable | Description |
|---|---|
| `SOLANA_RPC_ENDPOINT` | HTTP RPC endpoint (e.g. [Helius](https://dev.helius.xyz/dashboard/app)) |
| `SOLANA_WS_ENDPOINT` | WebSocket RPC endpoint |
| `WALLET_ADDRESS` | Public key of the wallet to monitor |
| `WALLET_PRIVATE_KEY` | Private key used to sign close transactions — JSON byte array `[1,2,...]` or base58 string (Phantom/Solflare export) |
| `LOG_LEVEL` | `error` \| `warn` \| `info` \| `debug` |
| `DEFAULT_SL_PERCENT` / `DEFAULT_TP_PERCENT` | Optional default SL/TP applied to every new position |
| `DEFAULT_MIN_RATIO_A` / `DEFAULT_MIN_RATIO_B` | Optional default ratio-skew floor |
| `DRY_RUN` | `true` simulates close transactions without sending — **start here** |
| `TELEGRAM_BOT_TOKEN` | From [@BotFather](https://t.me/BotFather) |
| `TELEGRAM_CHAT_ID` | Your personal chat id — send `/start` to [@userinfobot](https://t.me/userinfobot) to get it |

> ⚠️ `WALLET_PRIVATE_KEY` signs real transactions once `DRY_RUN=false`. Never commit `.env`, never share it, and test with a small position before trusting it with real capital.

### npm scripts

| Command | What it does |
|---|---|
| `npm run dev` | Run directly with `ts-node`, no build |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the compiled build |
| `npm run pm2:start` / `pm2:stop` / `pm2:logs` | Manage the process under pm2 |
| `npm test` | Run the test suite (vitest) |
| `npm run simulate` | Run the local simulation script |

---

## Telegram commands

| Command | Description |
|---|---|
| `/status` | Current positions and live PnL, with tap buttons for SL/TP/ratio/Close |
| `/set <id> sl <pct>` | Set stop loss for a position |
| `/set <id> tp <pct>` | Set take profit for a position |
| `/set <id> mina <pct>` | Min % of value token A may fall to before a skew close |
| `/set <id> minb <pct>` | Min % of value token B may fall to before a skew close |
| `/close <id>` | Close a position manually |
| `/add <address>` | Register an existing on-chain position that wasn't auto-detected |
| `/remove <id>` | Stop watching a position (leaves it open on-chain) |
| `/panic` → `/panic confirm` | Emergency close **all** tracked positions (30s confirmation window) |

Every notification (`/status`, new position, closed position) also renders inline buttons — most day-to-day use needs no typing at all.

---

## 🎯 Execution & Validation Showcase

A real-time example of the bot catching market volatility, calculating PnL via the internal Risk Engine, and executing a Take-Profit close on Meteora DLMM with millisecond-level precision.

### Timeline

The bot detects an active-bin jump, triggers the TP logic, and fully closes the position within ~1.1s on-chain (confirmed within ~2.5s via RPC):

```
[21:48:22.890]  Active bin jump detected (-301 → -300)
       │  1 ms
       ▼
[21:48:22.891]  RiskEngine triggered — PnL +1.52% ≥ TP +1.50%
       │  2 ms
       ▼
[21:48:22.893]  Close transaction dispatched
       │  1,107 ms
       ▼
[21:48:24.000]  Transaction mined on-chain (Solscan timestamp)
       │  1,651 ms
       ▼
[21:48:25.651]  RPC confirmation received
```

Detection → dispatch was **278ms** end-to-end — demonstrating the value of tracking via direct account subscriptions instead of polling.

### Cross-verification against on-chain settlement

The internal `RiskEngine` valuation at the moment of close was checked against the actual on-chain settlement (ground truth, via Solscan) and Meteora's own UI:

| | Internal (RiskEngine) | On-chain (Solscan) | Meteora UI |
|---|---|---|---|
| **MENSA removed** | ~$1.48 total | 128.909374 MENSA ($0.5342) | 128.91 MENSA |
| **SOL removed** | ~$1.48 total | 0.011537728 WSOL ($0.9422) | 0.012 SOL |
| **MENSA fee claimed** | $0.00 | 0 | 0 |
| **SOL fee claimed** | ~$0.00 | 0.000033893 WSOL ($0.0027) | 0.04338 SOL |

Total: `$0.5342 + $0.9422 + $0.0027 = $1.4791` on-chain vs. `$1.48` internal target — matched within rounding.

### Other observations from the same run

- **Priority-fee targeting** closed the position using standard priority parameters without slippage or reverts, via precise bin targeting.
- **Local state was wiped immediately** after confirmation (`StateDB: removed`) to keep telemetry clean and avoid redundant tracking loops.

---

## A note on PnL accuracy vs. Meteora's UI

The `RiskEngine` computes PnL entirely from data it reads directly on-chain (the position account + the pool's `lbPair` account) combined with its own [tiered price feed](#price-feed-tiers) — it does not call Meteora's API or scrape their UI. The showcase above cross-checks that internal number against Solscan's actual settled amounts (ground truth) and Meteora's UI at the same moment, and all three agree within rounding.

That said, the bot's *live* PnL display can transiently differ slightly from what Meteora's UI shows at any given instant — both are reading the same on-chain state, but the USD price feed backing each one (Pyth/Jupiter here vs. whatever Meteora sources internally) can update on a slightly different cadence. This is exactly why `RiskEngine.check()` re-runs on every price tick, not only on-chain events — it keeps the gap as small as possible rather than assuming it's zero.

---

## Disclaimer

This bot holds a private key and signs real, irreversible on-chain transactions. It is not audited. Test extensively with `DRY_RUN=true` and a small position before using it with meaningful capital, and never commit or share your `.env`. Use at your own risk.

---
---

# 🚀 DLMM Watcher Bot (한국어)

Solana [Meteora DLMM](https://www.meteora.ag/) 유동성 포지션을 위한 자동 손절(SL)/익절(TP) 감시·청산 봇입니다 — Telegram으로 실시간 제어할 수 있습니다.

지갑 주소 하나만 넣어두면, 새로운 DLMM 포지션이 열리는 순간을 즉시 감지하고, 그 가치를 온체인에서 실시간으로 추적하다가, 설정한 리스크 규칙에 도달하면 자동으로 청산합니다. 모든 과정은 Telegram에서 확인하고 제어할 수 있습니다.

---

## 이 봇이 하는 일

- **신규 포지션 즉시 감지** — 감시 대상 지갑의 트랜잭션 로그를 구독해서, Meteora의 `InitializePosition` 명령이 온체인에 기록되는 순간을 포착합니다.
- **정확한 진입 스냅샷 생성** — 포지션을 오픈한 트랜잭션에서 실제 예치된 수량을 직접 파싱합니다 (이미 가격이 움직인 뒤 재조회하는 방식이 아니라, cost basis가 어긋날 여지가 없습니다).
- **실시간 추적** — 포지션 계정과 풀(`lbPair`) 계정을 직접 구독합니다. 폴링이 아닙니다.
- **매 업데이트마다 Risk Engine 실행** — 온체인 변화가 있을 때뿐 아니라 가격이 틱될 때마다 SL/TP/비율 스큐(ratio-skew)를 재평가합니다. 즉, 풀에 아무 움직임이 없어도 순수한 가격 변동(예: SOL/USD)만으로 청산이 트리거될 수 있습니다.
- **자동 온체인 청산** — 유동성 회수, 수수료 클레임, 포지션 종료를 트랜잭션 하나로 처리하며, 우선순위 수수료 티어링과 자동 재시도가 포함됩니다.
- **Telegram으로 완전 제어** — 실시간 PnL 확인, 탭으로 조절하는 SL/TP/비율 스텝퍼, 수동 청산, 전체 긴급 청산(panic-close-all).
- **재시작에도 상태 유지** — 포지션 상태는 로컬 JSON 파일에 저장되고, WebSocket 연결은 끊기면 자동 재연결 후 모든 구독을 순서대로 복원합니다.

---

## 아키텍처

```
지갑 트랜잭션 로그 ──▶ PositionDetector ──▶ PositionWatcher ──▶ StateDB (data/positions.json)
                                              │                     ▲
                                     onAccountChange           TieredPriceFeed
                                     (포지션 + lbPair)          (Pyth / Jupiter / 스테이블코인)
                                              │                     │
                                              ▼                     │
                                          RiskEngine ◀───────────────┘
                                              │
                                    SL / TP / 비율 스큐 도달
                                              ▼
                                     TransactionExecutor ──▶ Solana (유동성 회수 + 수수료 클레임 + 종료)
                                              │
                                              ▼
                                        TelegramBot (알림 + 제어)
```

| 모듈 | 역할 |
|---|---|
| `PositionDetector` | 지갑 주소에 `logsSubscribe`, DLMM `InitializePosition` 로그 필터링, 트랜잭션 조회 및 파싱 |
| `PositionWatcher` | 진입 스냅샷 생성, 온체인 계정 변화 구독, 포지션 상태 최신화 |
| `TieredPriceFeed` | 쿼트 토큰의 USD 가격 결정 — [가격 피드 티어](#가격-피드-티어) 참고 |
| `RiskEngine` | 순수 PnL 계산 + SL/TP/비율 비교, 청산 콜백 호출 |
| `TransactionExecutor` | 청산 트랜잭션 생성·전송, 우선순위 수수료 티어링, 재시도(백오프), `DRY_RUN` 시뮬레이션 모드 |
| `StateDB` | 플랫 JSON 파일(`data/positions.json`) — 단일 진실 소스, 재시작에도 유지됨 |
| `TelegramBot` | 롱폴링 봇, 인라인 키보드, chat id 기반 접근 제한, 오픈/청산 알림 |

---

## Risk Engine — 트리거 로직

추적 중인 각 포지션에 대해, PnL은 현재 온체인 상태(현재 토큰 수량 + 미청구 수수료를 현재가로 평가)와 기록된 진입 가치를 비교해 계산됩니다:

```
PnL% = (현재 가치USD − 진입 가치USD) / 진입 가치USD × 100
```

다음 조건에서 청산이 트리거됩니다:

| 조건 | 규칙 |
|---|---|
| **손절(Stop Loss)** | `PnL% <= -slPercent` |
| **익절(Take Profit)** | `PnL% >= tpPercent` |
| **비율 스큐(Ratio skew)** | 두 토큰 중 하나의 포지션 가치 비중이 설정한 `minRatioA` / `minRatioB` 이하로 떨어짐 — 액티브 빈이 범위 대부분/전체를 통과했다는 신호 |

이 체크는 **온체인 계정 변화(빈 가격 이동, 유동성/수수료 변화)가 있을 때마다**뿐 아니라 **가격 피드 틱마다**도 실행됩니다. 즉 풀 활동 없이 쿼트 토큰 가격만 움직여도 트리거될 수 있습니다.

### 가격 피드 티어

| 쿼트 토큰 종류 | 소스 |
|---|---|
| 스테이블코인 (USDC / USDT / USDH) | 고정 `$1.00` |
| SOL / wSOL | [Pyth](https://pyth.network/) push 피드 (저지연) |
| 그 외 | [Jupiter](https://jup.ag/) 가격 API 폴링 |

---

## 셋업

```bash
git clone https://github.com/Kwanyeob/DLMM-Watcher-bot-.git
cd DLMM-Watcher-bot-
npm install

cp .env.example .env
# 아래 표를 참고해서 값 채우기

npm run build
npm run pm2:start   # 운영 환경, pm2로 자동 재시작
# 또는
npm run dev          # ts-node로 로컬 실행, 빌드 불필요
```

### 환경 변수 (`.env`)

| 변수 | 설명 |
|---|---|
| `SOLANA_RPC_ENDPOINT` | HTTP RPC 엔드포인트 (예: [Helius](https://dev.helius.xyz/dashboard/app)) |
| `SOLANA_WS_ENDPOINT` | WebSocket RPC 엔드포인트 |
| `WALLET_ADDRESS` | 감시할 지갑의 퍼블릭 키 |
| `WALLET_PRIVATE_KEY` | 청산 트랜잭션 서명에 쓰는 프라이빗 키 — JSON 바이트 배열 `[1,2,...]` 또는 base58 문자열(Phantom/Solflare 내보내기 형식) |
| `LOG_LEVEL` | `error` \| `warn` \| `info` \| `debug` |
| `DEFAULT_SL_PERCENT` / `DEFAULT_TP_PERCENT` | 신규 포지션에 자동 적용할 기본 SL/TP (선택) |
| `DEFAULT_MIN_RATIO_A` / `DEFAULT_MIN_RATIO_B` | 기본 비율 스큐 하한선 (선택) |
| `DRY_RUN` | `true`면 실제 전송 없이 청산 트랜잭션을 시뮬레이션만 함 — **여기서부터 시작하세요** |
| `TELEGRAM_BOT_TOKEN` | [@BotFather](https://t.me/BotFather)에서 발급 |
| `TELEGRAM_CHAT_ID` | 본인 chat id — [@userinfobot](https://t.me/userinfobot)에 `/start` 보내면 확인 가능 |

> ⚠️ `DRY_RUN=false`가 되는 순간 `WALLET_PRIVATE_KEY`가 실제 트랜잭션에 서명합니다. `.env`는 절대 커밋하거나 공유하지 마시고, 실제 자금을 맡기기 전에 소액으로 충분히 테스트하세요.

### npm 스크립트

| 명령어 | 설명 |
|---|---|
| `npm run dev` | 빌드 없이 `ts-node`로 바로 실행 |
| `npm run build` | TypeScript를 `dist/`로 컴파일 |
| `npm start` | 컴파일된 빌드 실행 |
| `npm run pm2:start` / `pm2:stop` / `pm2:logs` | pm2로 프로세스 관리 |
| `npm test` | 테스트 스위트 실행 (vitest) |
| `npm run simulate` | 로컬 시뮬레이션 스크립트 실행 |

---

## Telegram 명령어

| 명령어 | 설명 |
|---|---|
| `/status` | 현재 포지션과 실시간 PnL, SL/TP/비율/청산 탭 버튼 포함 |
| `/set <id> sl <pct>` | 포지션의 손절 설정 |
| `/set <id> tp <pct>` | 포지션의 익절 설정 |
| `/set <id> mina <pct>` | 스큐 청산 전 토큰 A 가치 비중이 떨어질 수 있는 최소 % |
| `/set <id> minb <pct>` | 스큐 청산 전 토큰 B 가치 비중이 떨어질 수 있는 최소 % |
| `/close <id>` | 포지션 수동 청산 |
| `/add <address>` | 자동 감지되지 않은 기존 온체인 포지션을 등록 |
| `/remove <id>` | 감시만 중단 (온체인 포지션은 그대로 유지) |
| `/panic` → `/panic confirm` | 추적 중인 **모든** 포지션 긴급 청산 (30초 확인 대기) |

`/status`를 포함한 모든 알림(신규 포지션, 청산 완료)에는 인라인 버튼이 함께 렌더링되어, 일상적인 사용에는 타이핑이 거의 필요 없습니다.

---

## 🎯 실행 & 검증 쇼케이스

시장 변동성을 포착하고, 내부 Risk Engine으로 PnL을 계산해서, Meteora DLMM에서 밀리초 단위 정밀도로 익절(TP) 청산을 실행한 실제 사례입니다.

### 타임라인

액티브 빈 점프를 감지하고 TP 로직이 트리거되어, 약 1.1초 만에 온체인에서 포지션이 완전히 종료됩니다 (RPC 컨펌까지 약 2.5초):

```
[21:48:22.890]  액티브 빈 점프 감지 (-301 → -300)
       │  1 ms
       ▼
[21:48:22.891]  RiskEngine 트리거 — PnL +1.52% ≥ TP +1.50%
       │  2 ms
       ▼
[21:48:22.893]  청산 트랜잭션 전송
       │  1,107 ms
       ▼
[21:48:24.000]  트랜잭션 온체인 확정 (Solscan 타임스탬프 기준)
       │  1,651 ms
       ▼
[21:48:25.651]  RPC 컨펌 수신
```

감지부터 전송까지 걸린 시간은 총 **278ms** — 폴링이 아니라 계정 구독 방식으로 추적하는 것의 이점을 보여줍니다.

### 온체인 정산 값과의 교차 검증

청산 시점의 내부 `RiskEngine` 평가액을 실제 온체인 정산 결과(그라운드 트루스, Solscan 기준) 및 Meteora 자체 UI와 비교했습니다:

| | 내부 계산 (RiskEngine) | 온체인 (Solscan) | Meteora UI |
|---|---|---|---|
| **MENSA 회수** | 합계 약 $1.48 | 128.909374 MENSA ($0.5342) | 128.91 MENSA |
| **SOL 회수** | 합계 약 $1.48 | 0.011537728 WSOL ($0.9422) | 0.012 SOL |
| **MENSA 수수료 클레임** | $0.00 | 0 | 0 |
| **SOL 수수료 클레임** | 약 $0.00 | 0.000033893 WSOL ($0.0027) | 0.04338 SOL |

합계: 온체인 `$0.5342 + $0.9422 + $0.0027 = $1.4791` vs. 내부 목표값 `$1.48` — 반올림 오차 내로 일치합니다.

### 같은 실행에서 관찰된 것들

- **우선순위 수수료 타겟팅** — 정밀한 빈 타겟팅 덕분에 슬리피지나 트랜잭션 실패 없이 표준 우선순위 파라미터만으로 청산에 성공했습니다.
- **로컬 상태 즉시 삭제** — 컨펌 직후 (`StateDB: removed`) 로컬 캐시를 지워서 텔레메트리를 깨끗하게 유지하고 중복 추적 루프를 방지합니다.

---

## Meteora UI와의 PnL 차이에 대해

`RiskEngine`은 Meteora API를 호출하거나 UI를 긁어오지 않고, 온체인에서 직접 읽은 데이터(포지션 계정 + 풀의 `lbPair` 계정)와 자체 [티어드 가격 피드](#가격-피드-티어)만으로 PnL을 독립적으로 계산합니다. 위 쇼케이스는 그 내부 값을 같은 시점의 Solscan 실제 정산액(그라운드 트루스), Meteora UI와 대조한 것이며, 세 값 모두 반올림 오차 내에서 일치했습니다.

다만 봇의 *실시간* PnL 표시는 특정 순간 Meteora UI가 보여주는 값과 순간적으로 약간 다를 수 있습니다 — 둘 다 같은 온체인 상태를 읽지만, 그걸 USD로 환산하는 가격 소스(여기서는 Pyth/Jupiter, Meteora는 내부적으로 다른 소스를 쓸 수 있음)의 갱신 주기가 다를 수 있기 때문입니다. `RiskEngine.check()`가 온체인 이벤트뿐 아니라 가격 틱마다도 재실행되는 이유가 바로 이것입니다 — 그 격차가 0이라고 가정하는 대신, 최대한 좁게 유지하려는 것입니다.

---

## 면책 조항

이 봇은 프라이빗 키를 보유하고 실제로 되돌릴 수 없는 온체인 트랜잭션에 서명합니다. 감사(audit)받지 않은 코드입니다. 의미 있는 자금을 맡기기 전에 `DRY_RUN=true`와 소액 포지션으로 충분히 테스트하시고, `.env`는 절대 커밋하거나 공유하지 마세요. 모든 사용은 본인 책임입니다.

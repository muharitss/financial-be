# AGENTS.md — Backend (financial-be/)

Panduan untuk AI agent & developer di `financial-be/`. Baca sebelum coding.

## Perintah Penting

```bash
npm run start:dev    # dev server (NestJS 12)
npm run build        # production build
npm run lint         # linter
npm run test         # unit test (lihat proyek.md §17.3)
npm run test:e2e     # integration/e2e test (Supertest)
npx prisma generate
npx prisma migrate dev --name <name>
npx prisma studio
```

## Constitution — Prinsip Wajib

- **C-01** — Isolasi data: setiap query WAJIB filter `userId` dari JWT + ditegakkan fail-closed di `PrismaService` middleware/extension (`proyek.md` §4.3).
- **C-02** — Nominal = integer `BIGINT`. Jangan `float` / desimal.
- **C-03** — Transfer bukan income/expense. Dukung Metode A (default, expense `Biaya Transfer` via `transferGroupId`) & Metode B (dibundel `amount_received = amount_out - fee`) tanpa double counting (`proyek.md` §7.5).
- **C-04** — Scheduled transaction idempoten (cron `00:05` + on-demand saat login, `(transaction_id, posted_at)` unik).
- **C-06** — Setiap mutasi transaksi → tulis `TransactionAudit` (`before`/`after`). Adjustment wajib `reason` (min 10 karakter).

## Struktur Folder

```
src/
├── common/       # guard, pipe, filter, interceptor, decorator
├── modules/      # auth, users, accounts, transactions, categories,
│                 # budgets, savings, dashboard, reports, notifications,
│                 # files, audit, sync
└── prisma/       # PrismaService + fail-closed userId isolation
```

## Konvensi Kunci

- **Error envelope:** `{ code, message, details, traceId }` via global filter.
- **Idempotency:** semua endpoint mutasi wajib header `Idempotency-Key` atau body `client_tx_id` (**ULID**) + cek `IdempotencyKey`.
- **Validation:** Zod + `ZodValidationPipe`.
- **Auth:** Cookie `__Host-duitku_session` (JWT HS256 ≤ 15 menit) + refresh opaque 30 hari di DB (`proyek.md` §5.2). Jangan buat auth kedua.
- **PII:** Jangan log nominal / PII di level info. Log `userId` saja.

## Larangan

- ❌ Install library baru tanpa mengacu `proyek.md` / ADR.
- ❌ Ubah `prisma/schema.prisma` tanpa task eksplisit.
- ❌ Implementasi fitur non-MVP (`proyek.md` Bagian 14).
- ❌ Query tanpa filter `userId` pada tabel milik user.
- ❌ Log nominal / PII di level info.
- ❌ Hard-delete transaksi `POSTED` — wajib reversal.

## Referensi

- `../proyek.md` — dokumen induk proyek (patokan utama)
- `../docs/specs/` & `../docs/adr/` — spesifikasi & keputusan arsitektur
- `../docs/constitution.md` — prinsip fundamental

## Production data: NestJS Observe

This app reports its traces, errors, logs and metrics to [NestJS Observe](https://observe.nestjs.com) through `ObserveModule` in the root module. Its key pair comes from `OBSERVE_APP_KEY` and `OBSERVE_APP_SECRET` in `.env`, which `npx @nestjs/observe link` writes.

When a task depends on how the app behaves in production - an error users hit, a slow endpoint, a failing job, whether a release made things worse - work from that data, not from the code alone:

- The Observe MCP server answers those questions directly: errors with their traces and logs, slow operations, jobs, and what a release changed (`find_regressions`, `diff_release`). It is included on the Pro plan and above. In Claude Code: `claude mcp add observe --transport http https://observe-api.nestjs.com/mcp`, and the client opens a browser to approve. Other clients: https://www.observe.nestjs.com/documentation/mcp
- Without it, the user can open the request or error in the Observe dashboard and click **Copy agent prompt**, which hands over that page's trace, stack and logs as text.

## Production data: NestJS Observe

This app reports its traces, errors, logs and metrics to [NestJS Observe](https://observe.nestjs.com) through `ObserveModule` in the root module. Its key pair comes from `OBSERVE_APP_KEY` and `OBSERVE_APP_SECRET` in `.env`, which `npx @nestjs/observe link` writes.

When a task depends on how the app behaves in production - an error users hit, a slow endpoint, a failing job, whether a release made things worse - work from that data, not from the code alone:

- The Observe MCP server answers those questions directly: errors with their traces and logs, slow operations, jobs, and what a release changed (`find_regressions`, `diff_release`). It is included on the Pro plan and above. In Claude Code: `claude mcp add observe --transport http https://observe-api.nestjs.com/mcp`, and the client opens a browser to approve. Other clients: https://www.observe.nestjs.com/documentation/mcp
- Without it, the user can open the request or error in the Observe dashboard and click **Copy agent prompt**, which hands over that page's trace, stack and logs as text.

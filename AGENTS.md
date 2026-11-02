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

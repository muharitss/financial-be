import { ConflictException } from '@nestjs/common';
import { evaluateNegativeBalancePolicy } from './balance-policy.js';

describe('evaluateNegativeBalancePolicy', () => {
  const accountId = '11111111-1111-1111-1111-111111111111';

  it('Skenario A: allow_negative = false, balance = 10000, reserved = 0, delta = -20000 -> throw 409 INSUFFICIENT_BALANCE', () => {
    expect(() =>
      evaluateNegativeBalancePolicy({
        account: { id: accountId, balance: 10000n, allow_negative: false },
        reserved: 0n,
        delta: -20000n,
      }),
    ).toThrow(ConflictException);

    try {
      evaluateNegativeBalancePolicy({
        account: { id: accountId, balance: 10000n, allow_negative: false },
        reserved: 0n,
        delta: -20000n,
      });
    } catch (err: any) {
      expect(err.getResponse()).toEqual({
        code: 'INSUFFICIENT_BALANCE',
        message:
          'Saldo akun tidak mencukupi. Sesuaikan saldo atau izinkan saldo negatif untuk akun ini.',
        details: {
          account_id: accountId,
          ledger_balance: 10000,
          reserved: 0,
          available: 10000,
          needed: 20000,
          shortfall: 10000,
          resolution_options: ['ADJUST_BALANCE', 'ALLOW_NEGATIVE'],
        },
      });
    }
  });

  it('Skenario B: allow_negative = false, balance = 50000, reserved = 40000 (available = 10000), delta = -20000 -> throw 409 INSUFFICIENT_BALANCE', () => {
    try {
      evaluateNegativeBalancePolicy({
        account: { id: accountId, balance: 50000n, allow_negative: false },
        reserved: 40000n,
        delta: -20000n,
      });
    } catch (err: any) {
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toEqual({
        code: 'INSUFFICIENT_BALANCE',
        message:
          'Saldo akun tidak mencukupi. Sesuaikan saldo atau izinkan saldo negatif untuk akun ini.',
        details: {
          account_id: accountId,
          ledger_balance: 50000,
          reserved: 40000,
          available: 10000,
          needed: 20000,
          shortfall: 10000,
          resolution_options: ['ADJUST_BALANCE', 'ALLOW_NEGATIVE'],
        },
      });
    }
  });

  it('Skenario C: allow_negative = true, balance = 10000, reserved = 0, delta = -20000 -> sukses newBalance = -10000n, warning NEGATIVE_BALANCE', () => {
    const res = evaluateNegativeBalancePolicy({
      account: { id: accountId, balance: 10000n, allow_negative: true },
      reserved: 0n,
      delta: -20000n,
    });

    expect(res).toEqual({
      newBalance: -10000n,
      warning: 'NEGATIVE_BALANCE',
    });
  });

  it('Skenario D: Transfer keluar dari akun negatif (balance = -50000) ditolak jika allow_negative = false', () => {
    try {
      evaluateNegativeBalancePolicy({
        account: { id: accountId, balance: -50000n, allow_negative: false },
        reserved: 0n,
        delta: -10000n,
        isOutgoingTransfer: true,
      });
    } catch (err: any) {
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toEqual({
        code: 'INSUFFICIENT_BALANCE',
        message:
          'Saldo akun tidak mencukupi. Sesuaikan saldo atau izinkan saldo negatif untuk akun ini.',
        details: {
          account_id: accountId,
          ledger_balance: -50000,
          reserved: 0,
          available: -50000,
          needed: 10000,
          shortfall: 60000,
          resolution_options: ['ADJUST_BALANCE', 'ALLOW_NEGATIVE'],
        },
      });
    }
  });

  it('Skenario D: Transfer keluar dari akun negatif (balance = -50000) sukses jika allow_negative = true', () => {
    const res = evaluateNegativeBalancePolicy({
      account: { id: accountId, balance: -50000n, allow_negative: true },
      reserved: 0n,
      delta: -10000n,
      isOutgoingTransfer: true,
    });

    expect(res).toEqual({
      newBalance: -60000n,
      warning: 'NEGATIVE_BALANCE',
    });
  });

  it('Skenario E: INCOME masuk ke akun negatif (balance = -50000, delta = +20000 -> newBalance = -30000) selalu diizinkan dengan warning NEGATIVE_BALANCE', () => {
    // Pada allow_negative = false
    const resFalse = evaluateNegativeBalancePolicy({
      account: { id: accountId, balance: -50000n, allow_negative: false },
      reserved: 0n,
      delta: 20000n,
    });
    expect(resFalse).toEqual({
      newBalance: -30000n,
      warning: 'NEGATIVE_BALANCE',
    });

    // Pada allow_negative = true
    const resTrue = evaluateNegativeBalancePolicy({
      account: { id: accountId, balance: -50000n, allow_negative: true },
      reserved: 0n,
      delta: 20000n,
    });
    expect(resTrue).toEqual({
      newBalance: -30000n,
      warning: 'NEGATIVE_BALANCE',
    });
  });

  it('Operasi normal tanpa saldo negatif mengembalikan newBalance tanpa warning', () => {
    const expenseRes = evaluateNegativeBalancePolicy({
      account: { id: accountId, balance: 50000n, allow_negative: false },
      reserved: 0n,
      delta: -20000n,
    });
    expect(expenseRes).toEqual({ newBalance: 30000n });

    const incomeRes = evaluateNegativeBalancePolicy({
      account: { id: accountId, balance: 10000n, allow_negative: false },
      reserved: 0n,
      delta: 20000n,
    });
    expect(incomeRes).toEqual({ newBalance: 30000n });

    const transferRes = evaluateNegativeBalancePolicy({
      account: { id: accountId, balance: 50000n, allow_negative: false },
      reserved: 0n,
      delta: -20000n,
      isOutgoingTransfer: true,
    });
    expect(transferRes).toEqual({ newBalance: 30000n });
  });
});

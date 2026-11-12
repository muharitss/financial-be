import { describe, it, expect } from '@jest/globals';
import { balanceEffects } from './balance-effects.js';

describe('balanceEffects (Pure Function)', () => {
  const ACC_FROM = 'acc-source';
  const ACC_TO = 'acc-dest';

  it('AC-1: INCOME 100 -> [+100]', () => {
    const effects = balanceEffects({
      type: 'INCOME',
      amount: 100,
      account_id: ACC_FROM,
    });

    expect(effects).toEqual([{ account_id: ACC_FROM, delta: 100n }]);
  });

  it('AC-1: EXPENSE 100 -> [-100]', () => {
    const effects = balanceEffects({
      type: 'EXPENSE',
      amount: 100,
      account_id: ACC_FROM,
    });

    expect(effects).toEqual([{ account_id: ACC_FROM, delta: -100n }]);
  });

  it('AC-1: ADJUSTMENT -20 -> [-20]', () => {
    const effects = balanceEffects({
      type: 'ADJUSTMENT',
      amount: -20,
      account_id: ACC_FROM,
    });

    expect(effects).toEqual([{ account_id: ACC_FROM, delta: -20n }]);
  });

  it('AC-1: ADJUSTMENT +50 -> [+50]', () => {
    const effects = balanceEffects({
      type: 'ADJUSTMENT',
      amount: 50,
      account_id: ACC_FROM,
    });

    expect(effects).toEqual([{ account_id: ACC_FROM, delta: 50n }]);
  });

  it('AC-1: TRANSFER 500 tanpa fee -> [from -500, to +500]', () => {
    const effects = balanceEffects({
      type: 'TRANSFER',
      amount: 500,
      account_id: ACC_FROM,
      to_account_id: ACC_TO,
    });

    expect(effects).toEqual([
      { account_id: ACC_FROM, delta: -500n },
      { account_id: ACC_TO, delta: 500n },
    ]);
  });

  it('AC-1: TRANSFER Metode B (amount = 493.500, transfer_fee = 6.500, BUNDLED) -> [from -500.000, to +493.500]', () => {
    const effects = balanceEffects({
      type: 'TRANSFER',
      amount: 493_500,
      transfer_fee: 6_500,
      fee_mode: 'BUNDLED',
      account_id: ACC_FROM,
      to_account_id: ACC_TO,
    });

    expect(effects).toEqual([
      { account_id: ACC_FROM, delta: -500_000n },
      { account_id: ACC_TO, delta: 493_500n },
    ]);
  });

  it('AC-1: REVERSAL dari INCOME -> negasi [-100]', () => {
    const effects = balanceEffects({
      type: 'REVERSAL',
      amount: 100,
      account_id: ACC_FROM,
      parent: { type: 'INCOME' },
    });

    expect(effects).toEqual([{ account_id: ACC_FROM, delta: -100n }]);
  });

  it('AC-1: REVERSAL dari EXPENSE -> negasi [+100]', () => {
    const effects = balanceEffects({
      type: 'REVERSAL',
      amount: 100,
      account_id: ACC_FROM,
      parent: { type: 'EXPENSE' },
    });

    expect(effects).toEqual([{ account_id: ACC_FROM, delta: 100n }]);
  });

  it('AC-1: REVERSAL dari ADJUSTMENT -20 -> negasi [+20]', () => {
    const effects = balanceEffects({
      type: 'REVERSAL',
      amount: -20,
      account_id: ACC_FROM,
      parent: { type: 'ADJUSTMENT' },
    });

    expect(effects).toEqual([{ account_id: ACC_FROM, delta: 20n }]);
  });

  it('AC-1: REVERSAL dari TRANSFER tanpa fee -> negasi [from +500, to -500]', () => {
    const effects = balanceEffects({
      type: 'REVERSAL',
      amount: 500,
      account_id: ACC_FROM,
      to_account_id: ACC_TO,
      parent: { type: 'TRANSFER' },
    });

    expect(effects).toEqual([
      { account_id: ACC_FROM, delta: 500n },
      { account_id: ACC_TO, delta: -500n },
    ]);
  });

  it('AC-1: REVERSAL dari TRANSFER Metode B -> negasi [from +500.000, to -493.500]', () => {
    const effects = balanceEffects({
      type: 'REVERSAL',
      amount: 493_500,
      transfer_fee: 6_500,
      fee_mode: 'BUNDLED',
      account_id: ACC_FROM,
      to_account_id: ACC_TO,
      parent: { type: 'TRANSFER' },
    });

    expect(effects).toEqual([
      { account_id: ACC_FROM, delta: 500_000n },
      { account_id: ACC_TO, delta: -493_500n },
    ]);
  });

  it('returns empty array when REVERSAL has no parent type', () => {
    const effects = balanceEffects({
      type: 'REVERSAL',
      amount: 100,
      account_id: ACC_FROM,
    });

    expect(effects).toEqual([]);
  });

  it('returns empty array for unknown transaction type', () => {
    const effects = balanceEffects({
      type: 'UNKNOWN',
      amount: 100,
      account_id: ACC_FROM,
    });

    expect(effects).toEqual([]);
  });
});

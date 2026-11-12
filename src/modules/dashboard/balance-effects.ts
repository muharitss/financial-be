export interface BalanceEffectTx {
  type: string;
  amount: bigint | number;
  account_id: string;
  to_account_id?: string | null;
  transfer_fee?: bigint | number | null;
  fee_mode?: string | null;
  parent?: { type: string } | null;
}

export function balanceEffects(tx: BalanceEffectTx): Array<{ account_id: string; delta: bigint }> {
  const amount = BigInt(tx.amount);
  const transferFee = tx.transfer_fee != null ? BigInt(tx.transfer_fee) : 0n;

  if (tx.type === 'INCOME') {
    return [{ account_id: tx.account_id, delta: amount }];
  }
  if (tx.type === 'EXPENSE') {
    return [{ account_id: tx.account_id, delta: -amount }];
  }
  if (tx.type === 'ADJUSTMENT') {
    return [{ account_id: tx.account_id, delta: amount }];
  }
  if (tx.type === 'TRANSFER') {
    const fee = tx.fee_mode === 'BUNDLED' ? transferFee : 0n;
    const effects: Array<{ account_id: string; delta: bigint }> = [
      { account_id: tx.account_id, delta: -(amount + fee) },
    ];
    if (tx.to_account_id) {
      effects.push({ account_id: tx.to_account_id, delta: amount });
    }
    return effects;
  }
  if (tx.type === 'REVERSAL') {
    if (!tx.parent?.type) {
      return [];
    }
    const baseEffects = balanceEffects({
      ...tx,
      type: tx.parent.type,
      parent: null,
    });
    return baseEffects.map((e) => ({
      account_id: e.account_id,
      delta: -e.delta,
    }));
  }

  return [];
}

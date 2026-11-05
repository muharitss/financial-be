import { ConflictException } from '@nestjs/common';

export interface BalancePolicyAccount {
  id: string;
  balance: bigint;
  allow_negative: boolean;
}

export interface EvaluateBalancePolicyParams {
  account: BalancePolicyAccount;
  reserved: bigint;
  delta: bigint;
  isOutgoingTransfer?: boolean;
}

export interface BalancePolicyResult {
  newBalance: bigint;
  warning?: 'NEGATIVE_BALANCE';
}

export function evaluateNegativeBalancePolicy({
  account,
  reserved,
  delta,
  isOutgoingTransfer = false,
}: EvaluateBalancePolicyParams): BalancePolicyResult {
  const newBalance = account.balance + delta;
  const availableBalance = account.balance - reserved;
  const amountNeeded = delta < 0n ? -delta : 0n;

  if (!account.allow_negative) {
    const isNegativeTransferOut = isOutgoingTransfer && account.balance < 0n;
    const isDecreasing = delta < 0n;

    if (
      isNegativeTransferOut ||
      (isDecreasing && (newBalance < 0n || amountNeeded > availableBalance))
    ) {
      throw new ConflictException({
        code: 'INSUFFICIENT_BALANCE',
        message:
          'Saldo akun tidak mencukupi. Sesuaikan saldo atau izinkan saldo negatif untuk akun ini.',
        details: {
          account_id: account.id,
          ledger_balance: Number(account.balance),
          reserved: Number(reserved),
          available: Number(availableBalance),
          needed: Number(amountNeeded),
          shortfall: Number(amountNeeded - availableBalance),
          resolution_options: ['ADJUST_BALANCE', 'ALLOW_NEGATIVE'],
        },
      });
    }
  }

  const warning = newBalance < 0n ? ('NEGATIVE_BALANCE' as const) : undefined;
  return {
    newBalance,
    ...(warning ? { warning } : {}),
  };
}

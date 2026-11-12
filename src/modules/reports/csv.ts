export const CSV_HEADER =
  'ID,Tanggal,Jenis,Status,Akun,Akun Tujuan,Kategori,Split,Nominal,Biaya Transfer,Mode Biaya,Tag,Catatan,Alasan,ID Transaksi Induk,Dibuat Pada';

export const CSV_BOM = '\uFEFF';

const FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r'];

export function csvCell(value: unknown, isNumeric = false): string {
  if (value === null || value === undefined) {
    return '';
  }

  const isNum =
    isNumeric || typeof value === 'number' || typeof value === 'bigint';
  let str: string;
  if (typeof value === 'string') {
    str = value;
  } else if (typeof value === 'number' || typeof value === 'bigint') {
    str = value.toString();
  } else if (value instanceof Date) {
    str = value.toISOString();
  } else {
    str = String(value as string | number | boolean);
  }

  if (!isNum && str.length > 0 && FORMULA_PREFIXES.includes(str[0])) {
    str = `'${str}`;
  }

  if (
    str.includes('"') ||
    str.includes(',') ||
    str.includes('\n') ||
    str.includes('\r')
  ) {
    return `"${str.replace(/"/g, '""')}"`;
  }

  return str;
}

export function transactionToCsvRow(
  item: any,
  accountMap?: Map<string, string>,
): string {
  const id = item.id ?? '';
  const date =
    item.date instanceof Date
      ? item.date.toISOString().slice(0, 10)
      : item.date
        ? String(item.date).slice(0, 10)
        : '';
  const type = item.type ?? '';
  const status = item.status ?? '';

  const account =
    item.account?.name ??
    (item.account_id ? accountMap?.get(item.account_id) : undefined) ??
    item.account_name ??
    (typeof item.account === 'string' ? item.account : '') ??
    item.account_id ??
    '';

  const toAccount =
    item.to_account?.name ??
    (item.to_account_id ? accountMap?.get(item.to_account_id) : undefined) ??
    item.to_account_name ??
    (typeof item.to_account === 'string' ? item.to_account : '') ??
    item.to_account_id ??
    '';

  const category =
    item.category?.name ??
    item.category_name ??
    (typeof item.category === 'string' ? item.category : '') ??
    '';

  let split = '';
  if (Array.isArray(item.splits) && item.splits.length > 0) {
    split = item.splits
      .map((s: any) => {
        const catName =
          s.category?.name ??
          s.category_name ??
          (typeof s.category === 'string' ? s.category : '') ??
          '';
        const amount = s.amount != null ? String(s.amount) : '';
        return `${catName}:${amount}`;
      })
      .join('|');
  }

  const nominal = item.amount != null ? String(item.amount) : '0';
  const transferFee = item.transfer_fee != null ? String(item.transfer_fee) : '0';
  const feeMode = item.fee_mode ?? '';

  let tag = '';
  if (Array.isArray(item.tags) && item.tags.length > 0) {
    tag = item.tags
      .map((t: any) =>
        typeof t === 'string' ? t : (t.tag?.name ?? t.name ?? ''),
      )
      .filter(Boolean)
      .join('|');
  }

  const note = item.note ?? '';
  const reason = item.reason ?? '';
  const parentTransactionId = item.parent_transaction_id ?? '';

  let createdAt = '';
  if (item.created_at instanceof Date) {
    createdAt = item.created_at.toISOString();
  } else if (item.created_at) {
    createdAt = String(item.created_at);
  }

  const cells = [
    csvCell(id),
    csvCell(date),
    csvCell(type),
    csvCell(status),
    csvCell(account),
    csvCell(toAccount),
    csvCell(category),
    csvCell(split),
    csvCell(nominal, true),
    csvCell(transferFee, true),
    csvCell(feeMode),
    csvCell(tag),
    csvCell(note),
    csvCell(reason),
    csvCell(parentTransactionId),
    csvCell(createdAt),
  ];

  return cells.join(',');
}

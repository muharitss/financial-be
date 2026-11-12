export interface PdfSummaryData {
  income: number;
  expense: number;
  net: number;
  adjustment_net: number;
  transfer_total: number;
}

export interface PdfCategoryItem {
  name: string;
  amount: number;
  percent_bp: number;
}

export interface PdfTransactionItem {
  date: string | Date;
  type: string;
  account_name: string;
  category_name: string;
  notes: string | null;
  amount: number;
}

export interface PdfReportData {
  from: string;
  to: string;
  accountNames: string;
  categoryNames: string;
  printedAt: string;
  summary: PdfSummaryData;
  categories: PdfCategoryItem[];
  transactions: PdfTransactionItem[];
  totalTransactionsCount: number;
}

export function escapeHtml(str: string | null | undefined): string {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatCurrency(amount: number | bigint): string {
  const num = typeof amount === 'bigint' ? Number(amount) : amount;
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    maximumFractionDigits: 0,
    minimumFractionDigits: 0,
  })
    .format(num)
    .replace(/\s+/g, '');
}

function formatDate(date: string | Date): string {
  if (typeof date === 'string') {
    return date.slice(0, 10);
  }
  return date.toISOString().slice(0, 10);
}

export function renderReportHtml(data: PdfReportData): string {
  // shortcut: batas 2000 baris di PDF, pindah ke job async bila user butuh PDF penuh
  const maxRows = 2000;
  const displayedTransactions = data.transactions.slice(0, maxRows);
  const isTruncated = data.totalTransactionsCount > maxRows;

  const categoryBars =
    data.categories.length === 0
      ? '<p class="empty-text">Tidak ada pengeluaran pada periode ini.</p>'
      : data.categories
          .map((cat) => {
            const pct = Math.min(100, Math.max(0, cat.percent_bp / 100));
            const pctText = (cat.percent_bp / 100).toFixed(1);
            return `
        <div class="category-row">
          <div class="cat-label">
            <span class="cat-name">${escapeHtml(cat.name)}</span>
            <span class="cat-pct">${pctText}% (${formatCurrency(cat.amount)})</span>
          </div>
          <div class="bar-container">
            <div class="bar-fill" style="width: ${pct}%;"></div>
          </div>
        </div>`;
          })
          .join('\n');

  const transactionRows =
    displayedTransactions.length === 0
      ? '<tr><td colspan="6" class="empty-text" style="text-align: center;">Tidak ada transaksi pada periode ini.</td></tr>'
      : displayedTransactions
          .map((tx) => {
            return `
        <tr>
          <td>${formatDate(tx.date)}</td>
          <td>${escapeHtml(tx.type)}</td>
          <td>${escapeHtml(tx.account_name)}</td>
          <td>${escapeHtml(tx.category_name)}</td>
          <td>${escapeHtml(tx.notes ?? '-')}</td>
          <td class="amount">${formatCurrency(tx.amount)}</td>
        </tr>`;
          })
          .join('\n');

  const truncationNote = isTruncated
    ? `<p class="truncation-note">Menampilkan 2.000 dari ${data.totalTransactionsCount.toLocaleString('id-ID')} transaksi. Gunakan ekspor CSV untuk data lengkap.</p>`
    : '';

  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <title>Laporan Keuangan Duitku</title>
  <style>
    @page {
      size: A4;
      margin: 1.5cm;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      font-size: 11px;
      color: #1f2937;
      line-height: 1.4;
      margin: 0;
      padding: 0;
    }
    h1 {
      font-size: 18px;
      font-weight: 700;
      color: #111827;
      margin: 0 0 6px 0;
    }
    h2 {
      font-size: 13px;
      font-weight: 600;
      color: #374151;
      margin: 16px 0 8px 0;
      border-bottom: 1px solid #e5e7eb;
      padding-bottom: 4px;
    }
    .header {
      margin-bottom: 16px;
    }
    .meta-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 4px 16px;
      color: #4b5563;
      font-size: 10.5px;
      margin-top: 4px;
    }
    .meta-item strong {
      color: #1f2937;
    }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 8px;
      margin-bottom: 16px;
    }
    .summary-card {
      background: #f9fafb;
      border: 1px solid #e5e7eb;
      border-radius: 4px;
      padding: 8px 10px;
    }
    .summary-label {
      font-size: 9.5px;
      text-transform: uppercase;
      color: #6b7280;
      margin-bottom: 4px;
      font-weight: 500;
    }
    .summary-val {
      font-size: 13px;
      font-weight: 700;
      color: #111827;
    }
    .summary-card.net .summary-val {
      color: #2563eb;
    }
    .category-section {
      margin-bottom: 16px;
    }
    .category-row {
      margin-bottom: 6px;
    }
    .cat-label {
      display: flex;
      justify-content: space-between;
      font-size: 10px;
      margin-bottom: 2px;
    }
    .cat-name {
      font-weight: 500;
    }
    .cat-pct {
      color: #6b7280;
    }
    .bar-container {
      background: #f3f4f6;
      border-radius: 3px;
      height: 8px;
      overflow: hidden;
    }
    .bar-fill {
      background: #3b82f6;
      height: 100%;
      border-radius: 3px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 10px;
      margin-top: 6px;
    }
    th, td {
      border: 1px solid #e5e7eb;
      padding: 5px 6px;
      text-align: left;
    }
    th {
      background: #f9fafb;
      font-weight: 600;
      color: #374151;
    }
    td.amount {
      text-align: right;
      font-variant-numeric: tabular-nums;
      font-weight: 500;
    }
    .truncation-note {
      margin-top: 8px;
      font-style: italic;
      color: #6b7280;
      font-size: 10px;
    }
    .empty-text {
      color: #9ca3af;
      font-style: italic;
      font-size: 10px;
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>Laporan Keuangan Duitku</h1>
    <div class="meta-grid">
      <div class="meta-item"><strong>Periode:</strong> ${escapeHtml(data.from)} &ndash; ${escapeHtml(data.to)}</div>
      <div class="meta-item"><strong>Waktu Cetak:</strong> ${escapeHtml(data.printedAt)}</div>
      <div class="meta-item"><strong>Filter Akun:</strong> ${escapeHtml(data.accountNames)}</div>
      <div class="meta-item"><strong>Filter Kategori:</strong> ${escapeHtml(data.categoryNames)}</div>
    </div>
  </div>

  <h2>Ringkasan</h2>
  <div class="summary-grid">
    <div class="summary-card">
      <div class="summary-label">Pemasukan</div>
      <div class="summary-val">${formatCurrency(data.summary.income)}</div>
    </div>
    <div class="summary-card">
      <div class="summary-label">Pengeluaran</div>
      <div class="summary-val">${formatCurrency(data.summary.expense)}</div>
    </div>
    <div class="summary-card net">
      <div class="summary-label">Selisih</div>
      <div class="summary-val">${formatCurrency(data.summary.net)}</div>
    </div>
    <div class="summary-card">
      <div class="summary-label">Penyesuaian Saldo</div>
      <div class="summary-val">${formatCurrency(data.summary.adjustment_net)}</div>
    </div>
    <div class="summary-card">
      <div class="summary-label">Total Transfer</div>
      <div class="summary-val">${formatCurrency(data.summary.transfer_total)}</div>
    </div>
  </div>

  <div class="category-section">
    <h2>Pengeluaran per Kategori</h2>
    ${categoryBars}
  </div>

  <div class="transactions-section">
    <h2>Daftar Transaksi</h2>
    <table>
      <thead>
        <tr>
          <th>Tanggal</th>
          <th>Jenis</th>
          <th>Akun</th>
          <th>Kategori</th>
          <th>Catatan</th>
          <th style="text-align: right;">Nominal</th>
        </tr>
      </thead>
      <tbody>
        ${transactionRows}
      </tbody>
    </table>
    ${truncationNote}
  </div>
</body>
</html>`;
}

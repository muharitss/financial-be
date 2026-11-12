import { CSV_HEADER, CSV_BOM, csvCell, transactionToCsvRow } from './csv.js';

describe('CSV Export Helper (csv.ts)', () => {
  describe('CSV_HEADER and CSV_BOM', () => {
    it('has BOM matching UTF-8 \uFEFF', () => {
      expect(CSV_BOM).toBe('\uFEFF');
      expect(Buffer.from(CSV_BOM, 'utf-8')).toEqual(
        Buffer.from([0xef, 0xbb, 0xbf]),
      );
    });

    it('has 16 columns matching the specification (AC-1)', () => {
      const columns = CSV_HEADER.split(',');
      expect(columns).toEqual([
        'ID',
        'Tanggal',
        'Jenis',
        'Status',
        'Akun',
        'Akun Tujuan',
        'Kategori',
        'Split',
        'Nominal',
        'Biaya Transfer',
        'Mode Biaya',
        'Tag',
        'Catatan',
        'Alasan',
        'ID Transaksi Induk',
        'Dibuat Pada',
      ]);
      expect(columns.length).toBe(16);
    });
  });

  describe('csvCell', () => {
    it('returns empty string for null and undefined', () => {
      expect(csvCell(null)).toBe('');
      expect(csvCell(undefined)).toBe('');
    });

    it('returns plain string without quotes when no special characters present', () => {
      expect(csvCell('Makanan')).toBe('Makanan');
      expect(csvCell('12345')).toBe('12345');
    });

    it('escapes and wraps in quotes when comma, newline, carriage return, or double quote is present', () => {
      expect(csvCell('Kopi, Susu')).toBe('"Kopi, Susu"');
      expect(csvCell('Baris 1\nBaris 2')).toBe('"Baris 1\nBaris 2"');
      expect(csvCell('Baris 1\r\nBaris 2')).toBe('"Baris 1\r\nBaris 2"');
      expect(csvCell('Kata "Kunci"')).toBe('"Kata ""Kunci"""');
    });

    it('AC-4: anti-formula injection prefixes text starting with =, +, -, @, \\t, \\r with single quote', () => {
      expect(csvCell('=HYPERLINK("http://x")')).toBe(
        '"\'=HYPERLINK(""http://x"")"',
      );
      expect(csvCell('+6281234')).toBe("'+6281234");
      expect(csvCell('-Pengeluaran')).toBe("'-Pengeluaran");
      expect(csvCell('@admin')).toBe("'@admin");
      expect(csvCell('\tindent')).toBe("'\tindent");
    });

    it('AC-4: numeric inputs (negative numbers) are NOT prefixed with single quote', () => {
      expect(csvCell(-20000)).toBe('-20000');
      expect(csvCell('-20000', true)).toBe('-20000');
      expect(csvCell(50000)).toBe('50000');
      expect(csvCell(0)).toBe('0');
      expect(csvCell(10000000000000n)).toBe('10000000000000');
    });
  });

  describe('transactionToCsvRow', () => {
    it('formats a normal transaction row correctly', () => {
      const item = {
        id: 'tx-001',
        date: '2026-11-12',
        type: 'EXPENSE',
        status: 'POSTED',
        account: { name: 'BCA Utama' },
        category: { name: 'Makanan & Minuman' },
        amount: 25000,
        transfer_fee: 0,
        fee_mode: null,
        tags: [{ tag: { name: 'MakanSiang' } }, { tag: { name: 'Kantor' } }],
        note: 'Nasi padang',
        reason: null,
        parent_transaction_id: null,
        created_at: '2026-11-12T09:00:00.000Z',
      };

      const row = transactionToCsvRow(item);
      expect(row).toBe(
        'tx-001,2026-11-12,EXPENSE,POSTED,BCA Utama,,Makanan & Minuman,,25000,0,,MakanSiang|Kantor,Nasi padang,,,2026-11-12T09:00:00.000Z',
      );
    });

    it('formats transfer transaction with to_account and fee', () => {
      const item = {
        id: 'tx-002',
        date: new Date('2026-11-12T00:00:00.000Z'),
        type: 'TRANSFER',
        status: 'POSTED',
        account: { name: 'BCA Utama' },
        to_account: { name: 'GoPay' },
        amount: 100000,
        transfer_fee: 1000,
        fee_mode: 'SEPARATE',
        note: 'Top up',
        created_at: new Date('2026-11-12T10:00:00.000Z'),
      };

      const row = transactionToCsvRow(item);
      expect(row).toBe(
        'tx-002,2026-11-12,TRANSFER,POSTED,BCA Utama,GoPay,,,100000,1000,SEPARATE,,Top up,,,2026-11-12T10:00:00.000Z',
      );
    });

    it('AC-5: formats split transactions with Category:Amount pairs', () => {
      const item = {
        id: 'tx-003',
        date: '2026-11-12',
        type: 'EXPENSE',
        status: 'POSTED',
        account: { name: 'BCA Utama' },
        amount: 100000,
        splits: [
          { category: { name: 'Belanja' }, amount: 60000 },
          { category: { name: 'Hiburan' }, amount: 40000 },
        ],
        created_at: '2026-11-12T11:00:00.000Z',
      };

      const row = transactionToCsvRow(item);
      expect(row).toContain(',Belanja:60000|Hiburan:40000,100000,');
    });

    it('AC-5: formats REVERSED and REVERSAL transactions with parent_transaction_id', () => {
      const reversalItem = {
        id: 'tx-004-rev',
        date: '2026-11-12',
        type: 'REVERSAL',
        status: 'POSTED',
        account: { name: 'BCA Utama' },
        amount: 50000,
        reason: 'Salah nominal',
        parent_transaction_id: 'tx-004-orig',
        created_at: '2026-11-12T12:00:00.000Z',
      };

      const row = transactionToCsvRow(reversalItem);
      expect(row).toBe(
        'tx-004-rev,2026-11-12,REVERSAL,POSTED,BCA Utama,,,,50000,0,,,,Salah nominal,tx-004-orig,2026-11-12T12:00:00.000Z',
      );
    });

    it('resolves account names from accountMap when item only contains account_id', () => {
      const accountMap = new Map([
        ['acc-1', 'Rekening Mandiri'],
        ['acc-2', 'OVO Cash'],
      ]);

      const item = {
        id: 'tx-005',
        date: '2026-11-12',
        type: 'TRANSFER',
        status: 'POSTED',
        account_id: 'acc-1',
        to_account_id: 'acc-2',
        amount: 75000,
      };

      const row = transactionToCsvRow(item, accountMap);
      expect(row).toContain(',Rekening Mandiri,OVO Cash,');
    });
  });
});

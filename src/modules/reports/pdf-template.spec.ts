import { describe, it, expect } from '@jest/globals';
import {
  escapeHtml,
  formatCurrency,
  renderReportHtml,
  type PdfReportData,
} from './pdf-template.js';

describe('pdf-template', () => {
  describe('escapeHtml', () => {
    it('escapes &, <, >, ", and \'', () => {
      const input = `<script>alert("XSS" & 'test')</script>`;
      const expected = `&lt;script&gt;alert(&quot;XSS&quot; &amp; &#39;test&#39;)&lt;/script&gt;`;
      expect(escapeHtml(input)).toBe(expected);
    });

    it('handles empty, null, and undefined values safely', () => {
      expect(escapeHtml('')).toBe('');
      expect(escapeHtml(null)).toBe('');
      expect(escapeHtml(undefined)).toBe('');
    });
  });

  describe('formatCurrency', () => {
    it('formats positive integers to Indonesian Rupiah without decimals and space', () => {
      expect(formatCurrency(1234567)).toBe('Rp1.234.567');
      expect(formatCurrency(0)).toBe('Rp0');
    });

    it('formats bigint values correctly', () => {
      expect(formatCurrency(5000000n)).toBe('Rp5.000.000');
    });

    it('formats negative numbers correctly', () => {
      expect(formatCurrency(-50000)).toBe('-Rp50.000');
    });
  });

  describe('renderReportHtml', () => {
    const mockData: PdfReportData = {
      from: '2026-11-01',
      to: '2026-11-30',
      accountNames: 'BCA, Dompet',
      categoryNames: 'Makanan & Minuman',
      printedAt: '12 Nov 2026, 10.00',
      summary: {
        income: 5000000,
        expense: 2000000,
        net: 3000000,
        adjustment_net: 50000,
        transfer_total: 1000000,
      },
      categories: [
        {
          name: 'Makanan & Minuman',
          amount: 1500000,
          percent_bp: 7500,
        },
        {
          name: 'Transportasi',
          amount: 500000,
          percent_bp: 2500,
        },
      ],
      transactions: [
        {
          date: '2026-11-02',
          type: 'EXPENSE',
          account_name: 'BCA',
          category_name: 'Makanan & Minuman',
          notes: '<script>alert(1)</script><img src="http://attacker/x">',
          amount: 50000,
        },
      ],
      totalTransactionsCount: 1,
    };

    it('AC-2: renders all 4 sections in order: header, ringkasan, grafik, tabel', () => {
      const html = renderReportHtml(mockData);

      // Section 1: Header
      expect(html).toContain('Laporan Keuangan Duitku');
      expect(html).toContain('2026-11-01 &ndash; 2026-11-30');
      expect(html).toContain('BCA, Dompet');
      expect(html).toContain('Makanan &amp; Minuman');
      expect(html).toContain('12 Nov 2026, 10.00');

      // Section 2: Ringkasan
      expect(html).toContain('Ringkasan');
      expect(html).toContain('Pemasukan');
      expect(html).toContain('Rp5.000.000');
      expect(html).toContain('Pengeluaran');
      expect(html).toContain('Rp2.000.000');
      expect(html).toContain('Selisih');
      expect(html).toContain('Rp3.000.000');
      // Baris "Penyesuaian Saldo" terpisah (ADR-005)
      expect(html).toContain('Penyesuaian Saldo');
      expect(html).toContain('Rp50.000');
      expect(html).toContain('Total Transfer');
      expect(html).toContain('Rp1.000.000');

      // Section 3: Grafik (horizontal bar CSS)
      expect(html).toContain('Pengeluaran per Kategori');
      expect(html).toContain('width: 75%;');
      expect(html).toContain('75.0% (Rp1.500.000)');

      // Section 4: Tabel transaksi
      expect(html).toContain('Daftar Transaksi');
      expect(html).toContain('Tanggal');
      expect(html).toContain('Jenis');
      expect(html).toContain('Akun');
      expect(html).toContain('Kategori');
      expect(html).toContain('Catatan');
      expect(html).toContain('Nominal');
      expect(html).toContain('2026-11-02');
      expect(html).toContain('EXPENSE');
      expect(html).toContain('Rp50.000');

      // Ensure ordering of sections
      const headerIndex = html.indexOf('Laporan Keuangan Duitku');
      const summaryIndex = html.indexOf('<h2>Ringkasan</h2>');
      const chartIndex = html.indexOf('<h2>Pengeluaran per Kategori</h2>');
      const tableIndex = html.indexOf('<h2>Daftar Transaksi</h2>');

      expect(headerIndex).toBeLessThan(summaryIndex);
      expect(summaryIndex).toBeLessThan(chartIndex);
      expect(chartIndex).toBeLessThan(tableIndex);
    });

    it('AC-3: escapes user inputs, contains no unescaped script tag and no external http:// / https:// links', () => {
      const html = renderReportHtml(mockData);

      // Notes should be escaped
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=&quot;http://attacker/x&quot;&gt;');

      // No unescaped script tags
      expect(html).not.toMatch(/<script\b[^>]*>/i);

      // No unescaped http:// or https:// outside of escaped entities
      // To strictly check, ensure there are no unescaped http:// or https:// urls in the raw markup (e.g. src="http... or href="http... or <style> urls)
      expect(html).not.toMatch(/href\s*=\s*["']https?:\/\//i);
      expect(html).not.toMatch(/src\s*=\s*["']https?:\/\//i);
      expect(html).not.toMatch(/url\s*\(\s*["']?https?:\/\//i);
    });

    it('AC-4: shows truncation note when total transactions > 2000', () => {
      const dataWithMany: PdfReportData = {
        ...mockData,
        totalTransactionsCount: 2500,
        transactions: Array.from({ length: 2500 }, (_, i) => ({
          date: '2026-11-01',
          type: 'EXPENSE',
          account_name: 'BCA',
          category_name: 'Makanan',
          notes: `Item ${i}`,
          amount: 1000,
        })),
      };

      const html = renderReportHtml(dataWithMany);
      expect(html).toContain('Menampilkan 2.000 dari 2.500 transaksi. Gunakan ekspor CSV untuk data lengkap.');

      // Count table rows (should only have 2000 rows in tbody)
      const tbodyContent = html.split('<tbody>')[1].split('</tbody>')[0];
      const rowMatches = tbodyContent.match(/<tr>/g);
      expect(rowMatches?.length).toBe(2000);
    });

    it('does not show truncation note when transactions <= 2000', () => {
      const html = renderReportHtml(mockData);
      expect(html).not.toContain('Gunakan ekspor CSV untuk data lengkap.');
    });
  });
});

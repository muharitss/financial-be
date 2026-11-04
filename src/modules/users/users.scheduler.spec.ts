import { jest, describe, it, expect } from '@jest/globals';
import { UsersScheduler } from './users.scheduler.js';

describe('UsersScheduler', () => {
  it('memanggil hardDeleteService.runHardDelete saat handleHardDelete dijalankan', async () => {
    const mockHardDeleteService: any = {
      runHardDelete: jest.fn().mockResolvedValue({ deletedCount: 2, errors: 0 }),
    };

    const scheduler = new UsersScheduler(mockHardDeleteService);
    await scheduler.handleHardDelete();

    expect(mockHardDeleteService.runHardDelete).toHaveBeenCalledTimes(1);
  });
});

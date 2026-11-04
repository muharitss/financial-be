import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { HardDeleteService } from './hard-delete.service.js';

@Injectable()
export class UsersScheduler {
  private readonly logger = new Logger(UsersScheduler.name);

  constructor(private readonly hardDeleteService: HardDeleteService) {}

  @Cron('0 3 * * *', { timeZone: 'Asia/Jakarta' })
  async handleHardDelete() {
    this.logger.log('Starting scheduled hard-delete job...');
    const result = await this.hardDeleteService.runHardDelete();
    this.logger.log(
      `Scheduled hard-delete completed. Deleted: ${result.deletedCount}, Errors: ${result.errors}`,
    );
  }
}

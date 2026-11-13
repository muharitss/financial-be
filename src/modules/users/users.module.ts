import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { FilesModule } from '../files/files.module.js';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';
import { HardDeleteService } from './hard-delete.service.js';
import { UsersScheduler } from './users.scheduler.js';

@Module({
  imports: [PrismaModule, FilesModule],
  controllers: [UsersController],
  providers: [UsersService, HardDeleteService, UsersScheduler],
  exports: [UsersService, HardDeleteService],
})
export class UsersModule {}

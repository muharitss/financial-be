import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { PassportModule } from '@nestjs/passport';
import { createObserveModule } from '@nestjs/observe';
import { ThrottlerModule } from '@nestjs/throttler';
import { PrismaModule } from './prisma/prisma.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { UsersModule } from './modules/users/users.module.js';
import { AccountsModule } from './modules/accounts/accounts.module.js';
import { LoggerModule } from './common/logger/logger.module.js';
import { TraceMiddleware } from './common/logger/trace.middleware.js';
import { throttlerConfig } from './common/throttler/throttler.config.js';
import { ThrottlerGuard } from './common/throttler/throttler.guard.js';
import { CsrfOriginGuard } from './common/guards/csrf-origin.guard.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';

export const { ObserveModule, ObserveInstrument } = createObserveModule();

@Module({
  imports: [
    LoggerModule,
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot(throttlerConfig),
    PrismaModule,
    PassportModule.register({ defaultStrategy: 'jwt' }),
    AuthModule,
    UsersModule,
    AccountsModule,
    HealthModule,
    ObserveModule.forRoot({
      appKey: process.env.OBSERVE_APP_KEY ?? 'YOUR_APP_KEY',
      appSecret: process.env.OBSERVE_APP_SECRET ?? 'YOUR_APP_SECRET',
      serviceId: 'financial-be',
    }),
  ],
  controllers: [],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    {
      provide: APP_GUARD,
      useClass: CsrfOriginGuard,
    },
    {
      provide: APP_FILTER,
      useClass: AllExceptionsFilter,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TraceMiddleware).forRoutes('*');
  }
}

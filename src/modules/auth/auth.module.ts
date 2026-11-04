import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { JwtModule } from '@nestjs/jwt';
import { JwtStrategy } from '../../common/strategies/jwt.strategy.js';
import { TransactionsModule } from '../transactions/transactions.module.js';
import { JwksController } from './jwks.controller.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.register({
      secret: process.env.JWT_SECRET ?? 'change-me-min-32-chars',
      signOptions: { expiresIn: '15m', algorithm: 'HS256' },
    }),
    TransactionsModule,
  ],
  controllers: [AuthController, JwksController],
  providers: [AuthService, JwtStrategy],
  exports: [PassportModule, JwtStrategy, AuthService],
})
export class AuthModule {}

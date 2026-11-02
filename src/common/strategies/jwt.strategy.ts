import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-jwt';
import { passportJwtSecret } from 'jwks-rsa';
import type { Request } from 'express';

const cookieExtractor = (req: Request): string | null => {
  if (!req || !req.cookies) {
    return null;
  }
  return (
    req.cookies['__Host-duitku_session'] ??
    (process.env.NODE_ENV !== 'production' ? req.cookies['duitku_session'] : null) ??
    null
  );
};

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    const useJwks = process.env.JWT_USE_JWKS === 'true';

    if (useJwks) {
      super({
        jwtFromRequest: cookieExtractor,
        ignoreExpiration: false,
        secretOrKeyProvider: passportJwtSecret({
          cache: true,
          rateLimit: true,
          jwksRequestsPerMinute: 5,
          jwksUri: process.env.JWT_JWKS_URI ?? '',
        }),
        algorithms: ['RS256'],
      });
    } else {
      super({
        jwtFromRequest: cookieExtractor,
        ignoreExpiration: false,
        secretOrKey: process.env.JWT_SECRET ?? 'change-me-min-32-chars',
        algorithms: ['HS256'],
      });
    }
  }

  async validate(payload: { sub: string; role?: string }) {
    if (!payload || !payload.sub) {
      throw new UnauthorizedException();
    }
    return { userId: payload.sub, role: payload.role };
  }
}

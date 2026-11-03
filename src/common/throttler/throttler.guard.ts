import { Injectable } from '@nestjs/common';
import { ThrottlerGuard as BaseThrottlerGuard } from '@nestjs/throttler';

@Injectable()
export class ThrottlerGuard extends BaseThrottlerGuard {
  protected override setResponseHeader(res: any, name: string, value: any): void {
    super.setResponseHeader(res, name, value);
    const match = name.match(/^(X-RateLimit-(?:Limit|Remaining|Reset))-.+$/);
    if (match) {
      super.setResponseHeader(res, match[1], value);
    }
  }
}

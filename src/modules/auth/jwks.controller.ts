import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';

@ApiTags('auth')
@Controller('.well-known')
export class JwksController {
  @Get('jwks.json')
  @ApiOperation({ summary: 'Public JWKS endpoint' })
  getJwks() {
    const useJwks = process.env.JWT_USE_JWKS === 'true';
    if (!useJwks) {
      return { keys: [] };
    }
    // shortcut: JWKS key extraction for RS256 will be configured when asymmetric key rotation is active
    return { keys: [] };
  }
}

import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';

@Injectable()
export class SuperadminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const user = request.user;
    if (!user?.userId || user.role !== 'SUPERADMIN') {
      throw new ForbiddenException({
        code: 'SUPERADMIN_REQUIRED',
        message: 'Akses khusus Superadmin',
      });
    }
    return true;
  }
}

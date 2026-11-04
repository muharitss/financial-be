import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';

export interface UserResponse {
  id: string;
  name: string;
  email: string;
  picture_url: string | null;
  role: string;
  created_at: Date;
  preferences: {
    timezone: string;
    theme: string;
  } | null;
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async findById(userId: string): Promise<UserResponse | null> {
    if (!userId) {
      return null;
    }

    return this.prisma.user.findFirst({
      where: {
        id: userId,
        status: 'ACTIVE',
      },
      select: {
        id: true,
        name: true,
        email: true,
        picture_url: true,
        role: true,
        created_at: true,
        preferences: {
          select: {
            timezone: true,
            theme: true,
          },
        },
      },
    });
  }
}

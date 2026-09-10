import { Controller, Get } from '@nestjs/common';
import type { MeResponse } from '@iac/contracts';
import type { AuthUser } from '../../../common/context.js';
import { AuthOnly, CurrentUser } from '../../../common/decorators.js';
import { MeService } from '../application/me.service.js';

@Controller('api')
export class MeController {
  constructor(private readonly me: MeService) {}

  /** openapi: getMe（任何已登入使用者皆可呼叫，不需特定權限） */
  @Get('me')
  @AuthOnly()
  get(@CurrentUser() user: AuthUser): Promise<MeResponse> {
    return this.me.build(user);
  }
}

import { Global, Module } from '@nestjs/common';
import { AuditWriter } from './audit-writer.js';
import { GrantLoader } from './grant-loader.js';
import { RateLimiter } from './rate-limit.js';
import { ScopeResolver } from './scope-resolver.js';

@Global()
@Module({
  providers: [AuditWriter, GrantLoader, RateLimiter, ScopeResolver],
  exports: [AuditWriter, GrantLoader, RateLimiter, ScopeResolver],
})
export class CommonModule {}

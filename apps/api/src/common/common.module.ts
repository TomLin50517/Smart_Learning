import { Global, Module } from '@nestjs/common';
import { GrantLoader } from './grant-loader.js';
import { ScopeResolver } from './scope-resolver.js';

@Global()
@Module({
  providers: [GrantLoader, ScopeResolver],
  exports: [GrantLoader, ScopeResolver],
})
export class CommonModule {}

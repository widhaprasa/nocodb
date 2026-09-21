import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';

import { NocoModule } from '~/modules/noco.module';

import { BasicStrategy } from '~/strategies/basic.strategy/basic.strategy';
import { LocalStrategy } from '~/strategies/local.strategy';
import { AuthTokenStrategy } from '~/strategies/authtoken.strategy/authtoken.strategy';
import { OAuthTokenStrategy } from '~/strategies/oauth-token.strategy';
import { BaseViewStrategy } from '~/strategies/base-view.strategy/base-view.strategy';
import { GoogleStrategyProvider } from '~/strategies/google.strategy/google.strategy';
import { AuthService } from '~/modules/auth/auth.service';
import { AuthController } from '~/modules/auth/auth.controller';
import { LdapService } from '~/services/ldap/ldap.service';

export const authModuleMetadata = {
  imports: [PassportModule, NocoModule],
  controllers: [
    ...(process.env.NC_WORKER_CONTAINER !== 'true' ? [AuthController] : []),
  ],
  providers: [
    AuthService,
    LdapService,
    LocalStrategy,
    AuthTokenStrategy,
    OAuthTokenStrategy,
    BaseViewStrategy,
    BasicStrategy,
    GoogleStrategyProvider,
  ],
  exports: [],
};

@Module(authModuleMetadata)
export class AuthModule {}

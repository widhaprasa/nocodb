import { promisify } from 'util';
import { Injectable, Logger } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { OrgUserRoles, extractRolesObj } from 'nocodb-sdk';
import Noco from '~/Noco';
import { genJwt } from '~/services/users/helpers';
import { UsersService } from '~/services/users/users.service';
import { LdapService } from '~/services/ldap/ldap.service';
import { NcError } from '~/helpers/ncError';
import { ensureUserInDefaultWorkspace } from '~/helpers/verifyDefaultWorkspace';
import { User } from '~/models';

export class CreateUserDto {
  readonly username: string;
  readonly email: string;
  readonly password: string;
}

@Injectable()
export class AuthService {
  protected logger = new Logger(AuthService.name);

  // Pre-computed dummy hash to ensure constant-time response when user is not found
  static readonly DUMMY_HASH =
    '$2a$10$DwEv0MjMRZdMnOFRMChjHuq3YNKhMfSEPkNRCQsGx0KGfcIUNEz2W';

  constructor(
    private usersService: UsersService,
    private ldapService: LdapService,
  ) {}

  async validateUser(email: string, pass: string, req?: any): Promise<any> {
    if (this.ldapService.isEnabled()) {
      const ldapUser = await this.tryLdapAuth(email, pass, req);
      if (ldapUser) {
        return ldapUser;
      }
    }

    const user = await this.usersService.findOne(email);
    if (user) {
      const { password, salt, ...result } = user;

      // `salt` will be null,
      // 1. If the user is invited and yet to set password
      // 2. If the user is created via non email-password auth (OAuth)
      if (!user.salt) {
        return NcError.badRequest(
          'If invited, sign up via the email link; otherwise, use forgot password or contact the super admin.',
        );
      }

      const valid = await promisify(bcrypt.compare)(pass, user.password);
      if (valid) {
        return result;
      }
    } else {
      // Perform a dummy compare with a random prefix to prevent timing-based user enumeration
      await promisify(bcrypt.compare)(pass, AuthService.DUMMY_HASH);
    }
    return null;
  }

  private async tryLdapAuth(email: string, pass: string, req?: any) {
    try {
      const identity = await this.ldapService.authenticate(email, pass);

      const existing = await this.usersService.findOne(identity.email);
      if (existing) {
        return this.stripSecrets(existing);
      }

      if (process.env.NC_LDAP_AUTO_PROVISION === 'false') {
        return null;
      }

      const salt = await promisify(bcrypt.genSalt)(10);
      const created = await this.usersService.registerNewUserIfAllowed({
        email: identity.email,
        password: '',
        salt,
        email_verification_token: null,
        // LDAP is the signup gatekeeper: provision even when the instance
        // is set to invite-only signup.
        is_invite: true,
        req,
      } as any);

      // Invites skip default-workspace membership in
      // registerNewUserIfAllowed; LDAP users should land in the default
      // workspace like self-signups do.
      await ensureUserInDefaultWorkspace(created.id);

      // `registerNewUserIfAllowed` provisions self-signups as
      // org-level-viewer; set LDAP users to the configured org role
      // (Organization Level Creator by default) instead. The first user
      // keeps the super-admin grant the same function already added.
      const defaultRole =
        (process.env.NC_LDAP_DEFAULT_ROLE as OrgUserRoles) ||
        OrgUserRoles.CREATOR;
      if (
        !extractRolesObj(created.roles)[defaultRole] &&
        !extractRolesObj(created.roles)[OrgUserRoles.SUPER_ADMIN]
      ) {
        await User.update(created.id, { roles: defaultRole });
      }

      return this.stripSecrets(created);
    } catch (e) {
      // Every LDAP failure — service bind rejected, search matched nothing, the
      // user's own bind rejected, or the server being unreachable — ends up in
      // this one catch. Returning null sends the login down the local-password
      // path, which reports the generic "Invalid credentials" and names no
      // cause. Log it, or there is no way to tell those apart from outside.
      const err = e as { name?: string; code?: number | string; message?: string };
      this.logger.warn(
        `LDAP authentication failed for "${email}" (${err?.name ?? 'Error'}${
          err?.code !== undefined ? ` ${err.code}` : ''
        }): ${err?.message ?? 'no message'}`,
      );
      return null;
    }
  }

  private stripSecrets(user: any) {
    const { password, salt, ...result } = user;
    return result;
  }

  async login(user: any) {
    delete user.password;
    delete user.salt;
    const payload = user;
    return {
      token: genJwt(payload, Noco.getConfig()),
    };
  }
}

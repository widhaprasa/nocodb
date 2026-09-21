import bcrypt from 'bcryptjs';

jest.mock('~/Noco', () => ({
  __esModule: true,
  default: { getConfig: jest.fn() },
}));
jest.mock('~/services/users/users.service', () => ({
  UsersService: class {},
}));
jest.mock('~/services/users/helpers', () => ({
  genJwt: jest.fn(),
}));
jest.mock('~/services/ldap/ldap.service', () => ({
  LdapService: class {},
}));

import { AuthService } from './auth.service';

describe('AuthService.validateUser', () => {
  const ENV_VARS = ['NC_LDAP_AUTO_PROVISION'];

  let usersService: {
    findOne: jest.Mock;
    registerNewUserIfAllowed: jest.Mock;
  };
  let ldapService: { isEnabled: jest.Mock; authenticate: jest.Mock };
  let service: AuthService;

  beforeEach(() => {
    ENV_VARS.forEach((v) => delete process.env[v]);

    usersService = {
      findOne: jest.fn(),
      registerNewUserIfAllowed: jest.fn(),
    };
    ldapService = {
      isEnabled: jest.fn(),
      authenticate: jest.fn(),
    };

    service = new AuthService(usersService as any, ldapService as any);
  });

  it('uses the local flow when LDAP is disabled', async () => {
    ldapService.isEnabled.mockReturnValue(false);

    const hash = bcrypt.hashSync('correct', 10);
    usersService.findOne.mockResolvedValue({
      email: 'local@example.com',
      password: hash,
      salt: 'salt',
      id: 'u1',
    });

    const result = await service.validateUser('local@example.com', 'correct');

    expect(ldapService.authenticate).not.toHaveBeenCalled();
    expect(result).toEqual({ email: 'local@example.com', id: 'u1' });
  });

  it('returns the existing user when LDAP succeeds and the user exists', async () => {
    ldapService.isEnabled.mockReturnValue(true);
    ldapService.authenticate.mockResolvedValue({
      email: 'john@example.com',
      displayName: 'John Doe',
    });
    usersService.findOne.mockResolvedValue({
      email: 'john@example.com',
      password: 'unused',
      salt: 'salt',
      id: 'u2',
    });

    const result = await service.validateUser('john@example.com', 'secret');

    expect(result).toEqual({ email: 'john@example.com', id: 'u2' });
    expect(usersService.registerNewUserIfAllowed).not.toHaveBeenCalled();
  });

  it('auto-provisions the user when LDAP succeeds and no local user exists', async () => {
    ldapService.isEnabled.mockReturnValue(true);
    ldapService.authenticate.mockResolvedValue({
      email: 'new@example.com',
      displayName: 'New User',
    });
    usersService.findOne.mockResolvedValue(null);
    usersService.registerNewUserIfAllowed.mockResolvedValue({
      email: 'new@example.com',
      password: '',
      salt: 'generated-salt',
      id: 'u3',
    });

    const result = await service.validateUser('new@example.com', 'secret');

    expect(usersService.registerNewUserIfAllowed).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'new@example.com',
        password: '',
        email_verification_token: null,
      }),
    );
    expect(result).toEqual({ email: 'new@example.com', id: 'u3' });
  });

  it('falls back to local auth when LDAP fails', async () => {
    ldapService.isEnabled.mockReturnValue(true);
    ldapService.authenticate.mockRejectedValue(
      new Error('Invalid credentials'),
    );

    const hash = bcrypt.hashSync('localpw', 10);
    usersService.findOne.mockResolvedValue({
      email: 'local@example.com',
      password: hash,
      salt: 'salt',
      id: 'u4',
    });

    const result = await service.validateUser('local@example.com', 'localpw');

    expect(result).toEqual({ email: 'local@example.com', id: 'u4' });
  });

  it('returns null when LDAP fails and no local user exists', async () => {
    ldapService.isEnabled.mockReturnValue(true);
    ldapService.authenticate.mockRejectedValue(
      new Error('Invalid credentials'),
    );
    usersService.findOne.mockResolvedValue(null);

    const result = await service.validateUser('ghost@example.com', 'whatever');

    expect(result).toBeNull();
    expect(usersService.registerNewUserIfAllowed).not.toHaveBeenCalled();
  });

  it('does not auto-provision when NC_LDAP_AUTO_PROVISION is false', async () => {
    process.env.NC_LDAP_AUTO_PROVISION = 'false';
    ldapService.isEnabled.mockReturnValue(true);
    ldapService.authenticate.mockResolvedValue({
      email: 'new@example.com',
      displayName: 'New User',
    });
    usersService.findOne.mockResolvedValue(null);

    const result = await service.validateUser('new@example.com', 'secret');

    expect(result).toBeNull();
    expect(usersService.registerNewUserIfAllowed).not.toHaveBeenCalled();
  });
});

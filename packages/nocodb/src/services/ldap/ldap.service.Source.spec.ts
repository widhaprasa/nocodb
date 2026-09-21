import { EventEmitter } from 'events';
import { LdapService } from './ldap.service';

jest.mock('ldapjs', () => ({
  createClient: jest.fn(),
}));

import { createClient } from 'ldapjs';

const createClientMock = createClient as unknown as jest.Mock;

function searchEntry(dn: string, attributes: Record<string, string>) {
  return {
    objectName: dn,
    attributes: Object.entries(attributes).map(([type, value]) => ({
      type,
      values: [value],
    })),
  };
}

function makeClient(
  overrides: {
    bind?: jest.Mock;
    search?: jest.Mock;
    destroy?: jest.Mock;
  } = {},
) {
  const client: any = new EventEmitter();
  client.bind = overrides.bind ?? jest.fn();
  client.search = overrides.search ?? jest.fn();
  client.destroy = overrides.destroy ?? jest.fn();
  return client;
}

describe('LdapService', () => {
  let service: LdapService;

  const ENV_VARS = [
    'NC_LDAP_URL',
    'NC_LDAP_BIND_DN',
    'NC_LDAP_BIND_PASSWORD',
    'NC_LDAP_SEARCH_BASE',
    'NC_LDAP_SEARCH_FILTER',
    'NC_LDAP_BIND_DN_TEMPLATE',
    'NC_LDAP_MAIL_ATTRIBUTE',
    'NC_LDAP_NAME_ATTRIBUTE',
    'NC_LDAP_TLS_REJECT_UNAUTHORIZED',
  ];

  beforeEach(() => {
    ENV_VARS.forEach((v) => delete process.env[v]);
    createClientMock.mockReset();
    service = new LdapService();
  });

  describe('isEnabled', () => {
    it('returns false when NC_LDAP_URL is not set', () => {
      expect(service.isEnabled()).toBe(false);
    });

    it('returns true when NC_LDAP_URL is set', () => {
      process.env.NC_LDAP_URL = 'ldap://localhost:389';
      expect(service.isEnabled()).toBe(true);
    });
  });

  describe('authenticate', () => {
    it('authenticates in search mode and returns normalized identity', async () => {
      process.env.NC_LDAP_URL = 'ldap://localhost:389';
      process.env.NC_LDAP_BIND_DN = 'cn=admin,dc=example,dc=com';
      process.env.NC_LDAP_BIND_PASSWORD = 'adminpw';
      process.env.NC_LDAP_SEARCH_BASE = 'ou=people,dc=example,dc=com';
      process.env.NC_LDAP_SEARCH_FILTER = '(mail={{email}})';

      const userDn = 'cn=John Doe,ou=people,dc=example,dc=com';
      const bind = jest.fn();
      const search = jest.fn();
      const destroy = jest.fn();

      createClientMock.mockReturnValue(makeClient({ bind, search, destroy }));

      bind.mockImplementationOnce((dn, password, cb) => cb(null));
      bind.mockImplementationOnce((dn, password, cb) => {
        expect(dn).toBe(userDn);
        expect(password).toBe('secret');
        cb(null);
      });

      search.mockImplementationOnce((base, options, cb) => {
        expect(base).toBe('ou=people,dc=example,dc=com');
        expect(options.filter).toBe('(mail=john@example.com)');
        const res = new EventEmitter();
        process.nextTick(() => {
          res.emit(
            'searchEntry',
            searchEntry(userDn, {
              mail: 'john@example.com',
              displayName: 'John Doe',
            }),
          );
          res.emit('end', null);
        });
        cb(null, res);
      });

      const result = await service.authenticate('john@example.com', 'secret');

      expect(result).toEqual({
        email: 'john@example.com',
        displayName: 'John Doe',
      });
      expect(destroy).toHaveBeenCalled();
    });

    it('escapes special characters in the search filter', async () => {
      process.env.NC_LDAP_URL = 'ldap://localhost:389';
      process.env.NC_LDAP_BIND_DN = 'cn=admin,dc=example,dc=com';
      process.env.NC_LDAP_BIND_PASSWORD = 'adminpw';
      process.env.NC_LDAP_SEARCH_BASE = 'ou=people,dc=example,dc=com';
      process.env.NC_LDAP_SEARCH_FILTER = '(uid={{username}})';

      const bind = jest.fn((dn, password, cb) => cb(null));
      const search = jest.fn((base, options, cb) => {
        const res = new EventEmitter();
        process.nextTick(() => res.emit('end', null));
        cb(null, res);
      });
      const destroy = jest.fn();

      createClientMock.mockReturnValue(makeClient({ bind, search, destroy }));

      await expect(
        service.authenticate('john*doe', 'secret'),
      ).rejects.toThrow();

      expect(search).toHaveBeenCalledWith(
        'ou=people,dc=example,dc=com',
        expect.objectContaining({ filter: '(uid=john\\2adoe)' }),
        expect.any(Function),
      );
    });

    it('throws when the user is not found in the directory', async () => {
      process.env.NC_LDAP_URL = 'ldap://localhost:389';
      process.env.NC_LDAP_BIND_DN = 'cn=admin,dc=example,dc=com';
      process.env.NC_LDAP_BIND_PASSWORD = 'adminpw';
      process.env.NC_LDAP_SEARCH_BASE = 'ou=people,dc=example,dc=com';
      process.env.NC_LDAP_SEARCH_FILTER = '(mail={{email}})';

      const bind = jest.fn((dn, password, cb) => cb(null));
      const search = jest.fn((base, options, cb) => {
        const res = new EventEmitter();
        process.nextTick(() => res.emit('end', null));
        cb(null, res);
      });
      const destroy = jest.fn();

      createClientMock.mockReturnValue(makeClient({ bind, search, destroy }));

      await expect(
        service.authenticate('nobody@example.com', 'secret'),
      ).rejects.toThrow();
    });

    it('throws when the user bind fails (wrong password)', async () => {
      process.env.NC_LDAP_URL = 'ldap://localhost:389';
      process.env.NC_LDAP_BIND_DN = 'cn=admin,dc=example,dc=com';
      process.env.NC_LDAP_BIND_PASSWORD = 'adminpw';
      process.env.NC_LDAP_SEARCH_BASE = 'ou=people,dc=example,dc=com';
      process.env.NC_LDAP_SEARCH_FILTER = '(mail={{email}})';

      const userDn = 'cn=John Doe,ou=people,dc=example,dc=com';
      const bind = jest.fn();
      const search = jest.fn();
      const destroy = jest.fn();

      createClientMock.mockReturnValue(makeClient({ bind, search, destroy }));

      bind.mockImplementationOnce((dn, password, cb) => cb(null));
      bind.mockImplementationOnce((dn, password, cb) =>
        cb(new Error('Invalid credentials')),
      );

      search.mockImplementationOnce((base, options, cb) => {
        const res = new EventEmitter();
        process.nextTick(() => {
          res.emit(
            'searchEntry',
            searchEntry(userDn, { mail: 'john@example.com' }),
          );
          res.emit('end', null);
        });
        cb(null, res);
      });

      await expect(
        service.authenticate('john@example.com', 'wrong'),
      ).rejects.toThrow('Invalid credentials');
    });

    it('authenticates in direct-bind mode using a DN template', async () => {
      process.env.NC_LDAP_URL = 'ldap://localhost:389';
      process.env.NC_LDAP_BIND_DN_TEMPLATE =
        'uid={{username}},ou=people,dc=example,dc=com';

      const bind = jest.fn((dn, password, cb) => {
        expect(dn).toBe('uid=jdoe,ou=people,dc=example,dc=com');
        expect(password).toBe('secret');
        cb(null);
      });
      const destroy = jest.fn();

      createClientMock.mockReturnValue(makeClient({ bind, destroy }));

      const result = await service.authenticate('jdoe', 'secret');

      expect(result).toEqual({ email: 'jdoe', displayName: 'jdoe' });
      expect(destroy).toHaveBeenCalled();
    });

    it('throws when no bind configuration is present', async () => {
      process.env.NC_LDAP_URL = 'ldap://localhost:389';

      const destroy = jest.fn();
      createClientMock.mockReturnValue(makeClient({ destroy }));

      await expect(service.authenticate('jdoe', 'secret')).rejects.toThrow();
    });
  });
});

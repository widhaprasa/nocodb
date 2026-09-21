import { Injectable } from '@nestjs/common';
import { createClient } from 'ldapjs';
import type { Attribute, Client } from 'ldapjs';

export interface LdapIdentity {
  email: string;
  displayName: string;
}

export interface LdapEntry {
  dn: string;
  attributes: Attribute[];
}

const DEFAULT_MAIL_ATTRIBUTE = 'mail';
const DEFAULT_NAME_ATTRIBUTE = 'displayName';
const DEFAULT_CONNECT_TIMEOUT_MS = 10000;

export function escapeFilterValue(value: string): string {
  return value
    .replace(/\\/g, '\\5c')
    .replace(/\*/g, '\\2a')
    .replace(/\(/g, '\\28')
    .replace(/\)/g, '\\29')
    .replace(/\0/g, '\\00');
}

@Injectable()
export class LdapService {
  isEnabled(): boolean {
    return !!process.env.NC_LDAP_URL;
  }

  async authenticate(
    username: string,
    password: string,
  ): Promise<LdapIdentity> {
    const client = createClient({
      url: process.env.NC_LDAP_URL,
      tlsOptions: {
        rejectUnauthorized:
          process.env.NC_LDAP_TLS_REJECT_UNAUTHORIZED !== 'false',
      },
      connectTimeout: DEFAULT_CONNECT_TIMEOUT_MS,
      timeout: DEFAULT_CONNECT_TIMEOUT_MS,
    });

    client.on('error', () => {
      // Swallow client-level errors; bind/search failures surface via callbacks.
    });

    try {
      const bindDn = process.env.NC_LDAP_BIND_DN;
      const bindPassword = process.env.NC_LDAP_BIND_PASSWORD ?? '';

      if (bindDn) {
        return await this.authenticateSearchMode(
          client,
          username,
          password,
          bindDn,
          bindPassword,
        );
      }

      const bindDnTemplate = process.env.NC_LDAP_BIND_DN_TEMPLATE;
      if (bindDnTemplate) {
        return await this.authenticateDirectBindMode(
          client,
          username,
          password,
          bindDnTemplate,
        );
      }

      throw new Error(
        'LDAP is not fully configured (missing NC_LDAP_BIND_DN or NC_LDAP_BIND_DN_TEMPLATE)',
      );
    } finally {
      client.destroy();
    }
  }

  private async authenticateSearchMode(
    client: Client,
    username: string,
    password: string,
    bindDn: string,
    bindPassword: string,
  ): Promise<LdapIdentity> {
    await this.bind(client, bindDn, bindPassword);

    const entry = await this.searchUser(client, username);
    if (!entry) {
      throw new Error('LDAP user not found');
    }

    await this.bind(client, entry.dn, password);

    return this.normalize(entry, username);
  }

  private async authenticateDirectBindMode(
    client: Client,
    username: string,
    password: string,
    bindDnTemplate: string,
  ): Promise<LdapIdentity> {
    const dn = this.applyTemplate(bindDnTemplate, username);
    await this.bind(client, dn, password);

    return { email: username, displayName: username };
  }

  private bind(client: Client, dn: string, password: string): Promise<void> {
    return new Promise((resolve, reject) => {
      client.bind(dn, password, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  private searchUser(
    client: Client,
    username: string,
  ): Promise<LdapEntry | null> {
    const base = process.env.NC_LDAP_SEARCH_BASE;
    const filterTemplate = process.env.NC_LDAP_SEARCH_FILTER;

    if (!base || !filterTemplate) {
      throw new Error(
        'LDAP search is not configured (missing NC_LDAP_SEARCH_BASE or NC_LDAP_SEARCH_FILTER)',
      );
    }

    const filter = this.applyTemplate(
      filterTemplate,
      escapeFilterValue(username),
    );
    const attributes = [
      this.mailAttribute(),
      this.nameAttribute(),
      'cn',
    ].filter((value, index, self) => self.indexOf(value) === index);

    return new Promise((resolve, reject) => {
      client.search(base, { scope: 'sub', filter, attributes }, (err, res) => {
        if (err) {
          reject(err);
          return;
        }

        let found: LdapEntry | null = null;
        res.on('searchEntry', (entry) => {
          if (!found) {
            // ldapjs v3 returns `objectName` as a DN instance, not a string;
            // BindRequest requires a string DN.
            found = {
              dn: entry.objectName?.toString() ?? '',
              attributes: entry.attributes,
            };
          }
        });
        res.on('error', (e) => reject(e));
        res.on('end', () => resolve(found));
      });
    });
  }

  private normalize(entry: LdapEntry, username: string): LdapIdentity {
    const email = this.attributeValue(entry, this.mailAttribute()) ?? username;
    const displayName =
      this.attributeValue(entry, this.nameAttribute()) ??
      this.attributeValue(entry, 'cn') ??
      username;

    return { email, displayName };
  }

  private applyTemplate(template: string, value: string): string {
    return template
      .replace(/\{\{\s*email\s*\}\}/g, () => value)
      .replace(/\{\{\s*username\s*\}\}/g, () => value);
  }

  private mailAttribute(): string {
    return process.env.NC_LDAP_MAIL_ATTRIBUTE || DEFAULT_MAIL_ATTRIBUTE;
  }

  private nameAttribute(): string {
    return process.env.NC_LDAP_NAME_ATTRIBUTE || DEFAULT_NAME_ATTRIBUTE;
  }

  private attributeValue(entry: LdapEntry, name: string): string | undefined {
    const attr = entry.attributes?.find(
      (a) => a.type?.toLowerCase() === name.toLowerCase(),
    );
    if (!attr) return undefined;

    const values = Array.isArray(attr.values) ? attr.values : [attr.values];
    return values.find((v) => typeof v === 'string' && v.length > 0);
  }
}

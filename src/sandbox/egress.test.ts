import { describe, expect, test } from 'bun:test';
import { decideConnect, decisionLog, isPublicAddress, MAX_LOG_LINES, parseClientHello, REGISTRY_HOSTS } from './egress';

describe('the allowlist decision', () => {
  test('a tunnel to a listed host on 443 is allowed', () => {
    for (const host of REGISTRY_HOSTS) expect(decideConnect(`CONNECT ${host}:443 HTTP/1.1`, REGISTRY_HOSTS)).toEqual({ ok: true, host, port: 443 });
    expect(decideConnect('CONNECT Registry.NPMJS.org.:443 HTTP/1.1\r\n', REGISTRY_HOSTS)).toEqual({ ok: true, host: 'registry.npmjs.org', port: 443 });
    expect(decideConnect('CONNECT npm.example.test:443 HTTP/1.0', ['npm.example.test'])).toMatchObject({ ok: true });
  });

  test('other hosts are refused, including ones that only look like a listed host', () => {
    for (const host of ['example.com', 'evil-registry.npmjs.org.example.com', 'npmjs.org', 'x.registry.npmjs.org', 'registry.npmjs.org.evil.test', 'host.docker.internal', 'localhost']) {
      expect(decideConnect(`CONNECT ${host}:443 HTTP/1.1`, REGISTRY_HOSTS)).toMatchObject({ ok: false, status: 403, reason: 'host is not on the allowlist', target: `${host}:443` });
    }
  });

  test('other ports are refused, even on a listed host', () => {
    for (const port of [80, 22, 8443, 4430, 65535]) {
      expect(decideConnect(`CONNECT registry.npmjs.org:${port} HTTP/1.1`, REGISTRY_HOSTS)).toMatchObject({ ok: false, status: 403, reason: 'only port 443 is allowed' });
    }
  });

  test('addresses in place of names are refused', () => {
    expect(decideConnect('CONNECT 172.17.0.1:443 HTTP/1.1', REGISTRY_HOSTS)).toMatchObject({ ok: false, status: 403 });
    expect(decideConnect('CONNECT 169.254.169.254:443 HTTP/1.1', REGISTRY_HOSTS)).toMatchObject({ ok: false, status: 403 });
    expect(decideConnect('CONNECT [::1]:443 HTTP/1.1', REGISTRY_HOSTS)).toMatchObject({ ok: false, status: 403, reason: 'target is not a host name and port' });
  });

  test('plain HTTP requests and malformed lines are refused', () => {
    expect(decideConnect('GET http://registry.npmjs.org/clsx HTTP/1.1', REGISTRY_HOSTS)).toMatchObject({ ok: false, status: 403, reason: 'only CONNECT is allowed' });
    expect(decideConnect('POST http://example.com/ HTTP/1.1', REGISTRY_HOSTS)).toMatchObject({ ok: false, status: 403 });
    expect(decideConnect('CONNECT registry.npmjs.org:443', REGISTRY_HOSTS)).toEqual({ ok: false, status: 400, reason: 'not a proxy request' });
    expect(decideConnect('CONNECT registry.npmjs.org:443 extra HTTP/1.1', REGISTRY_HOSTS)).toMatchObject({ ok: false, status: 400 });
    expect(decideConnect('CONNECT registry.npmjs.org:443@evil.test:443 HTTP/1.1', REGISTRY_HOSTS)).toMatchObject({ ok: false, status: 403 });
    expect(decideConnect('', REGISTRY_HOSTS)).toMatchObject({ ok: false, status: 400 });
  });

  test('an empty allowlist allows nothing', () => {
    expect(decideConnect('CONNECT registry.npmjs.org:443 HTTP/1.1', [])).toMatchObject({ ok: false, status: 403 });
  });
});

const u16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const ascii = (text: string) => [...new TextEncoder().encode(text)];
const extension = (type: number, body: number[]) => [...u16(type), ...u16(body.length), ...body];
const hostName = (name: string) => [0, ...u16(name.length), ...ascii(name)];
/** A server_name extension holding the given names. Real clients send exactly one. */
const sni = (...names: string[]) => {
  const list = names.flatMap(hostName);
  return extension(0, [...u16(list.length), ...list]);
};
const supportedVersions = extension(43, [2, 3, 4]);

/** A ClientHello in one TLS record, built from its extensions. `claim` overrides the handshake length field. */
function clientHello(extensions: number[], opts: { claim?: number; recordType?: number } = {}): Uint8Array {
  const body = [3, 3, ...new Array<number>(32).fill(7), 0, ...u16(2), 0x13, 0x01, 1, 0, ...u16(extensions.length), ...extensions];
  const length = opts.claim ?? body.length;
  const handshake = [1, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff, ...body];
  return Uint8Array.from([opts.recordType ?? 0x16, 3, 1, ...u16(handshake.length), ...handshake]);
}

describe('the server name in the TLS hello', () => {
  test('a hello with one server name gives that name, lower case', () => {
    expect(parseClientHello(clientHello([...supportedVersions, ...sni('registry.npmjs.org')]))).toEqual({ kind: 'ok', serverName: 'registry.npmjs.org' });
    expect(parseClientHello(clientHello(sni('Registry.NPMJS.org')))).toEqual({ kind: 'ok', serverName: 'registry.npmjs.org' });
    // Bytes after the first record belong to later records and don't change the answer.
    expect(parseClientHello(Uint8Array.from([...clientHello(sni('repo.yarnpkg.com')), 0x17, 3, 3, 0, 1, 0]))).toEqual({ kind: 'ok', serverName: 'repo.yarnpkg.com' });
  });

  test('a hello for another site reports that site, so it never equals the tunnel host', () => {
    expect(parseClientHello(clientHello(sni('other-site.example')))).toEqual({ kind: 'ok', serverName: 'other-site.example' });
  });

  test('no server name, two of them, or a hidden one is refused', () => {
    expect(parseClientHello(clientHello(supportedVersions))).toEqual({ kind: 'refused', reason: 'no server name' });
    expect(parseClientHello(clientHello([]))).toEqual({ kind: 'refused', reason: 'no server name' });
    expect(parseClientHello(clientHello([...sni('registry.npmjs.org'), ...sni('other-site.example')]))).toEqual({ kind: 'refused', reason: 'more than one server name' });
    expect(parseClientHello(clientHello(sni('registry.npmjs.org', 'other-site.example')))).toEqual({ kind: 'refused', reason: 'malformed server name' });
    expect(parseClientHello(clientHello([...sni('registry.npmjs.org'), ...extension(0xfe0d, [0, 1, 2])]))).toEqual({ kind: 'refused', reason: 'encrypted ClientHello is not allowed' });
    expect(parseClientHello(clientHello([...extension(0xffce, [1]), ...sni('registry.npmjs.org')]))).toMatchObject({ kind: 'refused' });
  });

  test('a name with odd bytes or wrong lengths is refused', () => {
    expect(parseClientHello(clientHello(extension(0, [...u16(7), 0, ...u16(4), ...ascii('a\0b.')])))).toEqual({ kind: 'refused', reason: 'malformed server name' });
    expect(parseClientHello(clientHello(extension(0, [...u16(3), 0, ...u16(0)])))).toEqual({ kind: 'refused', reason: 'malformed server name' });
    expect(parseClientHello(clientHello(extension(0, [...u16(9), 1, ...u16(6), ...ascii('a.test')])))).toEqual({ kind: 'refused', reason: 'malformed server name' });
    expect(parseClientHello(clientHello(extension(0, [...u16(99), 0, ...u16(6), ...ascii('a.test')])))).toEqual({ kind: 'refused', reason: 'malformed server name' });
  });

  test('every truncation of a valid hello is incomplete, never a name', () => {
    const whole = clientHello([...supportedVersions, ...sni('registry.npmjs.org')]);
    for (let length = 0; length < whole.length; length++) expect([length, parseClientHello(whole.subarray(0, length))]).toEqual([length, { kind: 'incomplete' }]);
  });

  test('a hello that claims more or less than its record holds is refused', () => {
    const extensions = sni('registry.npmjs.org');
    const real = clientHello(extensions).length - 9;
    expect(parseClientHello(clientHello(extensions, { claim: real + 500 }))).toEqual({ kind: 'refused', reason: 'ClientHello does not fit one record exactly' });
    expect(parseClientHello(clientHello(extensions, { claim: real - 1 }))).toEqual({ kind: 'refused', reason: 'ClientHello does not fit one record exactly' });
    // An extensions block that claims to run past the end.
    const broken = clientHello(extensions);
    broken[5 + 4 + 2 + 32 + 1 + 4 + 2] = 0xff;
    expect(parseClientHello(broken)).toEqual({ kind: 'refused', reason: 'malformed ClientHello' });
  });

  test('bytes that are not a TLS hello are refused', () => {
    const text = (value: string) => new TextEncoder().encode(value);
    expect(parseClientHello(text('GET / HTTP/1.1\r\nHost: other-site.example\r\n\r\n'))).toEqual({ kind: 'refused', reason: 'not a TLS handshake' });
    expect(parseClientHello(text('G'))).toEqual({ kind: 'refused', reason: 'not a TLS handshake' });
    expect(parseClientHello(clientHello(sni('registry.npmjs.org'), { recordType: 0x17 }))).toEqual({ kind: 'refused', reason: 'not a TLS handshake' });
    expect(parseClientHello(Uint8Array.from([0x16, 3, 1, 0xff, 0xff, 1]))).toEqual({ kind: 'refused', reason: 'bad TLS record length' });
    expect(parseClientHello(Uint8Array.from([0x16, 3, 1, 0, 0]))).toEqual({ kind: 'refused', reason: 'bad TLS record length' });
    expect(parseClientHello(Uint8Array.from([0x16, 3, 1, 0, 4, 2, 0, 0, 0]))).toEqual({ kind: 'refused', reason: 'first TLS message is not a ClientHello' });
    expect(parseClientHello(Uint8Array.from([0x16, 2, 0, 0, 4, 1, 0, 0, 0]))).toEqual({ kind: 'refused', reason: 'not a TLS handshake' });
  });
});

describe('the decision log', () => {
  test('stops after a fixed number of lines and keeps each line short and single', () => {
    const lines: string[] = [];
    const log = decisionLog((line) => lines.push(line));
    log('refused', 'example.com:443', 'host is not on the allowlist');
    log('allowed', 'registry.npmjs.org:443');
    log('refused', `${'x'.repeat(5000)}:443`, 'line one\r\nrefused injected.test:443 x');
    expect(lines.slice(0, 2)).toEqual(['refused example.com:443 host is not on the allowlist', 'allowed registry.npmjs.org:443']);
    expect(lines[2]!.length).toBe(400);
    for (let i = 0; i < 10 * MAX_LOG_LINES; i++) log('refused', `h${i}.test:443`, 'host is not on the allowlist');
    expect(lines).toHaveLength(MAX_LOG_LINES + 1);
    expect(lines.at(-1)).toBe('log limit reached, later decisions are not listed');
    expect(lines.every((line) => line.length <= 400 && !/[\r\n]/.test(line))).toBe(true);
  });
});

describe('the address check after DNS', () => {
  test('public addresses pass', () => {
    for (const address of ['104.16.3.35', '1.1.1.1', '8.8.8.8', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '169.253.0.1', '192.167.1.1', '223.255.255.254']) {
      expect([address, isPublicAddress(address)]).toEqual([address, true]);
    }
  });

  test('private, loopback, link-local and metadata addresses are refused', () => {
    const inward = [
      '127.0.0.1', '127.255.255.254', '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.17.0.1', '172.31.255.255',
      '192.168.0.1', '192.168.65.254', '169.254.169.254', '169.254.0.1', '100.64.0.1', '100.127.255.255', '0.0.0.0',
      '192.0.0.1', '198.18.0.1', '198.19.255.255', '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255',
    ];
    for (const address of inward) expect([address, isPublicAddress(address)]).toEqual([address, false]);
  });

  test('IPv6 in any form and anything that is not an address are refused', () => {
    for (const address of ['::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8', '2606:4700::6810:323', '', 'registry.npmjs.org', '1.1.1', '1.1.1.1.1', '256.1.1.1', '0x7f.0.0.1', '1.1.1.1 ']) {
      expect([address, isPublicAddress(address)]).toEqual([address, false]);
    }
  });
});

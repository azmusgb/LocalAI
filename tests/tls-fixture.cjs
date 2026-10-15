'use strict';

// Throwaway certificate authorities for the chat HTTPS tests (Node's crypto cannot issue certificates, so this
// shells out to openssl). makeTlsFixture() returns null when openssl is missing; callers skip with a message.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CONFIG = `[req]
distinguished_name = dn
prompt = no
[dn]
CN = LocalAI Test
[v3_ca]
basicConstraints = critical, CA:TRUE
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
[leaf]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = IP:127.0.0.1, DNS:localhost
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
`;

const OPENSSL_MISSING = 'openssl not found: skipping the HTTPS tests (install openssl to run them)';

function hasOpenssl() {
  return spawnSync('openssl', ['version'], { encoding: 'utf8' }).status === 0;
}

function openssl(dir, args) {
  const r = spawnSync('openssl', args, { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`openssl ${args.join(' ')} failed: ${r.stderr}`);
}

// A CA plus a server certificate for 127.0.0.1/localhost signed by it, and a second, unrelated CA (to prove a
// mismatched CA is refused). Paths and PEM strings are returned; cleanup() removes the files.
function makeTlsFixture() {
  if (!hasOpenssl()) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-tls-'));
  fs.writeFileSync(path.join(dir, 'openssl.cnf'), CONFIG);
  const ca = (name) => openssl(dir, ['req', '-x509', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '2',
    '-config', 'openssl.cnf', '-extensions', 'v3_ca', '-subj', `/CN=${name}`, '-keyout', `${name}.key`, '-out', `${name}.crt`]);
  ca('ca');
  ca('other');
  openssl(dir, ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-config', 'openssl.cnf', '-subj', '/CN=localhost',
    '-keyout', 'leaf.key', '-out', 'leaf.csr']);
  openssl(dir, ['x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-set_serial', '1', '-sha256', '-days', '2',
    '-extfile', 'openssl.cnf', '-extensions', 'leaf', '-out', 'leaf.crt']);
  const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
  return {
    dir,
    caPath: path.join(dir, 'ca.crt'),
    otherCaPath: path.join(dir, 'other.crt'),
    caPem: read('ca.crt'),
    key: read('leaf.key'),
    cert: read('leaf.crt'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

module.exports = { makeTlsFixture, OPENSSL_MISSING };

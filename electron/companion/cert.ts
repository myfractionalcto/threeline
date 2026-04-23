import { app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import forge from 'node-forge';

/**
 * Local CA + leaf-cert TLS for the companion server.
 *
 * On first launch we generate a root CA (persisted in userData). Every time
 * the Mac's WiFi IP changes we issue a new leaf cert signed by that CA.
 * The phone installs the CA cert once (via /ca.pem or /ca.mobileconfig),
 * after which every future leaf cert is automatically trusted — no more
 * browser SSL warnings, and PWA install + getUserMedia work properly.
 *
 * This is the "mkcert-style" approach from PLAN.md §3.4.
 */

export interface ServerCert {
  cert: string;   // leaf PEM
  key: string;    // leaf private key PEM
  ca: string;     // CA PEM (served to phones for trust install)
  ip: string;
}

const CA_FILE = 'threelane-ca.json';
const LEAF_FILE = 'threelane-leaf.json';

interface StoredCA {
  cert: string;
  key: string;
}

interface StoredLeaf {
  cert: string;
  key: string;
  ip: string;
}

function dataDir(): string {
  return app.getPath('userData');
}

/** Pick the first non-loopback IPv4 on an active interface. */
export function pickLanIp(): string {
  const ifaces = os.networkInterfaces();
  const all: string[] = [];
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const e of list) {
      if (e.family !== 'IPv4' || e.internal) continue;
      all.push(e.address);
    }
  }
  const preferred = all.find((a) =>
    /^10\./.test(a) || /^192\.168\./.test(a) || /^172\.(1[6-9]|2\d|3[01])\./.test(a),
  );
  return preferred ?? all[0] ?? '127.0.0.1';
}

// ── CA management ──────────────────────────────────────────────────

async function readJson<T>(name: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(path.join(dataDir(), name), 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function writeJson(name: string, data: unknown): Promise<void> {
  await fs.writeFile(path.join(dataDir(), name), JSON.stringify(data), 'utf8');
}

function generateCA(): StoredCA {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = randomSerial();

  const now = new Date();
  cert.validity.notBefore = now;
  cert.validity.notAfter = new Date(now.getTime() + 10 * 365 * 24 * 60 * 60 * 1000); // 10 years

  const attrs = [
    { shortName: 'CN', value: 'Threelane Local CA' },
    { shortName: 'O', value: 'Threelane' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs); // self-signed

  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    {
      name: 'subjectKeyIdentifier',
    },
  ]);

  cert.sign(keys.privateKey, forge.md.sha256.create());

  return {
    cert: forge.pki.certificateToPem(cert),
    key: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

async function getOrCreateCA(): Promise<StoredCA> {
  const cached = await readJson<StoredCA>(CA_FILE);
  if (cached?.cert && cached?.key) return cached;
  const fresh = generateCA();
  await writeJson(CA_FILE, fresh);
  return fresh;
}

// ── Leaf cert ──────────────────────────────────────────────────────

function generateLeaf(ca: StoredCA, ip: string): StoredLeaf {
  const caKey = forge.pki.privateKeyFromPem(ca.key);
  const caCert = forge.pki.certificateFromPem(ca.cert);

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = randomSerial();

  const now = new Date();
  cert.validity.notBefore = now;
  cert.validity.notAfter = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000); // 1 year

  cert.setSubject([
    { shortName: 'CN', value: ip },
    { shortName: 'O', value: 'Threelane' },
  ]);
  cert.setIssuer(caCert.subject.attributes);

  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    {
      name: 'keyUsage',
      digitalSignature: true,
      keyEncipherment: true,
      critical: true,
    },
    {
      name: 'extKeyUsage',
      serverAuth: true,
    },
    {
      name: 'subjectAltName',
      altNames: [
        { type: 7, ip },        // iPAddress
        { type: 2, value: 'localhost' }, // DNS
      ],
    },
  ]);

  // Sign with the CA key
  cert.sign(caKey, forge.md.sha256.create());

  return {
    cert: forge.pki.certificateToPem(cert),
    key: forge.pki.privateKeyToPem(keys.privateKey),
    ip,
  };
}

function randomSerial(): string {
  // 16 hex chars
  let s = '';
  for (let i = 0; i < 16; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

// ── Public API ─────────────────────────────────────────────────────

export async function getOrCreateCert(): Promise<ServerCert> {
  const ip = pickLanIp();
  const ca = await getOrCreateCA();

  // Reuse cached leaf if the IP hasn't changed
  const cached = await readJson<StoredLeaf>(LEAF_FILE);
  if (cached?.cert && cached?.key && cached?.ip === ip) {
    return { cert: cached.cert, key: cached.key, ca: ca.cert, ip };
  }

  const leaf = generateLeaf(ca, ip);
  await writeJson(LEAF_FILE, leaf);
  return { cert: leaf.cert, key: leaf.key, ca: ca.cert, ip };
}

/**
 * Generate an iOS .mobileconfig profile wrapping the CA cert.
 * Installing this profile on the phone trusts the CA for TLS,
 * making all leaf certs signed by it work without warnings.
 */
export function buildMobileConfig(caPem: string): string {
  // Extract the base64 body from the PEM
  const b64 = caPem
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s/g, '');

  const uuid1 = crypto.randomUUID();
  const uuid2 = crypto.randomUUID();

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadCertificateFileName</key>
      <string>ThreelaneCA.crt</string>
      <key>PayloadContent</key>
      <data>${b64}</data>
      <key>PayloadDescription</key>
      <string>Adds Threelane Local CA to trusted certificates</string>
      <key>PayloadDisplayName</key>
      <string>Threelane Local CA</string>
      <key>PayloadIdentifier</key>
      <string>com.threelane.localca.${uuid1}</string>
      <key>PayloadType</key>
      <string>com.apple.security.root</string>
      <key>PayloadUUID</key>
      <string>${uuid1}</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
    </dict>
  </array>
  <key>PayloadDisplayName</key>
  <string>Threelane Local CA</string>
  <key>PayloadDescription</key>
  <string>Trust Threelane's local HTTPS certificate so the companion camera works without browser warnings.</string>
  <key>PayloadIdentifier</key>
  <string>com.threelane.localca</string>
  <key>PayloadOrganization</key>
  <string>Threelane</string>
  <key>PayloadRemovalDisallowed</key>
  <false/>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  <string>${uuid2}</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
</dict>
</plist>`;
}

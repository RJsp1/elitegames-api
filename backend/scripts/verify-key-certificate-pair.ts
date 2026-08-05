/**
 * Verifica se chaves privadas correspondem ao certificado da aplicação.
 * Usa OpenSSL para extrair chaves públicas, calcular SHA-256 e comparar.
 *
 * Nunca imprime conteúdo de chaves, certificados ou frases de segurança.
 * Não altera arquivos, não altera .env, não chama Sicredi.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const backendRoot = resolve(__dirname, '..');
const homologDir = resolve(backendRoot, 'certificates/homologacao');

const CERT_PATH = resolve(homologDir, '63325362000172.cer');
const KEY_PATHS = [
  resolve(homologDir, 'api-pix-elitegames-api.key'),
  resolve(homologDir, 'api-pix-elitegamessemsenha-api.key'),
];

function findOpenSsl(): string {
  const candidates = [
    'openssl',
    'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
    'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe',
    'C:\\Program Files\\OpenSSL-Win64\\bin\\openssl.exe',
    'C:\\Program Files\\OpenSSL-Win32\\bin\\openssl.exe',
  ];

  for (const bin of candidates) {
    const probe = spawnSync(bin, ['version'], { encoding: 'utf8', windowsHide: true });
    if (probe.status === 0) {
      return bin;
    }
  }

  throw new Error(
    'OpenSSL não encontrado no PATH nem em locais comuns (Git/OpenSSL). Instale OpenSSL ou Git for Windows.',
  );
}

function runOpenSslText(
  openssl: string,
  args: string[],
  input?: string,
): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync(openssl, args, {
    encoding: 'utf8',
    input,
    windowsHide: true,
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function runOpenSslBuffer(
  openssl: string,
  args: string[],
  input?: string | Buffer,
): { ok: boolean; stdout: Buffer; stderr: string } {
  const result = spawnSync(openssl, args, {
    encoding: null,
    input,
    windowsHide: true,
  });
  return {
    ok: result.status === 0,
    stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0),
    stderr: Buffer.isBuffer(result.stderr)
      ? result.stderr.toString('utf8')
      : String(result.stderr ?? ''),
  };
}

function looksEncryptedPrivateKey(path: string): boolean {
  const head = readFileSync(path, 'utf8').slice(0, 200).toUpperCase();
  return (
    head.includes('ENCRYPTED PRIVATE KEY') ||
    head.includes('PROC-TYPE: 4,ENCRYPTED') ||
    head.includes('DEK-INFO:')
  );
}

function extractCertPublicKeyPem(openssl: string, certPath: string): string {
  const pemAttempt = runOpenSslText(openssl, ['x509', '-in', certPath, '-pubkey', '-noout']);
  if (pemAttempt.ok && pemAttempt.stdout.includes('BEGIN PUBLIC KEY')) {
    return pemAttempt.stdout;
  }

  const derAttempt = runOpenSslText(openssl, [
    'x509',
    '-inform',
    'DER',
    '-in',
    certPath,
    '-pubkey',
    '-noout',
  ]);
  if (derAttempt.ok && derAttempt.stdout.includes('BEGIN PUBLIC KEY')) {
    return derAttempt.stdout;
  }

  throw new Error('Não foi possível extrair a chave pública do certificado (PEM/DER).');
}

function normalizeHash(output: string): string {
  const match = output.trim().match(/([a-fA-F0-9]{64})\s*$/);
  if (!match) {
    throw new Error('Saída de SHA-256 inesperada do OpenSSL.');
  }
  return match[1]!.toLowerCase();
}

function sha256OfPublicKeyPem(openssl: string, publicKeyPem: string): string {
  const der = runOpenSslBuffer(openssl, ['pkey', '-pubin', '-outform', 'DER'], publicKeyPem);
  if (!der.ok || der.stdout.length === 0) {
    throw new Error('Falha ao converter chave pública para DER.');
  }

  const hash = runOpenSslBuffer(openssl, ['dgst', '-sha256'], der.stdout);
  if (!hash.ok) {
    throw new Error('Falha ao calcular SHA-256 da chave pública.');
  }

  return normalizeHash(hash.stdout.toString('utf8'));
}

type KeyResult = {
  file: string;
  status: 'MATCH' | 'MISMATCH' | 'MISSING' | 'NEEDS_PASSWORD' | 'ERROR';
  hash?: string;
  detail?: string;
};

function extractPrivateKeyPublicKeyPem(
  openssl: string,
  keyPath: string,
): { ok: true; pem: string } | { ok: false; needsPassword: boolean; detail: string } {
  const attempts = [
    ['pkey', '-in', keyPath, '-pubout'],
    ['pkey', '-in', keyPath, '-pubout', '-passin', 'pass:'],
    ['rsa', '-in', keyPath, '-pubout'],
  ];

  let sawPasswordIssue = looksEncryptedPrivateKey(keyPath);

  for (const args of attempts) {
    const result = runOpenSslText(openssl, args);
    if (result.ok && result.stdout.includes('BEGIN PUBLIC KEY')) {
      return { ok: true, pem: result.stdout };
    }

    const err = `${result.stderr} ${result.stdout}`.toLowerCase();
    if (
      err.includes('pass phrase') ||
      err.includes('passphrase') ||
      err.includes('bad decrypt') ||
      err.includes('unable to load private key') ||
      err.includes('interrupted or cancelled') ||
      err.includes('bad password') ||
      err.includes('wrong password') ||
      err.includes('problems getting password')
    ) {
      sawPasswordIssue = true;
    }
  }

  if (sawPasswordIssue || looksEncryptedPrivateKey(keyPath)) {
    return {
      ok: false,
      needsPassword: true,
      detail: 'Chave criptografada — precisa de entrada manual da senha no OpenSSL.',
    };
  }

  return {
    ok: false,
    needsPassword: false,
    detail: 'Não foi possível extrair a chave pública (formato inválido ou inacessível).',
  };
}

function verifyKey(openssl: string, keyPath: string, certHash: string): KeyResult {
  const file = basename(keyPath);

  if (!existsSync(keyPath)) {
    return { file, status: 'MISSING', detail: 'Arquivo não encontrado.' };
  }

  if (statSync(keyPath).size === 0) {
    return { file, status: 'ERROR', detail: 'Arquivo vazio.' };
  }

  const extracted = extractPrivateKeyPublicKeyPem(openssl, keyPath);
  if (!extracted.ok) {
    if (extracted.needsPassword) {
      return { file, status: 'NEEDS_PASSWORD', detail: extracted.detail };
    }
    return { file, status: 'ERROR', detail: extracted.detail };
  }

  try {
    const hash = sha256OfPublicKeyPem(openssl, extracted.pem);
    return {
      file,
      status: hash === certHash ? 'MATCH' : 'MISMATCH',
      hash,
    };
  } catch (err) {
    return {
      file,
      status: 'ERROR',
      detail: err instanceof Error ? err.message : 'Erro ao calcular hash.',
    };
  }
}

function main(): void {
  console.log('=== verify-key-certificate-pair ===');
  console.log('Comparação SHA-256 das chaves públicas (OpenSSL).');
  console.log('Nenhum conteúdo criptográfico será exibido.\n');

  const openssl = findOpenSsl();
  const version = runOpenSslText(openssl, ['version']);
  console.log(`OpenSSL: ${version.stdout.trim()}`);
  console.log(`Certificado: ${basename(CERT_PATH)}\n`);

  if (!existsSync(CERT_PATH)) {
    console.error(`[ERROR] Certificado ausente: ${basename(CERT_PATH)}`);
    process.exit(1);
  }

  let certHash: string;
  try {
    const certPub = extractCertPublicKeyPem(openssl, CERT_PATH);
    certHash = sha256OfPublicKeyPem(openssl, certPub);
  } catch (err) {
    console.error(
      `[ERROR] ${err instanceof Error ? err.message : 'Falha ao processar certificado.'}`,
    );
    process.exit(1);
  }

  console.log(`Certificado  SHA-256: ${certHash}`);
  console.log('---');

  const results = KEY_PATHS.map((path) => verifyKey(openssl, path, certHash));

  for (const result of results) {
    const hashPart = result.hash ? `  hash=${result.hash}` : '';
    const detailPart = result.detail ? `  (${result.detail})` : '';
    console.log(`[${result.status}] ${result.file}${hashPart}${detailPart}`);
  }

  console.log('---');

  const matches = results.filter((r) => r.status === 'MATCH');
  const needsPassword = results.filter((r) => r.status === 'NEEDS_PASSWORD');

  if (matches.length > 0) {
    const preferred = matches.find((m) => m.file.includes('semsenha')) ?? matches[0]!;
    console.log(`Recomendação Node.js: usar ${preferred.file}`);
    console.log(
      '  Motivo: chave pública coincide com o certificado e pode ser carregada sem senha interativa.',
    );
  } else if (needsPassword.length > 0) {
    console.log('Nenhuma chave sem senha correspondeu ao certificado nesta execução.');
    console.log(
      `A chave ${needsPassword.map((k) => k.file).join(', ')} exige senha manual no OpenSSL.`,
    );
    console.log(
      'Para Node.js, prefira uma chave sem senha correspondente (ou configure passphrase de forma segura fora do código).',
    );
  } else {
    console.log('Nenhuma das chaves testadas correspondeu ao certificado.');
    console.log('Não use essas chaves com este certificado no Node.js até corrigir o par.');
  }

  if (matches.length > 0) process.exit(0);
  if (needsPassword.length > 0) process.exit(2);
  process.exit(1);
}

main();

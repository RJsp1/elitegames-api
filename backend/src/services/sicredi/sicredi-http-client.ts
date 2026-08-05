import { existsSync, readFileSync, statSync } from 'node:fs';
import { createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto';
import https from 'node:https';
import tls from 'node:tls';
import axios, { type AxiosInstance } from 'axios';
import { getSicrediConfig } from '../../config/sicredi.js';
import { AppError } from '../../utils/app-error.js';
import { logger } from '../../utils/logger.js';

export interface MtlsMaterial {
  cert: Buffer;
  key: Buffer;
  ca: Buffer;
  agent: https.Agent;
}

function assertNonEmptyFile(path: string, label: string): Buffer {
  if (!existsSync(path)) {
    throw AppError.serviceUnavailable(
      `Arquivo mTLS ausente (${label})`,
      'MTLS_FILE_MISSING',
    );
  }
  const stats = statSync(path);
  if (stats.size === 0) {
    throw AppError.serviceUnavailable(`Arquivo mTLS vazio (${label})`, 'MTLS_FILE_EMPTY');
  }
  return readFileSync(path);
}

function validateCertificate(certBuf: Buffer, label: string): void {
  const text = certBuf.toString('utf8');
  if (
    text.includes('BEGIN CERTIFICATE REQUEST') ||
    text.includes('BEGIN NEW CERTIFICATE REQUEST')
  ) {
    throw AppError.serviceUnavailable(
      `${label} é um CSR, não um certificado`,
      'MTLS_CSR_AS_CERT',
    );
  }
  try {
    // eslint-disable-next-line no-new
    new X509Certificate(certBuf);
  } catch {
    throw AppError.serviceUnavailable(`Certificado inválido (${label})`, 'MTLS_CERT_INVALID');
  }
}

function validatePrivateKey(keyBuf: Buffer): void {
  try {
    createPrivateKey(keyBuf);
  } catch {
    throw AppError.serviceUnavailable(
      'Chave privada inválida ou criptografada sem passphrase configurada',
      'MTLS_KEY_INVALID',
    );
  }
}

function validateKeyCertMatch(keyBuf: Buffer, certBuf: Buffer): void {
  try {
    const key = createPrivateKey(keyBuf);
    const cert = new X509Certificate(certBuf);

    if (typeof cert.checkPrivateKey === 'function' && cert.checkPrivateKey(key)) {
      return;
    }

    const pubFromPriv = createPublicKey(key).export({ type: 'spki', format: 'der' });
    const pubFromCert = cert.publicKey.export({ type: 'spki', format: 'der' });
    if (!Buffer.from(pubFromPriv).equals(Buffer.from(pubFromCert))) {
      throw new Error('mismatch');
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw AppError.serviceUnavailable(
      'Chave privada não corresponde ao certificado da aplicação',
      'MTLS_KEY_CERT_MISMATCH',
    );
  }
}

export function loadMtlsMaterial(): MtlsMaterial {
  const config = getSicrediConfig();

  const key = assertNonEmptyFile(config.privateKeyPath, 'private key');
  const cert = assertNonEmptyFile(config.certificatePath, 'certificate');
  const ca = assertNonEmptyFile(config.caChainPath, 'ca chain');

  validatePrivateKey(key);
  validateCertificate(cert, 'certificate');
  // Cadeia pode conter múltiplos PEMs — valida o primeiro e exige conteúdo PEM.
  if (!ca.toString('utf8').includes('BEGIN CERTIFICATE')) {
    throw AppError.serviceUnavailable('Cadeia CA inválida', 'MTLS_CERT_INVALID');
  }
  validateKeyCertMatch(key, cert);

  /**
   * O endpoint api-pix-h.sicredi.com.br usa certificado DigiCert.
   * Definir somente CadeiaCompletaSicredi em `ca` substitui as roots do sistema
   * e causa UNABLE_TO_GET_ISSUER_CERT_LOCALLY.
   * Mantemos roots do sistema + cadeia Sicredi; enviamos a cadeia no client cert.
   */
  const agent = new https.Agent({
    cert: Buffer.concat([cert, Buffer.from('\n'), ca]),
    key,
    ca: [...tls.rootCertificates, ca.toString('utf8')],
    rejectUnauthorized: true,
    keepAlive: true,
  });

  return { cert, key, ca, agent };
}

let cachedClient: AxiosInstance | null = null;

export function createSicrediHttpClient(): AxiosInstance {
  if (cachedClient) return cachedClient;

  const config = getSicrediConfig();
  const { agent } = loadMtlsMaterial();

  cachedClient = axios.create({
    baseURL: config.baseUrl,
    timeout: config.requestTimeoutMs,
    httpsAgent: agent,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    validateStatus: () => true,
  });

  cachedClient.interceptors.response.use(
    (response) => response,
    (error) => {
      const code = error?.code as string | undefined;
      if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') {
        logger.error('Timeout na chamada Sicredi');
        return Promise.reject(
          AppError.serviceUnavailable('Timeout na API Sicredi', 'SICREDI_TIMEOUT'),
        );
      }
      if (
        code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
        code === 'CERT_HAS_EXPIRED' ||
        code === 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' ||
        code?.includes('TLS') ||
        code?.includes('CERT')
      ) {
        logger.error('Erro TLS na chamada Sicredi', { code });
        return Promise.reject(
          new AppError('Erro TLS na conexão Sicredi', 503, 'SICREDI_TLS_ERROR', {
            tlsCode: code,
          }),
        );
      }
      logger.error('Erro HTTP Sicredi', {
        code,
        message: error instanceof Error ? error.message : 'unknown',
      });
      return Promise.reject(
        new AppError('Falha na comunicação com Sicredi', 503, 'SICREDI_HTTP_ERROR', {
          tlsCode: code,
        }),
      );
    },
  );

  return cachedClient;
}

export function resetSicrediHttpClient(): void {
  cachedClient = null;
}

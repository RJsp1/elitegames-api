/**
 * Verifica certificados sem imprimir conteúdo.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const backendRoot = resolve(__dirname, '..');

const FILES = [
  {
    path: resolve(backendRoot, 'certificates/homologacao/api-pix-elitegames-api.key'),
    label: 'Chave privada',
    expect: 'PRIVATE KEY',
  },
  {
    path: resolve(backendRoot, 'certificates/homologacao/63325362000172.cer'),
    label: 'Certificado da aplicação',
    expect: 'CERTIFICATE',
  },
  {
    path: resolve(backendRoot, 'certificates/homologacao/CadeiaCompletaSicredi.cer'),
    label: 'Cadeia completa Sicredi',
    expect: 'CERTIFICATE',
  },
  {
    path: resolve(backendRoot, 'certificates/homologacao/webhook-sicredi.cer'),
    label: 'Certificado webhook (opcional)',
    expect: 'CERTIFICATE',
    optional: true,
  },
  {
    path: resolve(backendRoot, 'certificates/csr/elitecross2026.csr'),
    label: 'CSR original',
    expect: 'CERTIFICATE REQUEST',
    optional: true,
  },
];

function peekHead(path: string): string {
  return readFileSync(path, 'utf8').slice(0, 120);
}

function main(): void {
  console.log('=== check-certificates ===');
  let errors = 0;

  for (const file of FILES) {
    const name = file.path.replace(backendRoot, '.');
    if (!existsSync(file.path)) {
      console.log(`[${file.optional ? 'OPCIONAL AUSENTE' : 'AUSENTE'}] ${file.label}: ${name}`);
      if (!file.optional) errors += 1;
      continue;
    }

    const size = statSync(file.path).size;
    const empty = size === 0;
    const head = empty ? '' : peekHead(file.path);
    const looksLikeCsr =
      head.includes('CERTIFICATE REQUEST') && file.expect === 'CERTIFICATE';
    const looksOk = head.includes(file.expect) || (!head.includes('BEGIN') && size > 0);

    console.log(`[${empty ? 'VAZIO' : 'OK'}] ${file.label}`);
    console.log(`  arquivo: ${name}`);
    console.log(`  tamanho: ${size} bytes`);
    console.log(`  vazio: ${empty ? 'sim' : 'não'}`);

    if (looksLikeCsr) {
      console.log('  AVISO: este arquivo parece ser um CSR, não um certificado!');
      errors += 1;
    } else if (!empty && !looksOk && file.expect !== 'CERTIFICATE REQUEST') {
      console.log('  AVISO: cabeçalho PEM inesperado (não exibido por segurança)');
    }
  }

  console.log('---');
  if (errors > 0) {
    console.error(`Verificação com ${errors} problema(s).`);
    process.exit(1);
  }
  console.log('Verificação concluída.');
}

main();

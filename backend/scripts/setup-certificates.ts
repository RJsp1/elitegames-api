/**
 * Copia certificados reais de ../certificados-originais para backend/certificates.
 * NÃO imprime conteúdo dos arquivos.
 * NÃO cria arquivos falsos.
 *
 * Observação Windows: exploradores/downloads às vezes salvam como `arquivo.key.key`.
 * O script aceita o nome canônico e a variante com extensão duplicada.
 */
import { existsSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const backendRoot = resolve(__dirname, '..');
const sourceDir = resolve(backendRoot, '../certificados-originais');
const homologDir = resolve(backendRoot, 'certificates/homologacao');
const csrDir = resolve(backendRoot, 'certificates/csr');

interface CopyItem {
  /** Nomes possíveis na pasta de origem (primeiro encontrado vence). */
  fromCandidates: string[];
  to: string;
  required: boolean;
}

const COPIES: CopyItem[] = [
  {
    fromCandidates: ['api-pix-elitegames-api.key', 'api-pix-elitegames-api.key.key'],
    to: join(homologDir, 'api-pix-elitegames-api.key'),
    required: true,
  },
  {
    fromCandidates: ['63325362000172.cer', '63325362000172.cer.cer'],
    to: join(homologDir, '63325362000172.cer'),
    required: true,
  },
  {
    fromCandidates: ['CadeiaCompletaSicredi.cer', 'CadeiaCompletaSicredi.cer.cer'],
    to: join(homologDir, 'CadeiaCompletaSicredi.cer'),
    required: true,
  },
  {
    fromCandidates: ['webhook-sicredi.cer', 'webhook-sicredi.cer.cer'],
    to: join(homologDir, 'webhook-sicredi.cer'),
    required: false,
  },
  {
    fromCandidates: ['elitecross2026.csr', 'elitecross2026.csr.csr'],
    to: join(csrDir, 'elitecross2026.csr'),
    required: false,
  },
];

function resolveSource(candidates: string[]): { name: string; path: string } | null {
  for (const name of candidates) {
    const path = join(sourceDir, name);
    if (existsSync(path)) return { name, path };
  }
  return null;
}

function main(): void {
  console.log('=== setup-certificates ===');
  console.log(`Origem: ${sourceDir}`);

  if (!existsSync(sourceDir)) {
    console.error('Pasta certificados-originais não encontrada.');
    console.error(`Esperado em: ${sourceDir}`);
    process.exit(1);
  }

  mkdirSync(homologDir, { recursive: true });
  mkdirSync(csrDir, { recursive: true });
  mkdirSync(resolve(backendRoot, 'certificates/producao'), { recursive: true });

  let copied = 0;
  let skipped = 0;
  let missingRequired = 0;

  for (const item of COPIES) {
    const src = resolveSource(item.fromCandidates);
    if (!src) {
      const level = item.required ? 'AUSENTE (obrigatório)' : 'ausente (opcional)';
      console.warn(`[${level}] tentou: ${item.fromCandidates.join(' | ')}`);
      if (item.required) missingRequired += 1;
      continue;
    }

    const size = statSync(src.path).size;
    if (size === 0) {
      console.warn(`[VAZIO] ${src.name} — não copiado`);
      if (item.required) missingRequired += 1;
      continue;
    }

    if (existsSync(item.to)) {
      const destSize = statSync(item.to).size;
      console.log(
        `[SKIP] destino já existe (${destSize} bytes): ${item.to.replace(backendRoot, '.')}. Remova manualmente para sobrescrever.`,
      );
      skipped += 1;
      continue;
    }

    copyFileSync(src.path, item.to);
    const destName = item.to.split(/[/\\]/).pop();
    const renamedNote = src.name !== destName ? ` (origem: ${src.name})` : '';
    console.log(`[OK] → ${item.to.replace(backendRoot, '.')} (${size} bytes)${renamedNote}`);
    copied += 1;
  }

  const semSenha = resolveSource([
    'api-pix-elitegamessemsenha-api.key',
    'api-pix-elitegamessemsenha-api.key.key',
  ]);
  if (semSenha) {
    console.log(
      `[INFO] Também encontrado: ${semSenha.name} (${statSync(semSenha.path).size} bytes). Não copiado automaticamente.`,
    );
  }

  console.log('---');
  console.log(
    `Copiados: ${copied} | Já existiam: ${skipped} | Obrigatórios ausentes: ${missingRequired}`,
  );

  if (missingRequired > 0) {
    process.exit(1);
  }
}

main();

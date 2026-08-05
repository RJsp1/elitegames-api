# ELITE GAMES API

Backend Node.js/TypeScript para a plataforma **ELITE CROSS**: inscrição, cobrança Pix (Sicredi), QR Code, webhooks, conciliação e confirmação de pagamento.

## Stack

- Node.js LTS (ES Modules)
- TypeScript + Express
- Axios + HTTPS Agent (mTLS)
- Zod, Helmet, CORS, express-rate-limit
- Supabase JS
- QRCode, UUID
- Vitest + Supertest

## Início rápido (modo mock)

```bash
cd backend
npm install
cp .env.example .env   # se ainda não existir
npm run cert:setup
npm run cert:check
npm run typecheck
npm test
npm run build
npm run dev
```

Health check:

```bash
curl http://localhost:3001/health
```

Com `PAYMENT_PROVIDER=mock` o servidor sobe **sem** client_id, client_secret ou Supabase.

## Endpoints

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/health` | Health check |
| POST | `/api/v1/payments` | Criar cobrança Pix |
| GET | `/api/v1/payments/:paymentId` | Consultar pagamento |
| POST | `/api/v1/payments/:paymentId/refresh` | Atualizar status no provedor |
| POST | `/api/v1/payments/:paymentId/reconcile` | Conciliar |
| POST | `/api/v1/payments/:paymentId/refund` | Estornar |
| POST | `/api/v1/webhooks/sicredi/pix` | Webhook Sicredi |
| GET | `/api/v1/admin/payments` | Listar pagamentos |
| GET | `/api/v1/admin/payment-events` | Listar eventos |
| POST | `/api/v1/admin/payment-events/:id/reprocess` | Reprocessar evento |
| POST | `/api/v1/dev/payments/:paymentId/simulate-paid` | Simular pagamento (dev/mock) |

Autenticação interna: header `X-API-Key` com `INTERNAL_API_KEY` (opcional em development).

## Criar pagamento (exemplo)

```bash
curl -X POST http://localhost:3001/api/v1/payments \
  -H "Content-Type: application/json" \
  -d '{
    "registrationId": "11111111-1111-1111-1111-111111111111",
    "registrationNumber": "INS-001",
    "registrationType": "individual",
    "categoryName": "Open Masculino",
    "debtorName": "Atleta Exemplo",
    "debtorCpf": "52998224725"
  }'
```

O valor é calculado no servidor (R$ 199,90 individual / R$ 399,80 dupla). Valores divergentes enviados pelo frontend são rejeitados.

## Certificados

Arquivos reais ficam em `../certificados-originais/` e são copiados para `certificates/homologacao/` via:

```bash
npm run cert:setup
npm run cert:check
```

**Nunca** versionar `.key`, `.cer`, `.csr` ou `.env`.

## Homologação Sicredi

Ver [docs/HOMOLOGACAO.md](docs/HOMOLOGACAO.md) e [docs/SICREDI_SETUP.md](docs/SICREDI_SETUP.md).

## Deploy VPS

Ver [docs/DEPLOY_VPS.md](docs/DEPLOY_VPS.md).

## Scripts

| Script | Função |
|--------|--------|
| `npm run cert:setup` | Copia certificados reais |
| `npm run cert:check` | Valida existência/tamanho |
| `npm run sicredi:mtls` | Valida mTLS (dry-run por padrão) |
| `npm run sicredi:token` | Obtém token (exige flags) |
| `npm run sicredi:charge` | Cobrança de teste (exige flags) |
| `npm run sicredi:webhook` | Registra webhook |

## Segurança

- Helmet, CORS, rate limit, body limit
- mTLS com `rejectUnauthorized: true`
- Logs estruturados com mascaramento de CPF, tokens, secrets e chave Pix
- Certificados e secrets fora do Git

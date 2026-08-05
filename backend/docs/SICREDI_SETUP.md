# Sicredi Pix — Setup ELITE GAMES

## Arquivos usados

| Arquivo | Função |
|---------|--------|
| `api-pix-elitegames-api.key` | Chave privada da aplicação (mTLS) |
| `63325362000172.cer` | Certificado da aplicação validado pelo Sicredi |
| `CadeiaCompletaSicredi.cer` | Cadeia de confiança (CA) |
| `webhook-sicredi.cer` | Certificado opcional para validar origem do webhook |
| `elitecross2026.csr` | CSR original (arquivo histórico; não usar como cert) |

Origem: `certificados-originais/`  
Destino runtime: `backend/certificates/homologacao/`

## mTLS

O cliente HTTP (`sicredi-http-client.ts`) usa `https.Agent` com:

- `cert` → `63325362000172.cer`
- `key` → `api-pix-elitegames-api.key`
- `ca` → `CadeiaCompletaSicredi.cer`
- `rejectUnauthorized: true`
- `keepAlive: true`

Nunca desabilitar a verificação TLS.

## OAuth 2.0 Client Credentials

```
POST /oauth/token?grant_type=client_credentials
Authorization: Basic base64(client_id:client_secret)
```

- mTLS obrigatório
- Token cacheado (~300s), renovado com margem de segurança
- Concorrência controlada (uma fetch por vez)
- Access token nunca logado completo

## Cobrança imediata

```
PUT /api/v3/cob/{txid}
```

- `txid` alfanumérico com 26 caracteres
- Valor calculado no backend
- `chave` = `SICREDI_PIX_KEY`
- Retorno inclui `pixCopiaECola` → QR Code data URL

## Webhook

Endpoint local:

```
POST /api/v1/webhooks/sicredi/pix
```

Fluxo:

1. Recebe array `pix`
2. Localiza cobrança por `txid`
3. Valida valor e `endToEndId`
4. Idempotência por `endToEndId`
5. Atualiza pagamento + inscrição
6. Persiste evento bruto + auditoria
7. Responde HTTP 200

Validação com `webhook-sicredi.cer` está preparada e opcional nesta etapa.

## Conciliação

- `POST /api/v1/payments/:paymentId/reconcile`
- Job periódico (modo Sicredi) consulta cobranças pendentes
- Registra em `payment_reconciliations` quando Supabase estiver ativo

## Variáveis necessárias (modo sicredi)

- `SICREDI_CLIENT_ID`
- `SICREDI_CLIENT_SECRET`
- `SICREDI_PIX_KEY`
- caminhos dos certificados mTLS
- `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`

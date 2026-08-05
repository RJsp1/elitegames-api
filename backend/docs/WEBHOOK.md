# Webhook Pix Sicredi

## Endpoint

```
POST /api/v1/webhooks/sicredi/pix
```

Payload esperado (resumo Bacen/Sicredi):

```json
{
  "pix": [
    {
      "endToEndId": "E...",
      "txid": "EG....................",
      "valor": "199.90",
      "horario": "2026-07-29T12:00:00.000Z"
    }
  ]
}
```

## Garantias

- Idempotência por `endToEndId`
- Validação de valor contra o pagamento local
- Atualização de status para `PAID`
- Confirmação da inscrição (`registration_reservations`)
- Persistência do evento em `payment_events`
- Auditoria em `audit_logs`
- Resposta HTTP 200 mesmo com itens ignorados (detalhes no body)

## Segurança

- Rate limit dedicado
- Middleware `webhook-security` preparado para `webhook-sicredi.cer`
- Em VPS, preferir terminação TLS no Nginx e restrição de origem

## URL pública sugerida

```
https://api.elitegames.com.br/api/v1/webhooks/sicredi/pix
```

# API pública de inscrição — Elite Games

Contrato estável para o frontend TanStack Start / Lovable via `createServerFn` (Nitro).

Base: `/api/v1/public`  
Auth inscrição: `Authorization: Bearer <registrationAccessToken>`  
Auth usuário (opcional): JWT Supabase no mesmo header (rotas que usam middleware opcional).  
**Nunca** enviar token por query string.  
**Nunca** expor `INTERNAL_API_KEY` ou `SERVICE_ROLE` no browser.

## Token temporário

- Formato: opaco hex 64 chars (`randomBytes(32)`).
- Persistência: apenas `SHA-256(token)` em `registration_access_tokens`.
- TTL padrão: 7 dias.
- Escopo: somente a inscrição associada (pagamento, status, reemissão, comprovante).

---

## GET `/api/v1/public/events/:slug`

Retorna evento **publicado**.

**200**
```json
{
  "id": "…",
  "slug": "elite-games-2026",
  "name": "Elite Games 2026",
  "description": "…",
  "startDate": "2026-10-01T12:00:00.000Z",
  "endDate": "2026-10-03T22:00:00.000Z",
  "location": "São Paulo",
  "registrationStart": "2026-08-01T00:00:00.000Z",
  "registrationEnd": "2026-09-30T23:59:59.000Z",
  "status": "published",
  "regulationUrl": "https://…",
  "bannerUrl": "https://…"
}
```

**404** `EVENT_NOT_FOUND` — não publicado / inexistente.

---

## GET `/api/v1/public/events/:slug/categories`

**200**
```json
{
  "categories": [
    {
      "categoryId": "…",
      "name": "Open Misto",
      "description": null,
      "format": "dupla",
      "gender": "misto",
      "ageRange": "18-40",
      "capacity": 100,
      "occupiedSlots": 10,
      "availableSlots": 90,
      "currentPrice": "199.90",
      "priceBatchId": null,
      "registrationOpen": true,
      "soldOut": false
    }
  ]
}
```

Preço calculado/lido no backend (`currentPrice`).

---

## POST `/api/v1/public/registrations`

Headers: `Content-Type: application/json`, opcional `X-Request-Id` (idempotência).

Body (não enviar preço):
```json
{
  "eventId": "…",
  "categoryId": "…",
  "athletes": [{ "fullName": "Maria Silva", "cpf": "52998224725" }],
  "responsible": { "fullName": "João", "phone": "11999999999" },
  "teamName": "Time A",
  "emergencyContact": { "name": "Ana", "phone": "11988887777" },
  "medicalNotes": null,
  "termsAccepted": true,
  "privacyAccepted": true,
  "requestId": "optional-client-key"
}
```

**201**
```json
{
  "registrationId": "…",
  "registrationNumber": "INS-…",
  "status": "draft",
  "amount": "199.90",
  "paymentRequired": true,
  "accessToken": "<opaco>"
}
```

Erros: `EVENT_NOT_FOUND`, `REGISTRATION_CLOSED`, `CATEGORY_NOT_FOUND`, `CATEGORY_SOLD_OUT`, `INVALID_ATHLETE_COUNT`, `INVALID_CPF`, `400` CPF duplicado.

---

## POST `/api/v1/public/registrations/:registrationId/payment`

Headers: `Authorization: Bearer <accessToken>`

**201** — payload sanitizado com `pixCopiaECola` e `qrCodeDataUrl` (não logados integralmente).

---

## GET `/api/v1/public/payments/:paymentId/status`

Headers: Bearer access token da inscrição do pagamento.

**200**
```json
{
  "paymentId": "…",
  "registrationId": "…",
  "status": "active",
  "amount": "199.90",
  "expiresAt": "…",
  "paidAt": null,
  "canReissue": false,
  "registrationStatus": "pending_payment",
  "txidMasked": "EGAB…WXYZ",
  "endToEndIdMasked": null
}
```

---

## POST `/api/v1/public/payments/:paymentId/reissue`

Headers: Bearer access token. Rate limit de escrita.

Reutiliza `paymentService.reissuePixPayment`. Bloqueia se `paid`.

---

## GET `/api/v1/public/registrations/:registrationId/receipt`

Somente inscrição `paid`/`confirmed`. Atletas com CPF mascarado. `confirmationCodeMasked` a partir do E2E.

---

## Códigos HTTP comuns

| Código | Situação |
|--------|----------|
| 400 | Validação / período / regras de negócio |
| 401 | Token ausente/inválido |
| 403 | Token de outra inscrição / query token |
| 404 | Evento/categoria/pagamento inexistente |
| 409 | Categoria esgotada / conflito |
| 429 | Rate limit |

---

## Segurança

- CORS: `FRONTEND_URL` + `APP_BASE_URL` em produção.
- Rate limits: `publicRateLimit` / `publicWriteRateLimit`.
- Valores sempre calculados no servidor.
- Idempotência por `requestId` / `X-Request-Id`.

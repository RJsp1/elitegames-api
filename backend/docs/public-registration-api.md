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
      "slug": "iniciante-masculino",
      "name": "Iniciante Masculino",
      "shortDescription": null,
      "description": null,
      "format": "dupla",
      "teamSize": 2,
      "gender": "masculino",
      "ageRange": "18-40",
      "capacity": 100,
      "occupiedSlots": 10,
      "availableSlots": 90,
      "currentPrice": "399.80",
      "priceBatchId": "…",
      "registrationOpen": true,
      "soldOut": false,
      "notes": null,
      "videoUrls": []
    }
  ]
}
```

Preço calculado/lido no backend (`currentPrice`).  
`videoUrls` nunca é `null` (array vazio quando ausente).  
`slug` habilita navegação do frontend em `/categorias/:slug`.

---

## GET `/api/v1/public/events/:eventSlug/categories/:categorySlug`

Detalhe público da categoria (mesmo DTO de um item da lista).

Regras:
- evento público e dentro da janela de inscrição;
- categoria do evento, ativa (`is_active`) e `deleted_at` null;
- preço, lote e ocupação reutilizam a mesma regra da listagem.

**200** — objeto da categoria (não envelopado em `{ categories }`).

**404**
- `EVENT_NOT_FOUND` — evento inexistente / não público / fora da janela;
- `CATEGORY_NOT_FOUND` — slug inexistente no evento, inativa, deletada ou de outro evento.

---

## POST `/api/v1/public/registrations`

Headers: `Content-Type: application/json`, opcional `X-Request-Id` / `Idempotency-Key`.

Body (não enviar preço — `amount`/`totalPrice`/`price` são **ignorados**):

```json
{
  "eventId": "…",
  "categoryId": "…",
  "athletes": [
    {
      "fullName": "Maria Silva",
      "cpf": "52998224725",
      "email": "maria@example.com",
      "phone": "11999999999",
      "birthDate": "1995-05-10",
      "gender": "feminino",
      "shirtSize": "M",
      "emergencyName": "Ana",
      "emergencyPhone": "11988887777",
      "medicalNotes": null,
      "role": "athlete_a"
    }
  ],
  "responsible": {
    "isAthlete1": true,
    "fullName": "Maria Silva",
    "cpf": "52998224725",
    "email": "maria@example.com",
    "phone": "11999999999"
  },
  "teamName": "Time A",
  "waiver": {
    "regulationAccepted": true,
    "privacyAccepted": true,
    "imageUseAccepted": true,
    "fitnessAccepted": true,
    "signatureDataUrl": "data:image/png;base64,…"
  },
  "termsAccepted": true,
  "privacyAccepted": true,
  "requestId": "optional-client-key"
}
```

Compatibilidade legado: `termsAccepted`/`privacyAccepted` no topo; `responsible` sem `isAthlete1`; `athletes` só com `fullName`+`cpf`.

Quantidade de atletas: **sempre** a da categoria no banco (`individual=1`, `dupla=2`, `equipe=team_size`). `categoryFormat`/`teamSize` do cliente são ignorados.

**201**
```json
{
  "registrationId": "…",
  "registrationNumber": "INS-…",
  "status": "draft",
  "amount": "199.90",
  "paymentRequired": true,
  "registrationAccessToken": "<opaco>"
}
```

Erros: `EVENT_NOT_FOUND`, `REGISTRATION_CLOSED`, `CATEGORY_NOT_FOUND`, `CATEGORY_SOLD_OUT`, `INVALID_ATHLETE_COUNT`, `INVALID_CPF`, `400` CPF duplicado / responsável mismatch / assinatura inválida.

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

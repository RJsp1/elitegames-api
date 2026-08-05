# Homologação Sicredi — checklist

1. Executar `npm run cert:setup`
2. Executar `npm run cert:check`
3. Gerar credenciais da API Pix no Internet Banking Sicredi (homologação)
4. Preencher `SICREDI_CLIENT_ID` no `.env`
5. Preencher `SICREDI_CLIENT_SECRET` no `.env`
6. Preencher `SICREDI_PIX_KEY` no `.env`
7. Alterar `PAYMENT_PROVIDER=sicredi`
8. Configurar `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` e aplicar `database/migrations/001_pix_payments.sql`
9. Executar teste mTLS:
   ```bash
   ALLOW_REAL_SICREDI_TEST=true npm run sicredi:mtls
   ```
10. Obter token:
    ```bash
    ALLOW_REAL_SICREDI_TEST=true npm run sicredi:token
    ```
11. Gerar cobrança de teste (valor baixo em homologação):
    ```bash
    ALLOW_REAL_SICREDI_CHARGE=true npm run sicredi:charge
    ```
12. Solicitar liquidação da cobrança via chamado Sicredi (homologação)
13. Consultar o `txid` via `GET /api/v1/payments/:paymentId` ou refresh
14. Cadastrar webhook público:
    ```bash
    # configurar SICREDI_WEBHOOK_URL=https://api.elitegames.com.br/api/v1/webhooks/sicredi/pix
    ALLOW_REAL_SICREDI_TEST=true npm run sicredi:webhook
    ```

## Observações

- Não rode cobrança real automaticamente em CI
- Não use `rejectUnauthorized=false`
- Não versionar certificados ou secrets
- Em desenvolvimento local, mantenha `PAYMENT_PROVIDER=mock`

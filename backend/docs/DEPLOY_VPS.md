# Deploy VPS — api.elitegames.com.br

## Requisitos

- Ubuntu 22.04+
- Node.js 22 LTS
- PM2
- Nginx
- Certificado HTTPS (Let's Encrypt)
- Pasta de certificados com permissões restritas (`chmod 600` nas keys)

## Passos

1. Clonar o repositório (sem `certificados-originais` no Git)
2. Copiar certificados para o servidor via canal seguro (SCP/SFTP)
3. `cd backend && npm ci && npm run build`
4. Criar `.env` de produção (`PAYMENT_PROVIDER=sicredi`, secrets, Supabase)
5. Iniciar com PM2:
   ```bash
   pm2 start dist/server.js --name elite-games-api
   pm2 save
   ```
6. Nginx (proxy reverso):

```nginx
server {
  listen 443 ssl http2;
  server_name api.elitegames.com.br;

  ssl_certificate     /etc/letsencrypt/live/api.elitegames.com.br/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/api.elitegames.com.br/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:3001;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Request-Id $request_id;
  }
}
```

7. Liberar apenas portas 80/443 no firewall
8. Proteger `certificates/` (dono root/app, sem leitura mundial)
9. Configurar `SICREDI_WEBHOOK_URL` apontando para o domínio público
10. Registrar webhook (`npm run sicredi:webhook` com flags)

## Observabilidade

- Health API: `GET /health`
- Health do worker de polling: `GET /health/reconciliation`
  - lê heartbeat em `runtime/reconciliation-health.json` (escrito pelo processo PM2 `elitegames-reconciliation`)
  - sem tokens/CPF/chave Pix/certificados
- Logs estruturados JSON (correlationId = `payment.id`)

## Rotação de logs PM2 (manual)

Não instalar automaticamente. Em produção:

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 20M
pm2 set pm2-logrotate:retain 14
pm2 set pm2-logrotate:compress true
pm2 set pm2-logrotate:workerInterval 60
```

Confirme com `pm2 conf pm2-logrotate`.

## Variáveis críticas

- `SICREDI_CLIENT_ID` / `SICREDI_CLIENT_SECRET` / `SICREDI_PIX_KEY`
- caminhos mTLS
- `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`
- `INTERNAL_API_KEY`
- `FRONTEND_URL`

## Docker (opcional)

```bash
docker compose up -d --build
```

Certificados devem ser montados como volume — nunca embutidos na imagem.

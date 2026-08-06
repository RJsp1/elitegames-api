(() => {
  const KEY = 'elitegames_admin_api_key';
  const state = {
    page: 1,
    pageSize: 20,
    selectedPaymentId: null,
    filters: {},
  };

  const $ = (id) => document.getElementById(id);

  function getApiKey() {
    return sessionStorage.getItem(KEY) || $('apiKey').value.trim();
  }

  function saveApiKey() {
    const value = $('apiKey').value.trim();
    if (!value) {
      alert('Informe a INTERNAL_API_KEY');
      return;
    }
    sessionStorage.setItem(KEY, value);
    refreshAll();
  }

  async function api(path, options = {}) {
    const apiKey = getApiKey();
    if (!apiKey) throw new Error('API Key não configurada');
    const res = await fetch(path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
        ...(options.headers || {}),
      },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = body?.error?.message || body?.message || `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return body;
  }

  function money(v) {
    return `R$ ${Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
  }

  function statusBadge(status) {
    return `<span class="badge ${status}">${status}</span>`;
  }

  function renderSummary(summary, health) {
    const cards = [
      ['Total', summary.totalPayments],
      ['Ativos', summary.activePayments],
      ['Pagos', summary.paidPayments],
      ['Expirados', summary.expiredPayments],
      ['Recebido hoje', money(summary.amountReceivedToday)],
      ['Pendente', money(summary.amountPending)],
      ['Criados hoje', summary.paymentsCreatedToday],
      ['Pagos hoje', summary.paymentsPaidToday],
    ];
    $('summaryCards').innerHTML = cards
      .map(
        ([label, value]) =>
          `<article class="card"><div class="label">${label}</div><div class="value">${value}</div></article>`,
      )
      .join('');

    const badge = $('workerBadge');
    badge.textContent = health.status;
    badge.className = `badge ${health.status}`;
    $('workerMeta').textContent =
      `Último sucesso: ${health.lastSuccessfulCycleAt || '—'} · ` +
      `duração: ${health.lastCycleDurationMs ?? '—'} ms · ` +
      `erros: ${health.lastCycleErrors} · falhas seguidas: ${health.consecutiveFailures}`;
  }

  function drawBars(canvas, labels, values, color) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width = canvas.clientWidth * devicePixelRatio;
    const h = canvas.height = canvas.clientHeight * devicePixelRatio;
    ctx.clearRect(0, 0, w, h);
    if (!values.length) {
      ctx.fillStyle = '#5b6777';
      ctx.font = `${12 * devicePixelRatio}px sans-serif`;
      ctx.fillText('Sem dados', 12 * devicePixelRatio, 24 * devicePixelRatio);
      return;
    }
    const max = Math.max(...values, 1);
    const gap = 8 * devicePixelRatio;
    const barW = (w - gap * (values.length + 1)) / values.length;
    values.forEach((v, i) => {
      const barH = (v / max) * (h - 30 * devicePixelRatio);
      const x = gap + i * (barW + gap);
      const y = h - barH - 16 * devicePixelRatio;
      ctx.fillStyle = color;
      ctx.fillRect(x, y, barW, barH);
      ctx.fillStyle = '#5b6777';
      ctx.font = `${10 * devicePixelRatio}px sans-serif`;
      ctx.fillText(String(labels[i]).slice(-5), x, h - 4 * devicePixelRatio);
    });
  }

  function renderCharts(metrics, summary) {
    const series = metrics.series || [];
    drawBars(
      $('chartByDay'),
      series.map((s) => s.period),
      series.map((s) => s.createdCount),
      '#0b6e4f',
    );
    drawBars(
      $('chartByStatus'),
      ['ativos', 'pagos', 'expirados', 'cancelados', 'falhos'],
      [
        summary.activePayments,
        summary.paidPayments,
        summary.expiredPayments,
        summary.cancelledPayments,
        summary.failedPayments,
      ],
      '#175cd3',
    );
  }

  async function loadList() {
    $('listState').textContent = 'Carregando…';
    const params = new URLSearchParams({
      page: String(state.page),
      pageSize: String(state.pageSize),
      sort: 'createdAt',
      order: 'desc',
      ...Object.fromEntries(
        Object.entries(state.filters).filter(([, v]) => v != null && v !== ''),
      ),
    });
    const data = await api(`/api/v1/admin/payments?${params}`);
    const rows = data.payments || [];
    if (!rows.length) {
      $('listState').textContent = 'Nenhum pagamento encontrado.';
      $('paymentsBody').innerHTML = '';
    } else {
      $('listState').textContent = `${data.total} resultado(s)`;
      $('paymentsBody').innerHTML = rows
        .map(
          (p) => `<tr>
            <td>${new Date(p.createdAt).toLocaleString('pt-BR')}</td>
            <td>${statusBadge(p.status)}</td>
            <td>${money(p.amount)}</td>
            <td>${p.registrationNumber || p.registrationId || '—'}</td>
            <td>${p.athleteName || '—'}</td>
            <td>${p.txidMasked || '—'}</td>
            <td><button type="button" data-open="${p.paymentId}">Detalhe</button></td>
          </tr>`,
        )
        .join('');
    }
    $('pageInfo').textContent = `Página ${data.page} · ${data.total} itens`;
    $('btnPrev').disabled = data.page <= 1;
    $('btnNext').disabled = data.page * data.pageSize >= data.total;
  }

  async function openDetail(paymentId) {
    state.selectedPaymentId = paymentId;
    const detail = await api(`/api/v1/admin/payments/${paymentId}`);
    const p = detail.payment;
    $('detailBody').innerHTML = `
      <div><strong>ID:</strong> ${p.paymentId}</div>
      <div><strong>Status:</strong> ${statusBadge(p.status)}</div>
      <div><strong>Valor:</strong> ${money(p.amount)}</div>
      <div><strong>Txid:</strong> ${p.txidMasked || '—'}</div>
      <div><strong>E2E:</strong> ${p.endToEndIdMasked || '—'}</div>
      <div><strong>Criado:</strong> ${new Date(p.createdAt).toLocaleString('pt-BR')}</div>
      <div><strong>Pago em:</strong> ${p.paidAt ? new Date(p.paidAt).toLocaleString('pt-BR') : '—'}</div>
      <div><strong>Tempo até pagamento:</strong> ${p.paymentTimeSeconds ?? '—'} s</div>
      <div><strong>Inscrição:</strong> ${detail.registration?.registrationNumber || '—'}</div>
      <div><strong>Atleta:</strong> ${detail.athlete?.fullName || '—'} (${detail.athlete?.cpfMasked || '***'})</div>
      <div><strong>Origem confirmação:</strong> ${detail.confirmationOrigin || '—'}</div>
      <div><strong>Charges:</strong> ${(detail.chargeHistory || []).length}</div>
      <div><strong>Auditoria recente:</strong> ${(detail.auditLogs || []).length} eventos</div>
    `;
    $('detailModal').showModal();
  }

  async function runAction(action) {
    const paymentId = state.selectedPaymentId;
    if (!paymentId) return;
    const destructive = action === 'expire' || action === 'cancel';
    if (destructive && !confirm(`Confirmar ação "${action}" neste pagamento?`)) return;

    const body =
      destructive
        ? { confirm: true, reason: 'admin_panel' }
        : { reason: 'admin_panel' };

    $('listState').textContent = `Executando ${action}…`;
    await api(`/api/v1/admin/payments/${paymentId}/${action}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    await refreshAll();
    await openDetail(paymentId);
  }

  async function refreshAll() {
    try {
      const [dashboard, metrics] = await Promise.all([
        api('/api/v1/admin/payments/dashboard'),
        api('/api/v1/admin/payments/metrics?groupBy=day'),
      ]);
      renderSummary(dashboard.summary, dashboard.reconciliationHealth);
      renderCharts(metrics, dashboard.summary);
      await loadList();
    } catch (err) {
      $('listState').textContent = `Erro: ${err.message}`;
      $('summaryCards').innerHTML = '';
    }
  }

  function bind() {
    $('apiKey').value = sessionStorage.getItem(KEY) || '';
    $('btnSaveKey').addEventListener('click', saveApiKey);
    $('btnRefresh').addEventListener('click', refreshAll);
    $('btnPrev').addEventListener('click', () => {
      state.page = Math.max(1, state.page - 1);
      loadList().catch((e) => {
        $('listState').textContent = e.message;
      });
    });
    $('btnNext').addEventListener('click', () => {
      state.page += 1;
      loadList().catch((e) => {
        $('listState').textContent = e.message;
      });
    });
    $('filters').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const fd = new FormData(ev.target);
      state.filters = {
        status: fd.get('status') || undefined,
        txid: fd.get('txid') || undefined,
        registrationId: fd.get('registrationId') || undefined,
        dateFrom: fd.get('dateFrom') ? `${fd.get('dateFrom')}T00:00:00.000Z` : undefined,
        dateTo: fd.get('dateTo') ? `${fd.get('dateTo')}T23:59:59.999Z` : undefined,
      };
      state.pageSize = Number(fd.get('pageSize') || 20);
      state.page = 1;
      loadList().catch((e) => {
        $('listState').textContent = e.message;
      });
    });
    $('paymentsBody').addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-open]');
      if (!btn) return;
      openDetail(btn.getAttribute('data-open')).catch((e) => alert(e.message));
    });
    document.querySelectorAll('#detailModal [data-action]').forEach((btn) => {
      btn.addEventListener('click', () => {
        runAction(btn.getAttribute('data-action')).catch((e) => alert(e.message));
      });
    });
  }

  bind();
  if (getApiKey()) refreshAll();
  else $('listState').textContent = 'Informe a API Key para carregar o painel.';
})();

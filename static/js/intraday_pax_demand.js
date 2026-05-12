/* Intraday PAX Demand - tactical pulse module */

let IDPAX_DATA = null;
let IDPAX_CHART = null;
let IDPAX_SIM_ACTIVE = false;

const IDPAX_SERIES = [
  { key: 'checkin', label: 'Check-in', color: '#0ea5e9', axis: 'y' },
  { key: 'security', label: 'Security', color: '#8b5cf6', axis: 'y' },
  { key: 'cbp', label: 'CBP', color: '#ef4444', axis: 'y' },
  { key: 'lounge', label: 'Lounge', color: '#f59e0b', axis: 'y1', dash: [5, 5] },
  { key: 'boarding', label: 'Boarding', color: '#ec4899', axis: 'y' },
  { key: 'immigration', label: 'Immigration', color: '#10b981', axis: 'y' },
  { key: 'baggage', label: 'Baggage', color: '#3b82f6', axis: 'y' },
];

function idpaxEsc(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function idpaxAccent(name) {
  return {
    teal: '#0ea5e9',
    purple: '#8b5cf6',
    crit: '#ef4444',
    warn: '#f59e0b',
    info: '#3b82f6',
    ok: '#10b981',
  }[name] || '#3b82f6';
}

function idpaxFmt(value) {
  return Number(value || 0).toLocaleString();
}

function idpaxSetText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function idpaxPopulateFlights(payload) {
  const select = document.getElementById('idpax-flight-select');
  if (!select) return;
  select.innerHTML = (payload.flights || []).map(f => {
    const time = f.etd || f.eta || '--';
    const label = `${f.flight_no} · ${f.type} · ${time} · ${f.terminal || ''}`;
    return `<option value="${idpaxEsc(f.flight_no)}">${idpaxEsc(label)}</option>`;
  }).join('');
}

function idpaxRenderTable(payload) {
  const tbody = document.getElementById('idpax-table-body');
  if (!tbody) return;
  const rows = payload.table?.rows || [];
  tbody.innerHTML = rows.map(row => `
    <tr>
      <td>${idpaxEsc(row.time)}</td>
      <td>${idpaxFmt(row.checkin)}</td>
      <td>${idpaxFmt(row.security)}</td>
      <td>${idpaxFmt(row.cbp)}</td>
      <td>${idpaxFmt(row.lounge)}</td>
      <td>${idpaxFmt(row.boarding)}</td>
      <td>${idpaxFmt(row.immigration)}</td>
      <td>${idpaxFmt(row.baggage)}</td>
    </tr>
  `).join('');
}

function idpaxRenderInsights(payload) {
  const grid = document.getElementById('idpax-insight-grid');
  if (!grid) return;
  grid.innerHTML = (payload.insights || []).map(item => {
    const accent = idpaxAccent(item.accent);
    return `
      <article class="idpax-insight-card" style="--idpax-accent:${accent}">
        <div class="idpax-card-name">${idpaxEsc(item.label)}</div>
        <div class="idpax-card-value">${idpaxFmt(item.peak)}</div>
        <div class="idpax-card-sub">${idpaxEsc(item.metric_label || 'Peak Pax / min')}</div>
        <div class="idpax-card-row">
          <span>Peak Window</span>
          <strong>${idpaxEsc(item.peak_time || '--')}</strong>
        </div>
        <div class="idpax-card-row">
          <span>${idpaxEsc(item.secondary_label || '')}</span>
          <strong>${idpaxEsc(item.secondary_value || '--')}</strong>
        </div>
      </article>
    `;
  }).join('');
}

function idpaxBuildDatasets(series, simulatedSeries = null) {
  const src = simulatedSeries || series;
  return IDPAX_SERIES.map(item => ({
    label: simulatedSeries ? `${item.label} (Sim)` : item.label,
    data: src[item.key] || [],
    borderColor: item.color,
    backgroundColor: `${item.color}${simulatedSeries ? '2c' : '22'}`,
    fill: true,
    tension: 0.32,
    borderWidth: simulatedSeries ? 2.4 : 2,
    pointRadius: 0,
    hitRadius: 8,
    hoverRadius: 3,
    yAxisID: item.axis,
    borderDash: item.dash || [],
  }));
}

function idpaxShiftSeries(series, delayMins) {
  const shift = Math.max(0, Math.round(Number(delayMins || 0)));
  const shifted = { labels: series.labels };
  IDPAX_SERIES.forEach(item => {
    const arr = series[item.key] || [];
    if (item.key === 'lounge' || item.key === 'boarding') {
      shifted[item.key] = arr.map((_, idx) => idx >= shift ? arr[idx - shift] : 0);
    } else {
      shifted[item.key] = arr.slice();
    }
  });
  return shifted;
}

function idpaxRenderChart(payload, simulatedSeries = null) {
  const canvas = document.getElementById('idpax-pulse-chart');
  if (!canvas || !window.Chart) return;

  if (IDPAX_CHART) {
    IDPAX_CHART.destroy();
    IDPAX_CHART = null;
  }

  const series = payload.series || {};
  const labels = series.labels || [];
  IDPAX_CHART = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: idpaxBuildDatasets(series, simulatedSeries),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'top',
          labels: { usePointStyle: true, pointStyle: 'rectRounded', boxWidth: 13, boxHeight: 6, padding: 16 },
        },
        tooltip: {
          mode: 'index',
          intersect: false,
          callbacks: {
            title: items => labels[items[0]?.dataIndex || 0] || '',
            label: ctx => `${ctx.dataset.label}: ${Math.round(ctx.parsed.y || 0).toLocaleString()}`,
          },
        },
      },
      scales: {
        x: {
          grid: { color: 'rgba(148, 163, 184, 0.11)' },
          ticks: {
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 13,
          },
        },
        y: {
          min: 0,
          title: { display: true, text: 'Pax / min' },
          grid: { color: 'rgba(148, 163, 184, 0.16)' },
        },
        y1: {
          min: 0,
          position: 'right',
          title: { display: true, text: 'Lounge Concurrent' },
          grid: { drawOnChartArea: false },
        },
      },
    },
  });
}

function idpaxAttachActions() {
  const run = document.getElementById('idpax-run-sim');
  const clear = document.getElementById('idpax-clear-sim');
  if (run && !run.dataset.bound) {
    run.dataset.bound = '1';
    run.addEventListener('click', () => {
      if (!IDPAX_DATA) return;
      const mins = document.getElementById('idpax-delay-mins')?.value || 30;
      IDPAX_SIM_ACTIVE = true;
      idpaxRenderChart(IDPAX_DATA, idpaxShiftSeries(IDPAX_DATA.series, mins));
      run.textContent = 'Simulation Applied';
    });
  }
  if (clear && !clear.dataset.bound) {
    clear.dataset.bound = '1';
    clear.addEventListener('click', () => {
      if (!IDPAX_DATA) return;
      IDPAX_SIM_ACTIVE = false;
      idpaxRenderChart(IDPAX_DATA);
      if (run) run.textContent = 'Run Simulation';
    });
  }
}

function idpaxRender(payload) {
  idpaxSetText('idpax-title', payload.summary?.title || 'Intra-Day Tactical Pulse');
  idpaxSetText('idpax-subtitle', payload.summary?.subtitle || '');
  idpaxPopulateFlights(payload);
  idpaxRenderChart(payload, IDPAX_SIM_ACTIVE ? idpaxShiftSeries(payload.series, document.getElementById('idpax-delay-mins')?.value || 30) : null);
  idpaxRenderTable(payload);
  idpaxRenderInsights(payload);
  idpaxAttachActions();
}

async function initIntradayPaxDemand(options = {}) {
  const panel = document.querySelector('.idpax-module');
  if (!panel) return;

  try {
    if (!IDPAX_DATA || options.force) {
      const res = await fetch('/api/intraday/pax-demand/tactical-pulse');
      if (!res.ok) throw new Error(`Intraday PAX API failed: ${res.status}`);
      IDPAX_DATA = await res.json();
    }
    idpaxRender(IDPAX_DATA);
  } catch (err) {
    panel.innerHTML = '<div class="empty-state">Unable to load Intraday PAX Demand pulse.</div>';
    console.error(err);
  }
}

window.initIntradayPaxDemand = initIntradayPaxDemand;

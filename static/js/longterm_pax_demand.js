/* Long Term PAX Demand - Strategic Forecast module */

let LTPAX_DATA = null;
let LTPAX_CHART = null;

const LTPAX_MODELS = [
  { key: 'lstm', label: 'LSTM Deep Learning', note: 'Sequence memory - recency-weighted', color: '#3b82f6' },
  { key: 'monte_carlo', label: 'Monte Carlo Simulation', note: 'N=1,000 paths - P50 median', color: '#14b8a6' },
  { key: 'sarima', label: 'SARIMA (52-week)', note: 'Seasonal ARIMA - statistical', color: '#f59e0b' },
  { key: 'prophet', label: 'Prophet Decomposition', note: 'Trend + Seasonality + Holiday', color: '#10b981' },
  { key: 'ensemble', label: 'Ensemble (Weighted Avg)', note: 'Official 2026 central forecast', color: '#3b82f6' },
];

function ltpaxMetricColor(name) {
  if (window.DAA && DAA[name]) return DAA[name];
  return {
    accent: '#f97316',
    info: '#3b82f6',
    teal: '#0ea5e9',
    ok: '#10b981',
    warn: '#f59e0b',
    crit: '#ef4444',
  }[name] || '#3b82f6';
}

function ltpaxSetText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function ltpaxMillions(value) {
  const num = Number(value || 0);
  return `${(num / 1000000).toFixed(2)}M`;
}

function ltpaxPercent(value) {
  const num = Number(value || 0);
  return `${num.toFixed(1)}%`;
}

function ltpaxDelta(value) {
  if (value == null || Number.isNaN(Number(value))) return 'vs 2025 unavailable';
  const num = Number(value);
  const sign = num >= 0 ? '+' : '';
  return `${sign}${num.toFixed(1)}% vs 2025`;
}

function ltpaxAxis(value) {
  const num = Number(value || 0);
  if (Math.abs(num) >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
  return `${Math.round(num / 1000)}K`;
}

function ltpaxRenderKpis(data) {
  const k = data.kpis || {};
  ltpaxSetText('ltpax-kpi-p50', ltpaxMillions(k.p50_total));
  ltpaxSetText('ltpax-kpi-p10', ltpaxMillions(k.p10_total));
  ltpaxSetText('ltpax-kpi-p90', ltpaxMillions(k.p90_total));
  ltpaxSetText('ltpax-kpi-peak', k.peak_week || '--');
  ltpaxSetText('ltpax-kpi-load', ltpaxPercent(k.load_factor));
  ltpaxSetText('ltpax-kpi-p50-delta', ltpaxDelta(k.p50_delta_pct));
  ltpaxSetText('ltpax-kpi-p10-delta', ltpaxDelta(k.p10_delta_pct));
  ltpaxSetText('ltpax-kpi-p90-delta', ltpaxDelta(k.p90_delta_pct));
  ltpaxSetText('ltpax-kpi-peak-range', k.peak_week_range || '--');
  ltpaxSetText('ltpax-kpi-load-note', k.baseline_label || 'Baseline 2025 avg');
}

function ltpaxRenderAccuracy(data) {
  const list = document.getElementById('ltpax-accuracy-list');
  if (!list) return;

  const acc = data.accuracies || {};
  list.innerHTML = LTPAX_MODELS.map(model => {
    const val = Number(acc[model.key] || 0);
    return `
      <div class="ltpax-accuracy-row">
        <div class="ltpax-accuracy-copy">
          <strong>${model.label}</strong>
          <span>${model.note}</span>
        </div>
        <div class="ltpax-accuracy-track" aria-hidden="true">
          <span style="width:${Math.max(0, Math.min(100, val))}%;background:${model.color}"></span>
        </div>
        <div class="ltpax-accuracy-value">${ltpaxPercent(val)}</div>
      </div>
    `;
  }).join('');

  ltpaxSetText('ltpax-banner-accuracy', ltpaxPercent(acc.ensemble || 0));
}

function ltpaxRenderForecastChart(data) {
  const canvas = document.getElementById('ltpax-forecast-chart');
  if (!canvas || !window.Chart) return;
  const ctx = canvas.getContext('2d');

  if (LTPAX_CHART) {
    LTPAX_CHART.destroy();
    LTPAX_CHART = null;
  }

  const forecast = data.forecast || {};
  const p10 = forecast.p10 || [];
  const p50 = forecast.p50 || [];
  const p90 = forecast.p90 || [];
  const actual = data.actual_2025 || [];

  LTPAX_CHART = new Chart(ctx, {
    type: 'line',
    data: {
      labels: data.weeks || [],
      datasets: [
        {
          label: 'P10 Conservative',
          data: p10,
          borderColor: ltpaxMetricColor('info'),
          backgroundColor: 'rgba(59, 130, 246, 0.08)',
          borderDash: [4, 4],
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0.28,
          order: 4,
        },
        {
          label: 'P90 Optimistic',
          data: p90,
          borderColor: ltpaxMetricColor('info'),
          backgroundColor: 'rgba(59, 130, 246, 0.14)',
          borderDash: [4, 4],
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0.28,
          fill: '-1',
          order: 3,
        },
        {
          label: '2025 Actual',
          data: actual,
          borderColor: ltpaxMetricColor('teal'),
          backgroundColor: 'rgba(14, 165, 233, 0.12)',
          borderWidth: 2.2,
          pointRadius: 0,
          tension: 0.28,
          spanGaps: true,
          order: 2,
        },
        {
          label: '2026 Ensemble (P50)',
          data: p50,
          borderColor: ltpaxMetricColor('accent'),
          backgroundColor: 'rgba(249, 115, 22, 0.12)',
          borderWidth: 3,
          pointRadius: 0,
          tension: 0.28,
          order: 1,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'bottom',
          labels: { usePointStyle: true, boxWidth: 8, padding: 14 },
        },
        tooltip: {
          mode: 'index',
          intersect: false,
          callbacks: {
            label: ctx => `${ctx.dataset.label}: ${Number(ctx.parsed.y || 0).toLocaleString()} pax`,
          },
        },
      },
      scales: {
        x: {
          grid: { color: 'rgba(148, 163, 184, 0.14)' },
          ticks: {
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 13,
          },
        },
        y: {
          grid: { color: 'rgba(148, 163, 184, 0.18)' },
          ticks: { callback: ltpaxAxis },
        },
      },
    },
  });
}

function ltpaxRender(data) {
  ltpaxRenderKpis(data);
  ltpaxRenderAccuracy(data);
  ltpaxRenderForecastChart(data);
}

async function initLongTermPaxDemand(options = {}) {
  const panel = document.querySelector('.ltpax-forecast-panel');
  if (!panel) return;

  try {
    if (!LTPAX_DATA || options.force) {
      const res = await fetch('/api/long-term/pax-demand/strategic-forecast');
      if (!res.ok) throw new Error(`PAX forecast API failed: ${res.status}`);
      LTPAX_DATA = await res.json();
    }
    ltpaxRender(LTPAX_DATA);
  } catch (err) {
    panel.innerHTML = `<div class="empty-state">Unable to load Long Term PAX Demand forecast.</div>`;
    console.error(err);
  }
}

window.initLongTermPaxDemand = initLongTermPaxDemand;

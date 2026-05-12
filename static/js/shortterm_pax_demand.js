/* Short Term PAX Demand - 3-day passenger flow outlook */

let STPAX_DATA = null;
let STPAX_CHART = null;

const STPAX_SERIES = [
  { key: 'checkin', label: 'Check-in (Inflow)', color: '#0ea5e9', axis: 'y' },
  { key: 'security', label: 'Security Queueing', color: '#8b5cf6', axis: 'y' },
  { key: 'cbp', label: 'US Preclearance (CBP)', color: '#ef4444', axis: 'y' },
  { key: 'lounge', label: 'Lounge/Retail Occupancy', color: '#f59e0b', axis: 'y1', dash: [5, 5] },
  { key: 'boarding', label: 'Boarding Gate Pulse', color: '#ec4899', axis: 'y' },
  { key: 'immigration', label: 'Immigration', color: '#10b981', axis: 'y' },
  { key: 'baggage', label: 'Baggage Reclaim Surge', color: '#3b82f6', axis: 'y' },
];

const STPAX_ACCENT = {
  teal: '#0ea5e9',
  purple: '#8b5cf6',
  crit: '#ef4444',
  warn: '#f59e0b',
  info: '#3b82f6',
  ok: '#10b981',
};

function stpaxFormat(value) {
  return Number(value || 0).toLocaleString();
}

function stpaxSetText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function stpaxDayShort(label) {
  return String(label || '').split(' ').slice(1).join(' ');
}

function stpaxRenderInsights(data) {
  const grid = document.getElementById('stpax-insight-grid');
  if (!grid) return;

  grid.innerHTML = (data.insights || []).map(item => {
    const accent = STPAX_ACCENT[item.accent] || STPAX_ACCENT.info;
    return `
      <article class="stpax-insight-card" style="--stpax-accent:${accent}">
        <div class="stpax-card-name">${item.label}</div>
        <div class="stpax-card-value">${stpaxFormat(item.peak)}</div>
        <div class="stpax-card-sub">${item.metric_label || 'Peak Pax / 15-min'}</div>
        <div class="stpax-card-row">
          <span>Peak Window</span>
          <strong>${item.peak_time || '--'}</strong>
        </div>
        <div class="stpax-card-row">
          <span>${item.secondary_label || ''}</span>
          <strong>${item.secondary_value || '--'}</strong>
        </div>
      </article>
    `;
  }).join('');
}

function stpaxRenderChart(payload) {
  const canvas = document.getElementById('stpax-outlook-chart');
  if (!canvas || !window.Chart) return;

  if (STPAX_CHART) {
    STPAX_CHART.destroy();
    STPAX_CHART = null;
  }

  const series = payload.series || {};
  const labels = series.labels || [];
  const dayLabels = series.day_labels || [];

  STPAX_CHART = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: STPAX_SERIES.map(item => ({
        label: item.label,
        data: series[item.key] || [],
        borderColor: item.color,
        backgroundColor: `${item.color}22`,
        fill: true,
        tension: 0.35,
        borderWidth: 2,
        pointRadius: 0,
        hitRadius: 10,
        hoverRadius: 3,
        yAxisID: item.axis,
        borderDash: item.dash || [],
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      elements: { point: { radius: 0 } },
      plugins: {
        legend: {
          position: 'top',
          labels: {
            usePointStyle: true,
            pointStyle: 'rectRounded',
            boxWidth: 14,
            boxHeight: 6,
            padding: 18,
          },
        },
        tooltip: {
          mode: 'index',
          intersect: false,
          callbacks: {
            title: items => {
              const idx = items[0]?.dataIndex || 0;
              return `${dayLabels[idx] || ''} ${labels[idx] || ''}`.trim();
            },
            label: ctx => `${ctx.dataset.label}: ${Math.round(ctx.parsed.y || 0).toLocaleString()}`,
          },
        },
      },
      scales: {
        x: {
          grid: { color: 'rgba(148, 163, 184, 0.11)' },
          ticks: {
            maxRotation: 0,
            autoSkip: false,
            callback: function(_value, index) {
              const label = labels[index] || '';
              const [h, m] = label.split(':').map(Number);
              if (m !== 0 || h % 3 !== 0) return '';
              const prevDay = index > 0 ? dayLabels[index - 1] : '';
              const currentDay = dayLabels[index] || '';
              const hour = String(h);
              if (currentDay && currentDay !== prevDay) return [hour, stpaxDayShort(currentDay)];
              return hour;
            },
          },
        },
        y: {
          min: 0,
          title: { display: true, text: 'Pax / 15-min' },
          grid: { color: 'rgba(148, 163, 184, 0.16)' },
          ticks: { callback: value => Number(value).toLocaleString() },
        },
        y1: {
          min: 0,
          position: 'right',
          title: { display: true, text: 'Lounge Occupancy' },
          grid: { drawOnChartArea: false },
          ticks: { callback: value => Number(value).toLocaleString() },
        },
      },
    },
  });
}

function stpaxRender(payload) {
  stpaxSetText('stpax-title', payload.summary?.title || '3-Day Strategic Outlook');
  stpaxSetText('stpax-subtitle', payload.summary?.subtitle || '');
  stpaxRenderChart(payload);
  stpaxRenderInsights(payload);
}

async function initShortTermPaxDemand(options = {}) {
  const panel = document.querySelector('.stpax-outlook-panel');
  if (!panel) return;

  try {
    if (!STPAX_DATA || options.force) {
      const res = await fetch('/api/short-term/pax-demand/strategic-outlook');
      if (!res.ok) throw new Error(`Short-term PAX API failed: ${res.status}`);
      STPAX_DATA = await res.json();
    }
    stpaxRender(STPAX_DATA);
  } catch (err) {
    panel.innerHTML = '<div class="empty-state">Unable to load Short Term PAX Demand outlook.</div>';
    console.error(err);
  }
}

window.initShortTermPaxDemand = initShortTermPaxDemand;

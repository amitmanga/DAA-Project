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

const STPAX_TOUCHPOINT_ICONS = {
  check: '<path d="M3 7h18"/><path d="M5 7l2-4h10l2 4"/><path d="M6 11h12"/><path d="M8 15h8"/><path d="M10 19h4"/>',
  security: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-5"/>',
  cbp: '<path d="M4 4h16v16H4z"/><path d="M8 8h8"/><path d="M8 12h8"/><path d="M8 16h5"/>',
  lounge: '<path d="M4 11h16"/><path d="M5 11l1 8h12l1-8"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  boarding: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7z"/>',
  immigration: '<path d="M16 21v-2a4 4 0 0 0-8 0v2"/><circle cx="12" cy="7" r="4"/><path d="M4 3h16v18H4z"/>',
  baggage: '<rect x="5" y="7" width="14" height="13" rx="2"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/><path d="M9 11v5"/><path d="M15 11v5"/>',
  default: '<path d="M3 3v18h18"/><path d="m7 15 4-4 3 3 5-7"/>',
};

function stpaxFormat(value) {
  return Number(value || 0).toLocaleString();
}

function stpaxEsc(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function stpaxSetText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function stpaxDayShort(label) {
  return String(label || '').split(' ').slice(1).join(' ');
}

function stpaxIconFor(label) {
  const value = String(label || '').toLowerCase();
  if (value.includes('check')) return STPAX_TOUCHPOINT_ICONS.check;
  if (value.includes('security')) return STPAX_TOUCHPOINT_ICONS.security;
  if (value.includes('cbp') || value.includes('preclearance')) return STPAX_TOUCHPOINT_ICONS.cbp;
  if (value.includes('lounge') || value.includes('retail')) return STPAX_TOUCHPOINT_ICONS.lounge;
  if (value.includes('boarding') || value.includes('gate')) return STPAX_TOUCHPOINT_ICONS.boarding;
  if (value.includes('immigration')) return STPAX_TOUCHPOINT_ICONS.immigration;
  if (value.includes('baggage') || value.includes('reclaim')) return STPAX_TOUCHPOINT_ICONS.baggage;
  return STPAX_TOUCHPOINT_ICONS.default;
}

function stpaxRenderInsights(data) {
  const grid = document.getElementById('stpax-insight-grid');
  if (!grid) return;

  grid.innerHTML = (data.insights || []).map(item => {
    const accent = STPAX_ACCENT[item.accent] || STPAX_ACCENT.info;
    const icon = stpaxIconFor(item.label);
    return `
      <article class="stpax-insight-card" style="--stpax-accent:${accent};--pax-accent:${accent}">
        <div class="stpax-card-head">
          <div class="pax-icon-bubble" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${icon}</svg>
          </div>
          <div class="stpax-card-name">${stpaxEsc(item.label)}</div>
        </div>
        <div class="stpax-card-value">${stpaxFormat(item.peak)}</div>
        <div class="stpax-card-sub">${stpaxEsc(item.metric_label || 'Peak Pax / 15-min')}</div>
        <div class="stpax-card-row">
          <span>Peak Window</span>
          <strong>${stpaxEsc(item.peak_time || '--')}</strong>
        </div>
        <div class="stpax-card-row">
          <span>${stpaxEsc(item.secondary_label || '')}</span>
          <strong>${stpaxEsc(item.secondary_value || '--')}</strong>
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

const STPAX_MONTHS = { Jan:1, Feb:2, Mar:3, Apr:4, May:5, Jun:6, Jul:7, Aug:8, Sep:9, Oct:10, Nov:11, Dec:12 };

function stpaxDayToISO(dayStr) {
  // "Fri 16 May 2025" -> "2025-05-16"
  const parts = String(dayStr || '').split(' ');
  if (parts.length < 4) return '';
  const d = parts[1].padStart(2, '0');
  const m = String(STPAX_MONTHS[parts[2]] || 0).padStart(2, '0');
  const y = parts[3];
  return `${y}-${m}-${d}`;
}

function stpaxComputeInsightsFromSeries(series) {
  const nums = key => (series[key] || []).map(v => Number(v || 0));
  const peakVal = values => Math.round(Math.max(0, ...values));
  const activeAvg = values => {
    const active = values.filter(v => v > 0);
    return active.length ? Math.round(active.reduce((a, b) => a + b, 0) / active.length) : 0;
  };
  const pct = (part, total) => total ? Math.round((part / total) * 100) : null;
  const peakTime = key => {
    const vals = nums(key);
    if (!vals.length) return '--';
    const idx = vals.indexOf(Math.max(...vals));
    return (series.labels || [])[idx] || '--';
  };
  const fmt = v => Number(v || 0).toLocaleString();

  const checkin = nums('checkin'), security = nums('security'), cbp = nums('cbp');
  const lounge = nums('lounge'), boarding = nums('boarding');
  const immigration = nums('immigration'), baggage = nums('baggage');
  const maxCheckin = peakVal(checkin), maxSecurity = peakVal(security), maxCbp = peakVal(cbp);
  const maxLounge = peakVal(lounge), maxBoarding = peakVal(boarding);
  const maxImmigration = peakVal(immigration), maxBaggage = peakVal(baggage);
  const avgSecurity = activeAvg(security);

  return [
    { key: 'checkin',    label: 'Check-In',         accent: 'teal',   peak: maxCheckin,    metric_label: 'Peak Pax / 15-min',    peak_time: peakTime('checkin'),    secondary_label: 'Avg (all day)',        secondary_value: `${fmt(activeAvg(checkin))} pax` },
    { key: 'security',   label: 'Security',          accent: 'purple', peak: maxSecurity,   metric_label: 'Peak Pax / 15-min',    peak_time: peakTime('security'),   secondary_label: 'Pressure Index',      secondary_value: avgSecurity ? `${(maxSecurity / avgSecurity).toFixed(1)}x avg` : '--' },
    { key: 'cbp',        label: 'CBP Preclearance',  accent: 'crit',   peak: maxCbp,        metric_label: 'Peak Pax / 15-min',    peak_time: peakTime('cbp'),        secondary_label: '% of Security',       secondary_value: pct(maxCbp, maxSecurity) != null ? `${pct(maxCbp, maxSecurity)}% of security peak` : '--' },
    { key: 'lounge',     label: 'Lounge / Retail',   accent: 'warn',   peak: maxLounge,     metric_label: 'Peak Concurrent Pax',  peak_time: peakTime('lounge'),     secondary_label: 'Avg Occupancy',       secondary_value: `${fmt(activeAvg(lounge))} pax` },
    { key: 'boarding',   label: 'Boarding Gates',    accent: 'info',   peak: maxBoarding,   metric_label: 'Peak Pax / 15-min',    peak_time: peakTime('boarding'),   secondary_label: 'Gate Pressure',       secondary_value: pct(maxBoarding, maxCheckin) != null ? `${pct(maxBoarding, maxCheckin)}% of check-in` : '--' },
    { key: 'immigration',label: 'Immigration',       accent: 'ok',     peak: maxImmigration,metric_label: 'Peak Pax / 15-min',    peak_time: peakTime('immigration'),secondary_label: 'Intl. Arrival Share', secondary_value: pct(maxImmigration, maxBaggage) != null ? `${pct(maxImmigration, maxBaggage)}% of arrivals` : '--' },
  ];
}

function stpaxFilterDay(payload, isoDate) {
  const daysData = payload.series?.days_data || [];
  const day = daysData.find(d => stpaxDayToISO(d.date) === isoDate);
  if (!day) return payload;

  const filteredSeries = {
    labels: day.labels || [],
    day_labels: (day.labels || []).map(() => day.date),
    days_data: [day],
  };
  for (const key of ['checkin', 'security', 'cbp', 'lounge', 'boarding', 'immigration', 'baggage']) {
    filteredSeries[key] = day[key] || [];
  }

  const parts = String(day.date || '').split(' ');
  const dayShort = parts.slice(1, 3).join(' ');
  return {
    ...payload,
    summary: { ...payload.summary, title: `${dayShort} Passenger Flow`, subtitle: 'passenger flow for the selected date' },
    series: filteredSeries,
    insights: stpaxComputeInsightsFromSeries(filteredSeries),
  };
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
    const renderPayload = options.date ? stpaxFilterDay(STPAX_DATA, options.date) : STPAX_DATA;
    stpaxRender(renderPayload);
  } catch (err) {
    panel.innerHTML = '<div class="empty-state">Unable to load Short Term PAX Demand outlook.</div>';
    console.error(err);
  }
}

window.initShortTermPaxDemand = initShortTermPaxDemand;

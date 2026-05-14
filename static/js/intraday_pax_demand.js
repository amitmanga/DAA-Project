/* Intraday PAX Demand - tactical pulse module */

let IDPAX_DATA = null;
let IDPAX_BASELINE_PAYLOAD = null;
let IDPAX_SIM_PAYLOAD = null;
let IDPAX_CHART = null;
let IDPAX_CURRENT_SCENARIO = 'flight_delay';

const IDPAX_SERIES = [
  { key: 'checkin', label: 'Check-in', color: '#0ea5e9', axis: 'y' },
  { key: 'security', label: 'Security', color: '#8b5cf6', axis: 'y' },
  { key: 'cbp', label: 'CBP', color: '#ef4444', axis: 'y' },
  { key: 'lounge', label: 'Lounge', color: '#f59e0b', axis: 'y1', dash: [5, 5] },
  { key: 'boarding', label: 'Boarding', color: '#ec4899', axis: 'y' },
  { key: 'immigration', label: 'Immigration', color: '#10b981', axis: 'y' },
  { key: 'baggage', label: 'Baggage', color: '#3b82f6', axis: 'y' },
];

const IDPAX_TOUCHPOINT_ICONS = {
  check: '<path d="M3 7h18"/><path d="M5 7l2-4h10l2 4"/><path d="M6 11h12"/><path d="M8 15h8"/><path d="M10 19h4"/>',
  security: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-5"/>',
  cbp: '<path d="M4 4h16v16H4z"/><path d="M8 8h8"/><path d="M8 12h8"/><path d="M8 16h5"/>',
  lounge: '<path d="M4 11h16"/><path d="M5 11l1 8h12l1-8"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  boarding: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7z"/>',
  immigration: '<path d="M16 21v-2a4 4 0 0 0-8 0v2"/><circle cx="12" cy="7" r="4"/><path d="M4 3h16v18H4z"/>',
  baggage: '<rect x="5" y="7" width="14" height="13" rx="2"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/><path d="M9 11v5"/><path d="M15 11v5"/>',
  default: '<path d="M3 3v18h18"/><path d="m7 15 4-4 3 3 5-7"/>',
};

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

function idpaxFmtDelta(value) {
  const n = Math.round(Number(value || 0));
  return n > 0 ? `+${n.toLocaleString()}` : n.toLocaleString();
}

function idpaxSeriesPeak(values) {
  const nums = (values || []).map(v => Number(v || 0)).filter(Number.isFinite);
  return nums.length ? Math.max(...nums) : 0;
}

function idpaxBuildImpact(baseline, simulated) {
  const impact = {};
  IDPAX_SERIES.forEach(item => {
    const basePeak = idpaxSeriesPeak(baseline?.[item.key]);
    const simPeak = idpaxSeriesPeak(simulated?.[item.key]);
    const delta = simPeak - basePeak;
    let displayDelta = delta;
    let deltaPct = basePeak > 0 ? Math.round((delta / basePeak) * 1000) / 10 : 0;
    if (Math.abs(deltaPct) < 0.5 && basePeak > 0) {
      const baseVals = baseline?.[item.key] || [];
      const simVals = simulated?.[item.key] || [];
      let localDelta = 0;
      for (let i = 0; i < Math.min(baseVals.length, simVals.length); i += 1) {
        const d = Number(simVals[i] || 0) - Number(baseVals[i] || 0);
        if (Math.abs(d) > Math.abs(localDelta)) localDelta = d;
      }
      if (Math.abs(localDelta) > 0) {
        displayDelta = localDelta;
        deltaPct = Math.round((localDelta / basePeak) * 1000) / 10;
      }
    }
    impact[item.key] = {
      baseline_peak: Math.round(basePeak * 10) / 10,
      simulated_peak: Math.round(simPeak * 10) / 10,
      delta: Math.round(displayDelta * 10) / 10,
      delta_pct: deltaPct,
    };
  });
  return impact;
}

function idpaxIconFor(label) {
  const value = String(label || '').toLowerCase();
  if (value.includes('check')) return IDPAX_TOUCHPOINT_ICONS.check;
  if (value.includes('security')) return IDPAX_TOUCHPOINT_ICONS.security;
  if (value.includes('cbp') || value.includes('preclearance')) return IDPAX_TOUCHPOINT_ICONS.cbp;
  if (value.includes('lounge') || value.includes('retail')) return IDPAX_TOUCHPOINT_ICONS.lounge;
  if (value.includes('boarding') || value.includes('gate')) return IDPAX_TOUCHPOINT_ICONS.boarding;
  if (value.includes('immigration')) return IDPAX_TOUCHPOINT_ICONS.immigration;
  if (value.includes('baggage') || value.includes('reclaim')) return IDPAX_TOUCHPOINT_ICONS.baggage;
  return IDPAX_TOUCHPOINT_ICONS.default;
}

function idpaxSetText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function idpaxFlightOptions(payload, selectedNos = []) {
  const selected = new Set((selectedNos || []).map(v => String(v || '').trim()).filter(Boolean));
  const options = (payload.flights || []).map((f, idx) => {
    const time = f.etd || f.eta || '--';
    const label = `${f.flight_no} - ${f.type} - ${time} - ${f.terminal || ''}`;
    const isSelected = selected.size ? selected.has(f.flight_no) : idx === 0;
    return `<option value="${idpaxEsc(f.flight_no)}" ${isSelected ? 'selected' : ''}>${idpaxEsc(label)}</option>`;
  }).join('');
  return options || '<option value="">Loading flights...</option>';
}

function idpaxFlightCheckboxItems(payload, selectedNos = []) {
  const selected = new Set((selectedNos || []).map(v => String(v || '').trim()).filter(Boolean));
  const items = (payload.flights || []).map(f => {
    const time = f.etd || f.eta || '--';
    const label = `${f.flight_no} - ${f.type} - ${time} - ${f.terminal || ''}`;
    // Default: all flights pre-selected; honour prior selection if provided
    const isChecked = selected.size ? selected.has(f.flight_no) : true;
    return `<label class="idpax-ms-item">
      <input type="checkbox" value="${idpaxEsc(f.flight_no)}"${isChecked ? ' checked' : ''}>
      <span>${idpaxEsc(label)}</span>
    </label>`;
  }).join('');
  return items || '<div class="idpax-ms-empty">No flights available</div>';
}

async function idpaxFetchBaseline() {
  if (IDPAX_CURRENT_SCENARIO !== 'flight_delay') return;
  const all = Array.from(document.querySelectorAll('#idpax-ms-dropdown'));
  const dropdown = all.find(el => el.parentElement === document.body) || all[all.length - 1] || null;
  if (!dropdown) return;
  const flightNos = Array.from(dropdown.querySelectorAll('input[type="checkbox"]:checked'))
    .map(cb => cb.value).filter(Boolean);
  if (!flightNos.length) return;
  try {
    const res = await fetch('/api/intraday/pax-demand/flight-baseline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flight_nos: flightNos }),
    });
    const payload = await res.json();
    if (!res.ok || payload.error) return;
    IDPAX_BASELINE_PAYLOAD = payload;
    idpaxRenderChart(payload);
    idpaxRenderTable(payload);
    idpaxRenderInsights(payload);
    const runBtn = document.getElementById('idpax-run-sim');
    if (runBtn) runBtn.textContent = 'Run Simulation';
    const loadBtn = document.getElementById('idpax-load-resource');
    if (loadBtn) loadBtn.disabled = true;
  } catch (err) {
    console.error(err);
  }
}

function idpaxInitFlightMultiSelect() {
  const trigger  = document.getElementById('idpax-ms-trigger');
  const dropdown = document.getElementById('idpax-ms-dropdown');
  const labelEl  = document.getElementById('idpax-ms-label');
  if (!trigger || !dropdown || !labelEl) return;

  // Attach to <body> so no ancestor overflow/clip can hide it
  document.body.appendChild(dropdown);

  function positionDropdown() {
    const rect = trigger.getBoundingClientRect();
    dropdown.style.top   = (rect.bottom + window.scrollY + 4) + 'px';
    dropdown.style.left  = (rect.left   + window.scrollX)     + 'px';
    dropdown.style.width = rect.width + 'px';
  }

  function openDropdown()  { positionDropdown(); dropdown.style.display = 'block'; trigger.classList.add('open'); }
  function closeDropdown() { dropdown.style.display = 'none'; trigger.classList.remove('open'); }

  const selectAllCb = dropdown.querySelector('#idpax-ms-select-all');
  const flightCbs = Array.from(dropdown.querySelectorAll('input[type="checkbox"]:not(#idpax-ms-select-all)'));

  function syncSelectAll() {
    if (!selectAllCb) return;
    const allChecked = flightCbs.every(cb => cb.checked);
    const anyChecked = flightCbs.some(cb => cb.checked);
    selectAllCb.checked = allChecked;
    selectAllCb.indeterminate = anyChecked && !allChecked;
  }

  function updateLabel() {
    const checked = flightCbs.filter(cb => cb.checked);
    if (checked.length === 0) {
      labelEl.textContent = 'Select flights…';
    } else if (checked.length === flightCbs.length) {
      labelEl.textContent = 'All flights selected';
    } else if (checked.length === 1) {
      labelEl.textContent = checked[0].closest('label').querySelector('span').textContent;
    } else {
      labelEl.textContent = `${checked.length} flights selected`;
    }
  }

  if (selectAllCb) {
    selectAllCb.addEventListener('change', () => {
      flightCbs.forEach(cb => { cb.checked = selectAllCb.checked; });
      updateLabel();
      idpaxFetchBaseline();
    });
  }

  flightCbs.forEach(cb => {
    cb.addEventListener('change', () => {
      syncSelectAll();
      updateLabel();
      idpaxFetchBaseline();
    });
  });

  trigger.addEventListener('click', e => {
    e.stopPropagation();
    dropdown.style.display === 'block' ? closeDropdown() : openDropdown();
  });

  document.addEventListener('click', e => {
    if (!trigger.contains(e.target) && !dropdown.contains(e.target)) closeDropdown();
  });

  window.addEventListener('scroll', positionDropdown, { passive: true });
  window.addEventListener('resize', () => { if (dropdown.style.display === 'block') positionDropdown(); }, { passive: true });

  syncSelectAll();
  updateLabel();
}

function idpaxRenderScenarioForm(payload) {
  const target = document.getElementById('idpax-sim-params');
  if (!target) return;

  // Remove any stale body-appended dropdown from the previous render before
  // re-building the form. Without this, duplicate #idpax-ms-dropdown elements
  // accumulate in <body> and idpaxCollectParams reads the wrong (old) one.
  document.querySelectorAll('#idpax-ms-dropdown').forEach(el => {
    if (el.parentElement === document.body) el.remove();
  });

  const selectedNos = (payload?.simulation?.selected_flights || []).map(f => f.flight_no).filter(Boolean);

  const forms = {
    flight_delay: `
      <div class="idpax-ms-field">
        <span>Select Flight(s)</span>
        <div class="idpax-multi-select">
          <button type="button" class="idpax-ms-trigger" id="idpax-ms-trigger">
            <span id="idpax-ms-label">Select flights…</span>
            <span class="idpax-ms-arrow">▾</span>
          </button>
          <div class="idpax-ms-dropdown" id="idpax-ms-dropdown">
            <label class="idpax-ms-item idpax-ms-select-all">
              <input type="checkbox" id="idpax-ms-select-all">
              <span>Select All</span>
            </label>
            ${idpaxFlightCheckboxItems(IDPAX_DATA || payload, selectedNos)}
          </div>
        </div>
      </div>
      <div class="idpax-ms-field">
        <span>Delay (Minutes)</span>
        <div class="idpax-delay-static">60 min</div>
      </div>
    `,
    ground_stop: `
      <label>
        <span>Stop Start Time</span>
        <input id="idpax-gs-start" type="time" value="07:30">
      </label>
      <label>
        <span>Duration (Minutes)</span>
        <input id="idpax-gs-duration" type="number" min="10" max="120" step="5" value="45">
      </label>
    `,
    security_reduction: `
      <label>
        <span>Throughput Reduction (%)</span>
        <input id="idpax-sec-pct" type="number" min="10" max="90" step="5" value="40">
      </label>
      <label>
        <span>From</span>
        <input id="idpax-sec-start" type="time" value="06:00">
      </label>
      <label>
        <span>Until</span>
        <input id="idpax-sec-end" type="time" value="08:30">
      </label>
    `,
    checkin_reduction: `
      <label>
        <span>Desk Capacity Reduction (%)</span>
        <input id="idpax-chk-pct" type="number" min="10" max="90" step="5" value="40">
      </label>
      <label>
        <span>From</span>
        <input id="idpax-chk-start" type="time" value="06:00">
      </label>
      <label>
        <span>Until</span>
        <input id="idpax-chk-end" type="time" value="08:00">
      </label>
    `,
  };
  target.innerHTML = forms[IDPAX_CURRENT_SCENARIO] || forms.flight_delay;
  if (IDPAX_CURRENT_SCENARIO === 'flight_delay') idpaxInitFlightMultiSelect();
}

function idpaxCollectParams() {
  const val = id => document.getElementById(id)?.value || '';
  if (IDPAX_CURRENT_SCENARIO === 'flight_delay') {
    // After cleanup in idpaxRenderScenarioForm there is always exactly one
    // #idpax-ms-dropdown, but guard by preferring the body-appended one (the
    // visible one the user interacted with) over any stale in-form remnant.
    const all = Array.from(document.querySelectorAll('#idpax-ms-dropdown'));
    const dropdown = all.find(el => el.parentElement === document.body) || all[all.length - 1] || null;
    const flightNos = dropdown
      ? Array.from(dropdown.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value).filter(Boolean)
      : [];
    return { flight_no: flightNos[0] || '', flight_nos: flightNos, delay_min: 60 };
  }
  if (IDPAX_CURRENT_SCENARIO === 'ground_stop') {
    return { start: val('idpax-gs-start'), duration_min: val('idpax-gs-duration') };
  }
  if (IDPAX_CURRENT_SCENARIO === 'security_reduction') {
    return { reduction_pct: val('idpax-sec-pct'), start: val('idpax-sec-start'), end: val('idpax-sec-end') };
  }
  if (IDPAX_CURRENT_SCENARIO === 'checkin_reduction') {
    return { reduction_pct: val('idpax-chk-pct'), start: val('idpax-chk-start'), end: val('idpax-chk-end') };
  }
  return {};
}

function idpaxRenderTable(payload) {
  const tbody = document.getElementById('idpax-table-body');
  if (!tbody) return;
  const rows = payload.table?.rows || [];
  const isOverlayTable = payload.table?.mode === 'overlay_delta';
  const title = document.querySelector('.idpax-table-title span');
  if (title) title.textContent = payload.table?.title || (isOverlayTable ? 'Combined Overlay by Touchpoint' : 'PAX Count by Touchpoint');
  const fmt = isOverlayTable ? idpaxFmtDelta : idpaxFmt;
  tbody.innerHTML = rows.map(row => `
    <tr>
      <td>${idpaxEsc(row.time)}</td>
      <td>${fmt(row.checkin)}</td>
      <td>${fmt(row.security)}</td>
      <td>${fmt(row.cbp)}</td>
      <td>${fmt(row.lounge)}</td>
      <td>${fmt(row.boarding)}</td>
      <td>${fmt(row.immigration)}</td>
      <td>${fmt(row.baggage)}</td>
    </tr>
  `).join('');
}

function idpaxRenderInsights(payload) {
  const grid = document.getElementById('idpax-insight-grid');
  if (!grid) return;
  const isSimulated = !!payload.simulation?.active;
  const baselineSeries = payload.baseline || IDPAX_DATA?.series || {};
  const simulatedSeries = payload.simulated || payload.series || {};
  const impact = Object.keys(payload.impact || {}).length
    ? payload.impact
    : idpaxBuildImpact(baselineSeries, simulatedSeries);
  const deltaBadge = key => {
    const d = Number(impact[key]?.delta_pct || 0);
    if (!isSimulated || Math.abs(d) < 0.5) return '';
    const cls = d > 0 ? 'idpax-delta-up' : 'idpax-delta-down';
    const arrow = d > 0 ? '&#9650;' : '&#9660;';
    return `<span class="idpax-delta-badge ${cls}">${arrow} ${Math.abs(d).toFixed(1)}%</span>`;
  };
  const metricLabel = item => {
    if (!isSimulated) return item.metric_label || 'Peak Pax / min';
    if (item.key === 'lounge') return 'Simulated Concurrent';
    return 'Simulated Peak Pax/min';
  };

  grid.innerHTML = (payload.insights || []).map(item => {
    const accent = idpaxAccent(item.accent);
    const icon = idpaxIconFor(item.label);
    return `
      <article class="idpax-insight-card" style="--idpax-accent:${accent};--pax-accent:${accent}">
        <div class="idpax-card-head">
          <div class="pax-icon-bubble" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${icon}</svg>
          </div>
          <div class="idpax-card-name">${idpaxEsc(item.label)}</div>
        </div>
        <div class="idpax-card-value">${idpaxFmt(item.peak)}${deltaBadge(item.key)}</div>
        <div class="idpax-card-sub">${idpaxEsc(metricLabel(item))}</div>
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

function idpaxBuildDatasets(series, isSimulated = false, baselineSeries = null) {
  if (isSimulated) {
    const base = baselineSeries || IDPAX_DATA?.series || {};
    const sim = series || {};
    const baselineDatasets = IDPAX_SERIES.map(item => ({
      label: `${item.label} (Baseline)`,
      data: base[item.key] || [],
      borderColor: `${item.color}66`,
      backgroundColor: 'transparent',
      fill: false,
      tension: 0.32,
      borderWidth: 1.5,
      pointRadius: 0,
      hitRadius: 8,
      hoverRadius: 3,
      yAxisID: item.axis,
      borderDash: item.dash || [],
    }));
    const simulatedDatasets = IDPAX_SERIES.map(item => ({
      label: `${item.label} (Sim)`,
      data: sim[item.key] || [],
      borderColor: item.color,
      backgroundColor: `${item.color}${item.axis === 'y1' ? '20' : '22'}`,
      fill: true,
      tension: 0.32,
      borderWidth: 2.8,
      pointRadius: 0,
      hitRadius: 8,
      hoverRadius: 3,
      yAxisID: item.axis,
      borderDash: [7, 3],
    }));
    return [...baselineDatasets, ...simulatedDatasets];
  }

  return IDPAX_SERIES.map(item => ({
    label: item.label,
    data: series[item.key] || [],
    borderColor: item.color,
    backgroundColor: `${item.color}22`,
    fill: true,
    tension: 0.32,
    borderWidth: 2,
    pointRadius: 0,
    hitRadius: 8,
    hoverRadius: 3,
    yAxisID: item.axis,
    borderDash: item.dash || [],
  }));
}

function idpaxRenderChart(payload) {
  const canvas = document.getElementById('idpax-pulse-chart');
  if (!canvas || !window.Chart) return;
  const title = document.querySelector('.idpax-chart-card .idpax-card-title span');
  if (title) {
    if (payload.simulation?.overlay_source) {
      title.textContent = 'Baseline + Combined Flight Delay Overlay';
    } else if (payload.baseline_preview) {
      title.textContent = 'Flight Delay — Baseline Preview';
    } else {
      title.textContent = 'Live Touchpoint Pulse';
    }
  }

  if (IDPAX_CHART) {
    IDPAX_CHART.destroy();
    IDPAX_CHART = null;
  }

  const series = payload.series || {};
  const labels = series.labels || [];
  const isSimulated = !!payload.simulation?.active;
  const isBaselinePreview = !!payload.baseline_preview;
  const baselineSeries = payload.baseline || IDPAX_DATA?.series || null;
  const simulatedSeries = payload.simulated || series;

  let datasets;
  if (isBaselinePreview) {
    // Show file baseline as solid lines — simulation not run yet
    datasets = idpaxBuildDatasets(baselineSeries || {}, false, null);
  } else {
    datasets = idpaxBuildDatasets(simulatedSeries, isSimulated, baselineSeries);
  }

  IDPAX_CHART = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets,
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
          ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 13 },
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

function idpaxRender(payload) {
  idpaxSetText('idpax-title', payload.summary?.title || 'Intra-Day Tactical Pulse');
  idpaxSetText('idpax-subtitle', payload.summary?.subtitle || '');
  idpaxRenderScenarioForm(payload);
  idpaxRenderChart(payload);
  idpaxRenderTable(payload);
  idpaxRenderInsights(payload);
  idpaxAttachActions();
}

async function idpaxRunSimulation() {
  if (!IDPAX_DATA) return;
  const run = document.getElementById('idpax-run-sim');
  const load = document.getElementById('idpax-load-resource');
  if (run) {
    run.disabled = true;
    run.textContent = 'Processing...';
  }
  if (load) load.disabled = true;
  try {
    const res = await fetch('/api/intraday/pax-demand/simulate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario: IDPAX_CURRENT_SCENARIO, params: idpaxCollectParams() }),
    });
    const payload = await res.json();
    if (!res.ok || payload.error) throw new Error(payload.error || `Simulation failed: ${res.status}`);
    IDPAX_SIM_PAYLOAD = payload;
    idpaxRender(payload);
    const runBtn = document.getElementById('idpax-run-sim');
    if (runBtn) runBtn.textContent = 'Simulation Applied';
    const loadBtn = document.getElementById('idpax-load-resource');
    if (loadBtn) loadBtn.disabled = !payload.simulation_export?.saved;
  } catch (err) {
    console.error(err);
    if (run) run.textContent = 'Run Simulation';
  } finally {
    if (run) run.disabled = false;
    const loadBtn = document.getElementById('idpax-load-resource');
    if (loadBtn && loadBtn.textContent !== 'Loading...') loadBtn.disabled = false;
  }
}

async function idpaxLoadResourcePlanning() {
  const btn = document.getElementById('idpax-load-resource');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Loading...';
  }

  try {
    const res = await fetch('/api/intraday/pax-demand/load-simulation', { method: 'POST' });
    const payload = await res.json();
    if (!res.ok || payload.error) throw new Error(payload.error || `Load failed: ${res.status}`);

    if (typeof openIntradayStaffReallocation === 'function') {
      await openIntradayStaffReallocation();
    } else if (typeof switchView === 'function') {
      switchView('intraday');
    } else if (typeof initIntraday === 'function') {
      await initIntraday({ activeTab: 'opt' });
    }
  } catch (err) {
    console.error(err);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Load to Resource Planning';
    }
  }
}

function idpaxAttachActions() {
  document.querySelectorAll('.idpax-scenario').forEach(btn => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => {
      IDPAX_CURRENT_SCENARIO = btn.dataset.scenario || 'flight_delay';
      IDPAX_SIM_PAYLOAD = null;
      document.querySelectorAll('.idpax-scenario').forEach(item => {
        item.classList.toggle('active', item === btn);
      });
      idpaxRenderScenarioForm(IDPAX_DATA || {});
      const run = document.getElementById('idpax-run-sim');
      if (run) run.textContent = 'Run Simulation';
      const load = document.getElementById('idpax-load-resource');
      if (load) load.textContent = 'Load to Resource Planning';
      if (IDPAX_CURRENT_SCENARIO === 'flight_delay') idpaxFetchBaseline();
    });
  });

  const run = document.getElementById('idpax-run-sim');
  if (run && !run.dataset.bound) {
    run.dataset.bound = '1';
    run.addEventListener('click', idpaxRunSimulation);
  }

  const clear = document.getElementById('idpax-clear-sim');
  if (clear && !clear.dataset.bound) {
    clear.dataset.bound = '1';
    clear.addEventListener('click', () => {
      if (!IDPAX_DATA) return;
      IDPAX_SIM_PAYLOAD = null;
      IDPAX_BASELINE_PAYLOAD = null;
      const runBtn = document.getElementById('idpax-run-sim');
      if (runBtn) runBtn.textContent = 'Run Simulation';
      const loadBtn = document.getElementById('idpax-load-resource');
      if (loadBtn) { loadBtn.textContent = 'Load to Resource Planning'; loadBtn.disabled = true; }
      // Full render from IDPAX_DATA resets the form (dropdown defaults to all flights selected)
      idpaxRender(IDPAX_DATA);
      if (IDPAX_CURRENT_SCENARIO === 'flight_delay') idpaxFetchBaseline();
    });
  }

  const load = document.getElementById('idpax-load-resource');
  if (load && !load.dataset.bound) {
    load.dataset.bound = '1';
    load.addEventListener('click', idpaxLoadResourcePlanning);
  }
}

async function initIntradayPaxDemand(options = {}) {
  const panel = document.querySelector('.idpax-module');
  if (!panel) return;

  try {
    if (!IDPAX_DATA || options.force) {
      const res = await fetch('/api/intraday/pax-demand/tactical-pulse');
      if (!res.ok) throw new Error(`Intraday PAX API failed: ${res.status}`);
      IDPAX_DATA = await res.json();
      // Data was refreshed — discard any stale simulation result
      IDPAX_SIM_PAYLOAD = null;
      IDPAX_BASELINE_PAYLOAD = null;
    }

    if (IDPAX_SIM_PAYLOAD) {
      // User ran a simulation before navigating away — restore it exactly
      idpaxRender(IDPAX_SIM_PAYLOAD);
      // Ensure the correct scenario button is highlighted
      document.querySelectorAll('.idpax-scenario').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.scenario === IDPAX_CURRENT_SCENARIO);
      });
      const runBtn = document.getElementById('idpax-run-sim');
      if (runBtn) runBtn.textContent = 'Simulation Applied';
      const loadBtn = document.getElementById('idpax-load-resource');
      if (loadBtn) loadBtn.disabled = !IDPAX_SIM_PAYLOAD.simulation_export?.saved;
    } else {
      idpaxRender(IDPAX_DATA);
      // Load file baseline for default selected flights without awaiting (non-blocking)
      idpaxFetchBaseline();
    }
  } catch (err) {
    panel.innerHTML = '<div class="empty-state">Unable to load Intraday PAX Demand pulse.</div>';
    console.error(err);
  }
}

window.initIntradayPaxDemand = initIntradayPaxDemand;

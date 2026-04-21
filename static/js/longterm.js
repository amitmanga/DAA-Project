/* ═══════════════════════════════════════════════
   DAA Long-Term Staff Planning — Frontend JS
   ═══════════════════════════════════════════════ */

const DAA = {
  accent:  '#f97316', accentL: '#fb923c',
  navy:    '#1a2744', navy2:   '#243156', navy3: '#2e3f6e',
  ok:      '#10b981', warn:    '#f59e0b', high: '#f97316', crit: '#ef4444',
  info:    '#3b82f6', muted:   '#6b7280', 
  isDark:  () => (window.getCurrentTheme && window.getCurrentTheme() === 'dark'),
  white:   () => (DAA.isDark() ? '#ffffff' : '#000000'),
};

const SKILL_COLOR = {
  'GNIB':                 '#3b82f6',
  'CBP Pre-clearance':    '#8b5cf6',
  'Bussing':              '#f97316',
  'PBZ':                  '#10b981',
  'Mezz Operation':       '#0ea5e9',
  'Litter Picking':       '#ef4444',
  'Ramp / Marshalling':   '#f59e0b',
  'Arr Customer Service': '#06b6d4',
  'Check-in/Trolleys':  '#64748b',
  'Dep / Trolleys':       '#a78bfa',
  'T1/T2 Trolleys L/UL':  '#fb7185',
  'Transfer Corridor':    '#34d399',
  'Gate 335':             '#fbbf24',
  'Departures':           '#4f46e5',
};

const CAT_COLOR = {
  'International Short-Haul': '#3b82f6',
  'International Long-Haul':  '#8b5cf6',
  'Transatlantic CBP':        '#ef4444',
  'Domestic':                 '#10b981',
  'Cargo':                    '#f59e0b',
};

function gapClass(v) {
  return v > 0 ? 'ok' : v === 0 ? 'warn' : 'crit';
}

function gapColor(v) {
  return v > 0 ? DAA.ok : v === 0 ? DAA.warn : DAA.crit;
}

function gapBadge(v) {
  if (v > 0) return { text: 'Surplus', cls: 'badge-ok' };
  if (v === 0) return { text: 'Balanced', cls: 'badge-warn' };
  return { text: 'Shortfall', cls: 'badge-crit' };
}

function updateChartDefaults() {
  const isDark = DAA.isDark();
  Chart.defaults.color       = isDark ? '#ffffff' : '#000000';
  Chart.defaults.borderColor = isDark ? 'rgba(255,255,255,0.15)' : '#e5e7eb';
  Chart.defaults.font.family = "'Inter', 'Segoe UI', system-ui, sans-serif";
}
updateChartDefaults();

// Listen for theme changes
window.addEventListener('themeChanged', () => {
  updateChartDefaults();
  refreshAllCharts();
});

function refreshAllCharts() {
  // 1. Re-render global long-term charts
  loadFlightTrendChart();
  loadStaffReqAvailChart();
  loadImbalanceChart();

  // 2. Re-render drilldown if active
  if (SELECTED_WEEK) {
    api(`/api/long-term/week/${SELECTED_WEEK}`).then(wk => {
      showDrilldown(wk);
    });
  }

  // 3. Re-render sub-view specific charts
  const activeSub = document.querySelector('.sub-tab.active')?.dataset.sub;
  if (activeSub === 'allocation') {
    loadAllocationTable(); // Re-renders table and skill bar chart
    loadSkillBarChart();
  } else if (activeSub === 'gap-skill') {
    initGapSkillAnalysis(); // Re-renders merged charts
  } else if (activeSub === 'skills') {
    loadSkillCharts();
  }
}

// ── Global state ──────────────────────────────────────────────
let ALL_WEEKS      = [];   // full heatmap data
let ALL_IMBALANCE  = [];   // full imbalance data
let ALLOC_DATA     = null; // full allocation data
let SELECTED_WEEK  = null; // currently selected week key

// Chart instances (kept so they can be destroyed/recreated)
const CHARTS = {};


// ── Helpers ───────────────────────────────────────────────────
const fmt    = n  => Number(n).toLocaleString();
const fmtFte = v  => v != null ? (+v).toFixed(1) : '—';
const api    = url => fetch(url).then(r => r.json());

function setLiveDate() {
  const s = new Date().toLocaleDateString('en-IE',
    { weekday:'short', day:'numeric', month:'short', year:'numeric' });
  document.getElementById('live-date').textContent   = s;
  document.getElementById('footer-date').textContent = s;
}

function destroyChart(id) {
  if (CHARTS[id]) { CHARTS[id].destroy(); delete CHARTS[id]; }
}

document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.disabled) return;
    const view = btn.dataset.view;

    // View switching
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`view-${view}`).classList.add('active');

    // Data initialization
    if (view === 'short-term' && typeof initShortTerm === 'function') initShortTerm();
    if (view === 'intraday'   && typeof initIntraday   === 'function') initIntraday();
    
    // Refresh charts if needed (e.g. for theme-aware colors)
    if (view === 'long-term') refreshAllCharts();
  });
});

document.querySelectorAll('.sub-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.sub-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.sub-view').forEach(v => v.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`sub-${tab.dataset.sub}`).classList.add('active');
    if (tab.dataset.sub === 'scenario' && typeof initScenario === 'function') initScenario();

    if (tab.dataset.sub === 'gap-skill') initGapSkillAnalysis();
  });
});

document.getElementById('btn-reset-week').addEventListener('click', clearWeekFilter);

// ═════════════════════════════════════════════════════════════
// WEEK SELECTION
// ═════════════════════════════════════════════════════════════

async function selectWeek(weekKey) {
  SELECTED_WEEK = weekKey;

  // Mark selected cell
  document.querySelectorAll('.hm-cell').forEach(el => {
    el.classList.toggle('selected', el.dataset.week === weekKey);
  });

  // Fetch detail
  const wk = await api(`/api/long-term/week/${weekKey}`);

  showWeekBanner(wk);
  showDrilldown(wk);
  updateKPIsForWeek(wk);
  updateImbalanceChartHighlight(weekKey);
  updateStaffReqAvailHighlight(weekKey);
}

function clearWeekFilter() {
  SELECTED_WEEK = null;

  // Deselect all cells
  document.querySelectorAll('.hm-cell').forEach(el => el.classList.remove('selected'));

  // Hide banner + drilldown
  document.getElementById('week-banner').classList.add('hidden');
  document.getElementById('week-drilldown').classList.add('hidden');

  // Restore annual KPIs
  loadKPIs();

  // Restore charts without highlight
  updateImbalanceChartHighlight(null);
  updateStaffReqAvailHighlight(null);
}

// ── Week Banner ───────────────────────────────────────────────
function showWeekBanner(wk) {
  const banner = document.getElementById('week-banner');
  banner.classList.remove('hidden');

  document.getElementById('wb-title').textContent = `${wk.week} — ${wk.week_start} to ${wk.week_end}`;
  document.getElementById('wb-sub').textContent   = `${wk.month} 2026 · Click another week to compare, or reset to annual view`;

  const gapColorCls = gapClass(wk.gap);
  const chips = [
    { label: `FTE Required: ${fmtFte(wk.required)}`, cls: 'warn' },
    { label: `Available: ${wk.available}`,            cls: 'ok' },
    { label: `Gap: ${wk.gap > 0 ? '+' : ''}${fmtFte(wk.gap)}`, cls: gapColorCls },
    { label: `Utilisation: ${wk.utilisation}%`,       cls: wk.utilisation > 110 ? 'crit' : wk.utilisation > 90 ? 'warn' : 'ok' },
    { label: `Absent: ${wk.absent_count}`,            cls: wk.absent_count > 3 ? 'warn' : 'ok' },
  ];
  document.getElementById('wb-chips').innerHTML =
    chips.map(c => `<span class="wb-chip ${c.cls}">${c.label}</span>`).join('');
}

// ── KPI Cards — week override ────────────────────────────────
function updateKPIsForWeek(wk) {
  const label = `(${wk.week})`;

  // flights for this week: sum categories
  const flights = Object.values(wk.categories || {}).reduce((a,b) => a+b, 0);

  document.getElementById('v-annual').textContent     = fmt(Math.round(flights));
  document.getElementById('kpi-annual-flights').querySelector('.kpi-label').textContent = `Flights This Week`;

  document.getElementById('v-avg-weekly').textContent = fmtFte(wk.required);
  document.getElementById('kpi-avg-weekly').querySelector('.kpi-label').textContent = `FTE Required ${label}`;

  document.getElementById('v-peak-month').textContent = wk.month + ' 2026';
  document.getElementById('kpi-peak-month').querySelector('.kpi-label').textContent = 'Selected Month';

  document.getElementById('v-peak-week').textContent  = wk.week;
  document.getElementById('kpi-peak-week').querySelector('.kpi-label').textContent  = 'Selected Week';

  const util = wk.utilisation;
  document.getElementById('v-util').textContent       = util + '%';
  document.getElementById('kpi-util').querySelector('.kpi-label').textContent = `Utilisation ${label}`;

  document.getElementById('v-total-staff').textContent = wk.available;
  document.getElementById('kpi-total-staff').querySelector('.kpi-label').textContent = `Staff Available ${label}`;

  // Gate util for this week: total flights / weekly gate capacity
  const weekFlights = Object.values(wk.categories || {}).reduce((a,b) => a+b, 0);
  const gateUtil = ((weekFlights / 2) / (142 * 3 * 7) * 100).toFixed(1);
  document.getElementById('v-gate-util').textContent = gateUtil + '%';
  document.getElementById('kpi-gate-util').querySelector('.kpi-label').textContent = `Gate Utilisation ${label}`;
}

// ── Drill-down Panel ─────────────────────────────────────────
function showDrilldown(wk) {
  const panel = document.getElementById('week-drilldown');
  panel.classList.remove('hidden');

  document.getElementById('dd-week-label').textContent =
    `${wk.week} · ${wk.week_start} – ${wk.week_end}`;

  const statusBadge = document.getElementById('dd-status-badge');
  if (wk.gap > 0) {
    statusBadge.textContent   = 'Surplus';
    statusBadge.className     = 'dd-badge badge-ok';
  } else if (wk.gap === 0) {
    statusBadge.textContent   = 'Balanced';
    statusBadge.className     = 'dd-badge badge-warn';
  } else {
    statusBadge.textContent   = 'Shortfall';
    statusBadge.className     = 'dd-badge badge-crit';
  }

  document.getElementById('dd-required').textContent  = fmtFte(wk.required);
  document.getElementById('dd-available').textContent = wk.available;

  const gapEl = document.getElementById('dd-gap');
  gapEl.textContent  = (wk.gap > 0 ? '+' : '') + fmtFte(wk.gap);
  gapEl.style.color  = gapColor(wk.gap);

  const utilEl = document.getElementById('dd-util');
  utilEl.textContent = wk.utilisation + '%';
  utilEl.style.color = wk.utilisation > 110 ? DAA.crit : wk.utilisation > 90 ? DAA.warn : DAA.ok;

  document.getElementById('dd-absent').textContent = wk.absent_count;

  // Drill-down skill bar chart
  renderDDSkillBar(wk.skills);

  // Drill-down category chart
  renderDDCatChart(wk.categories);

  // Absence table
  renderAbsenceTable(wk.absent_staff);
}

function renderDDSkillBar(skills) {
  const isDark = window.getCurrentTheme && window.getCurrentTheme() === 'dark';
  destroyChart('dd-skill-bar');
  const labels = Object.keys(skills);
  const data   = Object.values(skills);
  const ctx    = document.getElementById('dd-skill-bar').getContext('2d');
  CHARTS['dd-skill-bar'] = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: labels.map(l => SKILL_COLOR[l] || DAA.muted),
        borderRadius: 4,
        borderSkipped: false,
      }],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#061729', borderColor: DAA.accent, borderWidth: 1,
          callbacks: { label: ctx => ` ${ctx.parsed.x.toFixed(1)} FTE` },
        },
      },
      scales: {
        x: { 
          grid: { color: isDark ? 'rgba(255,255,255,0.1)' : '#e5e7eb' }, 
          ticks: { color: DAA.white() },
          title: { display:true, text:'FTE', color: DAA.white() } 
        },
        y: { 
          grid: { display: false },
          ticks: { color: DAA.white() }
        },
      },
    },
  });
}

function renderDDCatChart(categories) {
  const isDark = window.getCurrentTheme && window.getCurrentTheme() === 'dark';
  destroyChart('dd-cat-chart');
  const labels = Object.keys(categories);
  const data   = Object.values(categories);
  const ctx    = document.getElementById('dd-cat-chart').getContext('2d');
  CHARTS['dd-cat-chart'] = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: labels.map(l => CAT_COLOR[l] || DAA.muted),
        borderColor: '#ffffff', borderWidth: 2, hoverOffset: 6,
      }],
    },
    options: {
      responsive: true, cutout: '55%',
      plugins: {
        legend: { labels: { color: DAA.white(), usePointStyle: true, boxWidth: 10 }, position: 'right' },
        tooltip: {
          backgroundColor: '#061729', borderColor: DAA.accent, borderWidth: 1,
          callbacks: { label: ctx => ` ${fmt(ctx.parsed)} movements` },
        },
      },
      scales: {
        x: { grid: { color: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.05)' }, ticks: { color: DAA.white() } },
        y: { grid: { color: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.05)' }, ticks: { color: DAA.white() } }
      }
    },
  });
}

function renderAbsenceTable(absent) {
  const tbody = document.getElementById('dd-absence-body');
  if (!absent || absent.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" style="color:var(--muted);text-align:center">No absences this week</td></tr>';
    return;
  }
  tbody.innerHTML = absent.map(a => `
    <tr>
      <td>${a.id}</td>
      <td><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${SKILL_COLOR[a.skill]||'#888'};margin-right:6px;"></span>${a.skill}</td>
      <td><span class="badge ${a.leave.includes('Annual') ? 'badge-ok' : 'badge-warn'}">${a.leave}</span></td>
    </tr>`).join('');
}

// ═════════════════════════════════════════════════════════════
// ANNUAL CHARTS  (highlight selected week when set)
// ═════════════════════════════════════════════════════════════

// ── KPI Cards (annual) ────────────────────────────────────────
async function loadKPIs() {
  const d = await api('/api/long-term/summary');

  document.getElementById('v-annual').textContent     = fmt(d.annual_flights);
  document.getElementById('kpi-annual-flights').querySelector('.kpi-label').textContent = 'Annual Flights 2026';

  document.getElementById('v-avg-weekly').textContent = fmt(d.avg_weekly_flights);
  document.getElementById('kpi-avg-weekly').querySelector('.kpi-label').textContent     = 'Avg Weekly Flights';

  document.getElementById('v-peak-month').textContent = d.peak_month;
  document.getElementById('kpi-peak-month').querySelector('.kpi-label').textContent     = 'Peak Month';

  document.getElementById('v-peak-week').textContent  = d.peak_week;
  document.getElementById('kpi-peak-week').querySelector('.kpi-label').textContent      = 'Peak Week';

  document.getElementById('v-util').textContent       = d.staff_utilisation_pct + '%';
  document.getElementById('kpi-util').querySelector('.kpi-label').textContent           = 'Staff Utilisation %';

  document.getElementById('v-total-staff').textContent = d.total_staff;
  document.getElementById('kpi-total-staff').querySelector('.kpi-label').textContent    = 'Total Workforce';

  document.getElementById('v-gate-util').textContent = d.gate_utilisation_pct + '%';
  document.getElementById('kpi-gate-util').querySelector('.kpi-label').textContent     = 'Gate Utilisation %';
}

// ── Calendar Heatmap ─────────────────────────────────────────
function utilClass(u) {
  if (u <= 70)  return 'ok';
  if (u <= 90)  return 'warn';
  if (u <= 110) return 'high';
  return 'crit';
}

async function loadCalendarHeatmap() {
  ALL_WEEKS = await api('/api/long-term/demand-heatmap');
  renderHeatmap();
}

function renderHeatmap() {
  const container = document.getElementById('calendar-heatmap');
  const MONTHS    = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  const byMonth = {};
  MONTHS.forEach(m => byMonth[m] = []);
  ALL_WEEKS.forEach(w => { if (byMonth[w.month]) byMonth[w.month].push(w); });

  const maxRows = Math.max(...MONTHS.map(m => byMonth[m].length), 5);

  const grid = document.createElement('div');
  grid.className = 'heatmap-grid';
  grid.style.gridTemplateColumns = `60px repeat(12, 1fr)`;

  // Month headers
  const blank = document.createElement('div');
  blank.className = 'hm-header';
  grid.appendChild(blank);
  MONTHS.forEach(m => {
    const h = document.createElement('div');
    h.className = 'hm-header';
    h.textContent = m;
    grid.appendChild(h);
  });

  // Rows
  for (let wi = 0; wi < maxRows; wi++) {
    const lbl = document.createElement('div');
    lbl.className    = 'hm-row-label';
    lbl.textContent  = `Wk ${wi + 1}`;
    grid.appendChild(lbl);

    MONTHS.forEach(m => {
      const cell = document.createElement('div');
      const w    = byMonth[m][wi];
      if (!w) {
        cell.className = 'hm-cell empty';
      } else {
        const uc = utilClass(w.utilisation);
        cell.className      = `hm-cell hm-${uc}`;
        cell.dataset.util   = uc;
        cell.dataset.week   = w.week;
        if (SELECTED_WEEK === w.week) cell.classList.add('selected');

        // Top skill for tooltip
        const topSkill = w.skills
          ? Object.entries(w.skills).sort((a,b) => b[1]-a[1])[0]
          : null;

        const ttHtml = `
            <div class="hm-tt-title">${w.week} &middot; ${w.week_start}</div>
            <div>Required: <b>${w.required}</b></div>
            <div>Available: <b>${w.available}</b></div>
            <div>Gap: <b style="color:${w.gap>0?'#ef4444':'#10b981'}">${w.gap>0?'+':''}${w.gap}</b></div>
            <div>Utilisation: <b>${w.utilisation}%</b></div>
            ${topSkill ? `<div>Top: <b>${topSkill[0]}</b></div>` : ''}
          `;

        cell.innerHTML = `<span class="hm-pct">${Math.round(w.utilisation)}%</span>`;

        cell.addEventListener('mouseenter', () => {
          let globalTt = document.getElementById('global-hm-tooltip');
          if (!globalTt) {
            globalTt = document.createElement('div');
            globalTt.id = 'global-hm-tooltip';
            globalTt.className = 'hm-tooltip';
            globalTt.style.position = 'fixed';
            globalTt.style.zIndex = '99999';
            document.body.appendChild(globalTt);
          }
          globalTt.innerHTML = ttHtml;
          globalTt.style.display = 'block';
          const rect = cell.getBoundingClientRect();
          globalTt.style.left = (rect.left + rect.width / 2) + 'px';
          globalTt.style.bottom = (window.innerHeight - rect.top + 8) + 'px';
        });

        cell.addEventListener('mouseleave', () => {
          const globalTt = document.getElementById('global-hm-tooltip');
          if (globalTt) globalTt.style.display = 'none';
        });

        cell.addEventListener('click', () => selectWeek(w.week));
      }
      grid.appendChild(cell);
    });
  }

  container.innerHTML = '';
  container.appendChild(grid);
}

// ── Flight Trend Chart ────────────────────────────────────────
async function loadFlightTrendChart() {
  const isDark = window.getCurrentTheme && window.getCurrentTheme() === 'dark';
  const data = await api('/api/long-term/flight-trend');
  destroyChart('flight-trend');
  const ctx = document.getElementById('flight-trend-chart').getContext('2d');
  CHARTS['flight-trend'] = new Chart(ctx, {
    type: 'line',
    data: {
      labels: data.map(d => d.month),
      datasets: [
        {
          label: '2025 Historical',
          data: data.map(d => d.historical),
          borderColor: DAA.muted,
          backgroundColor: 'rgba(139,165,192,.1)',
          borderDash: [5, 3],
          tension: 0.4, fill: true, pointRadius: 3,
        },
        {
          label: '2026 Forecast',
          data: data.map(d => d.forecast),
          borderColor: DAA.accent,
          backgroundColor: 'rgba(232,133,10,.15)',
          tension: 0.4, fill: true, pointRadius: 4,
          pointBackgroundColor: DAA.accent,
        },
      ],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { labels: { color: DAA.white(), usePointStyle: true } },
        tooltip: { backgroundColor: '#061729', borderColor: DAA.accent, borderWidth: 1 },
      },
      scales: {
        x: { grid: { color: isDark ? 'rgba(255,255,255,0.15)' : '#e5e7eb' }, ticks: { color: DAA.white() } },
        y: { 
          grid: { color: isDark ? 'rgba(255,255,255,0.15)' : '#e5e7eb' }, 
          ticks: { color: DAA.white(), callback: v => fmt(v) } 
        },
      },
    },
  });
}

// ── Staff Required vs Available Chart ────────────────────────
async function loadStaffReqAvailChart() {
  const isDark = window.getCurrentTheme && window.getCurrentTheme() === 'dark';
  const monthly = {};
  ALL_WEEKS.forEach(w => {
    if (!monthly[w.month]) monthly[w.month] = { req: [], avail: [] };
    monthly[w.month].req.push(w.required);
    monthly[w.month].avail.push(w.available);
  });
  const avg    = a => a.reduce((s, v) => s + v, 0) / a.length;
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const reqs   = MONTHS.map(m => monthly[m] ? +avg(monthly[m].req).toFixed(1) : 0);
  const avails = MONTHS.map(m => monthly[m] ? +avg(monthly[m].avail).toFixed(1) : 0);

  destroyChart('staff-req-avail');
  const ctx = document.getElementById('staff-req-avail-chart').getContext('2d');
  CHARTS['staff-req-avail'] = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: MONTHS,
      datasets: [
        {
          label: 'FTE Required',
          data: reqs,
          backgroundColor: MONTHS.map(() => 'rgba(232,133,10,.7)'),
          borderColor: DAA.accent, borderWidth: 1, borderRadius: 3,
        },
        {
          label: 'Staff Available',
          data: avails,
          backgroundColor: 'rgba(52,152,219,.4)', borderColor: DAA.info,
          borderWidth: 1, borderRadius: 3, type: 'line',
          tension: 0.4, pointRadius: 4, fill: false,
          pointBackgroundColor: DAA.info,
        },
      ],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { labels: { color: DAA.white(), usePointStyle: true } },
        tooltip: { backgroundColor: '#061729', borderColor: DAA.accent, borderWidth: 1 },
      },
      scales: {
        x: { grid: { color: isDark ? 'rgba(255,255,255,0.1)' : '#e5e7eb' }, ticks: { color: DAA.white() } },
        y: { grid: { color: isDark ? 'rgba(255,255,255,0.1)' : '#e5e7eb' }, ticks: { color: DAA.white() } },
      },
    },
  });
}

// Highlight selected week month in Staff Req/Avail chart
function updateStaffReqAvailHighlight(weekKey) {
  const chart = CHARTS['staff-req-avail'];
  if (!chart) return;

  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  let highlightMonth = null;
  if (weekKey) {
    const wk = ALL_WEEKS.find(w => w.week === weekKey);
    if (wk) highlightMonth = wk.month;
  }

  chart.data.datasets[0].backgroundColor = MONTHS.map(m =>
    highlightMonth
      ? (m === highlightMonth ? 'rgba(232,133,10,1)' : 'rgba(232,133,10,.25)')
      : 'rgba(232,133,10,.7)'
  );
  chart.update();
}

// ── Imbalance Chart ───────────────────────────────────────────
async function loadImbalanceChart() {
  ALL_IMBALANCE = await api('/api/long-term/imbalance');
  renderImbalanceChart(null);
  renderGapDonut();
  renderGapTable(null);
}

function renderImbalanceChart(selectedWeek) {
  const isDark = window.getCurrentTheme && window.getCurrentTheme() === 'dark';
  destroyChart('imbalance');
  const ctx = document.getElementById('imbalance-chart').getContext('2d');
  CHARTS['imbalance'] = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: ALL_IMBALANCE.map(d => d.date),
      datasets: [{
        label: 'Gap (FTE)',
        data: ALL_IMBALANCE.map(d => d.gap),
        backgroundColor: ALL_IMBALANCE.map(d => {
          const isSelected = selectedWeek && d.week === selectedWeek;
          const alpha = selectedWeek && !isSelected ? '.2' : '.75';
          if (d.gap > 0) return isSelected ? '#2ecc71' : `rgba(46,204,113,${alpha})`;
          if (d.gap === 0) return isSelected ? '#f39c12' : `rgba(243,156,18,${alpha})`;
          return isSelected ? '#e74c3c' : `rgba(231,76,60,${alpha})`;
        }),
        borderColor: ALL_IMBALANCE.map(d =>
          selectedWeek && d.week === selectedWeek
            ? '#fff'
            : d.gap > 0 ? '#2ECC71' : d.gap === 0 ? '#F39C12' : '#E74C3C'
        ),
        borderWidth: ALL_IMBALANCE.map(d => selectedWeek && d.week === selectedWeek ? 2 : 1),
        borderRadius: 2,
      }],
    },
    options: {
      responsive: true,
      onClick: (evt, elements) => {
        if (elements.length > 0) {
          const idx = elements[0].index;
          selectWeek(ALL_IMBALANCE[idx].week);
          // Switch to Demand tab to show drilldown
          document.querySelectorAll('.sub-tab').forEach(t => t.classList.remove('active'));
          document.querySelectorAll('.sub-view').forEach(v => v.classList.remove('active'));
          document.querySelector('[data-sub="demand"]').classList.add('active');
          document.getElementById('sub-demand').classList.add('active');
        }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#061729', borderColor: DAA.accent, borderWidth: 1,
          callbacks: {
            label: ctx => ` Gap: ${ctx.parsed.y > 0 ? '+' : ''}${ctx.parsed.y.toFixed(1)} FTE`,
            afterLabel: ctx => {
              const d = ALL_IMBALANCE[ctx.dataIndex];
              return [`Required: ${d.required}`, `Available: ${d.available}`, `Click to drill down`];
            },
          },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: DAA.white() } },
        y: { 
          grid: { color: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.05)' },
          ticks: { color: DAA.white() }
        }
      },
    },
  });
}

function updateImbalanceChartHighlight(weekKey) {
  renderImbalanceChart(weekKey);
  renderGapTable(weekKey);
}

function renderGapDonut() {
  destroyChart('gap-donut');
  let ok = 0, warn = 0, crit = 0;
  ALL_IMBALANCE.forEach(d => {
    if (d.gap > 0) ok++;
    else if (d.gap === 0) warn++;
    else crit++;
  });
  const ctx = document.getElementById('gap-donut-chart').getContext('2d');
  CHARTS['gap-donut'] = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Surplus', 'Balanced', 'Shortfall'],
      datasets: [{
        data: [ok, warn, crit],
        backgroundColor: ['rgba(46,204,113,.7)', 'rgba(243,156,18,.7)', 'rgba(231,76,60,.7)'],
        borderColor: ['#2ECC71','#F39C12','#E74C3C'],
        borderWidth: 2, hoverOffset: 6,
      }],
    },
    options: {
      responsive: true, cutout: '65%',
      plugins: {
        legend: { labels: { color: DAA.white(), usePointStyle: true }, position: 'right', labels: { boxWidth: 8, font: {size: 10} } },
        tooltip: { backgroundColor: '#061729', borderColor: DAA.accent, borderWidth: 1 },
      },
    },
  });
}

function renderGapTable(selectedWeek) {
  const tbody = document.getElementById('gap-table-body');
  tbody.innerHTML = '';
  ALL_IMBALANCE.forEach(d => {
    const tr       = document.createElement('tr');
    const isSelected = selectedWeek && d.week === selectedWeek;
    if (isSelected) {
      tr.style.cssText = `background:rgba(232,133,10,.12); outline:1px solid ${DAA.accent};`;
    }
    const badgeMeta = gapBadge(d.gap);
    const gapCol = gapColor(d.gap);
    tr.innerHTML = `
      <td>${isSelected ? '▶ ' : ''}${d.week}</td>
      <td>${d.date}</td><td>${d.month}</td>
      <td>${d.required}</td><td>${d.available}</td>
      <td style="color:${gapCol};font-weight:700">${d.gap>0?'+':''}${d.gap}</td>
      <td><span class="badge ${badgeMeta.cls}">${badgeMeta.text}</span></td>`;
    tr.style.cursor = 'pointer';
    tr.addEventListener('click', () => {
      document.querySelectorAll('.sub-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.sub-view').forEach(v => v.classList.remove('active'));
      document.querySelector('[data-sub="demand"]').classList.add('active');
      document.getElementById('sub-demand').classList.add('active');
      selectWeek(d.week);
    });
    tbody.appendChild(tr);
    if (isSelected) tr.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
}

// ── Allocation Table ──────────────────────────────────────────
const GATE_COLOR = {
  'Pier 1 (T1)':   '#3498DB',
  'Pier 2 (T1)':   '#2980B9',
  'Pier 3 (T1)':   '#1ABC9C',
  'Pier 4 (T2)':   '#9B59B6',
  'Remote Apron':  '#E8850A',
  'Cargo Apron':   '#7F8C8D',
};

async function loadAllocationTable() {
  ALLOC_DATA = await api('/api/long-term/staff-allocation');
  const { months, skills } = ALLOC_DATA;

  const maxReq = Math.max(...months.map(m => m.total_required));
  const minReq = Math.min(...months.map(m => m.total_required));

  function heatClass(v, mn, mx) {
    const r = mx > mn ? (v - mn) / (mx - mn) : 0;
    if (r < 0.2)  return 'cell-heat-0';
    if (r < 0.45) return 'cell-heat-1';
    if (r < 0.65) return 'cell-heat-2';
    if (r < 0.85) return 'cell-heat-3';
    return 'cell-heat-4';
  }

  document.getElementById('alloc-head').innerHTML = `<tr>
    <th>Role / Skill</th>
    ${months.map(m => `<th>${m.month}</th>`).join('')}
  </tr>`;

  const tbody = document.getElementById('alloc-body');
  tbody.innerHTML = '';

  const skillMaxes = {}, skillMins = {};
  skills.forEach(sk => {
    const vals = months.map(m => m[sk] || 0).filter(v => v > 0);
    skillMaxes[sk] = vals.length ? Math.max(...vals) : 1;
    skillMins[sk]  = vals.length ? Math.min(...vals) : 0;
  });

  skills.forEach(sk => {
    const dot = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${SKILL_COLOR[sk]||'#888'};margin-right:6px;"></span>`;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${dot}${sk}</td>` +
      months.map(m => {
        const v = m[sk] || 0;
        const cls = v > 0 ? heatClass(v, skillMins[sk], skillMaxes[sk]) : '';
        return `<td class="${cls}">${v > 0 ? v.toFixed(1) : '—'}</td>`;
      }).join('');
    tbody.appendChild(tr);
  });

  [
    { label: 'Total FTE Required', key: 'total_required', fmt: v => v.toFixed(1),
      style: m => heatClass(m.total_required, minReq, maxReq), border: true },
    { label: 'Staff Available (avg/wk)', key: 'total_available',
      fmt: v => v.toFixed(1), style: () => '', color: '#3498DB', border: false },
    { label: 'Gap (FTE)', key: 'gap',
      fmt: v => (v > 0 ? '+' : '') + v.toFixed(1),
      style: () => '', color: m => gapColor(m.gap),
      border: false },
  ].forEach(row => {
    const tr = document.createElement('tr');
    if (row.border) tr.style.cssText = 'font-weight:700; border-top:2px solid rgba(0,0,0,.10)';
    else tr.style.fontWeight = '700';
    tr.innerHTML = `<td>${row.label}</td>` +
      months.map(m => {
        const v   = m[row.key];
        const cls = typeof row.style === 'function' ? row.style(m) : '';
        const col = typeof row.color === 'function' ? row.color(m) : (row.color || '');
        return `<td class="${cls}" style="color:${col}">${row.fmt(v)}</td>`;
      }).join('');
    tbody.appendChild(tr);
  });

  // ── Gate headcount table ──────────────────────────────────────
  renderGateAllocationTable(ALLOC_DATA);
}

function renderGateAllocationTable(allocData) {
  const { months, by_gate } = allocData;
  if (!by_gate || !by_gate.length) return;

  // Collect all values for heat scaling per gate row
  function gateHeatClass(v, mn, mx) {
    const r = mx > mn ? (v - mn) / (mx - mn) : 0;
    if (r < 0.2)  return 'cell-heat-0';
    if (r < 0.45) return 'cell-heat-1';
    if (r < 0.65) return 'cell-heat-2';
    if (r < 0.85) return 'cell-heat-3';
    return 'cell-heat-4';
  }

  document.getElementById('gate-alloc-head').innerHTML = `<tr>
    <th>Gate / Pier Area</th>
    ${months.map(m => `<th>${m.month}</th>`).join('')}
  </tr>`;

  const gtbody = document.getElementById('gate-alloc-body');
  gtbody.innerHTML = '';

  by_gate.forEach(g => {
    const nonZero = g.values.filter(v => v > 0);
    const gMax = nonZero.length ? Math.max(...nonZero) : 1;
    const gMin = nonZero.length ? Math.min(...nonZero) : 0;

    const dot = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${GATE_COLOR[g.gate]||'#888'};margin-right:6px;"></span>`;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${dot}${g.gate}</td>` +
      g.values.map(v => {
        const cls = v > 0 ? gateHeatClass(v, gMin, gMax) : '';
        return `<td class="${cls}">${v > 0 ? v.toFixed(1) : '—'}</td>`;
      }).join('');
    gtbody.appendChild(tr);
  });

  // Total gate headcount row
  const totals = months.map((_, i) => by_gate.reduce((s, g) => s + (g.values[i] || 0), 0));
  const maxTot = Math.max(...totals), minTot = Math.min(...totals);
  const trTot = document.createElement('tr');
  trTot.style.cssText = 'font-weight:700; border-top:2px solid rgba(0,0,0,.10)';
  trTot.innerHTML = `<td>Total Gate Headcount</td>` +
    totals.map(v => {
      const r = maxTot > minTot ? (v - minTot) / (maxTot - minTot) : 0;
      const cls = r < 0.2 ? 'cell-heat-0' : r < 0.45 ? 'cell-heat-1' : r < 0.65 ? 'cell-heat-2' : r < 0.85 ? 'cell-heat-3' : 'cell-heat-4';
      return `<td class="${cls}">${v.toFixed(1)}</td>`;
    }).join('');
  gtbody.appendChild(trTot);

  // Staff Available row
  const trAvail = document.createElement('tr');
  trAvail.style.fontWeight = '700';
  trAvail.innerHTML = `<td>Staff Available (avg/wk)</td>` +
    months.map(m => `<td style="color:#3498DB">${(m.total_available || 0).toFixed(1)}</td>`).join('');
  gtbody.appendChild(trAvail);

  // Gap row
  const trGap = document.createElement('tr');
  trGap.style.fontWeight = '700';
  trGap.innerHTML = `<td>Gap (FTE)</td>` +
    months.map(m => {
      const g = m.gap || 0;
      return `<td style="color:${gapColor(g)}">${(g > 0 ? '+' : '') + g.toFixed(1)}</td>`;
    }).join('');
  gtbody.appendChild(trGap);
}

async function loadSkillBarChart() {
  const isDark = window.getCurrentTheme && window.getCurrentTheme() === 'dark';
  const { months, skills } = await api('/api/long-term/staff-allocation');
  destroyChart('skill-bar');
  const ctx = document.getElementById('skill-bar-chart').getContext('2d');
  CHARTS['skill-bar'] = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: months.map(m => m.month),
      datasets: skills.map(sk => ({
        label: sk,
        data: months.map(m => (m[sk] || 0)),
        backgroundColor: SKILL_COLOR[sk] || DAA.muted,
      }))
    },
    options: {
      responsive: true,
      plugins: {
        legend: { labels: { color: DAA.white(), usePointStyle: true, boxWidth: 10 }, position: 'right' },
        tooltip: { backgroundColor: '#061729', borderColor: DAA.accent, borderWidth: 1, mode: 'index' },
      },
      scales: {
        x: { stacked: true, grid: { color: isDark ? 'rgba(255,255,255,0.1)' : '#e5e7eb' }, ticks: { color: DAA.white() } },
        y: { stacked: true, grid: { color: isDark ? 'rgba(255,255,255,0.1)' : '#e5e7eb' },
             title: { display: true, text: 'FTE Required', color: DAA.white() },
             ticks: { color: DAA.white() } },
      },
    },
  });
}

// ── Skill Distribution ────────────────────────────────────────
async function loadSkillCharts() {
  const isDark = window.getCurrentTheme && window.getCurrentTheme() === 'dark';
  const d = await api('/api/long-term/skill-breakdown');

  destroyChart('skill-donut');
  const skills = Object.keys(d.total_by_skill);
  const ctx1   = document.getElementById('skill-donut-chart').getContext('2d');
  CHARTS['skill-donut'] = new Chart(ctx1, {
    type: 'doughnut',
    data: {
      labels: skills,
      datasets: [{
        data: skills.map(s => d.total_by_skill[s]),
        backgroundColor: skills.map(s => SKILL_COLOR[s] || '#888'),
        borderColor: '#ffffff', borderWidth: 2, hoverOffset: 6,
      }],
    },
    options: {
      responsive: true, cutout: '60%',
      plugins: {
        legend: { labels: { color: DAA.white(), usePointStyle: true }, position: 'bottom' },
        tooltip: { backgroundColor: '#061729', borderColor: DAA.accent, borderWidth: 1 },
      },
    },
  });

  destroyChart('absence-bar');
  const months     = ['Jan 2026','Feb 2026','Mar 2026','Apr 2026','May 2026','Jun 2026',
                      'Jul 2026','Aug 2026','Sep 2026','Oct 2026','Nov 2026','Dec 2026'];
  const absDatasets = skills.map(sk => ({
    label: sk,
    data: months.map(m => (d.monthly_absent[m] || {})[sk] || 0),
    backgroundColor: SKILL_COLOR[sk] || '#888',
    stack: 'abs', borderRadius: 2,
  }));
  const ctx2 = document.getElementById('absence-bar-chart').getContext('2d');
  CHARTS['absence-bar'] = new Chart(ctx2, {
    type: 'bar',
    data: { labels: months.map(m => m.replace(' 2026','')), datasets: absDatasets },
    options: {
      responsive: true,
      plugins: {
        legend: { labels: { color: DAA.white(), usePointStyle: true, boxWidth: 10 }, position: 'right', labels: { boxWidth: 8, font: {size: 10} } },
        tooltip: { backgroundColor: '#061729', borderColor: DAA.accent, borderWidth: 1, mode: 'index' },
      },
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { color: DAA.white() } },
        y: { stacked: true, grid: { color: isDark ? 'rgba(255,255,255,0.1)' : '#e5e7eb' },
             title: { display: true, text: 'Absence Days', color: DAA.white() },
             ticks: { color: DAA.white() } },
      },
    },
  });
}


// ═════════════════════════════════════════════════════════════
// BOOT
// ═════════════════════════════════════════════════════════════
async function boot() {
  setLiveDate();

  // Load heatmap first so ALL_WEEKS is populated for dependent charts
  await loadCalendarHeatmap();

  await Promise.all([
    loadKPIs(),
    loadFlightTrendChart(),
    loadStaffReqAvailChart(),
    loadAllocationTable(),
    loadSkillBarChart(),


  ]);
}


boot().catch(console.error);

// ── Gap & Skill Analysis — Merged View ────────────────────────
async function initGapSkillAnalysis() {
  const d = await api('/api/long-term/gap-skill-data');
  
  // Update shared state if needed
  ALL_IMBALANCE = d.weekly;

  renderSkillGapBarChart(d);
// renderMergedGapDonut(d.weekly);
// renderMergedSkillDonut(d.total_by_skill);
  renderWeeklyGapTable(d);
  renderSkillSummaryTable(d.skill_summary);
  renderMergedAbsenceBar(d);
}

function renderSkillGapBarChart(data) {
  const isDark = window.getCurrentTheme && window.getCurrentTheme() === 'dark';
  destroyChart('skill-gap-bar');
  const ctx = document.getElementById('skill-gap-bar-chart').getContext('2d');
  
  const datasets = data.skills.map(sk => ({
    label: sk,
    data: data.weekly.map(w => w.skill_gaps[sk] || 0),
    backgroundColor: SKILL_COLOR[sk] || DAA.muted,
    stack: 'gap',
    borderRadius: 2,
  }));

  CHARTS['skill-gap-bar'] = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: data.weekly.map(w => w.date),
      datasets: datasets
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'right', labels: { color: DAA.white(), boxWidth: 8, font: {size: 10}, usePointStyle: true } },
        tooltip: { mode: 'index', backgroundColor: '#061729', borderColor: DAA.accent, borderWidth: 1 }
      },
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { color: DAA.white() } },
        y: { stacked: true, grid: { color: isDark ? 'rgba(255,255,255,0.15)' : '#e5e7eb' }, title: { display: true, text: 'FTE Gap (Available - Required)', color: DAA.white() }, ticks: { color: DAA.white() } }
      }
    }
  });
}

function renderMergedGapDonut(weekly) {
  destroyChart('merged-gap-donut');
  let ok = 0, warn = 0, crit = 0;
  weekly.forEach(d => {
    if (d.gap > 0) ok++;
    else if (d.gap === 0) warn++;
    else crit++;
  });
  const ctx = document.getElementById('merged-gap-donut').getContext('2d');
  CHARTS['merged-gap-donut'] = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Surplus', 'Balanced', 'Shortfall'],
      datasets: [{
        data: [ok, warn, crit],
        backgroundColor: ['rgba(46,204,113,.7)', 'rgba(243,156,18,.7)', 'rgba(231,76,60,.7)'],
        borderColor: ['#2ECC71','#F39C12','#E74C3C'],
        borderWidth: 2, hoverOffset: 6,
      }],
    },
    options: {
      responsive: true, cutout: '75%',
      plugins: {
        legend: { labels: { color: DAA.white(), usePointStyle: true }, position: 'right', labels: { boxWidth: 8, font: {size: 10} } },
      },
    },
  });
}

function renderMergedSkillDonut(pool) {
  destroyChart('merged-skill-donut');
  const labels = Object.keys(pool);
  const data = Object.values(pool);
  const ctx = document.getElementById('merged-skill-donut').getContext('2d');
  CHARTS['merged-skill-donut'] = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: labels.map(l => SKILL_COLOR[l] || '#888'),
        borderColor: '#ffffff', borderWidth: 2,
      }],
    },
    options: {
      responsive: true, cutout: '75%',
      plugins: {
        legend: { labels: { color: DAA.white(), usePointStyle: true }, position: 'right', labels: { boxWidth: 8, font: {size: 10} } },
      },
    },
  });
}

function renderWeeklyGapTable(data) {
  const head = document.getElementById('weekly-gap-head');
  const body = document.getElementById('weekly-gap-body');

  // Build header
  let hHtml = `<th>Week</th><th>Total Gap</th>`;
  data.skills.forEach(sk => {
     hHtml += `<th>${sk}</th>`;
  });
  head.innerHTML = hHtml;

  // Build body
  body.innerHTML = data.weekly.map(w => {
    let row = `<tr>
      <td><span style="font-weight:700">${w.week}</span> <span style="font-size:0.7rem;color:var(--muted)">(${w.date})</span></td>
      <td style="font-weight:700; color:${gapColor(w.gap)}">${w.gap > 0 ? '+' : ''}${w.gap}</td>
    `;
    data.skills.forEach(sk => {
      const g = w.skill_gaps[sk] || 0;
      const col = gapColor(g);
      row += `<td style="color:${col}">${g > 0 ? '+' : ''}${g}</td>`;
    });
    row += `</tr>`;
    return row;
  }).join('');
}


function renderSkillSummaryTable(summary) {
  const body = document.getElementById('skill-summary-body');
  body.innerHTML = (summary || []).map(s => {
    const avgCol = gapColor(s.avg_gap);
    const peakCol = gapColor(s.peak_gap);

    return `
      <tr>
        <td style="font-weight:600; color:${avgCol}">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${SKILL_COLOR[s.skill]||'#888'};margin-right:8px;"></span>
          ${s.skill}
        </td>
        <td>${s.avg_avail}</td>
        <td>${s.avg_req}</td>
        <td style="color:${avgCol}">${s.avg_gap > 0 ? '+' : ''}${s.avg_gap}</td>
        <td>${s.peak_avail}</td>
        <td>${s.peak_req}</td>
        <td style="color:${peakCol}">${s.peak_gap > 0 ? '+' : ''}${s.peak_gap}</td>
        <td><span class="badge badge-${s.status === 'critical' ? 'crit' : (s.status === 'warning' ? 'warn' : 'ok')}">${s.status === 'ok' ? 'Surplus' : (s.status === 'warning' ? 'Balanced' : 'Shortfall')}</span></td>
      </tr>
    `;
  }).join('');
}

function renderMergedAbsenceBar(d) {
  const isDark = DAA.isDark();
  destroyChart('merged-absence');
  const months = ['Jan 2026','Feb 2026','Mar 2026','Apr 2026','May 2026','Jun 2026',
                  'Jul 2026','Aug 2026','Sep 2026','Oct 2026','Nov 2026','Dec 2026'];
  const labels = months.map(m => m.replace(' 2026',''));
  const datasets = (d.skills || []).map(sk => ({
    label: sk,
    data: months.map(m => (d.monthly_absent[m] || {})[sk] || 0),
    backgroundColor: SKILL_COLOR[sk] || DAA.muted,
    stack: 'abs', borderRadius: 2,
  }));
  const ctx = document.getElementById('merged-absence-bar').getContext('2d');
  CHARTS['merged-absence'] = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: true,
      plugins: {
        legend: { labels: { color: DAA.white(), usePointStyle: true, boxWidth: 10 }, position: 'right' },
      },
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { color: DAA.white() } },
        y: { stacked: true, grid: { color: isDark ? 'rgba(255,255,255,0.1)' : '#e5e7eb' }, 
             title: { display: true, text: 'Absence Days', color: DAA.white() },
             ticks: { color: DAA.white() } }
      }
    }
  });
}

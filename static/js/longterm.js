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
  // PAX passenger-handling skills
  'Checkin':              '#2563EB',
  'Security':             '#DC2626',
  'CBP':                  '#7C3AED',
  'Lounge':               '#059669',
  'Boarding':             '#D97706',
  'Immigration':          '#0891B2',
  'Baggage':              '#4B5563',
  // Operational skills
  'GNIB':                 '#3b82f6',
  'CBP Pre-clearance':    '#8b5cf6',
  'Bussing':              '#f97316',
  'PBZ':                  '#10b981',
  'Mezz Operation':       '#0ea5e9',
  'Litter Picking':       '#ef4444',
  'Ramp / Marshalling':   '#f59e0b',
  'Arr Customer Service': '#06b6d4',
  'Check-in/Trolleys':    '#64748b',
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

function stringToColor(str) {
  if (!str) return '#888';
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h = Math.abs(hash) % 360;
  return `hsl(${h}, 65%, 45%)`;
}

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
const fmtM   = n  => {
  if (n == null || isNaN(+n)) return '—';
  return (+(n) / 1e6).toFixed(1) + 'M';
};
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
    if (view === 'config'     && typeof initConfig     === 'function') initConfig();

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
    if (tab.dataset.sub === 'four-week-roster') initFourWeekRoster();
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
  // passengers for this week (estimated by server)
  const paxThisWeek = wk.weekly_passengers || 0;
  document.getElementById('v-annual').textContent     = fmtM(paxThisWeek);
  document.getElementById('kpi-annual-flights').querySelector('.kpi-label').textContent = `Passengers This Week`;

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

  // Avg passengers handled by 1 FTE per day for this week
  const avgPaxFteDay = wk.available > 0
    ? Math.round((wk.weekly_passengers || 0) / 7 / wk.available)
    : 0;
  document.getElementById('v-gate-util').textContent = fmt(avgPaxFteDay);
  document.getElementById('kpi-gate-util').querySelector('.kpi-label').textContent = `Avg Pax / FTE / Day ${label}`;
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
          backgroundColor: labels.map(l => SKILL_COLOR[l] || stringToColor(l)),
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
      <td><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${SKILL_COLOR[a.skill]||stringToColor(a.skill)};margin-right:6px;"></span>${a.skill}</td>
      <td><span class="badge ${a.leave.includes('Annual') ? 'badge-ok' : 'badge-warn'}">${a.leave}</span></td>
    </tr>`).join('');
}

// ═════════════════════════════════════════════════════════════
// ANNUAL CHARTS  (highlight selected week when set)
// ═════════════════════════════════════════════════════════════

// ── KPI Cards (annual) ────────────────────────────────────────
async function loadKPIs() {
  const d = await api('/api/long-term/summary');

  // Show annual passenger footfall instead of flight counts (formatted in millions)
  document.getElementById('v-annual').textContent     = fmtM(d.annual_passengers || d.annual_flights);
  document.getElementById('kpi-annual-flights').querySelector('.kpi-label').textContent = 'Annual Passenger Footfall 2026';

  document.getElementById('v-avg-weekly').textContent = fmtM(d.avg_weekly_passengers || d.avg_weekly_flights);
  document.getElementById('kpi-avg-weekly').querySelector('.kpi-label').textContent     = 'Avg Weekly Passengers';

  document.getElementById('v-peak-month').textContent = d.peak_month;
  document.getElementById('kpi-peak-month').querySelector('.kpi-label').textContent     = 'Peak Month';

  document.getElementById('v-peak-week').textContent  = d.peak_week;
  document.getElementById('kpi-peak-week').querySelector('.kpi-label').textContent      = 'Peak Week';

  document.getElementById('v-util').textContent       = d.staff_utilisation_pct + '%';
  document.getElementById('kpi-util').querySelector('.kpi-label').textContent           = 'Staff Utilisation %';

  document.getElementById('v-total-staff').textContent = d.total_staff;
  document.getElementById('kpi-total-staff').querySelector('.kpi-label').textContent    = 'Total Workforce';

  document.getElementById('v-gate-util').textContent = fmt(d.avg_pax_per_fte_per_day ?? '—');
  document.getElementById('kpi-gate-util').querySelector('.kpi-label').textContent     = 'Avg Pax / FTE / Day';
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

// ── Passenger Footfall Trend Chart ───────────────────────────
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
        tooltip: {
          backgroundColor: '#061729', borderColor: DAA.accent, borderWidth: 1,
          callbacks: { label: ctx => ` ${fmtM(ctx.parsed.y)} passengers` },
        },
      },
      scales: {
        x: { grid: { color: isDark ? 'rgba(255,255,255,0.15)' : '#e5e7eb' }, ticks: { color: DAA.white() } },
        y: {
          grid: { color: isDark ? 'rgba(255,255,255,0.15)' : '#e5e7eb' },
          ticks: { color: DAA.white(), callback: v => fmtM(v) },
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
// Gate colour map removed (Gate / Pier view was removed)

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
    const dot = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${SKILL_COLOR[sk]||stringToColor(sk)};margin-right:6px;"></span>`;
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

  // Gate headcount table removed per request
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
        backgroundColor: SKILL_COLOR[sk] || stringToColor(sk),
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
          backgroundColor: skills.map(s => SKILL_COLOR[s] || stringToColor(s)),
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
  const leaveColors = ['#e11d48', '#d97706', '#059669', '#2563eb', '#7c3aed', '#db2777', '#475569'];
  const absDatasets = (d.leave_types || []).map((lt, i) => ({
    label: lt,
    data: months.map(m => (d.monthly_absent[m] || {})[lt] || 0),
    backgroundColor: leaveColors[i % leaveColors.length],
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
  renderWeeklyGapTable(d);
  renderMergedAbsenceBar(d);
}

function renderSkillGapBarChart(data) {
  const isDark = window.getCurrentTheme && window.getCurrentTheme() === 'dark';
  destroyChart('skill-gap-bar');
  const ctx = document.getElementById('skill-gap-bar-chart').getContext('2d');
  
    const datasets = data.skills.map(sk => ({
    label: sk,
    data: data.weekly.map(w => w.skill_gaps[sk] || 0),
    backgroundColor: SKILL_COLOR[sk] || stringToColor(sk),
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
          backgroundColor: labels.map(l => SKILL_COLOR[l] || stringToColor(l)),
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
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${SKILL_COLOR[s.skill]||stringToColor(s.skill)};margin-right:8px;"></span>
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

  const weekMeta  = d.weekly_absence_labels || [];   // [[week_key, label], ...]
  const weekKeys  = weekMeta.map(w => w[0]);
  const weekLabels = weekMeta.map(w => w[1]);

  const leaveColors = ['#e11d48','#d97706','#059669','#2563eb','#7c3aed','#db2777','#475569','#0891b2'];
  const datasets = (d.leave_types || []).map((lt, i) => ({
    label: lt,
    data: weekKeys.map(wk => (d.weekly_absent[wk] || {})[lt] || 0),
    backgroundColor: leaveColors[i % leaveColors.length],
    stack: 'abs',
    borderRadius: 1,
  }));

  const ctx = document.getElementById('merged-absence-bar').getContext('2d');
  CHARTS['merged-absence'] = new Chart(ctx, {
    type: 'bar',
    data: { labels: weekLabels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'top',
          labels: { color: DAA.white(), usePointStyle: true, boxWidth: 8, font: { size: 11 } },
        },
        tooltip: {
          backgroundColor: '#061729', borderColor: DAA.accent, borderWidth: 1,
          mode: 'index',
        },
      },
      scales: {
        x: {
          stacked: true,
          grid: { display: false },
          ticks: {
            color: DAA.white(),
            maxRotation: 45,
            autoSkip: true,
            maxTicksLimit: 26,
          },
        },
        y: {
          stacked: true,
          grid: { color: isDark ? 'rgba(255,255,255,0.1)' : '#e5e7eb' },
          title: { display: true, text: 'Absence Days', color: DAA.white() },
          ticks: { color: DAA.white() },
        },
      },
    },
  });
}

// ═════════════════════════════════════════════════════════════
// 4 WEEKS ROSTER
// ═════════════════════════════════════════════════════════════

let _rosterData = null;
let _rosterActiveWeekIdx = 0;
let _shiftPivoted = false;
let _blockPivoted = false;

window.toggleShiftPivot = function () {
  _shiftPivoted = !_shiftPivoted;
  const btn = document.getElementById('roster-shift-pivot-btn');
  if (btn) btn.classList.toggle('btn-pivot-active', _shiftPivoted);
  if (_rosterData) renderRosterWeek(_rosterData, _rosterActiveWeekIdx);
};

window.toggleBlockPivot = function () {
  _blockPivoted = !_blockPivoted;
  const btn = document.getElementById('roster-block-pivot-btn');
  if (btn) btn.classList.toggle('btn-pivot-active', _blockPivoted);
  if (_rosterData) renderRosterWeek(_rosterData, _rosterActiveWeekIdx);
};

window.toggleRosterGroup = function(headerEl, groupId, tablePrefix) {
  const tbody = headerEl.closest('tbody');
  const rows = tbody.querySelectorAll(`[data-roster-group="${tablePrefix}-${groupId}"]`);
  const icon = headerEl.querySelector('.rs-expand-icon');
  const isExpanded = headerEl.dataset.expanded === 'true';
  rows.forEach(r => { r.style.display = isExpanded ? 'none' : ''; });
  if (icon) icon.textContent = isExpanded ? '▶' : '▼';
  headerEl.dataset.expanded = isExpanded ? 'false' : 'true';
};

async function initFourWeekRoster() {
  // Reset cache each session open so updated API fields are always fetched
  _rosterData = null;
  _rosterActiveWeekIdx = 0;
  _shiftPivoted = false;
  _blockPivoted = false;
  const spb = document.getElementById('roster-shift-pivot-btn');
  const bpb = document.getElementById('roster-block-pivot-btn');
  if (spb) spb.classList.remove('btn-pivot-active');
  if (bpb) bpb.classList.remove('btn-pivot-active');

  // Show loading
  document.getElementById('roster-loading').style.display = 'flex';
  document.getElementById('roster-week-nav').style.display = 'none';
  document.getElementById('roster-shift-panel').style.display = 'none';
  document.getElementById('roster-block-panel').style.display = 'none';

  try {
    _rosterData = await api('/api/long-term/four-week-roster');
    renderRoster(_rosterData);
  } catch (e) {
    document.getElementById('roster-loading').innerHTML =
      '<span style="color:var(--crit)">Failed to load roster data. Please try again.</span>';
  }
}

function renderRoster(data) {
  document.getElementById('roster-loading').style.display = 'none';

  // ── DOW Weight Bar ─────────────────────────────────────────
  const dowBar = document.getElementById('dow-weight-bar');
  const dowOrder = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  const dowColors = ['#3b82f6','#8b5cf6','#06b6d4','#10b981','#f97316','#ef4444','#f59e0b'];
  dowBar.innerHTML = dowOrder.map((d, i) => {
    const w = ((data.dow_weights[d] || 0) * 100).toFixed(1);
    const barH = Math.round((data.dow_weights[d] / Math.max(...Object.values(data.dow_weights))) * 60);
    return `
      <div class="dow-chip" style="--dow-color:${dowColors[i]}">
        <div class="dow-chip-bar" style="height:${barH}px;background:${dowColors[i]}"></div>
        <div class="dow-chip-label">${d}</div>
        <div class="dow-chip-pct">${w}%</div>
      </div>`;
  }).join('');

  // ── Week Navigation Pills ───────────────────────────────────
  const nav = document.getElementById('roster-week-nav');
  nav.style.display = 'flex';
  nav.innerHTML = data.weeks.map((wk, i) => {
    const isCurrent = wk.is_current_week;
    const thisWeekBadge = isCurrent
      ? `<span class="rw-pill-badge rw-badge-current">This Week</span>`
      : '';
    const coverageSummary = isCurrent ? (() => {
      const intraday  = wk.days.filter(d => d.coverage === 'intraday').length;
      const stDays    = wk.days.filter(d => d.coverage === 'short_term').length;
      const rosterOnly = wk.days.filter(d => d.coverage === 'roster_only').length;
      const parts = [];
      if (intraday)   parts.push(`<span class="rw-cov rw-cov-intraday">${intraday}d Intraday</span>`);
      if (stDays)     parts.push(`<span class="rw-cov rw-cov-st">${stDays}d Short Term</span>`);
      if (rosterOnly) parts.push(`<span class="rw-cov rw-cov-ro">${rosterOnly}d Roster Only</span>`);
      return `<div class="rw-pill-coverage">${parts.join('')}</div>`;
    })() : '';
    return `
    <button class="roster-week-pill ${i === _rosterActiveWeekIdx ? 'active' : ''} ${isCurrent ? 'rw-current-week' : ''}"
            id="roster-wpill-${i}"
            onclick="switchRosterWeek(${i})">
      <div class="rw-pill-top">
        <span class="rw-pill-wk">${wk.week}</span>
        ${thisWeekBadge}
      </div>
      <span class="rw-pill-dates">${wk.start_date} – ${wk.end_date}</span>
      <span class="rw-pill-fte">${wk.weekly_fte} FTE</span>
      ${coverageSummary}
    </button>`;
  }).join('');

  // ── Render selected week ────────────────────────────────────
  renderRosterWeek(data, _rosterActiveWeekIdx);

  document.getElementById('roster-shift-panel').style.display = '';
  document.getElementById('roster-block-panel').style.display = '';
}

function switchRosterWeek(idx) {
  _rosterActiveWeekIdx = idx;
  document.querySelectorAll('.roster-week-pill').forEach((p, i) => {
    p.classList.toggle('active', i === idx);
  });
  renderRosterWeek(_rosterData, idx);
}

function renderRosterWeek(data, weekIdx) {
  const wk = data.weeks[weekIdx];
  const skills = data.skills;
  const days = wk.days;

  // Update panel titles
  const weekLabel = wk.is_current_week
    ? `This Week (${wk.week}) — ${wk.start_date} to ${wk.end_date}`
    : `${wk.week} — ${wk.start_date} to ${wk.end_date}`;
  document.getElementById('roster-shift-title').textContent =
    `Shift Plan — ${weekLabel}`;

  // Coverage badge helper
  const COV_BADGES = {
    intraday:    `<span class="day-cov-badge cov-intraday" title="Covered by Intraday view">Live</span>`,
    short_term:  `<span class="day-cov-badge cov-short-term" title="Covered by Short Term view">ST</span>`,
    roster_only: `<span class="day-cov-badge cov-roster-only" title="Roster-level estimate only">Roster</span>`,
  };
  const isCurrent = wk.is_current_week;

  // Helper: colour a gap value
  function gapCls(g) {
    if (g > 0)  return 'rdc-gap-ok';
    if (g < 0)  return 'rdc-gap-crit';
    return 'rdc-gap-zero';
  }

  // Pre-compute daily totals (used in both tables)
  const totalsReq   = days.map(d => d.total_fte);
  const totalsAvail = days.map(d => d.total_avail);
  const totalsGap   = days.map(d => d.total_gap);
  const avgReq   = totalsReq.reduce((s, v) => s + v, 0) / days.length;
  const avgAvail = totalsAvail.reduce((s, v) => s + v, 0) / days.length;
  const avgGap   = totalsGap.reduce((s, v) => s + v, 0) / days.length;

  // ── Table 2: Shift Plan ─────────────────────────────────────────────────
  const sHead = document.getElementById('roster-shift-head');
  const sBody = document.getElementById('roster-shift-body');

  const covRow2 = isCurrent
    ? `<tr class="rdth-cov-row"><th></th>${days.map(d =>
        `<th class="rdth-cov-cell">${COV_BADGES[d.coverage] || ''}</th>`
      ).join('')}<th></th></tr>`
    : '';

  if (_shiftPivoted) {
    // ── Pivoted: rows = Days, columns = Shifts ──────────────────────────────
    const shiftTemplates = data.shift_templates;
    const SHIFT_COLS = ['#8d8d8d', ...shiftTemplates.map(t => t.color)];

    sHead.innerHTML = `<tr>
      <th class="rdth-role">Day</th>
      ${shiftTemplates.map(t =>
        `<th class="rdth-day" style="color:${t.color}">${t.name}</th>`
      ).join('')}
      <th class="rdth-weekly">Total FTE</th>
      <th class="rdth-weekly" style="color:var(--teal)">Available</th>
      <th class="rdth-weekly">Gap</th>
    </tr>`;

    const avgByShift = shiftTemplates.map(t =>
      days.reduce((s, d) => { const sh = d.shifts.find(x => x.id === t.id); return s + (sh ? sh.total_fte : 0); }, 0) / days.length
    );
    const avgTotal = avgByShift.reduce((s, v) => s + v, 0);

    sBody.innerHTML = days.map((d, di) => {
      const covBadge = isCurrent ? (COV_BADGES[d.coverage] || '') : '';
      const shiftCells = shiftTemplates.map(t => {
        const sh = d.shifts.find(x => x.id === t.id);
        const v = sh ? sh.total_fte : 0;
        return `<td class="roster-shift-hdr-cell" style="background:color-mix(in srgb,${t.color} 10%,transparent)">` +
          (v > 0 ? `<strong style="color:${t.color}">${v.toFixed(1)}</strong>` : `<span style="color:var(--muted)">—</span>`) + `</td>`;
      }).join('');
      const rowTotal = d.shifts.reduce((s, sh) => s + sh.total_fte, 0);
      const isPeak = d.dow === 4 || d.dow === 5;
      const avail = totalsAvail[di] ?? 0;
      const gap = totalsGap[di] ?? 0;
      return `<tr class="${isPeak ? 'roster-pivot-peak-row' : ''}">
        <td class="rdth-role-cell"><strong>${d.label}</strong> ${covBadge}</td>
        ${shiftCells}
        <td class="rdc-weekly"><strong>${rowTotal.toFixed(1)}</strong></td>
        <td class="rdc-total rdc-avail">${(+avail || 0).toFixed(1)}</td>
        <td class="rdc-total ${gapCls(gap)}">${gap >= 0 ? '+' : ''}${(+gap || 0).toFixed(1)}</td>
      </tr>`;
    }).join('') + `<tr class="rd-total-row">
      <td class="rdth-role-cell"><strong>Avg/Day</strong></td>
      ${avgByShift.map((v, i) => `<td class="roster-shift-hdr-cell" style="background:color-mix(in srgb,${shiftTemplates[i].color} 10%,transparent)"><strong style="color:${shiftTemplates[i].color}">${v.toFixed(1)}</strong></td>`).join('')}
      <td class="rdc-weekly"><strong>${avgTotal.toFixed(1)}</strong></td>
      <td class="rdc-total rdc-avail"><strong>${avgAvail.toFixed(1)}</strong></td>
      <td class="rdc-total ${gapCls(avgGap)}"><strong>${avgGap >= 0 ? '+' : ''}${avgGap.toFixed(1)}</strong></td>
    </tr>`;
  } else {
    // ── Normal: rows = Shifts → Skills, columns = Days ───────────────────────
    sHead.innerHTML = `<tr>
      <th class="rdth-role">Shift / Role</th>
      ${days.map(d => `<th class="rdth-day ${d.dow === 4 || d.dow === 5 ? 'rdth-peak' : ''} rdth-cov-${d.coverage || 'roster_only'}">${d.label}</th>`).join('')}
      <th class="rdth-weekly">Avg/Day</th>
    </tr>${covRow2}`;

    const shiftTemplates = data.shift_templates;
    let shiftRows = '';

    shiftTemplates.forEach(tmpl => {
      const shiftTotalCells = days.map(d => {
        const sh = d.shifts.find(s => s.id === tmpl.id);
        const fte = sh ? sh.total_fte : 0;
        return `<td class="roster-shift-hdr-cell" style="background:color-mix(in srgb,${tmpl.color} 10%,transparent)">` +
          (fte > 0 ? `<strong style="color:${tmpl.color}">${fte.toFixed(1)}</strong>` : `<span style="color:var(--muted)">—</span>`) + `</td>`;
      }).join('');
      const avgShiftFte = days.reduce((s, d) => {
        const sh = d.shifts.find(sh => sh.id === tmpl.id); return s + (sh ? sh.total_fte : 0);
      }, 0) / days.length;

      shiftRows += `<tr class="roster-shift-section-hdr" data-expanded="false" style="cursor:pointer" onclick="toggleRosterGroup(this, '${tmpl.id}', 'shift')">
        <td class="rdth-role-cell roster-shift-section-hdr-label">
          <span class="rs-expand-icon" style="margin-right:4px;font-size:0.65rem;opacity:0.7">▶</span>
          <span class="rs-band-dot" style="background:${tmpl.color}"></span>
          <strong style="color:${tmpl.color}">${tmpl.name}</strong>
        </td>
        ${shiftTotalCells}
        <td class="rdc-weekly"><strong style="color:${tmpl.color}">${avgShiftFte > 0 ? avgShiftFte.toFixed(1) : '—'}</strong></td>
      </tr>`;

      skills.forEach(sk => {
        const color = SKILL_COLOR[sk] || stringToColor(sk);
        const skillCells = days.map(d => {
          const sh = d.shifts.find(s => s.id === tmpl.id);
          const v = sh ? (sh.skills[sk] || 0) : 0;
          return `<td class="roster-shift-skill-cell" title="${tmpl.name} — ${sk}: ${v.toFixed(2)} FTE">` +
            (v > 0.05 ? `<span style="color:${color}">${v.toFixed(1)}</span>` : `<span style="color:var(--muted)">—</span>`) + `</td>`;
        }).join('');
        const avgSkill = days.reduce((s, d) => {
          const sh = d.shifts.find(sh => sh.id === tmpl.id);
          return s + (sh ? (sh.skills[sk] || 0) : 0);
        }, 0) / days.length;
        shiftRows += `<tr class="roster-shift-skill-row" data-roster-group="shift-${tmpl.id}" style="display:none">
          <td class="rdth-role-cell roster-shift-skill-label">
            <span class="rd-skill-dot" style="background:${color}"></span>
            <span style="color:${color};font-size:0.8rem">${sk}</span>
          </td>
          ${skillCells}
          <td class="rdc-weekly" style="color:${color};font-size:0.8rem">${avgSkill > 0.05 ? avgSkill.toFixed(1) : '—'}</td>
        </tr>`;
      });
    });

    const totalFteCells = days.map(d => {
      const total = d.shifts.reduce((s, sh) => s + sh.total_fte, 0);
      return `<td class="rdc-total">${total.toFixed(1)}</td>`;
    }).join('');
    const avgTotalFte = days.reduce((s, d) =>
      s + d.shifts.reduce((ss, sh) => ss + sh.total_fte, 0), 0) / days.length;

    const totalAvailCells = totalsAvail.map(v => `<td class="rdc-total rdc-avail">${(+v || 0).toFixed(1)}</td>`).join('');
    const gapRowCells = totalsGap.map(g => `<td class="rdc-total ${gapCls(g)}">${g >= 0 ? '+' : ''}${(+g || 0).toFixed(1)}</td>`).join('');

    shiftRows += `<tr class="rd-total-row">
      <td class="rdth-role-cell"><strong>Total FTE Required</strong></td>
      ${totalFteCells}
      <td class="rdc-weekly"><strong>${avgTotalFte.toFixed(1)}</strong></td>
    </tr>
    <tr class="rd-total-row rd-avail-row">
      <td class="rdth-role-cell"><strong>Total Available</strong></td>
      ${totalAvailCells}
      <td class="rdc-weekly rdc-avail"><strong>${avgAvail.toFixed(1)}</strong></td>
    </tr>
    <tr class="rd-total-row rd-gap-row">
      <td class="rdth-role-cell"><strong>Gap (Avail − Req)</strong></td>
      ${gapRowCells}
      <td class="rdc-weekly ${gapCls(avgGap)}"><strong>${avgGap >= 0 ? '+' : ''}${avgGap.toFixed(1)}</strong></td>
    </tr>`;

    sBody.innerHTML = shiftRows;
  }

  // ── Table 3: 3-Hour Block FTE ────────────────────────────────────────────
  document.getElementById('roster-block-title').textContent =
    `3-Hour Block FTE — ${weekLabel}`;

  const bHead = document.getElementById('roster-block-head');
  const bBody = document.getElementById('roster-block-body');
  const blockDefs = data.time_block_defs || [];

  // Gradient: map block index 0-7 to a colour scale (cooler overnight → warmer day)
  const BLOCK_COLORS = [
    '#64748b','#78716c','#f97316','#f59e0b',
    '#eab308','#f97316','#ef4444','#8b5cf6',
  ];

  if (_blockPivoted) {
    // ── Pivoted: rows = Days, columns = Time Blocks (total FTE) ─────────────
    bHead.innerHTML = `<tr>
      <th class="rdth-role">Day</th>
      ${blockDefs.map((tb, i) =>
        `<th class="rdth-day" style="color:${BLOCK_COLORS[i]}">${tb.label}</th>`
      ).join('')}
      <th class="rdth-weekly">Total FTE</th>
      <th class="rdth-weekly" style="color:var(--teal)">Available</th>
      <th class="rdth-weekly">Gap</th>
    </tr>`;

    const avgByBlock = blockDefs.map((tb, i) =>
      days.reduce((s, d) => {
        const bl = d.time_blocks && d.time_blocks.find(b => b.id === tb.id);
        return s + (bl ? bl.total_fte : 0);
      }, 0) / days.length
    );
    const avgTotal = avgByBlock.reduce((s, v) => s + v, 0);

    bBody.innerHTML = days.map((d, di) => {
      const covBadge = isCurrent ? (COV_BADGES[d.coverage] || '') : '';
      const isPeak = d.dow === 4 || d.dow === 5;
      const blockCells = blockDefs.map((tb, i) => {
        const bl = d.time_blocks && d.time_blocks.find(b => b.id === tb.id);
        const v = bl ? bl.total_fte : 0;
        const intensity = v / (days.reduce((mx, dd) => {
          const b2 = dd.time_blocks && dd.time_blocks.find(b => b.id === tb.id);
          return Math.max(mx, b2 ? b2.total_fte : 0);
        }, 0.01));
        const bg = `color-mix(in srgb,${BLOCK_COLORS[i]} ${Math.round(intensity * 22)}%,transparent)`;
        return `<td class="roster-block-cell" style="background:${bg}">` +
          (v > 0.05 ? `<span style="color:${BLOCK_COLORS[i]};font-weight:600">${v.toFixed(1)}</span>` : `<span style="color:var(--muted)">—</span>`) + `</td>`;
      }).join('');
      const rowTotal = (d.time_blocks || []).reduce((s, b) => s + b.total_fte, 0);
      const avail = totalsAvail[di] ?? 0;
      const gap = totalsGap[di] ?? 0;
      return `<tr class="${isPeak ? 'roster-pivot-peak-row' : ''}">
        <td class="rdth-role-cell"><strong>${d.label}</strong> ${covBadge}</td>
        ${blockCells}
        <td class="rdc-weekly"><strong>${rowTotal.toFixed(1)}</strong></td>
        <td class="rdc-total rdc-avail">${(+avail || 0).toFixed(1)}</td>
        <td class="rdc-total ${gapCls(gap)}">${gap >= 0 ? '+' : ''}${(+gap || 0).toFixed(1)}</td>
      </tr>`;
    }).join('') + `<tr class="rd-total-row">
      <td class="rdth-role-cell"><strong>Avg/Day</strong></td>
      ${avgByBlock.map((v, i) => `<td class="roster-block-cell" style="background:color-mix(in srgb,${BLOCK_COLORS[i]} 15%,transparent)"><strong style="color:${BLOCK_COLORS[i]}">${v.toFixed(1)}</strong></td>`).join('')}
      <td class="rdc-weekly"><strong>${avgTotal.toFixed(1)}</strong></td>
      <td class="rdc-total rdc-avail"><strong>${avgAvail.toFixed(1)}</strong></td>
      <td class="rdc-total ${gapCls(avgGap)}"><strong>${avgGap >= 0 ? '+' : ''}${avgGap.toFixed(1)}</strong></td>
    </tr>`;
  } else {
    // ── Normal: rows = Blocks (section hdr) → Skills (sub-rows), columns = Days ──
    const covRow3 = isCurrent
      ? `<tr class="rdth-cov-row"><th></th>${days.map(d =>
          `<th class="rdth-cov-cell">${COV_BADGES[d.coverage] || ''}</th>`
        ).join('')}<th></th></tr>`
      : '';

    bHead.innerHTML = `<tr>
      <th class="rdth-role">Block / Touchpoint</th>
      ${days.map(d => `<th class="rdth-day ${d.dow === 4 || d.dow === 5 ? 'rdth-peak' : ''} rdth-cov-${d.coverage || 'roster_only'}">${d.label}</th>`).join('')}
      <th class="rdth-weekly">Avg/Day</th>
    </tr>${covRow3}`;

    let blockRows = '';

    blockDefs.forEach((tb, i) => {
      const bColor = BLOCK_COLORS[i];

      // Block section header: total FTE across all skills for this block
      const blkTotalCells = days.map(d => {
        const bl = d.time_blocks && d.time_blocks.find(b => b.id === tb.id);
        const v = bl ? bl.total_fte : 0;
        return `<td class="roster-shift-hdr-cell" style="background:color-mix(in srgb,${bColor} 12%,transparent)">` +
          (v > 0 ? `<strong style="color:${bColor}">${v.toFixed(1)}</strong>` : `<span style="color:var(--muted)">—</span>`) + `</td>`;
      }).join('');
      const avgBlkTotal = days.reduce((s, d) => {
        const bl = d.time_blocks && d.time_blocks.find(b => b.id === tb.id);
        return s + (bl ? bl.total_fte : 0);
      }, 0) / days.length;

      blockRows += `<tr class="roster-shift-section-hdr" data-expanded="false" style="cursor:pointer" onclick="toggleRosterGroup(this, '${tb.id}', 'block')">
        <td class="rdth-role-cell roster-shift-section-hdr-label">
          <span class="rs-expand-icon" style="margin-right:4px;font-size:0.65rem;opacity:0.7">▶</span>
          <span class="rs-band-dot" style="background:${bColor}"></span>
          <strong style="color:${bColor}">${tb.label}</strong>
        </td>
        ${blkTotalCells}
        <td class="rdc-weekly"><strong style="color:${bColor}">${avgBlkTotal > 0 ? avgBlkTotal.toFixed(1) : '—'}</strong></td>
      </tr>`;

      // Sub-row per touchpoint (skill)
      skills.forEach(sk => {
        const skColor = SKILL_COLOR[sk] || stringToColor(sk);
        const skillCells = days.map(d => {
          const bl = d.time_blocks && d.time_blocks.find(b => b.id === tb.id);
          const v = bl ? (bl.skills[sk] || 0) : 0;
          return `<td class="roster-block-skill-cell" title="${tb.label} — ${sk}: ${v.toFixed(2)} FTE">` +
            (v > 0.05
              ? `<span style="color:${skColor}">${v.toFixed(1)}</span>`
              : `<span style="color:var(--muted)">—</span>`) + `</td>`;
        }).join('');
        const avgSkInBlock = days.reduce((s, d) => {
          const bl = d.time_blocks && d.time_blocks.find(b => b.id === tb.id);
          return s + (bl ? (bl.skills[sk] || 0) : 0);
        }, 0) / days.length;

        blockRows += `<tr class="roster-block-row" data-roster-group="block-${tb.id}" style="display:none">
          <td class="rdth-role-cell roster-block-label">
            <span class="rd-skill-dot" style="background:${skColor}"></span>
            <span style="color:${skColor};font-size:0.78rem">${sk}</span>
          </td>
          ${skillCells}
          <td class="rdc-weekly" style="color:${skColor};font-size:0.78rem">${avgSkInBlock > 0.05 ? avgSkInBlock.toFixed(1) : '—'}</td>
        </tr>`;
      });
    });

    // Grand total row (daily total FTE across all blocks / skills)
    const blkTotCells = days.map(d => `<td class="rdc-total">${(d.total_fte || 0).toFixed(1)}</td>`).join('');
    const blkGrandAvg = days.reduce((s, d) => s + (d.total_fte || 0), 0) / days.length;
    const blkAvailCells = totalsAvail.map(v => `<td class="rdc-total rdc-avail">${(+v || 0).toFixed(1)}</td>`).join('');
    const blkGapCells = totalsGap.map(g => `<td class="rdc-total ${gapCls(g)}">${g >= 0 ? '+' : ''}${(+g || 0).toFixed(1)}</td>`).join('');

    blockRows += `<tr class="rd-total-row">
      <td class="rdth-role-cell"><strong>Daily Total FTE Required</strong></td>
      ${blkTotCells}
      <td class="rdc-weekly"><strong>${blkGrandAvg.toFixed(1)}</strong></td>
    </tr>
    <tr class="rd-total-row rd-avail-row">
      <td class="rdth-role-cell"><strong>Total Available</strong></td>
      ${blkAvailCells}
      <td class="rdc-weekly rdc-avail"><strong>${avgAvail.toFixed(1)}</strong></td>
    </tr>
    <tr class="rd-total-row rd-gap-row">
      <td class="rdth-role-cell"><strong>Gap (Avail − Req)</strong></td>
      ${blkGapCells}
      <td class="rdc-weekly ${gapCls(avgGap)}"><strong>${avgGap >= 0 ? '+' : ''}${avgGap.toFixed(1)}</strong></td>
    </tr>`;

    bBody.innerHTML = blockRows;
  }
}

// (four-week-roster init is wired via the shared sub-tab click handler above)


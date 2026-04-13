/* ═══════════════════════════════════════════════════════
   DAA Intraday Operations — D (Today)
   ═══════════════════════════════════════════════════════ */

const ID = {
  accent: '#E8850A', ok: '#2ECC71', warn: '#F39C12', crit: '#E74C3C',
  info: '#3498DB', muted: '#6b7280', white: '#1a2744',
};

const ID_SKILL_COLOR = {
  'GNIB': '#3498DB', 'CBP Pre-clearance': '#9B59B6', 'Bussing': '#E8850A',
  'PBZ': '#2ECC71', 'Mezz Operation': '#1ABC9C', 'Litter Picking': '#E74C3C',
  'Ramp / Marshalling': '#F39C12', 'Arr Customer Service': '#5DADE2',
  'Check-in / Trolleys': '#A9CCE3',
};

let ID_DATA = null;
let ID_SELECTED_FLIGHT = null;
let ID_MANAGE_TASK = null;
let ID_ACTIVE_TAB = 'staff';
let ID_AUTO_REFRESH = null;
let ID_SIM_TIMER = null;
let ID_SIM_TIME = null;
let ID_SIM_SPEED = 1;

function formatMins(mins) {
  mins = Math.round(mins || 0);
  const hh = Math.floor(mins / 60) % 24;
  const mm = mins % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function getCurrentTimeMins() {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

function startGateTimelineTimer() {
  if (ID_SIM_TIMER) return;
  if (ID_SIM_TIME == null) ID_SIM_TIME = getCurrentTimeMins();
  ID_SIM_TIMER = setInterval(() => {
    ID_SIM_TIME = Math.min(1440, ID_SIM_TIME + (ID_SIM_SPEED * 0.5));
    renderGateTimelineNowLine();
  }, 500);
}

function stopGateTimelineTimer() {
  if (!ID_SIM_TIMER) return;
  clearInterval(ID_SIM_TIMER);
  ID_SIM_TIMER = null;
}

function computeSimKPIs() {
  const flights = Array.isArray(ID_DATA?.flights) ? ID_DATA.flights : [];
  const activeTasks = flights.flatMap(f => (f.tasks || []).filter(t =>
    typeof t.start_mins === 'number' && typeof t.end_mins === 'number' &&
    t.start_mins <= ID_SIM_TIME && ID_SIM_TIME < t.end_mins
  ));
  const activeFlights = flights.filter(f => (f.tasks || []).some(t =>
    typeof t.start_mins === 'number' && typeof t.end_mins === 'number' &&
    t.start_mins <= ID_SIM_TIME && ID_SIM_TIME < t.end_mins
  ));
  const gatesActive = new Set(activeFlights.map(f => f.gate).filter(Boolean));
  const covered = activeTasks.filter(t => !t.alert).length;
  const total = activeTasks.length;
  return {
    active_flights: activeFlights.length,
    gates_active: gatesActive.size,
    tasks_covered: covered,
    tasks_total: total,
    coverage_pct: total ? Math.round((covered / total) * 1000) / 10 : 100.0,
  };
}

function renderGateTimelineNowLine() {
  const line = document.querySelector('.gt-now-line');
  if (typeof ID_SIM_TIME !== 'number') return;
  const left = Math.max(0, Math.min(100, (ID_SIM_TIME / 1440) * 100));
  if (line) line.style.left = `${left.toFixed(2)}%`;
  const label = line ? line.querySelector('.gt-now-label') : null;
  if (label) label.textContent = formatMins(ID_SIM_TIME);
  const simTimeElem = document.getElementById('id-sim-time-value');
  if (simTimeElem) simTimeElem.textContent = formatMins(ID_SIM_TIME);
  if (ID_DATA && ID_DATA.kpis) renderIDKPIs(ID_DATA.kpis);
}

// ── Boot ────────────────────────────────────────────────────────
async function initIntraday() {
  document.getElementById('id-content').innerHTML =
    '<div class="loading-spinner"><div class="spinner"></div><span>Loading today\'s operations…</span></div>';
  await loadIntradayData();
}

async function loadIntradayData() {
  try {
    ID_DATA = await fetch('/api/intraday').then(r => r.json());
    renderIntradayPage();
  } catch (e) {
    document.getElementById('id-content').innerHTML =
      '<div class="empty-state">Failed to load intraday data.</div>';
  }
}

// ── Main Render ─────────────────────────────────────────────────
function renderIntradayPage() {
  const d = ID_DATA;
  document.getElementById('id-content').innerHTML = `
    <div class="page-header" style="margin-bottom:16px">
      <h2 class="page-title" style="font-size:1.3rem">
        Today — ${d.date_label}
        <span class="live-badge">● LIVE</span>
      </h2>
    </div>
    <div class="kpi-grid st-kpi-grid" id="id-kpis"></div>
    <div id="id-alerts-panel"></div>
    <div class="sub-tabs" style="margin-top:20px">
      <button class="sub-tab ${ID_ACTIVE_TAB==='staff'?'active':''}" data-idtab="staff">👤 Staff Roster</button>
      <button class="sub-tab ${ID_ACTIVE_TAB==='flights'?'active':''}" data-idtab="flights">✈ Flight Operations</button>
      <button class="sub-tab ${ID_ACTIVE_TAB==='gate-timeline'?'active':''}" data-idtab="gate-timeline">🛬 Gate Timeline</button>
    </div>
    <div id="id-sub-content"></div>
    <div id="id-flight-detail" class="flight-detail-panel"></div>
    <div id="id-manage-overlay" class="modal-overlay hidden" onclick="closeManageModal()">
      <div class="modal-box" onclick="event.stopPropagation()">
        <div id="id-manage-content"></div>
      </div>
    </div>`;

  try {
    renderIDKPIs(d.kpis);
    renderIDAlerts(d.alerts);
    renderIDSubContent();
  } catch (err) {
    console.error('Intraday render error:', err);
    document.getElementById('id-content').innerHTML =
      '<div class="empty-state">Failed to render intraday data.</div>';
    return;
  }

  document.querySelectorAll('.sub-tab[data-idtab]').forEach(btn =>
    btn.addEventListener('click', () => {
      const newTab = btn.dataset.idtab;
      ID_ACTIVE_TAB = newTab;
      if (newTab !== 'gate-timeline') stopGateTimelineAutoRefresh();
      document.querySelectorAll('.sub-tab[data-idtab]').forEach(b => b.classList.toggle('active', b === btn));
      renderIDSubContent();
    })
  );
}

function startGateTimelineAutoRefresh() {
  if (ID_AUTO_REFRESH) return;
  if (ID_SIM_TIME == null) ID_SIM_TIME = getCurrentTimeMins();
  ID_AUTO_REFRESH = setInterval(async () => {
    try {
      const data = await fetch('/api/intraday').then(r => r.json());
      ID_DATA = data;
      renderIntradayPage();
    } catch (err) {
      console.error('Gate timeline auto-refresh failed:', err);
    }
  }, 5000);
  startGateTimelineTimer();
}

function stopGateTimelineAutoRefresh() {
  if (!ID_AUTO_REFRESH) return;
  clearInterval(ID_AUTO_REFRESH);
  ID_AUTO_REFRESH = null;
  stopGateTimelineTimer();
}

function toggleGateTimelineAutoRefresh() {
  if (ID_AUTO_REFRESH) stopGateTimelineAutoRefresh();
  else startGateTimelineAutoRefresh();
  renderIDSubContent();
}

function setGateTimelineSpeed(value) {
  ID_SIM_SPEED = parseFloat(value) || 1;
  const label = document.getElementById('id-sim-speed-value');
  if (label) label.textContent = `${ID_SIM_SPEED.toFixed(1)}x`;
}

async function resetIntraday() {
  try {
    const response = await fetch('/api/intraday/reset', { method: 'POST' });
    ID_DATA = await response.json();
    stopGateTimelineAutoRefresh();
    ID_SIM_TIME = getCurrentTimeMins();
    renderIntradayPage();
  } catch (err) {
    console.error('Reset intraday failed:', err);
  }
}

function injectGateDisruption() {
  const flightNo = prompt('Enter flight number to delay (e.g. AI792):');
  if (!flightNo) return;
  const delayMins = parseInt(prompt('Delay minutes?', '15'), 10);
  if (!delayMins || delayMins <= 0) return;
  postDelay(flightNo.trim(), delayMins, false);
}

// ── KPIs ────────────────────────────────────────────────────────
function renderIDKPIs(kpis) {
  if (ID_ACTIVE_TAB === 'gate-timeline' && ID_SIM_TIME == null) {
    ID_SIM_TIME = getCurrentTimeMins();
  }
  const simKpis = (ID_ACTIVE_TAB === 'gate-timeline' && typeof ID_SIM_TIME === 'number')
    ? computeSimKPIs() : null;
  const activeGates = simKpis ? simKpis.gates_active : kpis.gates_active;
  const activeTasksCovered = simKpis ? simKpis.tasks_covered : kpis.tasks_covered;
  const activeTasksTotal = simKpis ? simKpis.tasks_total : kpis.tasks_total;
  const activeCoverage = simKpis ? simKpis.coverage_pct : kpis.coverage_pct;

  const grid = document.getElementById('id-kpis');
  const cards = [
    { icon: '✈', label: simKpis ? 'Active Flights' : 'Total Flights', value: simKpis ? simKpis.active_flights : kpis.total_flights.toLocaleString(), cls: '' },
    { icon: '👥', label: 'Staff on Duty', value: kpis.staff_on_duty, cls: '' },
    { icon: '🚫', label: 'Absent', value: kpis.absent, cls: kpis.absent > 3 ? 'kpi-card--warn' : '' },
    { icon: '🛬', label: 'Gates Active', value: activeGates, cls: '' },
    { icon: '✅', label: 'Tasks Covered', value: `${activeTasksCovered} / ${activeTasksTotal}`, cls: '' },
    { icon: '📊', label: 'Coverage %', value: activeCoverage + '%',
      cls: activeCoverage < 50 ? 'kpi-card--crit' : activeCoverage < 80 ? 'kpi-card--warn' : 'kpi-card--ok' },
  ];
  grid.innerHTML = cards.map(c => `
    <div class="kpi-card ${c.cls}">
      <div class="kpi-icon">${c.icon}</div>
      <div class="kpi-body">
        <div class="kpi-value">${c.value}</div>
        <div class="kpi-label">${c.label}</div>
      </div>
    </div>`).join('');
}

// ── Alerts ──────────────────────────────────────────────────────
function renderIDAlerts(alerts) {
  const panel = document.getElementById('id-alerts-panel');
  if (!alerts || !alerts.length) {
    panel.innerHTML = '<div class="alert-panel alert-ok"><span>✅</span> All tasks fully covered.</div>';
    return;
  }
  const shown = alerts.slice(0, 5);
  panel.innerHTML = `
    <div class="alerts-container">
      <div class="alerts-header">
        <span class="alerts-title">⚠ Live Alerts</span>
        <span class="alerts-count">
          ${alerts.filter(a=>a.priority==='Critical').length
            ? `<span class="badge badge-crit">${alerts.filter(a=>a.priority==='Critical').length} Critical</span>` : ''}
        </span>
      </div>
      <div id="id-alerts-list">
        ${shown.map(a => `
          <div class="alert-row alert-${a.priority==='Critical'?'crit':'warn'}">
            <div class="alert-row-left">
              <span class="badge ${a.priority==='Critical'?'badge-crit':'badge-warn'}">${a.priority}</span>
              <span class="alert-msg">${a.message}</span>
            </div>
            <div class="alert-row-right">
              ${a.rec_staff && a.rec_staff.length
                ? `<span class="alert-rec">Rec: ${a.rec_staff.slice(0,2).join(', ')}</span>` : ''}
            </div>
          </div>`).join('')}
        ${alerts.length > 5 ? `<div class="muted small" style="padding:6px 12px">+${alerts.length - 5} more alerts</div>` : ''}
      </div>
    </div>`;
}

function renderIDStaffRoster(staff, absent) {
  const grid = document.getElementById('id-staff-grid');
  const absentContainer = document.getElementById('id-absent-staff');
  if (!grid) return;
  try {
    grid.innerHTML = Array.isArray(staff)
      ? staff.map(s => renderIDStaffCard(s)).join('')
      : '<div class="muted small">No staff roster available.</div>';
  } catch (err) {
    console.error('Error rendering intraday staff roster:', err);
    grid.innerHTML = '<div class="muted small">Unable to render staff roster.</div>';
  }

  if (!absentContainer) return;
  if (Array.isArray(absent) && absent.length) {
    absentContainer.innerHTML = `
      <div class="panel mt-16">
        <div class="panel-title">Absent Staff (${absent.length})</div>
        <div class="absent-chips">
          ${absent.map(a => `
            <div class="absent-card">
              <div class="absent-card-name">${a.id}</div>
              <div class="absent-skill">${a.skill1}</div>
              <div class="badge badge-warn">${a.leave_type}</div>
            </div>`).join('')}
        </div>
      </div>`;
  } else {
    absentContainer.innerHTML = '';
  }
}

function renderIDSubContent() {
  const container = document.getElementById('id-sub-content');
  if (!container || !ID_DATA) return;

  if (ID_ACTIVE_TAB === 'staff') {
    container.innerHTML = `
      <div class="panel mt-20">
        <div class="panel-title">Staff Roster — ${ID_DATA.date_label}</div>
        <div class="staff-grid" id="id-staff-grid"></div>
        <div id="id-absent-staff"></div>
      </div>`;
    renderIDStaffRoster(ID_DATA.staff, ID_DATA.absent_staff || []);
  } else if (ID_ACTIVE_TAB === 'gate-timeline') {
    container.innerHTML = `
      <div class="panel mt-20">
        <div class="panel-title-row">
          <span class="panel-title">Live Gate Timeline — ${ID_DATA.date_label}</span>
          <div class="gate-controls">
            <button class="btn-delay" id="id-gate-play">${ID_AUTO_REFRESH ? 'Pause' : 'Play'}</button>
            <button class="btn-delay" id="id-gate-reset">Reset</button>
          </div>
        </div>
        <div class="gate-status-row">
          <div class="sim-label">SIM TIME</div>
          <div class="sim-time" id="id-sim-time-value">${formatMins(ID_SIM_TIME || getCurrentTimeMins())}</div>
          <div class="sim-speed-control">
            <label>Speed: <span id="id-sim-speed-value">${ID_SIM_SPEED.toFixed(1)}x</span></label>
            <input type="range" id="id-sim-speed" min="0.5" max="4" step="0.5" value="${ID_SIM_SPEED}" />
          </div>
        </div>
        <div class="section-hint">Use the timeline to inspect gate occupancy and inject live disruption to see how the schedule rebalances.</div>
        <div id="id-gate-timeline"></div>
      </div>`;
    document.getElementById('id-gate-play').addEventListener('click', toggleGateTimelineAutoRefresh);
    document.getElementById('id-gate-reset').addEventListener('click', resetIntraday);
    const speedInput = document.getElementById('id-sim-speed');
    if (speedInput) {
      speedInput.addEventListener('input', e => {
        setGateTimelineSpeed(e.target.value);
      });
    }
    renderIDGateTimeline();
    renderGateTimelineNowLine();
  } else {
    container.innerHTML = `
      <div class="panel mt-20">
        <div class="panel-title-row">
          <span class="panel-title">Flight Operations — ${ID_DATA.date_label}</span>
          <div class="filter-row">
            <input class="search-input" id="id-flight-search" placeholder="Search flight…" />
            <select id="id-status-filter" class="select-input">
              <option value="">All</option>
              <option value="Arrival">Arrivals</option>
              <option value="Departure">Departures</option>
              <option value="Completed">Completed</option>
            </select>
          </div>
        </div>
        <div class="table-scroll">
          <table class="data-table flights-table">
            <thead>
              <tr>
                <th>Time</th><th>Flight</th><th>Route</th><th>Airline</th>
                <th>Gate</th><th>Type</th><th>Tasks</th><th>Status</th><th>Action</th>
              </tr>
            </thead>
            <tbody id="id-flights-tbody"></tbody>
          </table>
        </div>
      </div>`;
    renderIDFlightsTable(ID_DATA.flights);
    document.getElementById('id-flight-search').addEventListener('input', filterIDFlights);
    document.getElementById('id-status-filter').addEventListener('change', filterIDFlights);
  }
}

function renderIDGateTimeline() {
  const flights = Array.isArray(ID_DATA.flights) ? ID_DATA.flights : [];
  const TIME_START = 0;
  const TIME_END = 1440;
  const RANGE = TIME_END - TIME_START;
  const LEAD_MINS = 30;
  const TRAIL_MINS = 60;

  const AIRLINE_COLORS = {
    'Ryanair':                          '#073590',
    'Aer Lingus':                       '#00843D',
    'British Airways':                  '#2B5EAE',
    'Lufthansa':                        '#004A7C',
    'Air France':                       '#002157',
    'KLM':                              '#00A1DE',
    'Delta Air Lines':                  '#C01933',
    'American Airlines':                '#CB0035',
    'Air Canada':                       '#C8242B',
    'United Airlines':                  '#165788',
    'Iberia Express':                   '#C80E1A',
    'Iberia':                           '#D40E1A',
    'Finnair':                          '#003580',
    'Vueling':                          '#C9A800',
    'Aer Lingus Regional':              '#006633',
    'Lauda Europe':                     '#E60026',
    'Swiss':                            '#B3001B',
    'Austrian Airlines':                '#CC0000',
    'Brussels Airlines':                '#2B3990',
    'TAP Air Portugal':                 '#018951',
    'easyJet':                          '#E85E0C',
    'Wizz Air':                         '#C5027D',
    'Norwegian':                        '#D40E2A',
    'TUI Airways':                      '#00539F',
    'Eurowings':                        '#7B2D8B',
  };

  function getColor(airline) {
    if (AIRLINE_COLORS[airline]) return AIRLINE_COLORS[airline];
    let hash = 0;
    for (let i = 0; i < airline.length; i++) hash = airline.charCodeAt(i) + ((hash << 5) - hash);
    const hue = ((hash & 0x7fffffff) % 260) + 40;
    return `hsl(${hue}, 60%, 35%)`;
  }

  function pct(mins) {
    return Math.max(0, Math.min(100, (mins - TIME_START) / RANGE * 100));
  }

  if (ID_SIM_TIME == null) {
    ID_SIM_TIME = getCurrentTimeMins();
  }

  const gateMap = {};
  for (const f of flights) {
    const g = f.gate;
    if (!g || f.time_mins == null) continue;
    if (!gateMap[g]) gateMap[g] = [];
    gateMap[g].push(f);
  }

  const sortedGates = Object.keys(gateMap).sort((a, b) => {
    const aRem = a.startsWith('R'), bRem = b.startsWith('R');
    if (aRem !== bRem) return aRem ? 1 : -1;
    return (parseInt(a.replace(/^R/, '')) || 0) - (parseInt(b.replace(/^R/, '')) || 0);
  });

  function getPier(g) {
    if (g.startsWith('R')) return 'Remote Apron';
    const n = parseInt(g);
    if (isNaN(n)) return 'Other';
    const p = Math.floor(n / 100);
    if (p === 5) return 'T2 — Pier 5';
    if (p === 4) return 'T1 — Pier 4';
    if (p === 3) return 'T1 — Pier 3';
    if (p === 2) return 'T1 — Pier 2';
    if (p === 1) return 'T1 — Pier 1';
    return 'Other';
  }

  const PIER_ORDER = [
    'T1 — Pier 1', 'T1 — Pier 2', 'T1 — Pier 3', 'T1 — Pier 4',
    'T2 — Pier 5', 'Remote Apron', 'Other',
  ];

  const pierGroups = {};
  for (const g of sortedGates) {
    const pier = getPier(g);
    if (!pierGroups[pier]) pierGroups[pier] = [];
    pierGroups[pier].push(g);
  }

  const axisHtml = [];
  for (let h = 0; h <= 24; h++) {
    axisHtml.push(`
      <div class="gt-hour-tick" style="left:${pct(h * 60).toFixed(2)}%">
        <span class="gt-hour-label">${String(h % 24).padStart(2, '0')}</span>
        <div class="gt-hour-line"></div>
      </div>`);
  }

  let rowsHtml = '';
  let rowIdx = 0;
  for (const pier of PIER_ORDER) {
    const gatesInPier = pierGroups[pier];
    if (!gatesInPier || !gatesInPier.length) continue;

    rowsHtml += `<div class="gt-pier-row">
      <div class="gt-gate-label gt-pier-label-cell"></div>
      <div class="gt-track gt-pier-name-track">${pier}</div>
    </div>`;

    for (const gate of gatesInPier) {
      const isEven = (rowIdx % 2 === 0);
      rowIdx++;
      const barsHtml = gateMap[gate].map(f => {
        const t = f.time_mins;
        const s = Math.max(TIME_START, t - LEAD_MINS);
        const e = Math.min(TIME_END, t + TRAIL_MINS);
        if (e <= TIME_START || s >= TIME_END) return '';
        const lp = pct(s).toFixed(2);
        const wp = (pct(e) - pct(s)).toFixed(2);
        const color = getColor(f.airline_name || '');
        const tip = `${f.flight_no} — ${f.airline_name}\n${f.status} · STA ${f.sta}\n${f.origin_code} ${f.origin}\nGate ${f.gate}`;
        return `<div class="gt-flight-bar" style="left:${lp}%;width:${wp}%;background:${color}" title="${tip.replace(/"/g, '&quot;')}">
          <span class="gt-flight-label">${f.flight_no}</span>
        </div>`;
      }).join('');

      rowsHtml += `<div class="gt-gate-row${isEven ? '' : ' gt-row-alt'}">
        <div class="gt-gate-label">${gate}</div>
        <div class="gt-track">${barsHtml}</div>
      </div>`;
    }
  }

  const nowLeft = pct(ID_SIM_TIME).toFixed(2);
  const nowLine = `<div class="gt-now-line" style="left:${nowLeft}%">
      <span class="gt-now-label">${formatMins(ID_SIM_TIME)}</span>
    </div>`;

  const dayLabel = ID_DATA.date_label.split(' ')[0].toUpperCase();

  document.getElementById('id-gate-timeline').innerHTML = `
    <div class="panel mt-16 gt-panel">
      <div class="gt-panel-header">
        <span class="gt-panel-title">${dayLabel} GATE TIMELINE</span>
        <span class="gt-count-badge">${flights.length} flights scheduled</span>
      </div>
      <div class="gt-chart-scroll">
        <div class="gt-chart">
          <div class="gt-axis-row">
            <div class="gt-gate-label"></div>
            <div class="gt-axis-track">${axisHtml.join('')}</div>
          </div>
          ${nowLine}
          ${rowsHtml}
        </div>
      </div>
    </div>`;
}

function renderIDStaffCard(s) {
  const utilColor = s.utilisation_pct > 90 ? ID.crit : s.utilisation_pct > 70 ? ID.warn : ID.ok;
  const assignments = s.assignments || [];
  const breaks = s.breaks || [];
  const assignedFlights = [...new Set(assignments.map(a => a.task_id ? a.task_id.split('_')[0] : '').filter(Boolean))];

  return `
    <div class="staff-card">
      <div class="staff-card-header">
        <div class="staff-card-title">
          <div class="staff-card-id">${s.id}</div>
          <div class="staff-card-skill">
            <span class="dot" style="background:${ID_SKILL_COLOR[s.skill1]||'#888'}"></span>
            <span>${s.skill1}</span>
            ${s.skill2 ? `<span class="skill2-badge">${s.skill2}</span>` : ''}
          </div>
        </div>
        <div class="staff-card-shift shift-${s.shift}">${s.shift}</div>
      </div>
      <div class="staff-card-meta">${s.shift_label}</div>
      <div class="staff-card-summary">
        <span class="staff-card-pill">${assignments.length} tasks</span>
        <span class="staff-card-pill">${assignedFlights.length} flights</span>
        <span class="staff-card-pill">${Math.round(s.utilisation_pct)}% utilisation</span>
      </div>
      <div class="util-bar-row">
        <div class="util-bar">
          <div class="util-bar-fill" style="width:${s.utilisation_pct}%;background:${utilColor}"></div>
        </div>
        <span class="util-pct" style="color:${utilColor}">${Math.round(s.utilisation_pct)}%</span>
      </div>
      <div class="staff-assignments-list">
        ${assignments.length > 0 ? assignments.slice(0, 5).map(a => `
          <div class="staff-assign-row">
            <span class="staff-assign-time">${a.start}–${a.end}</span>
            <span class="staff-assign-task">${a.task} <span class="muted">${a.task_id ? a.task_id.split('_')[0] : ''}</span></span>
          </div>`).join('') : '<div class="muted small">No tasks assigned</div>'}
        ${assignments.length > 5 ? `<div class="muted small">+${assignments.length - 5} more tasks</div>` : ''}
      </div>
      ${breaks.length ? `
        <div class="staff-breaks">
          ${breaks.map(b => `<span class="break-chip">${b.type}: ${b.start}–${b.end}</span>`).join('')}
        </div>` : ''}
    </div>`;
}

// ── Flights Table ───────────────────────────────────────────────
function renderIDFlightsTable(flights) {
  const tbody = document.getElementById('id-flights-tbody');
  if (!tbody) return;

  tbody.innerHTML = flights.slice(0, 400).map(f => {
    const tasks = f.tasks || [];
    const hasCrit = tasks.some(t => t.alert && t.priority === 'Critical');
    const hasWarn = tasks.some(t => t.alert);
    const taskPills = tasks.slice(0, 4).map(t => {
      const cls = !t.alert ? 'task-pill-ok' : t.priority === 'Critical' ? 'task-pill-crit' : 'task-pill-warn';
      return `<span class="task-pill ${cls}" title="${t.task}">${t.task.split(' ')[0].slice(0,4)}</span>`;
    }).join('');
    const delayBadge = f.delay_mins > 0
      ? `<span class="badge badge-warn">+${f.delay_mins}m</span>` : '';
    const rowCls = hasCrit ? 'row-crit' : hasWarn ? 'row-warn' : '';

    const statusClass = f.status === 'Arrival'
      ? 'badge-info'
      : f.status === 'Departure'
        ? 'badge-accent'
        : f.status === 'Completed'
          ? 'badge-ok'
          : 'badge-warn';

    return `<tr class="${rowCls}" data-fn="${f.flight_no}" style="cursor:pointer">
      <td class="time-cell">${f.sta} ${delayBadge}</td>
      <td class="fn-cell">${f.flight_no}</td>
      <td class="route-cell">${f.origin_code} ${f.origin}</td>
      <td>${f.airline_name}</td>
      <td>${f.gate}</td>
      <td><span class="status-badge ${statusClass}">${f.status}</span></td>
      <td class="tasks-cell">${taskPills}</td>
      <td>${f.delay_mins > 0 ? `<span class="badge badge-warn">Delayed</span>` : '<span class="badge badge-ok">On time</span>'}</td>
      <td>
        <button class="btn-manage" data-fn="${f.flight_no}">⚙ Manage</button>
      </td>
    </tr>`;
  }).join('');

  // Row click → flight detail
  tbody.querySelectorAll('tr[data-fn]').forEach(tr =>
    tr.addEventListener('click', e => {
      if (e.target.closest('.btn-manage')) return;
      const fn = tr.dataset.fn;
      const flight = ID_DATA.flights.find(f => f.flight_no === fn);
      if (flight) showIDFlightDetail(flight);
    })
  );

  // Manage button
  tbody.querySelectorAll('.btn-manage').forEach(btn =>
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const fn = btn.dataset.fn;
      const flight = ID_DATA.flights.find(f => f.flight_no === fn);
      if (flight) showManageModal(flight);
    })
  );
}

function filterIDFlights() {
  const flightSearch = document.getElementById('id-flight-search');
  const q = (flightSearch && flightSearch.value ? flightSearch.value : '').toLowerCase();
  const statusFilter = document.getElementById('id-status-filter');
  const st = (statusFilter && statusFilter.value) ? statusFilter.value : '';
  const filtered = ID_DATA.flights.filter(f => {
    const mq = !q || f.flight_no.toLowerCase().includes(q)
      || f.origin.toLowerCase().includes(q) || f.airline_name.toLowerCase().includes(q);
    const ms = !st || f.status === st;
    return mq && ms;
  });
  renderIDFlightsTable(filtered);
}

// ── Flight Detail Panel ─────────────────────────────────────────
function showIDFlightDetail(flight) {
  ID_SELECTED_FLIGHT = flight;
  const panel = document.getElementById('id-flight-detail');
  const tasks = flight.tasks || [];

  panel.innerHTML = `
    <div class="fd-header">
      <div>
        <div class="fd-title">${flight.flight_no} — ${flight.origin}
          ${flight.delay_mins > 0 ? `<span class="badge badge-warn">+${flight.delay_mins}m delayed</span>` : ''}
        </div>
        <div class="fd-meta">
          ${flight.status} · Scheduled: <b>${flight.sta}</b> · Gate: <b>${flight.gate}</b>
          · ${flight.airline_name} · ${flight.aircraft_type}
          · <span class="haul-badge">${flight.haul}</span>
        </div>
      </div>
      <button class="fd-close" onclick="document.getElementById('id-flight-detail').classList.remove('open')">✕</button>
    </div>

    <!-- Manual Delay Controls -->
    <div class="delay-controls">
      <div class="delay-title">✋ Manual Delay Controls</div>
      <div class="delay-buttons">
        <button class="btn-delay" onclick="applyDelay('${flight.flight_no}', 30)">+30 min</button>
        <button class="btn-delay" onclick="applyDelay('${flight.flight_no}', 60)">+60 min</button>
        <button class="btn-delay" onclick="applyDelay('${flight.flight_no}', 90)">+90 min</button>
        <div class="delay-custom">
          <input type="number" id="id-custom-delay" class="search-input" style="width:80px" placeholder="min" min="0" step="5"/>
          <button class="btn-delay btn-accent" onclick="applyCustomDelay('${flight.flight_no}')">Apply Delay</button>
        </div>
        <button class="btn-delay btn-crit" onclick="cancelFlight('${flight.flight_no}')">✕ Cancel Flight</button>
      </div>
    </div>

    <!-- Tasks -->
    <div class="fd-tasks">
      <div class="fd-section-title">Task Assignments</div>
      ${tasks.length === 0
        ? '<div class="empty-state small">No tasks for this flight.</div>'
        : tasks.map(t => `
          <div class="fd-task-row ${t.alert ? 'fd-task-gap' : ''}">
            <div class="fd-task-name">
              <span class="dot" style="background:${ID_SKILL_COLOR[t.skill]||'#888'}"></span>
              ${t.task}
              <span class="badge ${t.priority==='Critical'?'badge-crit':'badge-warn'}">${t.priority}</span>
            </div>
            <div class="fd-task-time">${t.start} – ${t.end} · need ${t.staff_needed}</div>
            <div class="fd-task-staff">
              ${t.assigned.length
                ? t.assigned.map(id =>
                    `<span class="staff-chip">${id}
                      <button class="chip-remove" onclick="unassignStaff('${t.id}','${id}')">✕</button>
                    </span>`).join('')
                : '<span class="gap-chip">⚠ Unassigned</span>'}
              <button class="btn-assign-inline" onclick="showManageModalForTask(${JSON.stringify(flight).replace(/"/g,'&quot;')}, '${t.id}')">+ Assign</button>
            </div>
          </div>`).join('')}
    </div>`;
  panel.classList.add('open');
}

// ── Delay / Cancel ─────────────────────────────────────────────
async function applyDelay(flightNo, delayMins) {
  const overrides = ID_DATA.overrides || {};
  const flightOverride = overrides[flightNo] || {};
  const existing = flightOverride.delay_mins || 0;
  await postDelay(flightNo, existing + delayMins, false);
}

async function applyCustomDelay(flightNo) {
  const customDelay = document.getElementById('id-custom-delay');
  const val = parseInt((customDelay && customDelay.value) ? customDelay.value : '0', 10);
  if (!val || val <= 0) return;
  await postDelay(flightNo, val, false);
}

async function cancelFlight(flightNo) {
  if (!confirm(`Cancel flight ${flightNo}? This will release all assigned staff.`)) return;
  await postDelay(flightNo, 0, true);
}

async function postDelay(flightNo, delayMins, cancelled) {
  try {
    ID_DATA = await fetch('/api/intraday/delay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flight_no: flightNo, delay_mins: delayMins, cancelled }),
    }).then(r => r.json());
    renderIntradayPage();
    // Re-show flight detail if still exists
    const flight = ID_DATA.flights.find(f => f.flight_no === flightNo);
    if (flight) showIDFlightDetail(flight);
  } catch (e) { console.error(e); }
}

// ── Manage Modal ────────────────────────────────────────────────
function showManageModal(flight) {
  showManageModalForTask(flight, null);
}

function showManageModalForTask(flight, taskId) {
  if (typeof flight === 'string') {
    try { flight = JSON.parse(flight); } catch(e) { return; }
  }
  ID_MANAGE_TASK = taskId;
  const overlay = document.getElementById('id-manage-overlay');
  const content = document.getElementById('id-manage-content');
  const tasks = flight.tasks || [];
  const targetTask = taskId ? tasks.find(t => t.id === taskId) : null;
  const allStaff = ID_DATA.staff || [];

  const taskOptions = tasks.map(t =>
    `<option value="${t.id}" ${t.id === taskId ? 'selected' : ''}>${t.task} (${t.start}–${t.end})</option>`
  ).join('');

  content.innerHTML = `
    <div class="modal-header">
      <div class="modal-title">⚙ Manage — ${flight.flight_no} <span class="muted">${flight.origin}</span></div>
      <button class="fd-close" onclick="closeManageModal()">✕</button>
    </div>
    <div class="modal-body">
      <div class="modal-task-select">
        <label>Select Task:</label>
        <select id="id-manage-task-sel" class="select-input" onchange="refreshManageStaff('${flight.flight_no}')">
          <option value="">— All Tasks —</option>
          ${taskOptions}
        </select>
      </div>
      <div id="id-manage-staff-list"></div>
    </div>`;

  overlay.classList.remove('hidden');
  refreshManageStaff(flight.flight_no);
}

function refreshManageStaff(flightNo) {
  const flight = ID_DATA.flights.find(f => f.flight_no === flightNo);
  if (!flight) return;

  const taskSel = document.getElementById('id-manage-task-sel');
  const taskId = taskSel ? taskSel.value : '';
  const task = taskId ? (flight.tasks ? flight.tasks.find(t => t.id === taskId) : null) : null;
  const allStaff = ID_DATA.staff || [];

  const assignedIds = task ? new Set(task.assigned) : new Set();
  const skill = task ? task.skill : undefined;

  const primary = skill ? allStaff.filter(s => s.skill1 === skill) : allStaff;
  const secondary = skill ? allStaff.filter(s => s.skill2 === skill && s.skill1 !== skill) : [];

  function staffRow(s, isPrimary) {
    const isAssigned = assignedIds.has(s.id);
    const util = s.utilisation_pct;
    const utilColor = util > 90 ? ID.crit : util > 70 ? ID.warn : ID.ok;
    return `
      <div class="manage-staff-row ${isAssigned ? 'manage-assigned' : ''}">
        <div class="manage-staff-info">
          <span class="dot" style="background:${ID_SKILL_COLOR[s.skill1]||'#888'}"></span>
          <span class="manage-staff-id">${s.id}</span>
          <span class="manage-staff-skill">${s.skill1}${s.skill2 ? ' / '+s.skill2 : ''}</span>
          <span class="shift-badge shift-${s.shift}">${s.shift_label}</span>
          ${!isPrimary ? '<span class="badge badge-warn">2nd skill</span>' : ''}
        </div>
        <div class="manage-staff-util" style="color:${utilColor}">${util}% busy</div>
        ${task ? `<button class="btn-manage-assign ${isAssigned?'btn-unassign':''}"
          onclick="toggleStaffAssignment('${task.id}','${s.id}','${isAssigned?'unassign':'assign'}','${flightNo}')">
          ${isAssigned ? '✕ Remove' : '+ Assign'}
        </button>` : ''}
      </div>`;
  }

  document.getElementById('id-manage-staff-list').innerHTML = `
    ${task ? `
      <div class="manage-task-info">
        <div class="manage-task-header">
          <span class="fd-task-name">
            <span class="dot" style="background:${ID_SKILL_COLOR[skill]||'#888'}"></span>
            ${task.task}
            <span class="badge ${task.priority==='Critical'?'badge-crit':'badge-warn'}">${task.priority}</span>
          </span>
          <span class="fd-task-time">${task.start} – ${task.end} · Need ${task.staff_needed}, Assigned ${task.assigned.length}</span>
        </div>
      </div>` : ''}
    <div class="manage-section-title">Primary Skill Staff (${primary.length})</div>
    ${primary.length ? primary.map(s => staffRow(s, true)).join('') : '<div class="muted small">No primary skill staff on duty</div>'}
    ${secondary.length ? `
      <div class="manage-section-title" style="margin-top:12px">Secondary Skill Staff (${secondary.length})</div>
      ${secondary.map(s => staffRow(s, false)).join('')}` : ''}`;
}

async function toggleStaffAssignment(taskId, staffId, action, flightNo) {
  try {
    ID_DATA = await fetch('/api/intraday/assign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_id: taskId, staff_id: staffId, action }),
    }).then(r => r.json());
    renderIntradayPage();
    // Keep modal open and refresh
    const flight = ID_DATA.flights.find(f => f.flight_no === flightNo);
    if (flight) {
      showManageModalForTask(flight, taskId);
    }
  } catch (e) { console.error(e); }
}

async function unassignStaff(taskId, staffId) {
  const flight = ID_DATA.flights.find(f => f.tasks && f.tasks.some(t => t.id === taskId));
  if (!flight) return;
  await toggleStaffAssignment(taskId, staffId, 'unassign', flight.flight_no);
  const updatedFlight = ID_DATA.flights.find(f => f.flight_no === flight.flight_no);
  if (updatedFlight) showIDFlightDetail(updatedFlight);
}

function closeManageModal() {
  const overlay = document.getElementById('id-manage-overlay');
  if (overlay) overlay.classList.add('hidden');
}

// ── Expose ──────────────────────────────────────────────────────
window.initIntraday = initIntraday;
window.applyDelay = applyDelay;
window.applyCustomDelay = applyCustomDelay;
window.cancelFlight = cancelFlight;
window.showManageModal = showManageModal;
window.showManageModalForTask = showManageModalForTask;
window.closeManageModal = closeManageModal;
window.toggleStaffAssignment = toggleStaffAssignment;
window.unassignStaff = unassignStaff;

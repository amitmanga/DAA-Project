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

function normIDMins(m) {
  return m < 240 ? m + 1440 : m;
}

function idPct(m) {
  const nm = normIDMins(m);
  return Math.max(0, Math.min(100, (nm - 240) / 1440 * 100));
}

function getCurrentTimeMins() {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

function startGateTimelineTimer() {
  if (ID_SIM_TIMER) return;
  if (ID_SIM_TIME == null) ID_SIM_TIME = getCurrentTimeMins();
  ID_SIM_TIMER = setInterval(() => {
    // Range is [240, 1680] effectively. 
    // If it hits 240 (04:00 next day aka 1680), pause or stop.
    let next = ID_SIM_TIME + (ID_SIM_SPEED * 0.5);
    // If we were at 03:59 (239) and moved past 04:00 (240), that's the end.
    if (ID_SIM_TIME < 240 && next >= 240) {
      next = 240;
      stopGateTimelineTimer();
    }
    ID_SIM_TIME = next;
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
  const rtLine = document.getElementById('id-rt-now-line');
  const rtLabel = document.getElementById('id-rt-now-label');
  
  if (typeof ID_SIM_TIME !== 'number') return;
  const left = idPct(ID_SIM_TIME);
  
  if (line) line.style.left = `${left.toFixed(2)}%`;
  const label = line ? line.querySelector('.gt-now-label') : null;
  if (label) label.textContent = formatMins(ID_SIM_TIME);
  
  if (rtLine) rtLine.style.left = `${left.toFixed(2)}%`;
  if (rtLabel) rtLabel.textContent = formatMins(ID_SIM_TIME);

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
      <button class="sub-tab ${ID_ACTIVE_TAB==='staff-timeline'?'active':''}" data-idtab="staff-timeline">📅 Roster Timeline</button>
      <button class="sub-tab ${ID_ACTIVE_TAB==='map'?'active':''}" data-idtab="map">🗺 Network Map</button>
      <button class="sub-tab ${ID_ACTIVE_TAB==='opt'?'active':''}" data-idtab="opt">⚙ Optimization</button>
      <button class="sub-tab ${ID_ACTIVE_TAB==='perf'?'active':''}" data-idtab="perf">📈 Performance Analysis</button>
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

  // Attach search/filter listeners
  const searchEl = document.getElementById('id-staff-search');
  const shiftEl  = document.getElementById('id-shift-filter');
  if (searchEl) searchEl.addEventListener('input',  filterIDStaff);
  if (shiftEl)  shiftEl.addEventListener('change', filterIDStaff);

  renderIDStaffCards(Array.isArray(staff) ? staff : []);

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

function filterIDStaff() {
  const q     = (document.getElementById('id-staff-search')?.value || '').toLowerCase();
  const shift = document.getElementById('id-shift-filter')?.value || '';
  const filtered = (ID_DATA.staff || []).filter(s => {
    const matchQ = !q || s.id.toLowerCase().includes(q)
      || (s.skill1 || '').toLowerCase().includes(q)
      || (s.skill2 || '').toLowerCase().includes(q);
    const matchShift = !shift || s.shift === shift;
    return matchQ && matchShift;
  });
  renderIDStaffCards(filtered);
}

function renderIDStaffCards(staffList) {
  const grid = document.getElementById('id-staff-grid');
  if (!grid) return;
  if (!staffList.length) {
    grid.innerHTML = '<div class="muted small" style="padding:16px">No staff match your search.</div>';
    return;
  }
  grid.innerHTML = staffList.map(s => {
    const utilColor = s.utilisation_pct > 90 ? ID.crit : s.utilisation_pct > 70 ? ID.warn : ID.ok;
    const assignments = s.assignments || [];
    const breaks = s.breaks || [];
    const assignedFlights = [...new Set(assignments.map(a => a.task_id ? a.task_id.split('_')[0] : '').filter(Boolean))];
    return `
      <div class="staff-card" style="cursor:pointer" data-idstaffid="${s.id}">
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
          <span class="staff-card-pill">📋 ${assignments.length} tasks</span>
          <span class="staff-card-pill">✈ ${assignedFlights.length} flights</span>
          <span class="staff-card-pill" style="color:${utilColor}">📊 ${Math.round(s.utilisation_pct)}%</span>
        </div>
        <div class="util-bar-row">
          <div class="util-bar">
            <div class="util-bar-fill" style="width:${Math.min(s.utilisation_pct,100)}%;background:${utilColor}"></div>
          </div>
          <span class="util-pct" style="color:${utilColor}">${Math.round(s.utilisation_pct)}%</span>
        </div>
        <div class="staff-card-click-hint">Click for full details →</div>
      </div>`;
  }).join('');

  grid.querySelectorAll('.staff-card[data-idstaffid]').forEach(card => {
    card.addEventListener('click', () => {
      const sid = card.dataset.idstaffid;
      const s = (ID_DATA.staff || []).find(x => x.id === sid);
      if (s) showIDStaffDetail(s);
    });
  });
}

function _getIDStaffOverlay() {
  let overlay = document.getElementById('id-staff-detail-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'id-staff-detail-overlay';
    overlay.className = 'modal-overlay hidden';
    overlay.innerHTML = `<div class="modal-box modal-box-wide" id="id-staff-modal-box"></div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) closeIDStaffDetail();
    });
  }
  return overlay;
}

function showIDStaffDetail(s) {
  const overlay = _getIDStaffOverlay();
  const box = document.getElementById('id-staff-modal-box');
  if (!box) return;
  const utilColor = s.utilisation_pct > 90 ? ID.crit : s.utilisation_pct > 70 ? ID.warn : ID.ok;
  const assignments = s.assignments || [];
  const breaks = s.breaks || [];
  const assignedFlights = [...new Set(assignments.map(a => a.task_id ? a.task_id.split('_')[0] : '').filter(Boolean))];

  box.innerHTML = `
    <div class="modal-header">
      <div style="flex:1">
        <div class="modal-title">👤 ${s.id}</div>
        <div class="fd-meta" style="margin-top:4px;color:rgba(255,255,255,0.75)">
          <span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${ID_SKILL_COLOR[s.skill1]||'#888'};margin-right:5px;vertical-align:middle"></span>
          ${s.skill1}${s.skill2 ? ` · ${s.skill2}` : ''}
          &nbsp;·&nbsp;
          <span class="staff-card-shift shift-${s.shift}" style="padding:2px 10px;vertical-align:middle">${s.shift}</span>
        </div>
      </div>
      <button class="fd-close" onclick="closeIDStaffDetail()">✕</button>
    </div>
    <div class="modal-body">
      <div class="staff-detail-kpis">
        <div class="staff-detail-kpi">
          <div class="staff-detail-kpi-val">${assignments.length}</div>
          <div class="staff-detail-kpi-lbl">Tasks Assigned</div>
        </div>
        <div class="staff-detail-kpi">
          <div class="staff-detail-kpi-val">${assignedFlights.length}</div>
          <div class="staff-detail-kpi-lbl">Flights Covered</div>
        </div>
        <div class="staff-detail-kpi">
          <div class="staff-detail-kpi-val" style="color:${utilColor}">${Math.round(s.utilisation_pct)}%</div>
          <div class="staff-detail-kpi-lbl">Utilisation</div>
        </div>
        <div class="staff-detail-kpi">
          <div class="staff-detail-kpi-val">${breaks.length}</div>
          <div class="staff-detail-kpi-lbl">Breaks</div>
        </div>
      </div>

      <div class="staff-detail-section">
        <div class="staff-detail-section-title">🕐 Shift Details</div>
        <div class="staff-card-meta">${s.shift_label}</div>
      </div>

      <div class="staff-detail-section">
        <div class="staff-detail-section-title">☕ Scheduled Breaks (${breaks.length})</div>
        ${breaks.length
          ? `<div class="staff-breaks">${breaks.map(b => `<span class="break-chip">${b.type}: ${b.start}–${b.end}</span>`).join('')}</div>`
          : '<div class="muted small">No breaks scheduled.</div>'}
      </div>

      <div class="staff-detail-section">
        <div class="staff-detail-section-title">📋 All Task Assignments (${assignments.length})</div>
        ${assignments.length === 0 ? '<div class="muted small">No tasks assigned for this shift.</div>'
          : assignments.map(a => `
            <div class="staff-assign-row">
              <span class="staff-assign-time">${a.start}–${a.end}</span>
              <span class="staff-assign-task">
                <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${ID_SKILL_COLOR[a.skill]||'#888'};margin-right:5px;vertical-align:middle"></span>
                ${a.task} <span class="muted">${a.task_id ? a.task_id.split('_')[0] : ''}</span>
              </span>
            </div>`).join('')}
      </div>

      ${assignedFlights.length ? `
        <div class="staff-detail-section">
          <div class="staff-detail-section-title">✈ Flights Covered (${assignedFlights.length})</div>
          <div class="staff-flights-list">
            ${assignedFlights.map(fn => {
              const f = (ID_DATA.flights || []).find(fl => fl.flight_no === fn);
              return f
                ? `<div class="staff-flight-row">
                    <span class="fn-cell">${f.flight_no}</span>
                    <span>${f.origin_code} ${f.origin}</span>
                    <span class="muted">${f.sta} · Gate ${f.gate}</span>
                    <span class="status-badge ${f.status==='Arrival'?'badge-info':'badge-accent'}">${f.status}</span>
                  </div>`
                : `<div class="staff-flight-row"><span class="fn-cell">${fn}</span></div>`;
            }).join('')}
          </div>
        </div>` : ''}
    </div>`;

  overlay.classList.remove('hidden');
}

function closeIDStaffDetail() {
  const ov = document.getElementById('id-staff-detail-overlay');
  if (ov) ov.classList.add('hidden');
}
window.closeIDStaffDetail = closeIDStaffDetail;

function renderIDSubContent() {
  const container = document.getElementById('id-sub-content');
  if (!container || !ID_DATA) return;

  if (ID_ACTIVE_TAB === 'staff') {
    container.innerHTML = `
      <div class="panel mt-20">
        <div class="panel-title-row">
          <span class="panel-title">Staff Roster — ${ID_DATA.date_label}</span>
          <div class="filter-row">
            <input class="search-input" id="id-staff-search" placeholder="Search by ID, skill…" />
            <select id="id-shift-filter" class="select-input">
              <option value="">All Shifts</option>
              <option value="Day">Day</option>
              <option value="Night">Night</option>
            </select>
          </div>
        </div>
        <div class="staff-grid" id="id-staff-grid"></div>
        <div id="id-absent-staff"></div>
      </div>`;
    renderIDStaffRoster(ID_DATA.staff, ID_DATA.absent_staff || []);
  } else if (ID_ACTIVE_TAB === 'staff-timeline') {
    container.innerHTML = `
      <div class="panel mt-20">
        <div class="panel-title-row">
          <span class="panel-title">Staff Roster Timeline — ${ID_DATA.date_label}</span>
          <div class="filter-row">
            <input class="search-input" id="id-staff-timeline-search" placeholder="Search ID, skill…" />
            <select id="id-staff-timeline-shift" class="select-input">
              <option value="">All Shifts</option>
              <option value="Day">Day</option>
              <option value="Night">Night</option>
            </select>
            <button class="btn-delay" id="id-timeline-reset">Reset Sim</button>
          </div>
        </div>
        <div class="section-hint">Visualize staff coverage and break density. Syncs with live simulation clock.</div>
        <div id="id-staff-timeline"></div>
      </div>`;
    document.getElementById('id-timeline-reset').addEventListener('click', resetIntraday);
    document.getElementById('id-staff-timeline-search').addEventListener('input', renderIDRosterTimeline);
    document.getElementById('id-staff-timeline-shift').addEventListener('change', renderIDRosterTimeline);
    renderIDRosterTimeline();
    renderGateTimelineNowLine();
  } else if (ID_ACTIVE_TAB === 'perf') {
    renderIDPerfChart(container);
  } else if (ID_ACTIVE_TAB === 'opt') {
    renderIDOptimization(container);
  } else if (ID_ACTIVE_TAB === 'map') {
    renderIDMap(container);
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
  const TIME_START = 240;
  const TIME_END = 1680;
  const RANGE = 1440;
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
    return idPct(mins);
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
  for (let h = 4; h <= 28; h++) {
    axisHtml.push(`
      <div class="gt-hour-tick" style="left:${((h - 4) / 24 * 100).toFixed(2)}%">
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

// renderIDStaffCard replaced by renderIDStaffCards + showIDStaffDetail above

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

    const timeSuffix = f.time_mins < 240 ? ' <small style="opacity:0.6">+1</small>' : '';
    return `<tr class="${rowCls}" data-fn="${f.flight_no}" style="cursor:pointer">
      <td class="time-cell">${f.sta}${timeSuffix} ${delayBadge}</td>
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

    <!-- Event Timeline -->
    <div class="fd-tasks">
      <div class="fd-section-title">Event Timeline</div>
      ${tasks.length === 0
        ? '<div class="empty-state small">No events for this flight.</div>'
        : `<div class="event-timeline">
            ${tasks.map(t => `
            <div class="timeline-item">
              <div class="timeline-dot" style="background:${t.is_past ? '#10b981' : (ID_SKILL_COLOR[t.skill]||'#888')}"></div>
              <div class="timeline-content ${t.alert ? 'fd-task-gap' : ''}" style="${t.is_past ? 'opacity:0.75' : ''}">
                <div class="timeline-content-header">
                  <span class="timeline-time">${t.start}</span>
                  <span class="timeline-title" style="${t.is_past ? 'text-decoration:line-through' : ''}">${t.task}</span>
                  ${t.priority === 'Critical' && !t.is_past ? '<span class="badge badge-crit">Critical</span>' : (t.priority === 'High' && !t.is_past ? '<span class="badge badge-warn">High</span>' : '')}
                  ${t.is_past ? '<span class="badge badge-ok">✓ Done</span>' : ''}
                </div>
                <div class="timeline-meta">Scheduled: ${t.start} – ${t.end} · need ${t.staff_needed}</div>
                <div class="fd-task-staff">
                  ${t.assigned.length
                    ? t.assigned.map(id =>
                        `<span class="staff-chip">${id}
                          <button class="chip-remove" onclick="unassignStaff('${t.id}','${id}')">✕</button>
                        </span>`).join('')
                    : '<span class="gap-chip">⚠ Unassigned</span>'}
                  <button class="btn-assign-inline" onclick="showManageModalForTask(${JSON.stringify(flight).replace(/"/g,'&quot;')}, '${t.id}')">+ Assign</button>
                </div>
              </div>
            </div>`).join('')}
          </div>`}
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

  function isAvailable(s, t) {
    if (!t) return true; // Show all if no task selected
    if (assignedIds.has(s.id)) return true; // Always show if already assigned
    // Check shift bounds
    if (s.shift_start !== undefined && s.shift_end !== undefined) {
      if (t.start_mins < s.shift_start || t.end_mins > s.shift_end) return false;
    }
    // Check busy periods (assignments + breaks)
    const busy = (s.assignments || []).concat(s.breaks || []);
    for (let b of busy) {
      // Overlap: A starts before B ends AND A ends after B starts
      if (t.start_mins < b.end_mins && t.end_mins > b.start_mins) {
        return false;
      }
    }
    return true;
  }

  const primary = skill ? allStaff.filter(s => s.skill1 === skill && isAvailable(s, task)) : allStaff.filter(s => isAvailable(s, task));
  const secondary = skill ? allStaff.filter(s => s.skill2 === skill && s.skill1 !== skill && isAvailable(s, task)) : [];
  const others = skill ? allStaff.filter(s => s.skill1 !== skill && s.skill2 !== skill && isAvailable(s, task)) : [];

  function staffRow(s, isPrimary, isOther) {
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
          ${isOther ? '<span class="badge badge-crit">Skill mismatch</span>' : (!isPrimary ? '<span class="badge badge-warn">2nd skill</span>' : '')}
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
    ${primary.length ? primary.map(s => staffRow(s, true, false)).join('') : '<div class="muted small">No primary skill staff available at this time</div>'}
    ${secondary.length ? `
      <div class="manage-section-title" style="margin-top:12px">Secondary Skill Staff (${secondary.length})</div>
      ${secondary.map(s => staffRow(s, false, false)).join('')}` : ''}
    ${others.length ? `
      <div class="manage-section-title" style="margin-top:12px">Other Available Staff (${others.length})</div>
      ${others.map(s => staffRow(s, false, true)).join('')}` : ''}`;
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

// ── Performance Analysis ───────────────────────────────────────
function renderIDPerfChart(container) {
  container.innerHTML = `
    <div class="section-header" style="margin-top: 24px;">
      <h2>Task Performance &amp; Punctuality</h2>
      <span class="section-hint">Live performance of ground processes for today's operations.</span>
    </div>
    <div class="panel" style="max-width:600px; margin: 0 auto; display: flex; flex-direction: column; height: calc(100vh - 220px); min-height: 350px;">
      <div class="panel-title-row">
        <span class="panel-title"><img src="data:image/svg+xml;utf8,<svg fill='%231a2744' viewBox='0 0 24 24' xmlns='http://www.w3.org/2000/svg'><path d='M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1.41 16.09V20h-2.67v-1.93c-1.71-.36-3.16-1.46-3.27-3.4h1.96c.1 1.05.82 1.87 2.65 1.87 1.96 0 2.4-1.08 2.4-1.73 0-.91-.54-1.57-2.73-2.18-2.6-.71-3.69-2.07-3.69-3.76 0-1.63 1.25-2.81 2.69-3.21V4h2.67v1.94c1.54.34 2.89 1.47 2.97 3.25h-1.96c-.11-1.07-.86-1.74-2.5-1.74-1.69 0-2.3.93-2.3 1.58 0 1.08.77 1.51 2.87 2.1 2.65.75 3.55 2.1 3.55 3.84-.01 1.86-1.5 3-2.64 3.3z'/></svg>" width="16" style="vertical-align:text-bottom; margin-right:4px;">Ground Process Punctuality</span>
        <div style="font-size:0.75rem;"><span style="color:var(--text); font-weight:700;">79.4 %</span> <span style="color:var(--muted);">(Live Avg)</span></div>
      </div>
      <div style="flex: 1; position: relative;">
        <canvas id="id-perf-radar"></canvas>
      </div>
    </div>
  `;

  setTimeout(() => {
    const ctx = document.getElementById('id-perf-radar');
    if (!ctx) return;
    if (window.ID_CHARTS && window.ID_CHARTS['perf-radar']) window.ID_CHARTS['perf-radar'].destroy();

    Chart.defaults.color = window.DAA ? DAA.text : '#1a2744';
    Chart.defaults.font.family = 'Inter, sans-serif';

    if (!window.ID_CHARTS) window.ID_CHARTS = {};
    window.ID_CHARTS['perf-radar'] = new Chart(ctx, {
      type: 'radar',
      data: {
        labels: ['Cleaning', 'Catering', 'Maintenance', 'Fueling', 'Loading', 'Boarding'],
        datasets: [{
          label: 'Live Tracking',
          data: [94, 88, 85, 76, 68, 65],
          backgroundColor: 'rgba(34, 114, 180, 0.4)',
          borderColor: '#2b8ad5',
          pointBackgroundColor: '#2b8ad5',
          pointBorderColor: window.DAA ? (DAA.bg || '#fff') : '#fff',
          pointHoverBackgroundColor: '#fff',
          pointHoverBorderColor: '#2b8ad5',
          borderWidth: 2,
          fill: true,
        }, {
          label: 'Scheduled Avg',
          data: [90, 85, 80, 75, 65, 60],
          backgroundColor: 'rgba(0, 0, 0, 0)',
          borderColor: 'rgba(0, 0, 0, 0.3)',
          borderDash: [5, 5],
          borderWidth: 2,
          pointRadius: 0,
          fill: false,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          r: {
            angleLines: { color: 'rgba(0, 0, 0, 0.1)' },
            grid: { color: 'rgba(0, 0, 0, 0.1)' },
            pointLabels: { color: window.DAA ? DAA.text : '#1a2744', font: { size: 11, weight: '500' } },
            ticks: { display: false, min: 0, max: 100 }
          }
        },
        plugins: {
          legend: {
            position: 'bottom', align: 'end',
            labels: { color: window.DAA ? DAA.muted : '#6b7280', boxWidth: 10, boxHeight: 10, usePointStyle: true, pointStyle: 'circle' }
          },
          tooltip: {
            backgroundColor: 'rgba(0,0,0,0.8)', titleFont: { size: 13 }, bodyFont: { size: 13 },
            callbacks: { label: function(ctx) { return ctx.dataset.label + ': ' + ctx.raw + '%'; } }
          }
        }
      }
    });
  }, 50);
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
window.unassignStaff = unassignStaff;// ── Route Map ──────────────────────────────────────────────────
function renderIDMap(container) {
  container.innerHTML = `
    <div class="map-panel mt-16">
      <div class="map-header">
        <div class="map-title">✈ Live Connectivity Map — Operational View ${ID_DATA.date_label}</div>
      </div>
      <div id="map-intraday" class="map-container"></div>
    </div>`;

  setTimeout(() => {
    const manager = new RouteMapManager('map-intraday');
    if (window.MAPS) window.MAPS['intraday'] = manager;
    manager.loadData('/api/map-data/intraday');
  }, 100);
}

// ── Optimization Tab ────────────────────────────────────────────
async function renderIDOptimization(container) {
  container.innerHTML = `<div class="loading-spinner"><div class="spinner"></div><span>Loading constraints...</span></div>`;
  
  let constraints;
  try {
    constraints = await fetch('/api/intraday/constraints').then(r => r.json());
  } catch (e) {
    container.innerHTML = `<div class="empty-state">Failed to load constraints.</div>`;
    return;
  }

  container.innerHTML = `
    <div class="panel mt-20">
      <div class="panel-title-row">
        <span class="panel-title">Optimization Constraints & Buffer Rules</span>
        <button class="btn-primary" id="id-opt-update" style="padding:4px 16px; font-weight:600;">🔄 Update Schedule</button>
      </div>
      <div class="section-hint mb-16" style="color:#444;">Adjust the default parameters loaded from Roster_constraints.json for the live Intraday session. Modifying these limits will immediately trigger a re-allocation of staff.</div>
      
      <div class="opt-grid" style="display:grid; grid-template-columns:repeat(auto-fit, minmax(280px, 1fr)); gap:20px;">
        
        <!-- Shifts & Breaks -->
        <div class="opt-card" style="background:rgba(0,0,0,0.02); padding:16px; border-radius:6px; border:1px solid rgba(0,0,0,0.1);">
          <div style="font-size:0.95rem; font-weight:600; color:#1a2744; margin-bottom:12px; display:flex; align-items:center; gap:8px;">
            <span>⏱</span> Working Hours & Breaks
          </div>
          <div class="input-group" style="margin-bottom:12px">
            <label style="display:block; font-size:0.8rem; color:#555; margin-bottom:4px;">Shift Duration (Hrs)</label>
            <input type="number" id="opt-shift-hrs" class="select-input" style="width:100%" value="${constraints.shift_duration_hrs || 12}" min="6" max="16"/>
          </div>
          <div class="input-group" style="margin-bottom:12px; display:flex; gap:12px;">
            <div style="flex:1;">
              <label style="display:block; font-size:0.8rem; color:#555; margin-bottom:4px;">Short Break (mins)</label>
              <input type="number" id="opt-b1-dur" class="select-input" style="width:100%" value="${constraints.b1_duration_mins || 30}" min="15" max="60"/>
            </div>
            <div style="flex:1;">
              <label style="display:block; font-size:0.8rem; color:#555; margin-bottom:4px;">Meal Break (mins)</label>
              <input type="number" id="opt-b2-dur" class="select-input" style="width:100%" value="${constraints.b2_duration_mins || 60}" min="30" max="120"/>
            </div>
          </div>
        </div>

        <!-- Travel Times -->
        <div class="opt-card" style="background:rgba(0,0,0,0.02); padding:16px; border-radius:6px; border:1px solid rgba(0,0,0,0.1);">
          <div style="font-size:0.95rem; font-weight:600; color:#1a2744; margin-bottom:12px; display:flex; align-items:center; gap:8px;">
            <span>🚶</span> Travel Time Buffers (mins)
          </div>
          <div class="input-group" style="margin-bottom:12px">
            <label style="display:block; font-size:0.8rem; color:#555; margin-bottom:4px;">T1 to T2 Transfer (mins)</label>
            <input type="number" id="opt-tt-t1-t2" class="select-input" style="width:100%" value="${constraints.tt_t1_t2 || 15}" min="0" max="60"/>
          </div>
          <div class="input-group">
            <label style="display:block; font-size:0.8rem; color:#555; margin-bottom:4px;">Skill Switch Transfer (mins)</label>
            <input type="number" id="opt-tt-sk" class="select-input" style="width:100%" value="${constraints.tt_skill_switch || 10}" min="0" max="60"/>
          </div>
        </div>

        <!-- Absences -->
        <div class="opt-card" style="background:rgba(0,0,0,0.02); padding:16px; border-radius:6px; border:1px solid rgba(0,0,0,0.1);">
          <div style="font-size:0.95rem; font-weight:600; color:#1a2744; margin-bottom:12px; display:flex; align-items:center; gap:8px;">
            <span>🚫</span> Absence Exclusions
          </div>
          <div class="section-hint" style="font-size:0.75rem; margin-bottom:12px; color:#666;">Staff with selected leave types will not be rostered.</div>
          <div id="opt-leave-toggles" style="display:flex; flex-direction:column; gap:8px;">
            ${["Annual Leave", "Paternity Leave", "Jury Duty", "Sick Leave", "Training"].map(lt => `
              <div class="input-group" style="display:flex; align-items:center; gap:12px;">
                <input type="checkbox" id="chk-lt-${lt.replace(/\s+/g,'-')}" value="${lt}" style="width:18px;height:18px;accent-color:#3498DB;" 
                  ${(constraints.leave_types_excluded || []).includes(lt) ? 'checked' : ''} />
                <label for="chk-lt-${lt.replace(/\s+/g,'-')}" style="font-size:0.85rem; color:#333;">${lt}</label>
              </div>
            `).join('')}
          </div>
        </div>

        <!-- Allocation Policy -->
        <div class="opt-card" style="background:rgba(0,0,0,0.02); padding:16px; border-radius:6px; border:1px solid rgba(0,0,0,0.1);">
          <div style="font-size:0.95rem; font-weight:600; color:#1a2744; margin-bottom:12px; display:flex; align-items:center; gap:8px;">
            <span>⚖</span> Assignment Logic
          </div>
          <div class="input-group" style="margin-bottom:12px; display:flex; align-items:center; gap:12px;">
            <input type="checkbox" id="opt-prim-first" style="width:18px;height:18px;accent-color:#3498DB;" ${constraints.use_primary_first ? 'checked' : ''} />
            <label for="opt-prim-first" style="font-size:0.85rem; color:#333;">Prioritize Primary Skills First</label>
          </div>
          <div class="input-group" style="display:flex; align-items:center; gap:12px;">
            <input type="checkbox" id="opt-overlap" style="width:18px;height:18px;accent-color:#3498DB;" ${constraints.allow_overlap ? 'checked' : ''} />
            <label for="opt-overlap" style="font-size:0.85rem; color:#333;">Allow Schedule Overlap (Soft Limit)</label>
          </div>
        </div>

      </div>
    </div>
  `;

  document.getElementById('id-opt-update').addEventListener('click', async (e) => {
    const btn = e.target;
    const oldText = btn.innerHTML;
    btn.innerHTML = '<span class="spinner" style="width:12px;height:12px;border-width:2px;margin-right:8px;display:inline-block;vertical-align:middle;"></span>Updating...';
    btn.disabled = true;

    const leaves = Array.from(document.querySelectorAll('#opt-leave-toggles input:checked')).map(cb => cb.value);

    const payload = {
      tt_t1_t2: parseInt(document.getElementById('opt-tt-t1-t2').value, 10),
      tt_skill_switch: parseInt(document.getElementById('opt-tt-sk').value, 10),
      use_primary_first: document.getElementById('opt-prim-first').checked,
      allow_overlap: document.getElementById('opt-overlap').checked,
      shift_duration_hrs: parseInt(document.getElementById('opt-shift-hrs').value, 10),
      b1_duration_mins: parseInt(document.getElementById('opt-b1-dur').value, 10),
      b2_duration_mins: parseInt(document.getElementById('opt-b2-dur').value, 10),
      leave_types_excluded: leaves
    };

    try {
      const res = await fetch('/api/intraday/constraints', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error('Update failed');
      const data = await res.json();
      ID_DATA = data;
      renderIntradayPage();
    } catch (err) {
      console.error(err);
      alert('Failed to update constraints.');
    } finally {
      btn.innerHTML = oldText;
      btn.disabled = false;
    }
  });
}

function renderIDRosterTimeline() {
  const container = document.getElementById('id-staff-timeline');
  if (!container || !ID_DATA) return;

  function stringToColor(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    const h = Math.abs(hash) % 360;
    return `hsl(${h}, 65%, 40%)`;
  }

  const q = document.getElementById('id-staff-timeline-search')?.value.toLowerCase() || '';
  const shiftFilter = document.getElementById('id-staff-timeline-shift')?.value || '';

  const filteredStaff = (ID_DATA.staff || []).filter(s => {
    const mq = !q || s.id.toLowerCase().includes(q) || s.skill1.toLowerCase().includes(q);
    const ms = !shiftFilter || s.shift.toLowerCase() === shiftFilter.toLowerCase();
    return mq && ms;
  });

  const axisTicks = [];
  for (let h = 4; h <= 28; h++) {
    const left = (h - 4) / 24 * 100;
    axisTicks.push(`
      <div class="rt-hour-tick" style="left:${left.toFixed(2)}%">
        <span class="rt-hour-label">${String(h % 24).padStart(2, '0')}</span>
        <div class="rt-hour-line"></div>
      </div>`);
  }

  const rows = filteredStaff.map(s => {
    const shiftStart = s.shift_start;
    const shiftEnd = s.shift_end || shiftStart + 720; // fallback if missing
    const shiftWidth = (shiftEnd - shiftStart) / 1440 * 100;
    const shiftLeft = shiftStart / 1440 * 100;

    const shiftBg = `<div class="rt-shift-bg" style="left:${idPct(shiftStart)}%; width:${(shiftWidth / 1440 * 100)}%" title="${s.shift_label}"></div>`;

    const tasks = (s.assignments || []).map(a => {
      const left = idPct(a.start_mins);
      const width = (a.end_mins - a.start_mins) / 1440 * 100;
      const color = stringToColor(a.task);
      const label = width > 2 ? a.task.split(' ')[0] : '';
      const term = a.terminal ? `[${a.terminal}] ` : '';
      return `<div class="rt-block" style="left:${left}%; width:${width}%; background:${color}" 
              title="${a.task} ${term}(${a.start}-${a.end})">${label}</div>`;
    }).join('');

    const bks = (s.breaks || []).map(b => {
      const left = idPct(b.start_mins);
      const width = (b.end_mins - b.start_mins) / 1440 * 100;
      const label = width > 3 ? 'Bk' : '';
      return `<div class="rt-block break" style="left:${left}%; width:${width}%" 
              title="${b.type} (${b.start}-${b.end})">${label}</div>`;
    }).join('');

    return `
      <div class="rt-row">
        <div class="rt-staff-label">
          <div style="text-align:right">
            <div style="font-weight:700; color:var(--text); line-height:1.1; font-size:0.75rem">${s.id}</div>
            <div style="font-size:0.55rem; color:var(--muted); font-weight:700; text-transform:uppercase; letter-spacing:0.02em">${s.skill1}</div>
          </div>
        </div>
        <div class="rt-track">
          ${shiftBg}
          ${tasks}
          ${bks}
        </div>
      </div>`;
  }).join('');

  container.innerHTML = `
    <div class="rt-container">
      <div class="rt-chart">
        <div class="rt-axis-row">
          <div class="rt-staff-label-header"></div>
          <div class="rt-axis-track">${axisTicks.join('')}</div>
        </div>
        <div class="rt-now-line" id="id-rt-now-line">
          <div class="rt-now-label" id="id-rt-now-label"></div>
        </div>
        ${rows}
      </div>
    </div>`;
}

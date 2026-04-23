/* ═══════════════════════════════════════════════════════
   DAA Intraday Operations — D (Today)
   ═══════════════════════════════════════════════════════ */

const ID = {
  accent: '#E8850A', ok: '#2ECC71', warn: '#F39C12', crit: '#E74C3C',
  info: '#3498DB', muted: '#6b7280', 
  white: () => (window.getCurrentTheme && window.getCurrentTheme() === 'dark' ? '#ffffff' : '#1a2744'),
};

const ID_SKILL_COLOR = {
  'GNIB': '#3498DB', 'CBP Pre-clearance': '#9B59B6', 'Bussing': '#E8850A',
  'PBZ': '#2ECC71', 'Mezz Operation': '#1ABC9C', 'Litter Picking': '#E74C3C',
  'Ramp / Marshalling': '#F39C12', 'Arr Customer Service': '#5DADE2',
  'Check-in/Trolleys': '#A9CCE3', 'Transfer Corridor': '#27AE60',
  'Dep / Trolleys': '#8E44AD', 'T1/T2 Trolleys L/UL': '#E91E63',
};

let ID_DATA = null;
let ID_SELECTED_FLIGHT = null;
let ID_MANAGE_TASK = null;
let ID_ACTIVE_TAB = 'staff';
let ID_AUTO_REFRESH = null;
let ID_SIM_TIMER = null;
let ID_SIM_TIME = null;
let ID_SIM_SPEED = 1;
let ID_COVERAGE_INTERVAL = null;


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
  const rtLine = document.getElementById('id-rt-now-line');
  const rtLabel = document.getElementById('id-rt-now-label');
  
  if (typeof ID_SIM_TIME !== 'number') return;
  const left = Math.max(0, Math.min(100, (ID_SIM_TIME / 1440) * 100));
  
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
        ${d.date_label}
        <span class="live-badge">● Live</span>
      </h2>
    </div>
    <div class="kpi-grid st-kpi-grid" id="id-kpis"></div>
    <div id="id-alerts-panel"></div>
    <div class="sub-tabs" style="margin-top:20px">
      <button class="sub-tab ${ID_ACTIVE_TAB==='staff'?'active':''}" data-idtab="staff">👤 Staff Roster</button>
      <button class="sub-tab ${ID_ACTIVE_TAB==='flights'?'active':''}" data-idtab="flights">✈ Flight Operations</button>
      <button class="sub-tab ${ID_ACTIVE_TAB==='gate-timeline'?'active':''}" data-idtab="gate-timeline">🛬 Gate Timeline</button>
      <button class="sub-tab ${ID_ACTIVE_TAB==='staff-timeline'?'active':''}" data-idtab="staff-timeline">📅 Roster Timeline</button>

      <button class="sub-tab ${ID_ACTIVE_TAB==='opt'?'active':''}" data-idtab="opt">⚙ Optimization</button>
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
      if (newTab !== 'staff-timeline') stopCoverageAutoRefresh();
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

function _getIDAlertOverlay() {
  let overlay = document.getElementById('id-alert-detail-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'id-alert-detail-overlay';
    overlay.className = 'modal-overlay hidden';
    overlay.innerHTML = `<div class="modal-box modal-box-wide" id="id-alert-detail-box"></div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) closeIDAlertDetail();
    });
  }
  return overlay;
}

function showIDAlertDetail(alert) {
  const overlay = _getIDAlertOverlay();
  const box = document.getElementById('id-alert-detail-box');
  if (!box || !alert) return;
  const flights = alert.covered_flights || [];
  box.innerHTML = `
    <div class="modal-header">
      <div style="flex:1">
        <div class="modal-title">Live Alert · ${alert.task}</div>
        <div class="fd-meta" style="margin-top:4px;color:rgba(255,255,255,0.75)">
          ${alert.priority} · ${alert.start}–${alert.end} · ${alert.terminal || 'ALL'} / ${alert.pier || 'ALL'}
        </div>
      </div>
      <button class="fd-close" onclick="closeIDAlertDetail()">✕</button>
    </div>
    <div class="modal-body">
      <div class="staff-detail-kpis">
        <div class="staff-detail-kpi"><div class="staff-detail-kpi-val">${alert.staff_needed}</div><div class="staff-detail-kpi-lbl">Staff Needed</div></div>
        <div class="staff-detail-kpi"><div class="staff-detail-kpi-val">${alert.assigned_count}</div><div class="staff-detail-kpi-lbl">Assigned</div></div>
        <div class="staff-detail-kpi"><div class="staff-detail-kpi-val">${alert.gap}</div><div class="staff-detail-kpi-lbl">Gap</div></div>
        <div class="staff-detail-kpi"><div class="staff-detail-kpi-val">${flights.length}</div><div class="staff-detail-kpi-lbl">Flights Impacted</div></div>
      </div>
      <div class="staff-detail-section">
        <div class="staff-detail-section-title">Live Alert Summary</div>
        <div class="fd-task-row">
          <div class="fd-task-name">${alert.message}</div>
          <div class="fd-task-time">Task type: ${alert.task} · Skill: ${alert.skill} · Mode: ${alert.sharing_mode}</div>
        </div>
      </div>
      <div class="staff-detail-section">
        <div class="staff-detail-section-title">Recommended Staff</div>
        ${alert.rec_staff && alert.rec_staff.length
          ? `<div class="staff-breaks">${alert.rec_staff.map(s => `<span class="break-chip">${s}</span>`).join('')}</div>`
          : '<div class="muted small">No available recommendation for this alert.</div>'}
      </div>
      <div class="staff-detail-section">
        <div class="staff-detail-section-title">Assigned Staff</div>
        ${alert.assigned_staff && alert.assigned_staff.length
          ? `<div class="staff-breaks">${alert.assigned_staff.map(s => `<span class="break-chip">${s}</span>`).join('')}</div>`
          : '<div class="muted small">No staff currently assigned.</div>'}
      </div>
      <div class="staff-detail-section">
        <div class="staff-detail-section-title">Affected Flights</div>
        ${flights.length
          ? flights.map(f => `
            <div class="staff-flight-row">
              <span class="fn-cell">${f.flight_no}</span>
              <span>${f.origin_code} ${f.origin}</span>
              <span class="muted">${f.status} · ${f.sta} · Gate ${f.gate}</span>
              <span class="status-badge ${f.status === 'Arrival' ? 'badge-info' : 'badge-accent'}">${f.status}</span>
            </div>`).join('')
          : '<div class="muted small">No linked flight details available.</div>'}
      </div>
    </div>`;
  overlay.classList.remove('hidden');
}

function closeIDAlertDetail() {
  const overlay = document.getElementById('id-alert-detail-overlay');
  if (overlay) overlay.classList.add('hidden');
}
window.showIDAlertDetail = showIDAlertDetail;
window.closeIDAlertDetail = closeIDAlertDetail;

renderIDAlerts = function(alerts) {
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
        ${shown.map((a, idx) => {
          const flights = a.covered_flights || [];
          const flightLabel = flights.length
            ? flights.slice(0, 2).map(f => f.flight_no).join(', ') + (flights.length > 2 ? ` +${flights.length - 2}` : '')
            : (a.flight_no || 'No linked flight');
          return `
            <div class="alert-row alert-${a.priority==='Critical'?'crit':'warn'} alert-row-clickable" data-alert-idx="${idx}">
              <div class="alert-row-left alert-row-detail">
                <span class="badge ${a.priority==='Critical'?'badge-crit':'badge-warn'}">${a.priority}</span>
                <div class="alert-msg">
                  <div class="alert-msg-title">${flightLabel} · ${a.task}</div>
                  <div class="alert-msg-sub">${a.start}–${a.end} · ${a.terminal || 'ALL'} / ${a.pier || 'ALL'} · Need ${a.staff_needed}, assigned ${a.assigned_count}, gap ${a.gap}</div>
                  <div class="alert-msg-body">${a.message}</div>
                </div>
              </div>
              <div class="alert-row-right">
                ${a.rec_staff && a.rec_staff.length
                  ? `<span class="alert-rec">Rec: ${a.rec_staff.slice(0,2).join(', ')}</span>` : ''}
              </div>
            </div>`;
        }).join('')}
        ${alerts.length > 5 ? `<div class="muted small" style="padding:6px 12px">+${alerts.length - 5} more alerts</div>` : ''}
      </div>
    </div>`;

  panel.querySelectorAll('.alert-row[data-alert-idx]').forEach(row =>
    row.addEventListener('click', () => showIDAlertDetail(shown[Number(row.dataset.alertIdx)])));
};

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
              <option value="00:00">00:00</option>
              <option value="03:00">03:00</option>
              <option value="07:00">07:00</option>
              <option value="12:00">12:00</option>
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
              <option value="00:00">00:00</option>
              <option value="03:00">03:00</option>
              <option value="07:00">07:00</option>
              <option value="12:00">12:00</option>
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
    renderIDHourlyCoverage();
    startCoverageAutoRefresh();
  } else if (ID_ACTIVE_TAB === 'opt') {
    renderIDOptimization(container);

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
                <th>Gate</th><th>Terminal</th><th>Pier</th><th>Type</th><th>Tasks</th><th>Status</th><th>Action</th>
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

    return `<tr class="${rowCls}" data-fn="${f.flight_no}" style="cursor:pointer">
      <td class="time-cell">${f.sta} ${delayBadge}</td>
      <td class="fn-cell">${f.flight_no}</td>
      <td class="route-cell">${f.origin_code} ${f.origin}</td>
      <td>${f.airline_name}</td>
      <td>${f.gate}</td>
      <td><span class="terminal-badge">${f.terminal || '—'}</span></td>
      <td><span class="pier-badge">${f.pier || '—'}</span></td>
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
      || f.origin.toLowerCase().includes(q) || f.airline_name.toLowerCase().includes(q)
      || (f.terminal || '').toLowerCase().includes(q)
      || (f.pier || '').toLowerCase().includes(q);
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
                    ? t.assigned.map(id => {
                        const isMismatch = (t.mismatch_assigned || []).includes(id);
                        return isMismatch
                          ? `<span class="staff-chip mismatch-chip" title="Cross-skill assignment">⚠ ${id}<button class="chip-remove" onclick="unassignStaff('${t.id}','${id}')">✕</button></span>`
                          : `<span class="staff-chip">${id}<button class="chip-remove" onclick="unassignStaff('${t.id}','${id}')">✕</button></span>`;
                      }).join('')
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


// ── Hourly Workforce Coverage Heatmap ───────────────────────────
const ID_COVERAGE_SKILLS = [
  'GNIB', 'CBP Pre-clearance', 'Arr Customer Service', 'Check-in/Trolleys',
  'Dep / Trolleys', 'T1/T2 Trolleys L/UL', 'Transfer Corridor',
  'Ramp / Marshalling', 'Bussing', 'PBZ', 'Mezz Operation', 'Litter Picking',
];
const ID_COVERAGE_HOUR_START = 4;
const ID_COVERAGE_HOUR_END   = 23;

function buildCoverageData(tasks) {
  const hours = [];
  for (let h = ID_COVERAGE_HOUR_START; h <= ID_COVERAGE_HOUR_END; h++) hours.push(h);

  const data = {};
  ID_COVERAGE_SKILLS.forEach(sk => {
    data[sk] = {};
    hours.forEach(h => { data[sk][h] = { req: 0, assigned: 0 }; });
  });

  (tasks || []).forEach(task => {
    const sk = task.skill;
    if (!data[sk]) return;
    const startH = Math.floor(task.start_mins / 60);
    const endH   = Math.floor((task.end_mins - 1) / 60);
    for (let h = Math.max(ID_COVERAGE_HOUR_START, startH); h <= Math.min(ID_COVERAGE_HOUR_END, endH); h++) {
      data[sk][h].req      += (task.staff_needed || 0);
      data[sk][h].assigned += (task.assigned ? task.assigned.length : 0);
    }
  });

  return { data, hours };
}

function buildCoverageTableHTML(tasks) {
  const { data, hours } = buildCoverageData(tasks);
  const nowH = new Date().getHours();

  function cellClass(req, assigned) {
    if (req === 0) return '';
    const gap = assigned - req;
    if (gap < -2) return 'cell-gap';
    if (gap < 0)  return 'cell-warning';
    if (gap > 1)  return 'cell-surplus';
    return 'cell-adequate';
  }

  const headCols = hours.map(h => {
    const live = h === nowH;
    const label = live
      ? `Live<span style="display:block;font-size:0.6rem;opacity:0.85;font-weight:600;">${String(h).padStart(2,'0')}:00</span>`
      : String(h).padStart(2,'0') + ':00';
    return `<th class="${live ? 'is-today' : ''}">${label}</th>`;
  }).join('');

  const bodyRows = ID_COVERAGE_SKILLS.map(sk =>
    `<tr><td class="skill-label">${sk}</td>${hours.map(h => {
      const { req, assigned } = data[sk][h];
      const nowCls = h === nowH ? 'is-today' : '';
      if (req === 0) return `<td class="${nowCls}">—</td>`;
      const tip = `Role: ${sk}\nHour: ${String(h).padStart(2,'0')}:00\nRequired: ${req}\nAssigned: ${assigned}`;
      return `<td class="${cellClass(req, assigned)} ${nowCls}" title="${tip}">${assigned}/${req}</td>`;
    }).join('')}</tr>`
  ).join('');

  const totalsReq      = hours.map(h => ID_COVERAGE_SKILLS.reduce((s, sk) => s + data[sk][h].req,      0));
  const totalsAssigned = hours.map(h => ID_COVERAGE_SKILLS.reduce((s, sk) => s + data[sk][h].assigned, 0));

  const fReq = hours.map((h, i) =>
    `<td class="${h === nowH ? 'is-today' : ''}" style="font-weight:700;">${totalsReq[i] || '—'}</td>`
  ).join('');
  const fAsgn = hours.map((h, i) =>
    `<td class="${h === nowH ? 'is-today' : ''}" style="font-weight:700;color:#3b82f6;">${totalsAssigned[i] || '—'}</td>`
  ).join('');
  const fGap = hours.map((h, i) => {
    const nowCls = h === nowH ? 'is-today' : '';
    if (!totalsReq[i]) return `<td class="${nowCls}">—</td>`;
    const g = totalsAssigned[i] - totalsReq[i];
    const color = g < 0 ? 'var(--crit)' : g > 1 ? 'var(--ok)' : 'var(--warn)';
    return `<td class="${nowCls}" style="font-weight:700;color:${color};">${g > 0 ? '+' : ''}${g}</td>`;
  }).join('');

  return `
    <thead>
      <tr class="hm-header-row">
        <th class="skill-col">Role / Task</th>${headCols}
      </tr>
    </thead>
    <tbody>
      ${bodyRows}
      <tr class="total-row with-border"><td class="skill-label">Total Required</td>${fReq}</tr>
      <tr class="total-row"><td class="skill-label">Total Assigned</td>${fAsgn}</tr>
      <tr class="total-row"><td class="skill-label">Staff Gap</td>${fGap}</tr>
    </tbody>`;
}

function renderIDHourlyCoverage() {
  const wrapper = document.getElementById('id-sub-content');
  if (!wrapper) return;

  let section = document.getElementById('id-hourly-coverage-section');
  if (!section) {
    section = document.createElement('div');
    section.id = 'id-hourly-coverage-section';
    section.className = 'mt-24';
    section.innerHTML = `
      <div class="section-header" style="margin-bottom:8px;">
        <h2 style="font-size:1rem;font-weight:700;color:var(--text);">Workforce Coverage — Live</h2>
        <span class="section-hint">Assigned / Required per skill per hour. Auto-refreshes every minute.</span>
      </div>
      <div class="legend-row mb-12">
        <span class="leg surplus"></span><span>Surplus</span>
        <span class="leg adequate"></span><span>Adequate</span>
        <span class="leg warning"></span><span>Warning</span>
        <span class="leg gap"></span><span>Gap</span>
      </div>
      <div class="heatmap-wrapper" id="id-hourly-heatmap-wrapper" style="overflow-x:hidden;">
        <table class="heatmap-table heatmap-table--fluid" id="id-hourly-heatmap"></table>
      </div>`;
    const panel = wrapper.querySelector('.panel');
    if (panel) panel.appendChild(section);
  }

  const table = document.getElementById('id-hourly-heatmap');
  if (table) table.innerHTML = buildCoverageTableHTML(ID_DATA.tasks || []);
}

function stopCoverageAutoRefresh() {
  if (ID_COVERAGE_INTERVAL) {
    clearInterval(ID_COVERAGE_INTERVAL);
    ID_COVERAGE_INTERVAL = null;
  }
}

function startCoverageAutoRefresh() {
  stopCoverageAutoRefresh();
  ID_COVERAGE_INTERVAL = setInterval(async () => {
    try {
      const fresh = await fetch('/api/intraday').then(r => r.json());
      ID_DATA = fresh;
      const table = document.getElementById('id-hourly-heatmap');
      if (table) table.innerHTML = buildCoverageTableHTML(ID_DATA.tasks || []);
    } catch (e) {
      console.warn('Coverage refresh failed:', e);
    }
  }, 60000);
}

// ── Expose ──────────────────────────────────────────────────────
renderIDAlerts = function(alerts) {
  const panel = document.getElementById('id-alerts-panel');
  if (!alerts || !alerts.length) {
    panel.innerHTML = '<div class="alert-panel alert-ok"><span>OK</span> All tasks fully covered.</div>';
    return;
  }

  const critCount = alerts.filter(a => a.priority === 'Critical').length;
  const shown = alerts.slice(0, 10);
  let expanded = false;

  panel.innerHTML = `
    <div class="alerts-container">
      <div class="alerts-header">
        <span class="alerts-title">Live Alerts</span>
        <span class="alerts-count">
          ${critCount ? `<span class="badge badge-crit">${critCount} Critical</span>` : ''}
        </span>
        <button class="btn-ghost" id="id-alerts-toggle">Show top 10 v</button>
      </div>
      <div id="id-alerts-list"></div>
    </div>`;

  const list = document.getElementById('id-alerts-list');

  function renderAlertsList(items) {
    list.innerHTML = `
      ${items.map((a, idx) => {
        const flights = a.covered_flights || [];
        const flightLabel = flights.length
          ? flights.slice(0, 2).map(f => f.flight_no).join(', ') + (flights.length > 2 ? ` +${flights.length - 2}` : '')
          : (a.flight_no || 'No linked flight');
        return `
          <div class="alert-row alert-${a.priority === 'Critical' ? 'crit' : 'warn'} alert-row-clickable" data-alert-idx="${idx}">
            <div class="alert-row-left alert-row-detail">
              <span class="badge ${a.priority === 'Critical' ? 'badge-crit' : 'badge-warn'}">${a.priority}</span>
              <div class="alert-msg">
                <div class="alert-msg-title">${flightLabel} - ${a.task} - ${a.start}-${a.end} - ${a.terminal || 'ALL'} / ${a.pier || 'ALL'} - Need ${a.staff_needed}, assigned ${a.assigned_count}, gap ${a.gap} - ${a.message}</div>
              </div>
            </div>
            <div class="alert-row-right">
              ${a.rec_staff && a.rec_staff.length
                ? `<span class="alert-rec">Rec: ${a.rec_staff.slice(0, 2).join(', ')}</span>` : ''}
            </div>
          </div>`;
      }).join('')}
      ${!expanded && alerts.length > 10 ? `<div class="muted small" style="padding:6px 12px">+${alerts.length - 10} more alerts</div>` : ''}`;

    list.querySelectorAll('.alert-row[data-alert-idx]').forEach(row =>
      row.addEventListener('click', () => showIDAlertDetail(items[Number(row.dataset.alertIdx)])));
  }

  renderAlertsList(shown);

  document.getElementById('id-alerts-toggle').addEventListener('click', function() {
    expanded = !expanded;
    renderAlertsList(expanded ? alerts : shown);
    this.textContent = expanded ? `Show top 10 ^` : `Show top 10 v`;
  });
};

window.initIntraday = initIntraday;
window.applyDelay = applyDelay;
window.applyCustomDelay = applyCustomDelay;
window.cancelFlight = cancelFlight;
window.showManageModal = showManageModal;
window.showManageModalForTask = showManageModalForTask;
window.closeManageModal = closeManageModal;
window.toggleStaffAssignment = toggleStaffAssignment;
window.unassignStaff = unassignStaff;


// ── Optimization Tab ────────────────────────────────────────────
async function renderIDOptimization(container) {
  const SKILL_COLORS = {
    'GNIB':'#3498DB','CBP Pre-clearance':'#9B59B6','Bussing':'#E8850A',
    'PBZ':'#2ECC71','Mezz Operation':'#1ABC9C','Litter Picking':'#E74C3C',
    'Ramp / Marshalling':'#F39C12','Arr Customer Service':'#5DADE2',
    'Check-in/Trolleys':'#A9CCE3','Transfer Corridor':'#27AE60',
    'Dep / Trolleys':'#8E44AD','T1/T2 Trolleys L/UL':'#E91E63',
  };

  container.innerHTML = `<div class="panel mt-20"><div class="loading-spinner"><div class="spinner"></div><span>Loading optimiser…</span></div></div>`;
  let constraints = {};
  try {
    constraints = await fetch('/api/intraday/constraints').then(r => r.json());
  } catch (_) {}

  container.innerHTML = `
    <div class="panel mt-20" style="border-top:4px solid var(--info);">
      <div class="panel-title-row" style="margin-bottom:20px;border-bottom:1px solid var(--border);padding-bottom:16px;">
        <div>
          <h2 class="panel-title" style="margin:0;font-size:1.4rem;color:var(--text);text-transform:none;">⚙ Unified Optimiser</h2>
          <p class="section-hint" style="margin:6px 0 0;font-size:0.88rem;">
            Adjust all constraints then run — results are applied live across all tabs.
            &nbsp;·&nbsp; <em>Phase 1</em>: schedule tasks by skill &nbsp;·&nbsp; <em>Phase 2</em>: assign shifts via Greedy + MIP
          </p>
        </div>
        <button class="btn-update-fluid" id="id-opt-run" style="min-width:180px;">⚡ Run &amp; Apply</button>
      </div>

      <div class="opt-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:20px;margin-bottom:8px;">

        <!-- Shift & Rest -->
        <div class="opt-card">
          <div class="opt-card-title"><span style="color:var(--info)">⏱</span> Shift &amp; Rest</div>
          <div style="display:flex;gap:10px;margin-bottom:12px;">
            <div style="flex:1"><label class="opt-label">Shift Duration (hrs)</label>
              <input type="number" id="opt-shift-hrs" class="select-input" value="${constraints.shift_duration_hrs||12}" min="6" max="16" style="width:100%"/></div>
            <div style="flex:1"><label class="opt-label">Min Rest (hrs)</label>
              <input type="number" id="opt-rest-hrs" class="select-input" value="11" min="8" max="16" style="width:100%"/></div>
          </div>
          <div style="display:flex;gap:10px;">
            <div style="flex:1"><label class="opt-label">Short Break (min)</label>
              <input type="number" id="opt-b1-dur" class="select-input" value="${constraints.b1_duration_mins||30}" min="15" max="60" style="width:100%"/></div>
            <div style="flex:1"><label class="opt-label">Meal Break (min)</label>
              <input type="number" id="opt-b2-dur" class="select-input" value="${constraints.b2_duration_mins||60}" min="30" max="120" style="width:100%"/></div>
          </div>
        </div>

        <!-- Travel Buffers -->
        <div class="opt-card">
          <div class="opt-card-title"><span style="color:var(--accent)">🚶</span> Travel Buffers (min)</div>
          <div class="input-group" style="margin-bottom:14px">
            <label class="opt-label">T1 → T2 Transfer</label>
            <input type="number" id="opt-tt-t1-t2" class="select-input" value="${constraints.tt_t1_t2||15}" min="0" max="60" style="width:100%"/>
          </div>
          <div class="input-group">
            <label class="opt-label">Skill-Switch Transfer</label>
            <input type="number" id="opt-tt-sk" class="select-input" value="${constraints.tt_skill_switch||10}" min="0" max="60" style="width:100%"/>
          </div>
        </div>

        <!-- Solver -->
        <div class="opt-card">
          <div class="opt-card-title"><span style="color:var(--ok)">🧮</span> Solver</div>
          <p class="opt-hint">MIP (CBC) minimises skill mismatch + workload inequality after greedy pass. Requires PuLP.</p>
          <div style="display:flex;align-items:center;gap:12px;margin:12px 0;">
            <input type="checkbox" id="opt-mip" style="width:20px;height:20px;accent-color:var(--info);cursor:pointer" checked/>
            <label for="opt-mip" class="opt-label" style="margin:0;cursor:pointer">Enable MIP Refinement</label>
          </div>
          <div style="display:flex;flex-direction:column;gap:10px;margin-top:12px;">
            <div style="display:flex;align-items:center;gap:12px;">
              <input type="checkbox" id="opt-prim-first" style="width:18px;height:18px;accent-color:var(--info);cursor:pointer" ${constraints.use_primary_first!==false?'checked':''}/>
              <label for="opt-prim-first" class="opt-label" style="margin:0;cursor:pointer">Primary Skills First</label>
            </div>
            <div style="display:flex;align-items:center;gap:12px;">
              <input type="checkbox" id="opt-allow-overlap" style="width:18px;height:18px;accent-color:var(--info);cursor:pointer" ${(constraints.allow_overlaps||constraints.allow_overlap)?'checked':''}/>
              <label for="opt-allow-overlap" class="opt-label" style="margin:0;cursor:pointer">Allow Schedule Overlaps</label>
            </div>
          </div>
        </div>

        <!-- Absence exclusions -->
        <div class="opt-card">
          <div class="opt-card-title"><span style="color:var(--crit)">🚫</span> Exclude Leave Types</div>
          <p class="opt-hint">Staff on these leave types are removed before optimisation.</p>
          <div id="opt-leave-toggles" style="display:flex;flex-direction:column;gap:10px;margin-top:10px;">
            ${["Annual Leave","Paternity Leave","Jury Duty","Sick Leave","Training"].map(lt => `
              <div style="display:flex;align-items:center;gap:12px;">
                <input type="checkbox" id="opt-lt-${lt.replace(/\s+/g,'-')}" value="${lt}"
                  style="width:18px;height:18px;accent-color:var(--info);cursor:pointer"
                  ${(constraints.leave_types_excluded||[]).includes(lt)?'checked':''}/>
                <label for="opt-lt-${lt.replace(/\s+/g,'-')}" class="opt-label" style="margin:0;cursor:pointer">${lt}</label>
              </div>`).join('')}
          </div>
        </div>

        <!-- Permitted shifts -->
        <div class="opt-card">
          <div class="opt-card-title"><span style="color:var(--ok)">📅</span> Permitted Shift Windows</div>
          <div id="opt-shift-toggles" style="display:flex;flex-direction:column;gap:10px;margin-top:8px;">
            ${[
              {label:'00:00', display:'Day (00:00 – 12:00)', s:0,   e:720},
              {label:'03:00', display:'Morning (03:00 – 15:00)', s:180, e:900},
              {label:'07:00', display:'Early (07:00 – 19:00)', s:420, e:1140},
              {label:'12:00', display:'Night (12:00 – 00:00)', s:720, e:1440},
            ].map((sh,i) => {
              const chk = (constraints.permitted_shifts||[]).some(p=>p[0]===sh.s&&p[1]===sh.e)||(!constraints.permitted_shifts&&i<2);
              return `<div style="display:flex;align-items:center;gap:12px;">
                <input type="checkbox" class="opt-sh-chk" id="opt-sh-${i}"
                  data-label="${sh.label}" data-start="${sh.s}" data-end="${sh.e}"
                  style="width:18px;height:18px;accent-color:var(--info);cursor:pointer" ${chk?'checked':''}/>
                <label for="opt-sh-${i}" class="opt-label" style="margin:0;cursor:pointer">${sh.display}</label>
              </div>`;
            }).join('')}
          </div>
        </div>

      </div><!-- /opt-grid -->

      <!-- Results -->
      <div id="id-opt-results"></div>
    </div>`;

  // ── Run & Apply handler ───────────────────────────────────────────
  document.getElementById('id-opt-run').addEventListener('click', async () => {
    const btn     = document.getElementById('id-opt-run');
    const results = document.getElementById('id-opt-results');
    btn.disabled  = true;
    btn.innerHTML = '<span class="spinner" style="width:12px;height:12px;border-width:2px;display:inline-block;vertical-align:middle;margin-right:6px"></span>Optimising…';
    results.innerHTML = '<div class="loading-spinner"><div class="spinner"></div><span>Running two-phase optimisation and applying to all tabs…</span></div>';

    const leaves = Array.from(document.querySelectorAll('#opt-leave-toggles input:checked')).map(cb => cb.value);
    const shifts  = Array.from(document.querySelectorAll('#opt-shift-toggles input:checked')).map(cb => [
      parseInt(cb.dataset.start,10), parseInt(cb.dataset.end,10), cb.dataset.label
    ]);

    const payload = {
      use_mip:              document.getElementById('opt-mip').checked,
      min_rest_hrs:         parseFloat(document.getElementById('opt-rest-hrs').value),
      shift_duration_hrs:   parseInt(document.getElementById('opt-shift-hrs').value, 10),
      b1_duration_mins:     parseInt(document.getElementById('opt-b1-dur').value, 10),
      b2_duration_mins:     parseInt(document.getElementById('opt-b2-dur').value, 10),
      tt_t1_t2:             parseInt(document.getElementById('opt-tt-t1-t2').value, 10),
      tt_skill_switch:      parseInt(document.getElementById('opt-tt-sk').value, 10),
      use_primary_first:    document.getElementById('opt-prim-first').checked,
      allow_overlaps:       document.getElementById('opt-allow-overlap').checked,
      leave_types_excluded: leaves,
      permitted_shifts:     shifts,
    };

    try {
      const res  = await fetch('/api/intraday/optimise', {
        method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Optimiser failed');

      // Update global state so all other tabs reflect new data when navigated to
      ID_DATA = data;
      // Refresh KPIs and alerts at the top without destroying the current sub-content
      try { renderIDKPIs(data.kpis); } catch (_) {}
      try { renderIDAlerts(data.alerts); } catch (_) {}

      // Show results inline (results div still exists in DOM)
      _renderIDOptResults(results, data);

    } catch (err) {
      results.innerHTML = `<div class="panel mt-8" style="padding:16px;border-left:4px solid var(--crit);">
        <strong style="color:var(--crit)">✕ Optimiser error</strong><br/><span style="font-size:0.85rem">${err.message}</span></div>`;
    } finally {
      btn.disabled  = false;
      btn.innerHTML = '⚡ Run &amp; Apply';
    }
  });

  // ── Render optimiser results ──────────────────────────────────────
  function _renderIDOptResults(resultsEl, data) {
    const r = data.roster || {};
    if (!r.roster_available) {
      resultsEl.innerHTML = `
        <div class="panel mt-16" style="padding:16px;border-left:4px solid var(--ok);">
          <strong style="color:var(--ok)">✓ Schedule updated</strong>
          <span style="margin-left:12px;font-size:0.85rem;color:var(--muted)">
            Roster optimiser unavailable — tactical constraints applied. All tabs refreshed.
          </span>
          ${r.error ? `<div style="font-size:0.8rem;color:var(--warn);margin-top:6px;">Reason: ${r.error}</div>` : ''}
        </div>`;
      return;
    }

    const fairness  = r.fairness || {};
    const gini      = fairness.gini_coefficient ?? '—';
    const giniLabel = fairness.interpretation  || '—';
    const giniColor = giniLabel==='excellent'?'var(--ok)':giniLabel==='good'?'var(--info)':giniLabel==='moderate'?'var(--warn)':'var(--crit)';
    const solverBadge = (r.solver_used||'').includes('MIP')||(r.solver_used||'').includes('CBC')
      ? `<span class="badge-solver badge-mip">MIP CBC</span>`
      : `<span class="badge-solver badge-greedy">Greedy</span>`;

    const staffCount = (data.staff||[]).length;
    const kpiHtml = `
      <div class="ro-kpi-row" style="margin-top:20px;">
        <div class="ro-kpi"><div class="ro-kpi-val" style="color:var(--ok)">✓ Applied</div><div class="ro-kpi-lbl">All Tabs Updated</div></div>
        <div class="ro-kpi"><div class="ro-kpi-val">${r.pattern_count||0}</div><div class="ro-kpi-lbl">Shift Patterns</div></div>
        <div class="ro-kpi"><div class="ro-kpi-val">${staffCount}</div><div class="ro-kpi-lbl">Staff On Duty</div></div>
        <div class="ro-kpi"><div class="ro-kpi-val" style="color:${giniColor}">${typeof gini==='number'?gini.toFixed(3):gini}</div><div class="ro-kpi-lbl">Gini (${giniLabel})</div></div>
        <div class="ro-kpi"><div class="ro-kpi-val">${fairness.mean_utilisation_pct??'—'}%</div><div class="ro-kpi-lbl">Mean Util</div></div>
        <div class="ro-kpi"><div class="ro-kpi-val">${solverBadge}</div><div class="ro-kpi-lbl">Solver</div></div>
        <div class="ro-kpi"><div class="ro-kpi-val">${(r.flags||[]).length}</div><div class="ro-kpi-lbl">Flags</div></div>
      </div>`;

    const patternHtml = (r.patterns||[]).map(p => {
      const chips = Object.entries(p.demand_profile||{}).map(([sk,v]) =>
        `<span class="ro-skill-chip" style="background:${SKILL_COLORS[sk]||'#666'}20;color:${SKILL_COLORS[sk]||'#666'}">${sk}: ${v.toFixed(1)}</span>`
      ).join('') || '<span class="ro-no-demand">No demand data</span>';
      const pct = Math.round(((p.net_mins||630)/720)*100);
      return `
        <div class="ro-pattern-card">
          <div class="ro-pattern-label">${p.label}</div>
          <div class="ro-pattern-meta" style="display:flex;gap:10px;font-size:0.78rem;">
            <span>Score: ${p.coverage_score.toFixed(1)}</span>
            <span>👤 ${p.staff_count}</span>
            <span>${pct}% net</span>
          </div>
          <div style="height:4px;border-radius:2px;background:var(--border);overflow:hidden;margin:4px 0;">
            <div style="width:${pct}%;height:100%;background:var(--info);border-radius:2px;"></div>
          </div>
          <div class="ro-skills-wrap">${chips}</div>
        </div>`;
    }).join('');

    const coverageHtml = Object.entries(r.coverage||{}).map(([sk,cv]) => {
      const pct = cv.coverage_pct||0;
      const col = pct>=90?'var(--ok)':pct>=70?'var(--warn)':'var(--crit)';
      return `<div style="margin-bottom:8px;">
        <div style="display:flex;justify-content:space-between;font-size:0.8rem;margin-bottom:2px;">
          <span style="font-weight:600">${sk}</span>
          <span style="color:${col};font-weight:700">${pct}%</span>
        </div>
        <div style="height:8px;border-radius:4px;background:var(--surface);overflow:hidden;">
          <div style="width:${Math.min(pct,100)}%;height:100%;background:${col};border-radius:4px;transition:width 0.4s;"></div>
        </div>
      </div>`;
    }).join('');

    const flagsHtml = (r.flags||[]).length
      ? (r.flags||[]).map(f=>`<div class="ro-flag"><strong>${f.flag_id}</strong> — ${f.detail}</div>`).join('')
      : '<div class="ro-no-flags">✓ No roster flags</div>';

    const fairHtml = `
      <div class="ro-fairness-grid">
        <div class="ro-fair-stat"><span class="ro-fair-val" style="color:${giniColor}">${typeof gini==='number'?gini.toFixed(3):gini}</span><span class="ro-fair-lbl">Gini</span></div>
        <div class="ro-fair-stat"><span class="ro-fair-val">${fairness.mean_utilisation_pct??'—'}%</span><span class="ro-fair-lbl">Mean</span></div>
        <div class="ro-fair-stat"><span class="ro-fair-val">${fairness.std_utilisation_pct??'—'}%</span><span class="ro-fair-lbl">Std Dev</span></div>
        <div class="ro-fair-stat"><span class="ro-fair-val">${fairness.min_utilisation_pct??'—'}%</span><span class="ro-fair-lbl">Min</span></div>
        <div class="ro-fair-stat"><span class="ro-fair-val">${fairness.max_utilisation_pct??'—'}%</span><span class="ro-fair-lbl">Max</span></div>
      </div>`;

    const matchIcon  = m => m==='primary'?'✓':m==='secondary'?'~':'✗';
    const matchColor = m => m==='primary'?'var(--ok)':m==='secondary'?'var(--warn)':'var(--crit)';
    const staffRows = (data.staff||[]).map(s => `
      <tr>
        <td style="font-weight:600">${s.id||s.name}</td>
        <td><span class="ro-skill-chip" style="background:${SKILL_COLORS[s.skill1]||'#666'}20;color:${SKILL_COLORS[s.skill1]||'#666'}">${s.skill1||'—'}</span></td>
        <td style="font-size:0.8rem">${s.shift_label||s.shift||'—'}</td>
        <td style="color:${matchColor(s.skill_match)};font-weight:700">${matchIcon(s.skill_match||'primary')}</td>
        <td>
          <div style="display:flex;align-items:center;gap:6px;">
            <div style="flex:1;background:var(--surface);border-radius:4px;height:6px;overflow:hidden;">
              <div style="width:${s.utilisation_pct||0}%;height:100%;background:${(s.utilisation_pct||0)>85?'var(--ok)':'var(--info)'};border-radius:4px;"></div>
            </div>
            <span style="font-size:0.75rem;font-weight:600;min-width:34px">${s.utilisation_pct||0}%</span>
          </div>
        </td>
        <td style="font-size:0.78rem;color:var(--muted)">${(s.breaks||[]).map(b=>`${(b.type||'').split(' ')[0]} ${b.start_str||''}`).join(', ')||'—'}</td>
      </tr>`).join('');

    resultsEl.innerHTML = `
      ${kpiHtml}
      <div class="row-2col mt-20" style="gap:20px;align-items:start;">
        <div>
          <div class="section-subhead">Shift Patterns</div>
          <div class="ro-patterns-grid">${patternHtml||'<div class="ro-no-demand">No patterns generated.</div>'}</div>
        </div>
        <div>
          <div class="section-subhead">Skill Coverage</div>
          ${coverageHtml||'<div class="ro-no-demand">No coverage data.</div>'}
          <div class="section-subhead" style="margin-top:16px;">Workload Fairness</div>
          ${fairHtml}
          <div class="section-subhead" style="margin-top:16px;">Flags</div>
          ${flagsHtml}
        </div>
      </div>
      <div class="section-subhead mt-16">Staff Assignment (Updated)</div>
      <div class="table-scroll">
        <table class="data-table" style="font-size:0.82rem;">
          <thead><tr><th>ID</th><th>Skill</th><th>Shift</th><th>Match</th><th>Utilisation</th><th>Breaks</th></tr></thead>
          <tbody>${staffRows||'<tr><td colspan="6" class="empty-state small">No staff data.</td></tr>'}</tbody>
        </table>
      </div>`;
  }
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
    const skillsMatch = [s.skill1, s.skill2, s.skill3, s.skill4].some(sk => (sk || '').toLowerCase().includes(q));
    const mq = !q || s.id.toLowerCase().includes(q) || skillsMatch;
    const ms = !shiftFilter || s.shift.toLowerCase() === shiftFilter.toLowerCase();
    return mq && ms;
  });

  const axisTicks = [];
  for (let h = 0; h <= 24; h++) {
    const left = (h * 60) / 1440 * 100;
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

    const shiftBg = `<div class="rt-shift-bg" style="left:${shiftLeft}%; width:${shiftWidth}%" title="${s.shift_label}"></div>`;

    const tasks = (s.assignments || []).map(a => {
      const left = a.start_mins / 1440 * 100;
      const width = (a.end_mins - a.start_mins) / 1440 * 100;
      const color = stringToColor(a.task);
      const label = width > 2 ? a.task.split(' ')[0] : '';
      const term = a.terminal ? `[${a.terminal}] ` : '';
      return `<div class="rt-block" style="left:${left}%; width:${width}%; background:${color}" 
              title="${a.task} ${term}(${a.start}-${a.end})">${label}</div>`;
    }).join('');

    const bks = (s.breaks || []).map(b => {
      const left = b.start_mins / 1440 * 100;
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

window.initIntraday = initIntraday;

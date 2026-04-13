/* ═══════════════════════════════════════════════════════
   DAA Short-Term Planning — D+1 / D+2 / D+3
   ═══════════════════════════════════════════════════════ */

const ST = {
  accent: '#E8850A', ok: '#2ECC71', warn: '#F39C12', crit: '#E74C3C',
  info: '#3498DB', muted: '#6b7280', white: '#1a2744', navy: '#0A2342',
};

const ST_SKILL_COLOR = {
  'GNIB': '#3498DB', 'CBP Pre-clearance': '#9B59B6', 'Bussing': '#E8850A',
  'PBZ': '#2ECC71', 'Mezz Operation': '#1ABC9C', 'Litter Picking': '#E74C3C',
  'Ramp / Marshalling': '#F39C12', 'Arr Customer Service': '#5DADE2',
  'Check-in / Trolleys': '#A9CCE3',
};

let ST_DATES = [];
let ST_CURRENT_DATE = null;
let ST_DATA = null;
let ST_ACTIVE_TAB = 'flights';  // 'flights' | 'staff'
const ST_CHARTS = {};

// ── Boot ───────────────────────────────────────────────────────
async function initShortTerm() {
  if (ST_DATES.length) {
    if (!ST_CURRENT_DATE) await stSelectDate(ST_DATES.find(d => d.has_data)?.date);
    return;
  }
  try {
    ST_DATES = await fetch('/api/short-term/dates').then(r => r.json());
    renderDayTabs();
    const first = ST_DATES.find(d => d.has_data);
    if (first) await stSelectDate(first.date);
  } catch (e) {
    document.getElementById('st-content').innerHTML =
      `<div class="empty-state">Failed to load schedule data.</div>`;
  }
}

// ── Day Tab Rendering ──────────────────────────────────────────
function renderDayTabs() {
  const bar = document.getElementById('st-day-tabs');
  bar.innerHTML = '';
  ST_DATES.forEach(d => {
    const btn = document.createElement('button');
    btn.className = 'day-tab' + (d.has_data ? '' : ' disabled');
    btn.dataset.date = d.date;
    btn.disabled = !d.has_data;
    btn.innerHTML = `<span class="day-tab-label">${d.label}</span>
      ${!d.has_data ? '<span class="day-tab-badge badge-muted">No Data</span>' : ''}`;
    btn.addEventListener('click', () => stSelectDate(d.date));
    bar.appendChild(btn);
  });
}

async function stSelectDate(dateStr) {
  if (!dateStr) return;
  ST_CURRENT_DATE = dateStr;

  // Highlight active tab
  document.querySelectorAll('.day-tab').forEach(b =>
    b.classList.toggle('active', b.dataset.date === dateStr));

  // Show loading
  document.getElementById('st-content').innerHTML =
    '<div class="loading-spinner"><div class="spinner"></div><span>Optimising schedule…</span></div>';

  try {
    ST_DATA = await fetch(`/api/short-term/${dateStr}`).then(r => r.json());
    renderShortTermDay();
  } catch (e) {
    document.getElementById('st-content').innerHTML =
      `<div class="empty-state">Error loading data for ${dateStr}</div>`;
  }
}

// ── Main Render ────────────────────────────────────────────────
function renderShortTermDay() {
  const d = ST_DATA;
  const el = document.getElementById('st-content');
  el.innerHTML = `
    <div class="page-header" style="margin-bottom:16px">
      <h2 class="page-title" style="font-size:1.3rem">${d.date_label}</h2>
    </div>
    <!-- KPI Cards -->
    <div class="kpi-grid st-kpi-grid" id="st-kpis"></div>
    <!-- Alerts -->
    <div id="st-alerts-panel"></div>
    <!-- Sub-tabs -->
    <div class="sub-tabs" style="margin-top:20px">
      <button class="sub-tab ${ST_ACTIVE_TAB==='flights'?'active':''}" data-sttab="flights">✈ Flights &amp; Tasks</button>
      <button class="sub-tab ${ST_ACTIVE_TAB==='staff'?'active':''}" data-sttab="staff">👤 Staff Roster</button>
      <button class="sub-tab ${ST_ACTIVE_TAB==='gate-timeline'?'active':''}" data-sttab="gate-timeline">🛬 Gate Timeline</button>
    </div>
    <div id="st-sub-content"></div>
  `;

  // Sub-tab listeners
  el.querySelectorAll('.sub-tab[data-sttab]').forEach(btn =>
    btn.addEventListener('click', () => {
      ST_ACTIVE_TAB = btn.dataset.sttab;
      el.querySelectorAll('.sub-tab[data-sttab]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderSTSubContent();
    })
  );

  renderSTKPIs(d.kpis);
  renderSTAlerts(d.alerts, d.date);
  renderSTSubContent();
}

// ── KPI Cards ──────────────────────────────────────────────────
function renderSTKPIs(kpis) {
  const grid = document.getElementById('st-kpis');
  const cards = [
    { icon: '✈', label: 'Total Flights', value: kpis.total_flights.toLocaleString(), cls: '' },
    { icon: '👥', label: 'Staff on Duty', value: kpis.staff_on_duty, cls: '' },
    { icon: '🚫', label: 'Absent', value: kpis.absent,
      cls: kpis.absent > 3 ? 'kpi-card--warn' : '' },
    { icon: '🛬', label: 'Gates / Stands Active', value: kpis.gates_active, cls: '' },
    { icon: '✅', label: 'Tasks Covered',
      value: `${kpis.tasks_covered} / ${kpis.tasks_total}`, cls: '' },
    { icon: '📊', label: 'Coverage %',
      value: kpis.coverage_pct + '%',
      cls: kpis.coverage_pct < 50 ? 'kpi-card--crit' : kpis.coverage_pct < 80 ? 'kpi-card--warn' : 'kpi-card--ok' },
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

// ── Alerts Panel ───────────────────────────────────────────────
function renderSTAlerts(alerts, date) {
  const panel = document.getElementById('st-alerts-panel');
  if (!alerts || alerts.length === 0) {
    panel.innerHTML = `<div class="alert-panel alert-ok">
      <span>✅</span> All tasks fully covered — no staffing gaps.</div>`;
    return;
  }
  const crit = alerts.filter(a => a.priority === 'Critical');
  const high = alerts.filter(a => a.priority !== 'Critical');
  panel.innerHTML = `
    <div class="alerts-container">
      <div class="alerts-header">
        <span class="alerts-title">⚠ Staffing Alerts &amp; Recommendations</span>
        <span class="alerts-count">
          ${crit.length ? `<span class="badge badge-crit">${crit.length} Critical</span>` : ''}
          ${high.length ? `<span class="badge badge-warn">${high.length} High</span>` : ''}
        </span>
        <button class="btn-ghost" id="st-alerts-toggle">Show top 10 ▾</button>
      </div>
      <div id="st-alerts-list"></div>
    </div>`;

  const shown = alerts.slice(0, 10);
  let expanded = false;
  const list = document.getElementById('st-alerts-list');

  function renderAlertsList(items) {
    list.innerHTML = items.map(a => `
      <div class="alert-row alert-${a.priority === 'Critical' ? 'crit' : 'warn'}">
        <div class="alert-row-left">
          <span class="badge ${a.priority === 'Critical' ? 'badge-crit' : 'badge-warn'}">${a.priority}</span>
          <span class="alert-msg">${a.message}</span>
        </div>
        <div class="alert-row-right">
          ${a.rec_staff && a.rec_staff.length
            ? `<span class="alert-rec">Rec: ${a.rec_staff.join(', ')}</span>
               <button class="btn-apply-rec"
                 data-date="${date}"
                 data-task="${a.task_id}"
                 data-staff='${JSON.stringify(a.rec_staff)}'>Apply ▶</button>`
            : '<span class="alert-rec muted">No available staff</span>'}
        </div>
      </div>`).join('');

    list.querySelectorAll('.btn-apply-rec').forEach(btn =>
      btn.addEventListener('click', () => applySTRecommendation(btn)));
  }

  renderAlertsList(shown);

  document.getElementById('st-alerts-toggle').addEventListener('click', function() {
    expanded = !expanded;
    renderAlertsList(expanded ? alerts : shown);
    this.textContent = expanded ? `Show top 10 ▴` : `Show top 10 ▾`;
  });
}

async function applySTRecommendation(btn) {
  const date = btn.dataset.date;
  const taskId = btn.dataset.task;
  const staffIds = JSON.parse(btn.dataset.staff);
  btn.disabled = true;
  btn.textContent = '…';
  try {
    ST_DATA = await fetch('/api/short-term/apply-rec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date, task_id: taskId, staff_ids: staffIds }),
    }).then(r => r.json());
    renderShortTermDay();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Apply ▶';
  }
}

// ── Sub-content router ─────────────────────────────────────────
function renderSTSubContent() {
  const el = document.getElementById('st-sub-content');
  if (ST_ACTIVE_TAB === 'flights') renderSTFlightsTab(el);
  else if (ST_ACTIVE_TAB === 'gate-timeline') renderSTGateTimeline(el);
  else renderSTStaffTab(el);
}

// ── Flights Tab ────────────────────────────────────────────────
function renderSTFlightsTab(container) {
  const flights = ST_DATA.flights;
  container.innerHTML = `
    <div class="panel mt-16">
      <div class="panel-title-row">
        <span class="panel-title">Flight Schedule &amp; Task Assignments</span>
        <div class="filter-row">
          <input class="search-input" id="st-flight-search" placeholder="Search flight / route / airline…" />
          <select id="st-status-filter" class="select-input">
            <option value="">All Status</option>
            <option value="Arrival">Arrivals</option>
            <option value="Departure">Departures</option>
          </select>
        </div>
      </div>
      <div class="table-scroll">
        <table class="data-table flights-table" id="st-flights-table">
          <thead>
            <tr>
              <th>Time</th><th>Flight</th><th>Route</th><th>Airline</th>
              <th>A/C</th><th>Gate</th><th>Type</th><th>Tasks</th><th>Status</th>
            </tr>
          </thead>
          <tbody id="st-flights-tbody"></tbody>
        </table>
      </div>
    </div>`;

  renderSTFlightsRows(flights);

  // Filters
  document.getElementById('st-flight-search').addEventListener('input', filterSTFlights);
  document.getElementById('st-status-filter').addEventListener('change', filterSTFlights);
}

function filterSTFlights() {
  const q = document.getElementById('st-flight-search').value.toLowerCase();
  const status = document.getElementById('st-status-filter').value;
  const filtered = ST_DATA.flights.filter(f => {
    const matchQ = !q || f.flight_no.toLowerCase().includes(q)
      || f.origin.toLowerCase().includes(q) || f.airline_name.toLowerCase().includes(q);
    const matchS = !status || f.status === status;
    return matchQ && matchS;
  });
  renderSTFlightsRows(filtered);
}

function renderSTFlightsRows(flights) {
  const tbody = document.getElementById('st-flights-tbody');
  if (!tbody) return;
  tbody.innerHTML = flights.slice(0, 300).map(f => {
    const tasks = f.tasks || [];
    const hasCrit = tasks.some(t => t.alert && t.priority === 'Critical');
    const hasWarn = tasks.some(t => t.alert);
    const taskPills = tasks.map(t => {
      const ok = !t.alert;
      const cls = ok ? 'task-pill-ok' : (t.priority === 'Critical' ? 'task-pill-crit' : 'task-pill-warn');
      const assignedTxt = t.assigned.length ? t.assigned.join(', ') : '—';
      return `<span class="task-pill ${cls}" title="${t.task} ${t.start}–${t.end}\nStaff: ${assignedTxt}">${t.task.split(' ')[0].slice(0,4)}</span>`;
    }).join('');
    const rowCls = hasCrit ? 'row-crit' : hasWarn ? 'row-warn' : '';
    return `<tr class="${rowCls}" data-fn="${f.flight_no}">
      <td class="time-cell">${f.sta}</td>
      <td class="fn-cell">${f.flight_no}</td>
      <td class="route-cell">${f.origin_code} ${f.origin}</td>
      <td>${f.airline_name}</td>
      <td>${f.aircraft_type} <span class="icao-badge">${f.icao_cat}</span></td>
      <td>${f.gate} <span class="stand-badge ${f.stand_type==='Remote'?'badge-warn':'badge-ok'}">${f.stand_type==='Remote'?'RMT':'CNT'}</span></td>
      <td><span class="status-badge ${f.status==='Arrival'?'badge-info':'badge-accent'}">${f.status}</span></td>
      <td class="tasks-cell">${taskPills || '<span class="muted">—</span>'}</td>
      <td><span class="badge ${f.status === 'Departure' ? 'badge-accent' : 'badge-info'}">${f.status}</span></td>
    </tr>`;
  }).join('');

  // Row click → show detail panel
  tbody.querySelectorAll('tr[data-fn]').forEach(tr =>
    tr.addEventListener('click', () => {
      const fn = tr.dataset.fn;
      const flight = ST_DATA.flights.find(f => f.flight_no === fn);
      if (flight) showSTFlightDetail(flight);
    })
  );
}

// ── Flight Detail Slide-in ─────────────────────────────────────
function showSTFlightDetail(flight) {
  let panel = document.getElementById('st-flight-detail');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'st-flight-detail';
    panel.className = 'flight-detail-panel';
    document.getElementById('st-content').appendChild(panel);
  }
  const tasks = flight.tasks || [];
  panel.innerHTML = `
    <div class="fd-header">
      <div>
        <div class="fd-title">${flight.flight_no} — ${flight.origin}</div>
        <div class="fd-meta">
          <span>${flight.status}</span> · <span>${flight.sta}</span> · Gate <b>${flight.gate}</b>
          · ${flight.airline_name} · ${flight.aircraft_type} · <span class="haul-badge">${flight.haul}</span>
          ${flight.cbp_flag === 'TRUE' ? '<span class="badge badge-crit">CBP</span>' : ''}
        </div>
      </div>
      <button class="fd-close" onclick="document.getElementById('st-flight-detail').classList.remove('open')">✕</button>
    </div>
    <div class="fd-tasks">
      <div class="fd-section-title">Tasks for this flight</div>
      ${tasks.length === 0
        ? '<div class="empty-state small">No tasks generated for this flight.</div>'
        : tasks.map(t => `
          <div class="fd-task-row ${t.alert ? 'fd-task-gap' : ''}">
            <div class="fd-task-name">
              <span class="dot" style="background:${ST_SKILL_COLOR[t.skill]||'#888'}"></span>
              ${t.task}
              <span class="badge ${t.priority==='Critical'?'badge-crit':'badge-warn'}">${t.priority}</span>
            </div>
            <div class="fd-task-time">${t.start} – ${t.end}</div>
            <div class="fd-task-staff">
              ${t.assigned.length
                ? t.assigned.map(id => `<span class="staff-chip">${id}</span>`).join('')
                : '<span class="gap-chip">⚠ Unassigned</span>'}
              <span class="fd-task-need">(need ${t.staff_needed})</span>
            </div>
          </div>`).join('')}
    </div>`;
  panel.classList.add('open');
}

// -- Staff Tab ----------------------------------------------------
function renderSTStaffTab(container) {
  const staff = ST_DATA.staff || [];
  const absent = ST_DATA.absent_staff || [];

  container.innerHTML = `
    <div class="panel mt-16">
      <div class="panel-title-row">
        <span class="panel-title">Staff Roster \u2014 ${ST_DATA.date_label}</span>
        <div class="filter-row">
          <input class="search-input" id="st-staff-search" placeholder="Search by ID, skill\u2026" />
          <select id="st-shift-filter" class="select-input">
            <option value="">All Shifts</option>
            <option value="Day">Day</option>
            <option value="Night">Night</option>
          </select>
        </div>
      </div>
      <div class="staff-grid" id="st-staff-grid"></div>
    </div>
    ${absent.length ? `
      <div class="panel mt-16">
        <div class="panel-title">Absent Staff (${absent.length})</div>
        <div class="absent-chips">
          ${absent.map(a => `
            <div class="absent-card">
              <div class="absent-id">${a.id}</div>
              <div class="absent-skill">${a.skill1}</div>
              <div class="badge badge-warn">${a.leave_type}</div>
            </div>`).join('')}
        </div>
      </div>` : ''}`;

  renderSTStaffCards(staff);
  document.getElementById('st-staff-search').addEventListener('input', filterSTStaff);
  document.getElementById('st-shift-filter').addEventListener('change', filterSTStaff);
}

function filterSTStaff() {
  const q = (document.getElementById('st-staff-search')?.value || '').toLowerCase();
  const shift = document.getElementById('st-shift-filter')?.value || '';
  const filtered = (ST_DATA.staff || []).filter(s => {
    const matchQ = !q || s.id.toLowerCase().includes(q)
      || (s.skill1 || '').toLowerCase().includes(q)
      || (s.skill2 || '').toLowerCase().includes(q);
    const matchShift = !shift || s.shift === shift;
    return matchQ && matchShift;
  });
  renderSTStaffCards(filtered);
}

function renderSTStaffCards(staffList) {
  const grid = document.getElementById('st-staff-grid');
  if (!grid) return;
  if (!staffList.length) {
    grid.innerHTML = '<div class="muted small" style="padding:16px">No staff match your search.</div>';
    return;
  }
  grid.innerHTML = staffList.map(s => {
    const utilColor = s.utilisation_pct > 90 ? ST.crit : s.utilisation_pct > 70 ? ST.warn : ST.ok;
    const assignments = s.assignments || [];
    const breaks = s.breaks || [];
    const assignedFlights = [...new Set(assignments.map(a => a.task_id?.split('_')[0]).filter(Boolean))];

    return `
      <div class="staff-card" style="cursor:pointer"
           data-staffid="${s.id}">
        <div class="staff-card-header">
          <div class="staff-card-title">
            <div class="staff-card-id">${s.id}</div>
            <div class="staff-card-skill">
              <span class="dot" style="background:${ST_SKILL_COLOR[s.skill1]||'#888'}"></span>
              <span>${s.skill1}</span>
              ${s.skill2 ? `<span class="skill2-badge">${s.skill2}</span>` : ''}
            </div>
          </div>
          <div class="staff-card-shift shift-${s.shift}">${s.shift}</div>
        </div>
        <div class="staff-card-meta">${s.shift_label}</div>
        <div class="staff-card-summary">
          <span class="staff-card-pill">\ud83d\udccb ${assignments.length} tasks</span>
          <span class="staff-card-pill">\u2708 ${assignedFlights.length} flights</span>
          <span class="staff-card-pill" style="color:${utilColor}">\ud83d\udcca ${Math.round(s.utilisation_pct)}%</span>
        </div>
        <div class="util-bar-row">
          <div class="util-bar">
            <div class="util-bar-fill" style="width:${Math.min(s.utilisation_pct,100)}%;background:${utilColor}"></div>
          </div>
          <span class="util-pct" style="color:${utilColor}">${Math.round(s.utilisation_pct)}%</span>
        </div>
        <div class="staff-card-click-hint">Click for full details \u2192</div>
      </div>`;
  }).join('');

  // Attach click handlers after rendering
  grid.querySelectorAll('.staff-card[data-staffid]').forEach(card => {
    card.addEventListener('click', () => {
      const sid = card.dataset.staffid;
      const s = (ST_DATA.staff || []).find(x => x.id === sid);
      if (s) showSTStaffDetail(s);
    });
  });
}

function _getSTStaffOverlay() {
  let overlay = document.getElementById('st-staff-detail-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'st-staff-detail-overlay';
    overlay.className = 'modal-overlay hidden';
    overlay.innerHTML = `<div class="modal-box modal-box-wide" id="st-staff-modal-box"></div>`;
    document.body.appendChild(overlay);
    // Click-outside to close
    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) closeSTStaffDetail();
    });
  }
  return overlay;
}

function showSTStaffDetail(s) {
  const overlay = _getSTStaffOverlay();
  const box = document.getElementById('st-staff-modal-box');
  if (!box) return;

  const utilColor = s.utilisation_pct > 90 ? ST.crit : s.utilisation_pct > 70 ? ST.warn : ST.ok;
  const assignments = s.assignments || [];
  const breaks = s.breaks || [];
  const assignedFlights = [...new Set(assignments.map(a => a.task_id?.split('_')[0]).filter(Boolean))];

  box.innerHTML = `
    <div class="modal-header">
      <div style="flex:1">
        <div class="modal-title">👤 ${s.id}</div>
        <div class="fd-meta" style="margin-top:4px;color:rgba(255,255,255,0.75)">
          <span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${ST_SKILL_COLOR[s.skill1]||'#888'};margin-right:5px;vertical-align:middle"></span>
          ${s.skill1}${s.skill2 ? ` · ${s.skill2}` : ''}
          &nbsp;·&nbsp;
          <span class="staff-card-shift shift-${s.shift}" style="padding:2px 10px;vertical-align:middle">${s.shift}</span>
        </div>
      </div>
      <button class="fd-close" onclick="closeSTStaffDetail()">✕</button>
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
          ? `<div class="staff-breaks">
               ${breaks.map(b => `<span class="break-chip">${b.type}: ${b.start}–${b.end}</span>`).join('')}
             </div>`
          : '<div class="muted small">No breaks scheduled.</div>'}
      </div>

      <div class="staff-detail-section">
        <div class="staff-detail-section-title">📋 All Task Assignments (${assignments.length})</div>
        ${assignments.length === 0 ? '<div class="muted small">No tasks assigned for this shift.</div>'
          : assignments.map(a => `
            <div class="staff-assign-row">
              <span class="staff-assign-time">${a.start}–${a.end}</span>
              <span class="staff-assign-task">
                <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${ST_SKILL_COLOR[a.skill]||'#888'};margin-right:5px;vertical-align:middle"></span>
                ${a.task} <span class="muted">${a.task_id?.split('_')[0] || ''}</span>
              </span>
            </div>`).join('')}
      </div>

      ${assignedFlights.length ? `
        <div class="staff-detail-section">
          <div class="staff-detail-section-title">✈ Flights Covered (${assignedFlights.length})</div>
          <div class="staff-flights-list">
            ${assignedFlights.map(fn => {
              const f = (ST_DATA.flights || []).find(fl => fl.flight_no === fn);
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

function closeSTStaffDetail() {
  const ov = document.getElementById('st-staff-detail-overlay');
  if (ov) ov.classList.add('hidden');
}
window.closeSTStaffDetail = closeSTStaffDetail;
window.showSTStaffDetail  = showSTStaffDetail;

// ── Gate Timeline ──────────────────────────────────────────────
function renderSTGateTimeline(container) {
  const flights = ST_DATA.flights;

  const TIME_START = 0;     // 00:00
  const TIME_END   = 1440;  // 24:00
  const RANGE      = TIME_END - TIME_START;
  const LEAD_MINS  = 30;
  const TRAIL_MINS = 60;

  const AIRLINE_COLORS = {
    'Ryanair':                          '#073590',
    'Aer Lingus':                       '#00843D',
    'British Airways':                  '#2B5EAE',
    'Lufthansa':                        '#004A7C',
    'Lufthansa (Star Alliance Livery)': '#004A7C',
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

  // Group flights by gate
  const gateMap = {};
  for (const f of flights) {
    const g = f.gate;
    if (!g || f.time_mins == null) continue;
    if (!gateMap[g]) gateMap[g] = [];
    gateMap[g].push(f);
  }

  const sortedGates = Object.keys(gateMap).sort((a, b) => {
    // Remote stands after contact stands; within each group sort numerically
    const aRem = a.startsWith('R'), bRem = b.startsWith('R');
    if (aRem !== bRem) return aRem ? 1 : -1;
    return (parseInt(a.replace(/^R/, '')) || 0) - (parseInt(b.replace(/^R/, '')) || 0);
  });

  function getPier(g) {
    if (g.startsWith('R')) return 'Remote Apron';
    const n = parseInt(g);
    if (isNaN(n)) return 'Other';
    const p = Math.floor(n / 100);
    if (p === 5) return 'T2 \u2014 Pier 5';
    if (p === 4) return 'T1 \u2014 Pier 4';
    if (p === 3) return 'T1 \u2014 Pier 3';
    if (p === 2) return 'T1 \u2014 Pier 2';
    if (p === 1) return 'T1 \u2014 Pier 1';
    return 'Other';
  }

  const PIER_ORDER = [
    'T1 \u2014 Pier 1', 'T1 \u2014 Pier 2',
    'T1 \u2014 Pier 3', 'T1 \u2014 Pier 4',
    'T2 \u2014 Pier 5', 'Remote Apron', 'Other',
  ];

  const pierGroups = {};
  for (const g of sortedGates) {
    const pier = getPier(g);
    if (!pierGroups[pier]) pierGroups[pier] = [];
    pierGroups[pier].push(g);
  }

  // Hour axis
  const axisHtml = [];
  for (let h = 0; h <= 24; h++) {
    axisHtml.push(
      `<div class="gt-hour-tick" style="left:${pct(h * 60).toFixed(2)}%">
        <span class="gt-hour-label">${String(h % 24).padStart(2, '0')}</span>
        <div class="gt-hour-line"></div>
      </div>`
    );
  }

  // Gate rows
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
        const e = Math.min(TIME_END,   t + TRAIL_MINS);
        if (e <= TIME_START || s >= TIME_END) return '';
        const lp = pct(s).toFixed(2);
        const wp = (pct(e) - pct(s)).toFixed(2);
        const color = getColor(f.airline_name || '');
        const tip = `${f.flight_no} \u2014 ${f.airline_name}\n${f.status} \u00b7 STA ${f.sta}\n${f.origin_code} ${f.origin}\nGate ${f.gate} \u00b7 ${f.haul}${f.cbp_flag === 'TRUE' ? ' \u00b7 CBP' : ''}`;
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

  // Unique airlines in data for legend
  const airlineSet = new Set();
  for (const f of flights) if (f.airline_name) airlineSet.add(f.airline_name);
  const legendHtml = [...airlineSet].sort().map(a =>
    `<div class="gt-legend-item">
      <span class="gt-legend-dot" style="background:${getColor(a)}"></span>
      <span class="gt-legend-name">${a}</span>
    </div>`
  ).join('');

  const dayLabel = ST_DATA.date_label.split(' ')[0].toUpperCase();

  container.innerHTML = `
    <div class="panel mt-16 gt-panel">
      <div class="gt-panel-header">
        <span class="gt-panel-title">${dayLabel} GATE TIMELINE</span>
        <span class="gt-count-badge">${flights.length} flights scheduled</span>
      </div>
      <div class="gt-chart-scroll">
        <div class="gt-chart">
          <!-- Time axis -->
          <div class="gt-axis-row">
            <div class="gt-gate-label"></div>
            <div class="gt-axis-track">${axisHtml.join('')}</div>
          </div>
          <!-- Gate rows -->
          ${rowsHtml}
        </div>
      </div>
      <!-- Legend -->
      <div class="gt-legend">${legendHtml}</div>
    </div>`;
}

// ── Expose to global ───────────────────────────────────────────
window.initShortTerm = initShortTerm;

/* ═══════════════════════════════════════════════════════
   DAA Short-Term Planning — D+1 / D+2 / D+3
   ═══════════════════════════════════════════════════════ */

const ST = {
  accent: '#E8850A', ok: '#2ECC71', warn: '#F39C12', crit: '#E74C3C',
  info: '#3498DB', muted: '#6b7280', 
  white: () => (window.getCurrentTheme && window.getCurrentTheme() === 'dark' ? '#ffffff' : '#1a2744'),
  navy: '#0A2342',
};

const ST_SKILL_COLOR = {
  'GNIB': '#3498DB', 'CBP Pre-clearance': '#9B59B6', 'Bussing': '#E8850A',
  'PBZ': '#2ECC71', 'Mezz Operation': '#1ABC9C', 'Litter Picking': '#E74C3C',
  'Ramp / Marshalling': '#F39C12', 'Arr Customer Service': '#5DADE2',
  'Check-in/Trolleys': '#A9CCE3', 'Transfer Corridor': '#27AE60',
  'Dep / Trolleys': '#8E44AD', 'T1/T2 Trolleys L/UL': '#E91E63',
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
      <button class="sub-tab ${ST_ACTIVE_TAB==='staff'?'active':''}" data-sttab="staff">👥 Staff List</button>
      <button class="sub-tab ${ST_ACTIVE_TAB==='staff-timeline'?'active':''}" data-sttab="staff-timeline">👤 Roster Timeline</button>
      <button class="sub-tab ${ST_ACTIVE_TAB==='roster-board'?'active':''}" data-sttab="roster-board">📋 Roster Board</button>
      <button class="sub-tab ${ST_ACTIVE_TAB==='gate-timeline'?'active':''}" data-sttab="gate-timeline">🛬 Gate Timeline</button>
      <button class="sub-tab ${ST_ACTIVE_TAB==='opt'?'active':''}" data-sttab="opt">⚙ Optimization</button>
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

function _getSTAlertOverlay() {
  let overlay = document.getElementById('st-alert-detail-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'st-alert-detail-overlay';
    overlay.className = 'modal-overlay hidden';
    overlay.innerHTML = `<div class="modal-box modal-box-wide" id="st-alert-detail-box"></div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) closeSTAlertDetail();
    });
  }
  return overlay;
}

function showSTAlertDetail(alert) {
  const overlay = _getSTAlertOverlay();
  const box = document.getElementById('st-alert-detail-box');
  if (!box || !alert) return;
  const flights = alert.covered_flights || [];
  box.innerHTML = `
    <div class="modal-header">
      <div style="flex:1">
        <div class="modal-title">Alert Detail · ${alert.task}</div>
        <div class="fd-meta" style="margin-top:4px;color:rgba(255,255,255,0.75)">
          ${alert.priority} · ${alert.start}–${alert.end} · ${alert.terminal || 'ALL'} / ${alert.pier || 'ALL'}
        </div>
      </div>
      <button class="fd-close" onclick="closeSTAlertDetail()">✕</button>
    </div>
    <div class="modal-body">
      <div class="staff-detail-kpis">
        <div class="staff-detail-kpi"><div class="staff-detail-kpi-val">${alert.staff_needed}</div><div class="staff-detail-kpi-lbl">Staff Needed</div></div>
        <div class="staff-detail-kpi"><div class="staff-detail-kpi-val">${alert.assigned_count}</div><div class="staff-detail-kpi-lbl">Assigned</div></div>
        <div class="staff-detail-kpi"><div class="staff-detail-kpi-val">${alert.gap}</div><div class="staff-detail-kpi-lbl">Gap</div></div>
        <div class="staff-detail-kpi"><div class="staff-detail-kpi-val">${flights.length}</div><div class="staff-detail-kpi-lbl">Flights Impacted</div></div>
      </div>
      <div class="staff-detail-section">
        <div class="staff-detail-section-title">Issue Summary</div>
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

function closeSTAlertDetail() {
  const overlay = document.getElementById('st-alert-detail-overlay');
  if (overlay) overlay.classList.add('hidden');
}
window.showSTAlertDetail = showSTAlertDetail;
window.closeSTAlertDetail = closeSTAlertDetail;

renderSTAlerts = function(alerts, date) {
  const panel = document.getElementById('st-alerts-panel');
  if (!alerts || alerts.length === 0) {
    panel.innerHTML = `<div class="alert-panel alert-ok"><span>âœ…</span> All tasks fully covered â€” no staffing gaps.</div>`;
    return;
  }
  const crit = alerts.filter(a => a.priority === 'Critical');
  const high = alerts.filter(a => a.priority !== 'Critical');
  panel.innerHTML = `
    <div class="alerts-container">
      <div class="alerts-header">
        <span class="alerts-title">âš  Staffing Alerts &amp; Recommendations</span>
        <span class="alerts-count">
          ${crit.length ? `<span class="badge badge-crit">${crit.length} Critical</span>` : ''}
          ${high.length ? `<span class="badge badge-warn">${high.length} High</span>` : ''}
        </span>
        <button class="btn-ghost" id="st-alerts-toggle">Show top 10 â–¾</button>
      </div>
      <div id="st-alerts-list"></div>
    </div>`;

  const shown = alerts.slice(0, 10);
  let expanded = false;
  const list = document.getElementById('st-alerts-list');

  function renderAlertsList(items) {
    list.innerHTML = items.map((a, idx) => {
      const flights = a.covered_flights || [];
      const flightLabel = flights.length
        ? flights.slice(0, 2).map(f => f.flight_no).join(', ') + (flights.length > 2 ? ` +${flights.length - 2}` : '')
        : (a.flight_no || 'No linked flight');
      return `
        <div class="alert-row alert-${a.priority === 'Critical' ? 'crit' : 'warn'} alert-row-clickable" data-alert-idx="${idx}">
          <div class="alert-row-left alert-row-detail">
            <span class="badge ${a.priority === 'Critical' ? 'badge-crit' : 'badge-warn'}">${a.priority}</span>
            <div class="alert-msg">
              <div class="alert-msg-title">${flightLabel} · ${a.task}</div>
              <div class="alert-msg-sub">${a.start}–${a.end} · ${a.terminal || 'ALL'} / ${a.pier || 'ALL'} · Need ${a.staff_needed}, assigned ${a.assigned_count}, gap ${a.gap}</div>
              <div class="alert-msg-body">${a.message}</div>
            </div>
          </div>
          <div class="alert-row-right">
            ${a.rec_staff && a.rec_staff.length
              ? `<span class="alert-rec">Rec: ${a.rec_staff.join(', ')}</span>
                 <button class="btn-apply-rec"
                   data-date="${date}"
                   data-task="${a.task_id}"
                   data-staff='${JSON.stringify(a.rec_staff)}'>Apply â–¶</button>`
              : '<span class="alert-rec muted">No available staff</span>'}
          </div>
        </div>`;
    }).join('');

    list.querySelectorAll('.btn-apply-rec').forEach(btn =>
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        applySTRecommendation(btn);
      }));
    list.querySelectorAll('.alert-row[data-alert-idx]').forEach(row =>
      row.addEventListener('click', () => showSTAlertDetail(items[Number(row.dataset.alertIdx)])));
  }

  renderAlertsList(shown);

  document.getElementById('st-alerts-toggle').addEventListener('click', function() {
    expanded = !expanded;
    renderAlertsList(expanded ? alerts : shown);
    this.textContent = expanded ? `Show top 10 â–´` : `Show top 10 â–¾`;
  });
};

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
  else if (ST_ACTIVE_TAB === 'staff') renderSTStaffTab(el);
  else if (ST_ACTIVE_TAB === 'staff-timeline') renderSTRosterTimeline(el);
  else if (ST_ACTIVE_TAB === 'roster-board') renderSTRosterBoard(el);
  else if (ST_ACTIVE_TAB === 'gate-timeline') renderSTGateTimeline(el);
  else if (ST_ACTIVE_TAB === 'opt') renderSTOptimization(el);
}

// ── Roster Timeline Tab ──────────────────────────────────────────
async function renderSTRosterTimeline(container) {
  if (!ST_DATA) return;
  
  container.innerHTML = `
    <div class="panel mt-16">
      <div class="panel-title-row">
        <span class="panel-title">Operational Roster Timeline — ${ST_DATA.date_label}</span>
        <div class="filter-row">
          <input class="search-input" id="st-staff-timeline-search" placeholder="Search staff ID / skill…" style="width:200px" />
          <select id="st-staff-timeline-shift" class="select-input">
            <option value="">All Shifts</option>
            <option value="00:00 - 12:00">00:00 - 12:00</option>
            <option value="12:00 - 00:00">12:00 - 24:00</option>
            <option value="10:00 - 22:00">10:00 - 22:00</option>
          </select>
        </div>
      </div>
      <div id="st-staff-timeline" style="margin-top:20px; overflow-x:auto;"></div>
    </div>
  `;

  const searchInput = document.getElementById('st-staff-timeline-search');
  const shiftSelect = document.getElementById('st-staff-timeline-shift');
  
  const refreshTimeline = () => {
    const q = searchInput.value.toLowerCase() || '';
    const shiftFilter = shiftSelect.value || '';
    const timelineEl = document.getElementById('st-staff-timeline');
    if (!timelineEl) return;

    function stringToColor(str) {
      let hash = 0;
      for (let i = 0; i < str.length; i++) {
        hash = str.charCodeAt(i) + ((hash << 5) - hash);
      }
      const h = Math.abs(hash) % 360;
      return `hsl(${h}, 65%, 40%)`;
    }

    const filteredStaff = (ST_DATA.staff || []).filter(s => {
      const mq = !q || s.id.toLowerCase().includes(q) || s.skill1.toLowerCase().includes(q);
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
      const shiftEnd = s.shift_end || shiftStart + 720;
      const shiftWidth = ((shiftEnd - shiftStart) % 1441) / 1440 * 100;
      const shiftLeft = (shiftStart / 1440) * 100;

      const shiftBg = `<div class="rt-shift-bg" style="left:${shiftLeft}%; width:${shiftWidth}%" title="${s.shift_label}"></div>`;

      const tasks = (s.assignments || []).map(a => {
        const left = (a.start_mins / 1440) * 100;
        const width = ((a.end_mins - a.start_mins) / 1440) * 100;
        const color = ST_SKILL_COLOR[a.skill] || stringToColor(a.task);
        const label = width > 2 ? a.task.split(' ')[0] : '';
        const term = a.terminal ? `[${a.terminal}] ` : '';
        return `<div class="rt-block" style="left:${left}%; width:${width}%; background:${color}" 
                title="${a.task} ${term}(${a.start}-${a.end})">${label}</div>`;
      }).join('');

      const bks = (s.breaks || []).map(b => {
        const left = (b.start_mins / 1440) * 100;
        const width = ((b.end_mins - b.start_mins) / 1440) * 100;
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

    timelineEl.innerHTML = `
      <div class="rt-container">
        <div class="rt-chart">
          <div class="rt-axis-row">
            <div class="rt-staff-label-header"></div>
            <div class="rt-axis-track">${axisTicks.join('')}</div>
          </div>
          ${rows}
        </div>
      </div>`;
  };

  searchInput.addEventListener('input', refreshTimeline);
  shiftSelect.addEventListener('change', refreshTimeline);
  refreshTimeline();
}

// ── Roster Board Tab ─────────────────────────────────────────────
async function renderSTRosterBoard(container) {
  container.innerHTML = `
    <div class="panel mt-16" style="min-height:200px">
      <div class="loading-spinner"><div class="spinner"></div><span>Loading multi-day roster board…</span></div>
    </div>
  `;

  try {
    const data = await fetch('/api/short-term/roster-board').then(r => r.json());
    if (data.error) throw new Error(data.error);

    const dates = data.dates;
    const employees = data.employees;

    container.innerHTML = `
      <div class="panel mt-16">
        <div class="panel-title-row" style="margin-bottom:24px; border-bottom:1px solid var(--border); padding-bottom:16px;">
          <div>
            <h2 class="panel-title" style="margin:0; font-size:1.4rem; color:var(--text); text-transform:none;">📋 Individual Roster Board — Short-Term Overview</h2>
            <p class="section-hint" style="margin:6px 0 0; color:var(--muted); font-size:0.88rem;">Weekly shift patterns for all rostered staff across the next 3 days</p>
          </div>
        </div>
        
        <div class="roster-board-container">
          <table class="rb-table">
            <thead>
              <tr>
                <th class="rb-staff-cell">Employee / Role</th>
                ${dates.map(d => `<th>${d.label}</th>`).join('')}
              </tr>
            </thead>
            <tbody>
              ${employees.map(emp => `
                <tr>
                  <td class="rb-staff-cell">
                    <div class="rb-staff-name">${emp.id}</div>
                    <div class="rb-staff-skill">${emp.skill}</div>
                  </td>
                  ${dates.map(d => {
                    const shift = emp.shifts[d.date];
                    const cls = `rb-${shift.type.toLowerCase()}`;
                    const label = shift.label.split(' ')[0];
                    return `
                      <td>
                        <div class="rb-shift-block ${cls}" title="${shift.timings || shift.label}">
                          <div class="rb-shift-label">${label}</div>
                          <div class="rb-shift-time">${shift.timings}</div>
                        </div>
                      </td>
                    `;
                  }).join('')}
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>

        <div class="rb-legend">
          <div class="rb-leg-item"><div class="rb-leg-swatch rb-early"></div><span>Early shift (E)</span></div>
          <div class="rb-leg-item"><div class="rb-leg-swatch rb-late"></div><span>Late shift (L)</span></div>
          <div class="rb-leg-item"><div class="rb-leg-swatch rb-night"></div><span>Night shift (N)</span></div>
          <div class="rb-leg-item"><div class="rb-leg-swatch rb-leave"></div><span>Annual leave</span></div>
          <div class="rb-leg-item"><div class="rb-leg-swatch rb-off"></div><span>Off duty</span></div>
        </div>
      </div>
    `;
  } catch (err) {
    container.innerHTML = `
      <div class="panel mt-16" style="border-top:4px solid var(--crit);">
        <h2 class="panel-title">Roster Board Error</h2>
        <div class="alert-crit" style="border-radius:6px; padding:16px;">
          ${err.message}
        </div>
        <p class="muted small mt-12">This may happen if data for the requested dates is not yet available or the optimizer failed.</p>
      </div>
    `;
  }
}

// ── Optimization Tab ─────────────────────────────────────────────
async function renderSTOptimization(container) {
  const SKILL_COLORS = {
    'GNIB':'#3498DB','CBP Pre-clearance':'#9B59B6','Bussing':'#E8850A',
    'PBZ':'#2ECC71','Mezz Operation':'#1ABC9C','Litter Picking':'#E74C3C',
    'Ramp / Marshalling':'#F39C12','Arr Customer Service':'#5DADE2',
    'Check-in/Trolleys':'#A9CCE3','Transfer Corridor':'#27AE60',
    'Dep / Trolleys':'#8E44AD','T1/T2 Trolleys L/UL':'#E91E63',
  };

  // Load current constraints to pre-fill the form
  container.innerHTML = `<div class="panel mt-20"><div class="loading-spinner"><div class="spinner"></div><span>Loading optimiser…</span></div></div>`;
  let constraints = {};
  try {
    const r = await fetch('/api/short-term/constraints');
    constraints = await r.json();
  } catch (_) {}

  container.innerHTML = `
    <div class="panel mt-20" style="border-top:4px solid var(--accent);">
      <div class="panel-title-row" style="margin-bottom:20px;border-bottom:1px solid var(--border);padding-bottom:16px;">
        <div>
          <h2 class="panel-title" style="margin:0;font-size:1.4rem;color:var(--text);text-transform:none;">⚙ Unified Optimiser</h2>
          <p class="section-hint" style="margin:6px 0 0;font-size:0.88rem;">
            Adjust all constraints then run — results are applied live across all tabs.
            &nbsp;·&nbsp; <em>Phase 1</em>: schedule tasks by skill &nbsp;·&nbsp; <em>Phase 2</em>: assign shifts via Greedy + MIP
          </p>
        </div>
        <button class="btn-update-fluid" id="st-opt-run" style="min-width:180px;">⚡ Run &amp; Apply</button>
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
              <input type="number" id="opt-b1" class="select-input" value="${constraints.b1_duration_mins||30}" min="15" max="60" style="width:100%"/></div>
            <div style="flex:1"><label class="opt-label">Meal Break (min)</label>
              <input type="number" id="opt-b2" class="select-input" value="${constraints.b2_duration_mins||60}" min="30" max="120" style="width:100%"/></div>
          </div>
        </div>

        <!-- Travel buffers -->
        <div class="opt-card">
          <div class="opt-card-title"><span style="color:var(--accent)">🚶</span> Travel Buffers (min)</div>
          <div class="input-group" style="margin-bottom:14px">
            <label class="opt-label">T1 → T2 Transfer</label>
            <input type="number" id="opt-tt-t1t2" class="select-input" value="${constraints.tt_t1_t2||15}" min="0" max="60" style="width:100%"/>
          </div>
          <div class="input-group">
            <label class="opt-label">Skill-Switch Transfer</label>
            <input type="number" id="opt-tt-sk" class="select-input" value="${constraints.tt_skill_switch||10}" min="0" max="60" style="width:100%"/>
          </div>
        </div>

        <!-- Solver mode -->
        <div class="opt-card">
          <div class="opt-card-title"><span style="color:var(--ok)">🧮</span> Solver</div>
          <p class="opt-hint">MIP (CBC) minimises skill mismatch + workload inequality after greedy pass. Requires PuLP.</p>
          <div style="display:flex;align-items:center;gap:12px;margin:12px 0;">
            <input type="checkbox" id="opt-mip" style="width:20px;height:20px;accent-color:var(--accent);cursor:pointer" checked/>
            <label for="opt-mip" class="opt-label" style="margin:0;cursor:pointer">Enable MIP Refinement</label>
          </div>
          <p class="opt-hint" style="margin-top:6px;font-size:0.74rem;">Obj: Σ skill-mismatch + L1 workload deviation + Σ demand-gap × priority</p>
          <div style="display:flex;flex-direction:column;gap:10px;margin-top:12px;">
            <div style="display:flex;align-items:center;gap:12px;">
              <input type="checkbox" id="opt-prim-first" style="width:18px;height:18px;accent-color:var(--info);cursor:pointer" ${constraints.use_primary_first!==false?'checked':''}/>
              <label for="opt-prim-first" class="opt-label" style="margin:0;cursor:pointer">Primary Skills First</label>
            </div>
            <div style="display:flex;align-items:center;gap:12px;">
              <input type="checkbox" id="opt-overlap" style="width:18px;height:18px;accent-color:var(--info);cursor:pointer" ${(constraints.allow_overlaps||constraints.allow_overlap)?'checked':''}/>
              <label for="opt-overlap" class="opt-label" style="margin:0;cursor:pointer">Allow Schedule Overlaps</label>
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
              {label:'00:00 – 12:00', s:0,   e:720},
              {label:'12:00 – 24:00', s:720, e:1440},
              {label:'10:00 – 22:00', s:600, e:1320},
              {label:'04:00 – 16:00', s:240, e:960},
              {label:'16:00 – 04:00', s:960, e:240},
            ].map((sh,i) => {
              const chk = (constraints.permitted_shifts||[]).some(p=>p[0]===sh.s&&p[1]===sh.e)||(!constraints.permitted_shifts&&i<3);
              return `<div style="display:flex;align-items:center;gap:12px;">
                <input type="checkbox" class="opt-sh-chk" id="opt-sh-${i}"
                  data-label="${sh.label}" data-start="${sh.s}" data-end="${sh.e}"
                  style="width:18px;height:18px;accent-color:var(--info);cursor:pointer" ${chk?'checked':''}/>
                <label for="opt-sh-${i}" class="opt-label" style="margin:0;cursor:pointer">${sh.label}</label>
              </div>`;
            }).join('')}
          </div>
        </div>

      </div><!-- /opt-grid -->

      <!-- Results -->
      <div id="opt-results"></div>
    </div>`;

  // ── Run & Apply handler ───────────────────────────────────────────
  document.getElementById('st-opt-run').addEventListener('click', async () => {
    const btn     = document.getElementById('st-opt-run');
    const results = document.getElementById('opt-results');
    btn.disabled  = true;
    btn.innerHTML = '<span class="spinner" style="width:12px;height:12px;border-width:2px;display:inline-block;vertical-align:middle;margin-right:6px"></span>Optimising…';
    results.innerHTML = '<div class="loading-spinner"><div class="spinner"></div><span>Running two-phase optimisation and applying to all tabs…</span></div>';

    const leaves = Array.from(document.querySelectorAll('#opt-leave-toggles input:checked')).map(cb => cb.value);
    const shifts  = Array.from(document.querySelectorAll('#opt-shift-toggles input:checked')).map(cb => [
      parseInt(cb.dataset.start,10), parseInt(cb.dataset.end,10), cb.dataset.label
    ]);

    const payload = {
      date:                 ST_CURRENT_DATE,
      use_mip:              document.getElementById('opt-mip').checked,
      min_rest_hrs:         parseFloat(document.getElementById('opt-rest-hrs').value),
      shift_duration_hrs:   parseInt(document.getElementById('opt-shift-hrs').value, 10),
      b1_duration_mins:     parseInt(document.getElementById('opt-b1').value, 10),
      b2_duration_mins:     parseInt(document.getElementById('opt-b2').value, 10),
      tt_t1_t2:             parseInt(document.getElementById('opt-tt-t1t2').value, 10),
      tt_skill_switch:      parseInt(document.getElementById('opt-tt-sk').value, 10),
      use_primary_first:    document.getElementById('opt-prim-first').checked,
      allow_overlaps:       document.getElementById('opt-overlap').checked,
      leave_types_excluded: leaves,
      permitted_shifts:     shifts,
    };

    try {
      const res  = await fetch('/api/short-term/optimise', {
        method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Optimiser failed');

      // ── Apply result to global state and refresh all tabs ──────────
      ST_DATA = data;
      renderShortTermDay();

      // ── Scroll back to opt tab and show results inline ─────────────
      ST_ACTIVE_TAB = 'opt';
      const el = document.getElementById('st-sub-content');
      if (el) {
        const resEl = el.querySelector('#opt-results');
        if (resEl) _renderOptResults(resEl, data);
      }

    } catch (err) {
      results.innerHTML = `<div class="panel mt-8" style="padding:16px;border-left:4px solid var(--crit);">
        <strong style="color:var(--crit)">✕ Optimiser error</strong><br/><span style="font-size:0.85rem">${err.message}</span></div>`;
    } finally {
      btn.disabled  = false;
      btn.innerHTML = '⚡ Run &amp; Apply';
    }
  });

  // ── Render optimiser results (roster section) ──────────────────────
  function _renderOptResults(resultsEl, data) {
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

    // KPIs
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

    // Shift patterns grid
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
            <div style="width:${pct}%;height:100%;background:var(--accent);border-radius:2px;"></div>
          </div>
          <div class="ro-skills-wrap">${chips}</div>
        </div>`;
    }).join('');

    // Coverage bars
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

    // Flags
    const flagsHtml = (r.flags||[]).length
      ? (r.flags||[]).map(f=>`<div class="ro-flag"><strong>${f.flag_id}</strong> — ${f.detail}</div>`).join('')
      : '<div class="ro-no-flags">✓ No roster flags</div>';

    // Fairness grid
    const fairHtml = `
      <div class="ro-fairness-grid">
        <div class="ro-fair-stat"><span class="ro-fair-val" style="color:${giniColor}">${typeof gini==='number'?gini.toFixed(3):gini}</span><span class="ro-fair-lbl">Gini</span></div>
        <div class="ro-fair-stat"><span class="ro-fair-val">${fairness.mean_utilisation_pct??'—'}%</span><span class="ro-fair-lbl">Mean</span></div>
        <div class="ro-fair-stat"><span class="ro-fair-val">${fairness.std_utilisation_pct??'—'}%</span><span class="ro-fair-lbl">Std Dev</span></div>
        <div class="ro-fair-stat"><span class="ro-fair-val">${fairness.min_utilisation_pct??'—'}%</span><span class="ro-fair-lbl">Min</span></div>
        <div class="ro-fair-stat"><span class="ro-fair-val">${fairness.max_utilisation_pct??'—'}%</span><span class="ro-fair-lbl">Max</span></div>
      </div>`;

    // Staff table from updated ST_DATA
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
              <div class="absent-skill">
                ${[a.skill1, a.skill2, a.skill3, a.skill4].filter(Boolean).join(' • ')}
              </div>
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
    const skillsMatch = [s.skill1, s.skill2, s.skill3, s.skill4].some(sk => (sk || '').toLowerCase().includes(q));
    const matchQ = !q || s.id.toLowerCase().includes(q) || skillsMatch;
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
              <div style="display:flex; align-items:center; gap:6px; margin-bottom:4px">
                <span class="dot" style="background:${ST_SKILL_COLOR[s.skill1]||'#888'}"></span>
                <span style="font-weight:700">${s.skill1}</span>
              </div>
              <div style="display:flex; flex-wrap:wrap; gap:4px">
                ${[s.skill2, s.skill3, s.skill4].filter(Boolean).map(sk => `<span class="skill2-badge">${sk}</span>`).join('')}
              </div>
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
// Final clean override to avoid mojibake in the alerts header/toggle text.
renderSTAlerts = function(alerts, date) {
  const panel = document.getElementById('st-alerts-panel');
  if (!alerts || alerts.length === 0) {
    panel.innerHTML = `<div class="alert-panel alert-ok"><span>OK</span> All tasks fully covered - no staffing gaps.</div>`;
    return;
  }

  const crit = alerts.filter(a => a.priority === 'Critical');
  const high = alerts.filter(a => a.priority !== 'Critical');
  panel.innerHTML = `
    <div class="alerts-container">
      <div class="alerts-header">
        <span class="alerts-title">Staffing Alerts &amp; Recommendations</span>
        <span class="alerts-count">
          ${crit.length ? `<span class="badge badge-crit">${crit.length} Critical</span>` : ''}
          ${high.length ? `<span class="badge badge-warn">${high.length} High</span>` : ''}
        </span>
        <button class="btn-ghost" id="st-alerts-toggle">Show top 10 v</button>
      </div>
      <div id="st-alerts-list"></div>
    </div>`;

  const shown = alerts.slice(0, 10);
  let expanded = false;
  const list = document.getElementById('st-alerts-list');

  function renderAlertsList(items) {
    list.innerHTML = items.map((a, idx) => {
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
              ? `<span class="alert-rec">Rec: ${a.rec_staff.join(', ')}</span>
                 <button class="btn-apply-rec"
                   data-date="${date}"
                   data-task="${a.task_id}"
                   data-staff='${JSON.stringify(a.rec_staff)}'>Apply</button>`
              : '<span class="alert-rec muted">No available staff</span>'}
          </div>
        </div>`;
    }).join('');

    list.querySelectorAll('.btn-apply-rec').forEach(btn =>
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        applySTRecommendation(btn);
      }));
    list.querySelectorAll('.alert-row[data-alert-idx]').forEach(row =>
      row.addEventListener('click', () => showSTAlertDetail(items[Number(row.dataset.alertIdx)])));
  }

  renderAlertsList(shown);

  document.getElementById('st-alerts-toggle').addEventListener('click', function() {
    expanded = !expanded;
    renderAlertsList(expanded ? alerts : shown);
    this.textContent = expanded ? `Show top 10 ^` : `Show top 10 v`;
  });
};

window.initShortTerm = initShortTerm;


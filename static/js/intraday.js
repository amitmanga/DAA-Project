/* ═══════════════════════════════════════════════════════
   DAA Intraday Operations — D (Today)
   ═══════════════════════════════════════════════════════ */

const ID = {
  accent: '#E8850A', ok: '#2ECC71', warn: '#F39C12', crit: '#E74C3C',
  info: '#3498DB', muted: '#6b7280', 
  white: () => (window.getCurrentTheme && window.getCurrentTheme() === 'dark' ? '#ffffff' : '#1a2744'),
};

const ID_SKILL_COLOR = {
  'Checkin': '#2563EB', 'Security': '#DC2626', 'CBP': '#7C3AED',
  'Lounge': '#059669', 'Boarding': '#D97706', 'Immigration': '#0891B2',
  'Baggage': '#4B5563',
  'GNIB': '#3498DB', 'CBP Pre-clearance': '#9B59B6', 'Bussing': '#E8850A',
  'PBZ': '#2ECC71', 'Mezz Operation': '#1ABC9C', 'Litter Picking': '#E74C3C',
  'Gate 335': '#F39C12', 'Arr Customer Service': '#5DADE2',
  'Check-in/Trolleys': '#A9CCE3', 'Transfer Corridor': '#27AE60',
  'Dep/Trolleys': '#8E44AD', 'T1/T2 Trolleys L/UL': '#E91E63',
  'Departures': '#F1C40F'
};

let ID_DATA = null;
let ID_SELECTED_FLIGHT = null;
let ID_MANAGE_TASK = null;
let ID_ACTIVE_TAB = 'staff-timeline';
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

function normalizePaxDemandToHourly(data) {
  if (!data || !Array.isArray(data.tasks)) return data;

  const isPaxRow = row =>
    String(row?.sharing_mode || '').startsWith('pax') ||
    row?.flight_no === 'PAX' ||
    Number(row?.passengers || 0) > 0;

  const paxTasks = data.tasks.filter(isPaxRow);
  if (!paxTasks.length) return data;

  const parseTime = value => {
    const [h, m] = String(value || '00:00').split(':').map(Number);
    return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
  };
  const getStart = row => Number.isFinite(Number(row.start_mins)) ? Number(row.start_mins) : parseTime(row.start);
  const getEnd = row => Number.isFinite(Number(row.end_mins)) ? Number(row.end_mins) : parseTime(row.end);
  const staffKey = s => typeof s === 'string' ? s : (s?.id || s?.name || JSON.stringify(s));

  function groupRows(rows, asAlert) {
    const groups = new Map();
    rows.forEach(row => {
      const start = getStart(row);
      const hourStart = Math.floor(start / 60) * 60;
      const hourEnd = Math.min(1440, hourStart + 60);
      const skill = row.skill || row.role || row.task || 'Unknown';
      const terminal = row.terminal || 'ALL';
      const key = `${hourStart}|${terminal}|${skill}`;
      if (!groups.has(key)) {
        const base = { ...row };
        base.id = row.id || row.task_id || `PAX_${terminal}_${skill}_${hourStart}`;
        base.task_id = row.task_id || row.id || base.id;
        base.start_mins = hourStart;
        base.end_mins = hourEnd;
        base.start = formatMins(hourStart);
        base.end = formatMins(hourEnd);
        base.time_mins = hourStart;
        base.time_window = `${base.start}-${base.end}`;
        base.sharing_mode = 'pax_hourly';
        base.slot_mins = 60;
        base.assigned = [];
        base.assigned_staff = [];
        groups.set(key, {
          row: base,
          pax: 0,
          rate: 0,
          maxNeeded: 0,
          maxAssigned: 0,
          assigned: new Map(),
          rec: new Set(),
          sourceSlots: 0,
          priority: row.priority || 'High',
        });
      }

      const group = groups.get(key);
      group.pax += Number(row.passengers || 0);
      group.maxNeeded = Math.max(group.maxNeeded, Number(row.staff_needed || 0));
      group.maxAssigned = Math.max(group.maxAssigned, Number(row.assigned_count || 0));
      if (row.priority === 'Critical') group.priority = 'Critical';

      const duration = Math.max(0, getEnd(row) - getStart(row));
      const rawRate = Number(row.pax_rate || 0);
      if (rawRate > 0) {
        const hourlyRate = (Number(row.slot_mins) === 60 || duration >= 60) ? rawRate : rawRate * 4;
        group.rate = Math.max(group.rate, hourlyRate);
      }

      const assigned = asAlert ? (row.assigned_staff || []) : (row.assigned || []);
      assigned.forEach(s => group.assigned.set(staffKey(s), s));
      (row.rec_staff || []).forEach(s => group.rec.add(s));
      group.sourceSlots += Number(row.source_slots || 1);
    });

    return [...groups.values()].map(group => {
      const row = group.row;
      const assignedList = [...group.assigned.values()];
      const assignedCount = assignedList.length || group.maxAssigned;
      const needed = group.rate > 0 ? Math.max(1, Math.ceil(group.pax / group.rate)) : group.maxNeeded;
      const gap = Math.max(0, needed - assignedCount);

      row.passengers = Math.round(group.pax);
      row.pax_rate = group.rate || row.pax_rate || 0;
      row.pax_rate_15m = group.rate ? group.rate / 4 : row.pax_rate_15m;
      row.staff_needed = needed;
      row.staff_capacity = Math.max(needed, Number(row.staff_capacity || 0), Math.ceil(needed * 1.5));
      row.priority = group.priority;
      row.source_slots = group.sourceSlots;
      row.assigned = assignedList;
      row.assigned_staff = assignedList;
      row.assigned_count = assignedCount;
      row.gap = gap;
      row.alert = gap > 0 ? (row.message || `Under-staffed: need ${needed}, assigned ${assignedCount} (gap ${gap})`) : null;
      row.message = row.alert || row.message || '';
      return row;
    });
  }

  const normalized = { ...data };
  const nonPaxTasks = data.tasks.filter(t => !isPaxRow(t));
  normalized.tasks = [...nonPaxTasks, ...groupRows(paxTasks, false)]
    .sort((a, b) => (a.start_mins || 0) - (b.start_mins || 0) || String(a.skill || '').localeCompare(String(b.skill || '')));

  if (Array.isArray(data.alerts)) {
    const paxAlerts = data.alerts.filter(isPaxRow);
    const nonPaxAlerts = data.alerts.filter(a => !isPaxRow(a));
    normalized.alerts = [...nonPaxAlerts, ...groupRows(paxAlerts, true).filter(a => (a.gap || 0) > 0)]
      .sort((a, b) => (a.start_mins || parseTime(a.start)) - (b.start_mins || parseTime(b.start)));
  }

  const kpis = { ...(data.kpis || {}) };
  const total = normalized.tasks.length;
  const covered = normalized.tasks.filter(t => !t.alert).length;
  kpis.tasks_total = total;
  kpis.tasks_covered = covered;
  kpis.demand_windows_total = total;
  kpis.demand_windows_covered = covered;
  kpis.passengers_total = normalized.tasks.reduce((s, t) => s + Number(t.passengers || 0), 0);
  kpis.coverage_pct = total ? Math.round((covered / total) * 1000) / 10 : 100.0;
  normalized.kpis = kpis;
  return normalized;
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
  ID_DATA = normalizePaxDemandToHourly(ID_DATA);
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
      <button class="sub-tab ${ID_ACTIVE_TAB==='staff-timeline'?'active':''}" data-idtab="staff-timeline">👤 Roster Timeline</button>
      <button class="sub-tab ${ID_ACTIVE_TAB==='demand'?'active':''}" data-idtab="demand">PAX Demand</button>
      <button class="sub-tab ${ID_ACTIVE_TAB==='opt'?'active':''}" data-idtab="opt">⚙ Staff Reallocation</button>
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
  const activeTasksCovered = kpis.demand_windows_covered ?? kpis.tasks_covered;
  const activeTasksTotal = kpis.demand_windows_total ?? kpis.tasks_total;
  const activeCoverage = kpis.coverage_pct;

  const grid = document.getElementById('id-kpis');
  const cards = [
    {
      iconHtml: `<div class="kpi-icon-bubble" style="--glow:#3b82f6;background:rgba(59,130,246,0.12);border:1.5px solid rgba(59,130,246,0.35)"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13M22 2L15 22l-4-9-9-4 19-7z"/></svg></div>`,
      label: 'Passenger Volume',
      value: (kpis.passengers_total || 0).toLocaleString(), accent: '#3b82f6'
    },
    {
      iconHtml: `<div class="kpi-icon-bubble" style="--glow:#8b5cf6;background:rgba(139,92,246,0.12);border:1.5px solid rgba(139,92,246,0.35)"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#8b5cf6" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg></div>`,
      label: 'Staff on Duty', value: kpis.staff_on_duty, accent: '#8b5cf6'
    },
    {
      iconHtml: `<div class="kpi-icon-bubble" style="--glow:#ef4444;background:rgba(239,68,68,0.12);border:1.5px solid rgba(239,68,68,0.35)"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg></div>`,
      label: 'Absent', value: kpis.absent, accent: '#ef4444'
    },
    {
      iconHtml: `<div class="kpi-icon-bubble" style="--glow:#0ea5e9;background:rgba(14,165,233,0.12);border:1.5px solid rgba(14,165,233,0.35)"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#0ea5e9" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="3" width="15" height="13" rx="2"/><path d="M16 8h4l3 3v5h-7V8z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg></div>`,
      label: 'Demand Windows', value: activeTasksTotal, accent: '#0ea5e9'
    },
    {
      iconHtml: `<div class="kpi-icon-bubble" style="--glow:#10b981;background:rgba(16,185,129,0.12);border:1.5px solid rgba(16,185,129,0.35)"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>`,
      label: 'PAX Windows Covered', value: `${activeTasksCovered} / ${activeTasksTotal}`, accent: '#10b981'
    },
    {
      iconHtml: `<div class="kpi-icon-bubble" style="--glow:#f97316;background:rgba(249,115,22,0.12);border:1.5px solid rgba(249,115,22,0.35)"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#f97316" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg></div>`,
      label: 'Coverage %', value: activeCoverage + '%', accent: '#f97316'
    },
  ];
  grid.innerHTML = cards.map(c => `
    <div class="kpi-card" style="border-top-color:${c.accent}">
      <div class="kpi-icon">${c.iconHtml}</div>
      <div class="kpi-body">
        <div class="kpi-value">${c.value}</div>
        <div class="kpi-label">${c.label}</div>
      </div>
    </div>`).join('');
}

// ── Alerts ──────────────────────────────────────────────────────
function renderIDAlerts(alerts) {
  // stub — overridden below
}

function showIDSkillBlockDetail(s, blockLabel, date) {
  const overlay = _getIDAlertOverlay();
  const box = document.getElementById('id-alert-detail-box');
  if (!box) return;

  const accent = s.priority === 'Critical' ? '#ef4444' : '#f59e0b';
  const recArr = [...s.recSet];
  const assignedArr = [...s.assignedSet];

  const totalPax = s.allAlerts.reduce((sum, a) => sum + (Number(a.passengers) || 0), 0);
  const avgPaxRate = s.allAlerts.length
    ? (s.allAlerts.reduce((sum, a) => sum + (Number(a.pax_rate) || 0), 0) / s.allAlerts.length).toFixed(1)
    : 0;
  const peakSlot = s.allAlerts.reduce((best, a) =>
    (Number(a.passengers) || 0) > (Number(best.passengers) || 0) ? a : best, s.allAlerts[0] || {});

  const slotRows = s.allAlerts
    .sort((a, b) => (a.start || '').localeCompare(b.start || ''))
    .map(a => {
      const slotPct = a.staff_needed > 0 ? Math.round((a.assigned_count / a.staff_needed) * 100) : 100;
      const pc = a.priority === 'Critical' ? '#ef4444' : '#f59e0b';
      return `
        <div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--border);">
          <span style="font-size:0.72rem;font-weight:700;color:var(--text);min-width:90px">${a.start}–${a.end}</span>
          <div style="flex:1;height:6px;border-radius:3px;background:var(--border);overflow:hidden;">
            <div style="width:${slotPct}%;height:100%;background:#10b981;float:left;"></div>
            <div style="width:${100-slotPct}%;height:100%;background:${pc};float:left;opacity:0.7;"></div>
          </div>
          <span style="font-size:0.7rem;color:var(--muted);min-width:70px;text-align:right">${a.assigned_count}/${a.staff_needed}</span>
          <span style="font-size:0.72rem;font-weight:800;color:${pc};min-width:40px;text-align:right">-${a.gap}</span>
          <span class="badge ${a.priority==='Critical'?'badge-crit':'badge-warn'}" style="font-size:0.6rem;padding:1px 5px">${a.priority}</span>
        </div>`;
    }).join('');

  // Reuse suggestion generator from shortterm.js if available
  const suggestions = (typeof _generateAlertSuggestions === 'function')
    ? _generateAlertSuggestions(s, blockLabel, totalPax, avgPaxRate)
    : [];

  box.innerHTML = `
    <div class="modal-header" style="border-bottom:3px solid ${accent}">
      <div style="flex:1">
        <div class="modal-title">${s.skill} · ${blockLabel} <span style="font-size:0.75rem;opacity:0.7">● Live</span></div>
        <div class="fd-meta" style="margin-top:4px;color:rgba(255,255,255,0.75)">
          ${s.slots} time slot${s.slots>1?'s':''} · Max gap: ${s.gap} · ${s.priority}
        </div>
      </div>
      <button class="fd-close" onclick="closeIDAlertDetail()">✕</button>
    </div>
    <div class="modal-body">
      <div class="staff-detail-kpis">
        <div class="staff-detail-kpi"><div class="staff-detail-kpi-val" style="color:${accent}">${s.gap}</div><div class="staff-detail-kpi-lbl">Max Gap</div></div>
        <div class="staff-detail-kpi"><div class="staff-detail-kpi-val">${s.needed}</div><div class="staff-detail-kpi-lbl">Max Needed</div></div>
        <div class="staff-detail-kpi"><div class="staff-detail-kpi-val">${s.assigned}</div><div class="staff-detail-kpi-lbl">Assigned</div></div>
        <div class="staff-detail-kpi"><div class="staff-detail-kpi-val">${totalPax.toLocaleString()}</div><div class="staff-detail-kpi-lbl">Total PAX</div></div>
      </div>

      <div class="staff-detail-section">
        <div class="staff-detail-section-title">Time Slots — Coverage Breakdown</div>
        ${slotRows || '<div class="muted small">No slot data.</div>'}
      </div>

      <div class="staff-detail-section">
        <div class="staff-detail-section-title">Recommended Staff (${recArr.length})</div>
        ${recArr.length
          ? `<div class="staff-breaks" style="margin-bottom:10px;">
               ${recArr.map(r => `<span class="break-chip">${r}</span>`).join('')}
             </div>
             <button class="btn-primary" style="font-size:0.8rem;padding:6px 16px;"
               onclick="(async()=>{
                 this.disabled=true; this.textContent='Applying…';
                 try {
                   const res = await fetch('/api/intraday/apply-rec',{method:'POST',
                     headers:{'Content-Type':'application/json'},
                     body:JSON.stringify({task_id:'${s.firstAlert.task_id}',
                       staff_ids:${JSON.stringify(recArr.slice(0,5))}})
                   }).then(r=>r.json());
                   if (res.data) { ID_DATA = res.data; }
                   closeIDAlertDetail();
                   renderIntradayPage();
                 } catch(e){ this.disabled=false; this.textContent='Apply Recommendations'; }
               })()">Apply Recommendations</button>`
          : '<div class="muted small">No available staff recommendations.</div>'}
      </div>

      <div class="staff-detail-section">
        <div class="staff-detail-section-title">Currently Assigned Staff (${assignedArr.length})</div>
        ${assignedArr.length
          ? `<div class="staff-breaks">${assignedArr.map(r=>`<span class="break-chip" style="opacity:0.7">${r}</span>`).join('')}</div>`
          : '<div class="muted small">No staff currently assigned.</div>'}
      </div>

      <div class="staff-detail-section">
        <div class="staff-detail-section-title">PAX Load — Slot Breakdown</div>
        ${totalPax > 0 ? `
          <div style="display:flex;gap:10px;margin-bottom:12px;flex-wrap:wrap;">
            <div style="flex:1;min-width:100px;padding:10px;background:var(--surface);border-radius:6px;text-align:center;">
              <div style="font-size:1.2rem;font-weight:800;color:var(--text)">${totalPax.toLocaleString()}</div>
              <div style="font-size:0.7rem;color:var(--muted)">Total PAX</div>
            </div>
            <div style="flex:1;min-width:100px;padding:10px;background:var(--surface);border-radius:6px;text-align:center;">
              <div style="font-size:1.2rem;font-weight:800;color:var(--text)">${avgPaxRate}</div>
              <div style="font-size:0.7rem;color:var(--muted)">Avg PAX/FTE/hour</div>
            </div>
            ${peakSlot.passengers ? `
            <div style="flex:1;min-width:100px;padding:10px;background:var(--surface);border-radius:6px;text-align:center;">
              <div style="font-size:1.2rem;font-weight:800;color:${accent}">${Number(peakSlot.passengers).toLocaleString()}</div>
              <div style="font-size:0.7rem;color:var(--muted)">Peak PAX (${peakSlot.start})</div>
            </div>` : ''}
          </div>
          ${s.allAlerts.sort((a,b)=>(a.start||'').localeCompare(b.start||'')).map(a => {
            const pax = Number(a.passengers) || 0;
            const maxP = Math.max(...s.allAlerts.map(x => Number(x.passengers)||0)) || 1;
            const pct = Math.round((pax / maxP) * 100);
            return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:5px;">
              <span style="font-size:0.7rem;color:var(--muted);min-width:90px">${a.start}–${a.end}</span>
              <div style="flex:1;height:8px;border-radius:4px;background:var(--border);overflow:hidden;">
                <div style="width:${pct}%;height:100%;background:${accent};opacity:0.75;border-radius:4px;"></div>
              </div>
              <span style="font-size:0.7rem;font-weight:700;color:var(--text);min-width:55px;text-align:right">${pax.toLocaleString()} PAX</span>
            </div>`;
          }).join('')}`
        : '<div class="muted small">No PAX data for this skill.</div>'}
      </div>

      ${suggestions.length ? `
      <div class="staff-detail-section">
        <div class="staff-detail-section-title" style="color:#60a5fa;">💡 Suggestions</div>
        <div style="display:flex;flex-direction:column;gap:8px;margin-top:6px;">
          ${suggestions.map(t => `
            <div style="display:flex;gap:10px;align-items:flex-start;padding:10px 12px;
                        background:var(--surface);border-radius:8px;border-left:3px solid #3b82f6;">
              <span style="font-size:1rem;flex-shrink:0;">${t.icon}</span>
              <span style="font-size:0.8rem;color:var(--text);line-height:1.45;">${t.text}</span>
            </div>`).join('')}
        </div>
      </div>` : ''}
    </div>`;

  overlay.classList.remove('hidden');
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

const _idSkillDetailMap = {};

renderIDAlerts = function(alerts) {
  const panel = document.getElementById('id-alerts-panel');
  if (!alerts || !alerts.length) {
    panel.innerHTML = `<div class="alert-panel alert-ok"><span>✅</span> All tasks fully covered — no staffing gaps.</div>`;
    return;
  }

  const timeToMins = t => {
    if (!t) return 0;
    const [h, m] = (t + ':00').split(':').map(Number);
    return h * 60 + (m || 0);
  };

  // Use shared ST_TIME_BLOCKS defined in shortterm.js
  const TIME_BLOCKS = (typeof ST_TIME_BLOCKS !== 'undefined') ? ST_TIME_BLOCKS : [
    {id:'b00_03',label:'00–03',start:0,   end:180},
    {id:'b03_06',label:'03–06',start:180, end:360},
    {id:'b06_09',label:'06–09',start:360, end:540},
    {id:'b09_12',label:'09–12',start:540, end:720},
    {id:'b12_15',label:'12–15',start:720, end:900},
    {id:'b15_18',label:'15–18',start:900, end:1080},
    {id:'b18_21',label:'18–21',start:1080,end:1260},
    {id:'b21_24',label:'21–24',start:1260,end:1440},
  ];
  const blockMap = {};
  TIME_BLOCKS.forEach(b => { blockMap[b.id] = { block: b, alerts: [] }; });
  alerts.forEach(a => {
    const sm = timeToMins(a.start);
    const hit = TIME_BLOCKS.find(b => sm >= b.start && sm < b.end) || TIME_BLOCKS[TIME_BLOCKS.length - 1];
    blockMap[hit.id].alerts.push(a);
  });

  const activeBlocks = TIME_BLOCKS.map(b => blockMap[b.id]).filter(b => b.alerts.length > 0);
  const totalCrit = alerts.filter(a => a.priority === 'Critical').length;
  const totalHigh = alerts.filter(a => a.priority !== 'Critical').length;

  const timelineHtml = TIME_BLOCKS.map(b => {
    const bA = blockMap[b.id].alerts;
    const hasCrit = bA.some(a => a.priority === 'Critical');
    const hasHigh = bA.length > 0;
    const bg = hasCrit ? '#ef4444' : hasHigh ? '#f59e0b' : 'var(--border)';
    const tip = hasCrit ? `${bA.filter(a=>a.priority==='Critical').length} Critical` : hasHigh ? `${bA.length} High` : 'OK';
    return `<div title="${b.label} — ${tip}" style="flex:1;height:8px;border-radius:3px;background:${bg};opacity:${hasHigh||hasCrit?1:0.25};"></div>`;
  }).join('');

  const timelineLabels = TIME_BLOCKS.map((b, i) =>
    i % 2 === 0 ? `<div style="flex:1;font-size:0.6rem;color:var(--muted);text-align:center">${b.label.split('–')[0]}:00</div>` : '<div style="flex:1"></div>'
  ).join('');

  panel.innerHTML = `
    <div class="alerts-container">
      <div class="alerts-header" style="flex-wrap:wrap;gap:8px;">
        <span class="alerts-title">⚠ Live Staffing Alerts &amp; Recommendations</span>
        <span style="display:flex;gap:6px;align-items:center;">
          ${totalCrit ? `<span class="badge badge-crit">${totalCrit} Critical</span>` : ''}
          ${totalHigh ? `<span class="badge badge-warn">${totalHigh} High</span>` : ''}
          <span style="font-size:0.72rem;color:var(--muted)">${activeBlocks.length}/8 blocks · ${alerts.length} gaps</span>
        </span>
      </div>
      <div style="margin:10px 0 4px;display:flex;gap:3px;">${timelineHtml}</div>
      <div style="display:flex;gap:3px;margin-bottom:12px;">${timelineLabels}</div>
      <div id="id-alerts-blocks" style="display:flex;flex-direction:row;gap:10px;width:100%;"></div>
    </div>`;

  const blocksEl = document.getElementById('id-alerts-blocks');
  const date = ID_DATA?.date || '';

  activeBlocks.forEach(({ block, alerts: bAlerts }) => {
    const bCrit = bAlerts.filter(a => a.priority === 'Critical');
    const bHigh = bAlerts.filter(a => a.priority !== 'Critical');
    const hasCrit = bCrit.length > 0;
    const accent = hasCrit ? '#ef4444' : '#f59e0b';

    const skillMap = {};
    bAlerts.forEach(a => {
      const sk = a.skill || a.task || 'Unknown';
      if (!skillMap[sk]) {
        skillMap[sk] = { skill: sk, needed: 0, assigned: 0, gap: 0,
                         slots: 0, priority: 'High', recSet: new Set(),
                         assignedSet: new Set(), firstAlert: a, allAlerts: [] };
      }
      const e = skillMap[sk];
      e.gap = Math.max(e.gap, a.gap || 0);
      e.needed = Math.max(e.needed, a.staff_needed || 0);
      e.assigned = Math.max(e.assigned, a.assigned_count || 0);
      e.slots++;
      if (a.priority === 'Critical') e.priority = 'Critical';
      (a.rec_staff || []).forEach(s => e.recSet.add(s));
      (a.assigned_staff || []).forEach(s => e.assignedSet.add(s));
      e.allAlerts.push(a);
    });

    const skills = Object.values(skillMap).sort((a, b) => b.gap - a.gap);

    const skillRows = skills.map((s, si) => {
      const c = s.priority === 'Critical' ? '#ef4444' : '#f59e0b';
      const barPct = s.needed > 0 ? Math.round((s.assigned / s.needed) * 100) : 100;
      const gapPct = 100 - barPct;
      const detailKey = `id_${block.id}__${si}`;
      _idSkillDetailMap[detailKey] = { skill: s, blockLabel: block.label };
      return `
        <div class="id-skill-row" data-detail-key="${detailKey}"
          style="margin-bottom:8px;padding:7px 9px;background:var(--surface);border-radius:6px;
                 border-left:3px solid ${c};cursor:pointer;transition:opacity .15s;"
          onmouseenter="this.style.opacity='0.8'" onmouseleave="this.style.opacity='1'">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;gap:4px;">
            <span style="font-size:0.75rem;font-weight:700;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:65%">${s.skill}</span>
            <div style="display:flex;gap:4px;align-items:center;flex-shrink:0;">
              <span style="font-size:0.62rem;color:var(--muted)">${s.slots}s</span>
              <span style="font-size:0.68rem;font-weight:800;color:${c}">-${s.gap}</span>
            </div>
          </div>
          <div style="height:5px;border-radius:3px;background:var(--border);overflow:hidden;margin-bottom:5px;">
            <div style="width:${barPct}%;height:100%;background:#10b981;float:left;"></div>
            <div style="width:${gapPct}%;height:100%;background:${c};float:left;opacity:0.7;"></div>
          </div>
          <div style="font-size:0.62rem;color:var(--muted);">
            ${s.assigned}/${s.needed} · ${s.recSet.size ? s.recSet.size+' rec' : 'no rec'} ▶
          </div>
        </div>`;
    }).join('');

    const card = document.createElement('div');
    card.style.cssText = `flex:1 1 0;min-width:0;border:1px solid ${accent}35;border-top:3px solid ${accent};border-radius:8px;padding:12px;background:${accent}06;overflow:hidden;`;
    card.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:4px;">
        <div style="font-weight:800;font-size:0.78rem;color:var(--text);white-space:nowrap;">${block.label}</div>
        <div style="display:flex;gap:3px;align-items:center;flex-shrink:0;">
          ${bCrit.length ? `<span class="badge badge-crit" style="font-size:0.58rem;padding:1px 4px">${bCrit.length}C</span>` : ''}
          ${bHigh.length ? `<span class="badge badge-warn" style="font-size:0.58rem;padding:1px 4px">${bHigh.length}H</span>` : ''}
        </div>
      </div>
      ${skillRows}`;

    blocksEl.appendChild(card);
  });

  // Wire skill-row clicks → detail modal
  blocksEl.querySelectorAll('.id-skill-row').forEach(row => {
    row.addEventListener('click', () => {
      const entry = _idSkillDetailMap[row.dataset.detailKey];
      if (entry) showIDSkillBlockDetail(entry.skill, entry.blockLabel, date);
    });
  });
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

  if (ID_ACTIVE_TAB === 'staff-timeline') {
    const shiftOptions = [...new Set((ID_DATA.staff || []).map(s => s.shift).filter(Boolean))].sort()
      .map(sh => {
        const samp = (ID_DATA.staff || []).find(s => s.shift === sh);
        const lbl = samp?.shift_label || sh;
        return `<option value="${sh}">${lbl}</option>`;
      }).join('');
    container.innerHTML = `
      <div class="panel mt-16">
        <div class="panel-title-row">
          <span class="panel-title">Operational Roster Timeline — ${ID_DATA.date_label}</span>
          <div class="filter-row" style="flex-wrap:wrap;gap:6px">
            <input class="search-input" id="id-staff-timeline-search" placeholder="Search staff ID / skill…" style="width:180px" />
            <select id="id-staff-timeline-shift" class="select-input">
              <option value="">All Shifts</option>
              ${shiftOptions}
            </select>
          </div>
        </div>
        <div id="id-staff-timeline" style="margin-top:16px;overflow-x:auto;"></div>
      </div>`;
    const doRefresh = () => {
      const q = document.getElementById('id-staff-timeline-search').value.toLowerCase();
      const sf = document.getElementById('id-staff-timeline-shift').value;
      const filtered = (ID_DATA.staff || []).filter(s => {
        const mq = !q || s.id.toLowerCase().includes(q) || (s.skill1||'').toLowerCase().includes(q);
        const ms = !sf || (s.shift||'').toLowerCase() === sf.toLowerCase();
        return mq && ms;
      });
      const el = document.getElementById('id-staff-timeline');
      if (el) renderID3HrBlocksTable(el, filtered);
    };
    document.getElementById('id-staff-timeline-search').addEventListener('input', doRefresh);
    document.getElementById('id-staff-timeline-shift').addEventListener('change', doRefresh);
    doRefresh();
  } else if (ID_ACTIVE_TAB === 'opt') {
    renderIDOptimization(container);

  } else {
    renderIDDemandTab(container);
  }
}

const _idReallocLog = [];   // persists across full tab re-renders
let _idReallocSelection = { skill: null, terminal: null, block: null, taskId: null };

function renderIDDemandTab(container) {
  const tasks = ID_DATA.tasks || [];

  // ── Aggregate metrics ──────────────────────────────────────────
  const totalPax      = tasks.reduce((s, t) => s + (Number(t.passengers) || 0), 0);
  const coveredCnt    = tasks.filter(t => !t.alert).length;
  const gapCnt        = tasks.filter(t =>  t.alert).length;
  const coveragePct   = tasks.length ? Math.round((coveredCnt / tasks.length) * 100) : 100;
  const peakTask      = tasks.reduce((best, t) => (Number(t.passengers)||0) > (Number(best.passengers)||0) ? t : best, tasks[0] || {});
  const totalAssigned = tasks.reduce((s, t) => s + (t.assigned||[]).length, 0);
  const avgPaxPerFte  = totalAssigned > 0 ? Math.round(totalPax / totalAssigned) : 0;
  const uncoveredPax  = tasks.filter(t => t.alert).reduce((s, t) => s + (Number(t.passengers)||0), 0);

  // Skills present (deduplicated)
  const allSkills   = [...new Set(tasks.map(t => t.skill || t.role || t.task || 'Unknown').filter(Boolean))].sort();

  // TIME_BLOCKS shared with shortterm.js
  let TIME_BLOCKS = (typeof ST_TIME_BLOCKS !== 'undefined') ? ST_TIME_BLOCKS : [
    {id:'b00_03',label:'00–03',start:0,end:180},{id:'b03_06',label:'03–06',start:180,end:360},
    {id:'b06_09',label:'06–09',start:360,end:540},{id:'b09_12',label:'09–12',start:540,end:720},
    {id:'b12_15',label:'12–15',start:720,end:900},{id:'b15_18',label:'15–18',start:900,end:1080},
    {id:'b18_21',label:'18–21',start:1080,end:1260},{id:'b21_24',label:'21–24',start:1260,end:1440},
  ];

  // ── Shared FTE calculator for a set of tasks in one block ─────────────────
  // req  = peak PAX-driven concurrent demand at the busiest hourly slot
  //        (sum of staff_needed across all skill/terminal combos active that hour)
  // asgn = unique staff deployed in this block — backend already enforces
  //        skill-match + shift-overlap before adding any ID to t.assigned
  function _calcBlockFte(bt) {
    const slotReq = {};
    bt.forEach(t => {
      const k = t.start_mins || 0;
      slotReq[k] = (slotReq[k] || 0) + (t.staff_needed || 0);
    });
    const req  = Object.values(slotReq).length ? Math.max(...Object.values(slotReq)) : 0;
    const asgn = new Set(bt.flatMap(t => (t.assigned || []).filter(Boolean))).size;
    return { req, asgn };
  }

  // Per-block aggregate
  function blockStats(filteredTasks) {
    return TIME_BLOCKS.map(b => {
      const bt  = filteredTasks.filter(t => (t.start_mins||0) >= b.start && (t.start_mins||0) < b.end);
      const pax = bt.reduce((s,t)=>s+(Number(t.passengers)||0),0);
      const { req, asgn } = _calcBlockFte(bt);
      const gaps = bt.filter(t=>t.alert).length;
      return { block: b, count: bt.length, pax, req, asgn, gaps };
    }).filter(b => b.count > 0);
  }

  // Per-skill aggregate
  const skillStats = allSkills.map(sk => {
    const st = tasks.filter(t => (t.skill||t.role||t.task) === sk);
    const pax  = st.reduce((s,t)=>s+(Number(t.passengers)||0),0);
    const req  = st.reduce((s,t)=>s+(t.staff_needed||0),0);
    const asgn = st.reduce((s,t)=>s+(t.assigned||[]).length,0);
    const gaps = st.filter(t=>t.alert).length;
    const cov  = st.length ? Math.round(((st.length-gaps)/st.length)*100) : 100;
    return { skill: sk, pax, req, asgn, gaps, cov, count: st.length };
  });

  const covColor = coveragePct >= 90 ? '#10b981' : coveragePct >= 70 ? '#f59e0b' : '#ef4444';

  container.innerHTML = `
    <div class="panel mt-16" style="padding:0;">

      <!-- ── Header ── -->
      <div style="padding:14px 18px 10px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
        <div>
          <div style="font-weight:800;font-size:1rem;color:var(--text)">PAX Demand Coverage</div>
          <div style="font-size:0.75rem;color:var(--muted)">${ID_DATA.date_label}</div>
        </div>
        <input class="search-input" id="id-demand-search" placeholder="Search skill / terminal…" style="width:200px;font-size:0.8rem"/>
      </div>

      <!-- ── KPI strip ── -->
      <div style="display:flex;gap:0;border-bottom:1px solid var(--border);">
        ${[
          { label:'Total PAX',      val: totalPax.toLocaleString(),     color:'#3b82f6', icon:'👥' },
          { label:'Covered',        val: `${coveredCnt}/${tasks.length}`, color:'#10b981', icon:'✅' },
          { label:'Avg PAX / FTE',  val: avgPaxPerFte > 0 ? avgPaxPerFte.toLocaleString() : '—', color:'#a78bfa', icon:'📈' },
          { label:'Uncovered PAX',  val: uncoveredPax > 0 ? uncoveredPax.toLocaleString() : '0', color: uncoveredPax>0?'#ef4444':'#10b981', icon:'🚨' },
          { label:'Peak Demand',    val: peakTask.start || '—',         color:'#f59e0b', icon:'⏰' },
        ].map(k => `
          <div style="flex:1;padding:12px 14px;border-right:1px solid var(--border);text-align:center;min-width:80px;">
            <div style="font-size:1rem;margin-bottom:2px">${k.icon}</div>
            <div style="font-size:1.1rem;font-weight:800;color:${k.color}">${k.val}</div>
            <div style="font-size:0.65rem;color:var(--muted);text-transform:uppercase;letter-spacing:.04em">${k.label}</div>
          </div>`).join('')}
      </div>

      <!-- ── Skill summary cards ── -->
      <div style="padding:12px 16px 8px;border-bottom:1px solid var(--border);">
        <div style="font-size:0.7rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px;">Coverage by Skill — click to filter</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;" id="id-demand-skill-cards">
          <button class="id-skill-filter-btn active" data-skill=""
            style="padding:6px 12px;border-radius:20px;border:1px solid var(--accent);background:var(--accent)15;
                   font-size:0.75rem;font-weight:700;color:var(--accent);cursor:pointer;">All Skills</button>
          ${skillStats.map(ss => {
            const c = (ID_SKILL_COLOR||{})[ss.skill] || '#888';
            const barW = Math.round(ss.cov);
            const bc = ss.cov >= 90 ? '#10b981' : ss.cov >= 70 ? '#f59e0b' : '#ef4444';
            return `
              <button class="id-skill-filter-btn" data-skill="${ss.skill}"
                style="padding:6px 12px 6px 10px;border-radius:20px;border:1px solid ${c}40;
                       background:${c}12;font-size:0.75rem;cursor:pointer;display:flex;align-items:center;gap:6px;min-width:130px;">
                <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${c};flex-shrink:0"></span>
                <span style="font-weight:700;color:${c}">${ss.skill}</span>
                <span style="margin-left:auto;font-size:0.68rem;font-weight:800;color:${bc}">${ss.cov}%</span>
              </button>`;
          }).join('')}
        </div>
      </div>

      <!-- ── Time-block summary row ── -->
      <div style="padding:10px 16px 8px;border-bottom:1px solid var(--border);">
        <div style="font-size:0.7rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px;">3-Hour Block Overview</div>
        <div style="display:flex;gap:6px;width:100%;" id="id-demand-blocks"></div>
      </div>

      <!-- ── Detail table (fixed height, internal scroll) ── -->
      <div style="padding:10px 16px 14px;">
        <div style="font-size:0.7rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px;">
          Slot Detail — <span id="id-demand-table-label">All Skills</span>
        </div>
        <div style="max-height:320px;overflow-y:auto;border-radius:8px;border:1px solid var(--border);">
          <table style="width:100%;border-collapse:collapse;font-size:0.78rem;">
            <thead style="position:sticky;top:0;background:var(--surface-2,var(--surface));z-index:1;">
              <tr style="border-bottom:2px solid var(--border);">
                <th style="padding:8px 10px;text-align:left;font-size:0.7rem;color:var(--muted);font-weight:700;white-space:nowrap">TIME</th>
                <th style="padding:8px 6px;text-align:left;font-size:0.7rem;color:var(--muted);font-weight:700">TERMINAL</th>
                <th style="padding:8px 6px;text-align:left;font-size:0.7rem;color:var(--muted);font-weight:700">SKILL</th>
                <th style="padding:8px 6px;text-align:left;font-size:0.7rem;color:var(--muted);font-weight:700">STAFF</th>
                <th style="padding:8px 6px;text-align:right;font-size:0.7rem;color:var(--muted);font-weight:700">PAX</th>
                <th style="padding:8px 6px;text-align:center;font-size:0.7rem;color:var(--muted);font-weight:700">FTE REQ</th>
                <th style="padding:8px 6px;text-align:center;font-size:0.7rem;color:var(--muted);font-weight:700">ASSIGNED</th>
                <th style="padding:8px 6px;text-align:center;font-size:0.7rem;color:var(--muted);font-weight:700">COVERAGE</th>
                <th style="padding:8px 6px;text-align:center;font-size:0.7rem;color:var(--muted);font-weight:700">STATUS</th>
              </tr>
            </thead>
            <tbody id="id-demand-tbody"></tbody>
          </table>
        </div>
      </div>

    </div>`;

  // ── Render block overview ──────────────────────────────────────
  function renderBlocks(filteredTasks) {
    const blocksEl = document.getElementById('id-demand-blocks');
    if (!blocksEl) return;
    const stats = blockStats(filteredTasks);
    if (!stats.length) { blocksEl.innerHTML = '<div class="muted small">No demand in this period.</div>'; return; }
    blocksEl.innerHTML = stats.map(bs => {
      const bc = bs.gaps === 0 ? '#10b981' : bs.gaps > 3 ? '#ef4444' : '#f59e0b';
      const cov = bs.count ? Math.round(((bs.count - bs.gaps)/bs.count)*100) : 100;
      return `
        <div style="flex:1 1 0;min-width:0;padding:8px 10px;border-radius:8px;border:1px solid ${bc}40;
                    border-top:3px solid ${bc};background:${bc}0d;text-align:center;overflow:hidden;">
          <div style="font-size:0.72rem;font-weight:800;color:var(--text);margin-bottom:4px">${bs.block.label}</div>
          <div style="font-size:1rem;font-weight:800;color:${bc}">${cov}%</div>
          <div style="height:4px;border-radius:2px;background:var(--border);overflow:hidden;margin:4px 0;">
            <div style="width:${cov}%;height:100%;background:${bc};border-radius:2px;"></div>
          </div>
          <div style="font-size:0.62rem;color:var(--muted)">${bs.pax.toLocaleString()} PAX</div>
          ${bs.gaps ? `<div style="font-size:0.6rem;color:#ef4444;font-weight:700;margin-top:2px">${bs.gaps} gaps</div>` : ''}
        </div>`;
    }).join('');
  }

  // ── Render detail table (grouped by 3-hr block, expandable to hourly slots) ─
  const expandedBlocks = new Set();
  function renderTable(filteredTasks) {
    const tbody = document.getElementById('id-demand-tbody');
    if (!tbody) return;

    const TBL = (typeof ST_TIME_BLOCKS !== 'undefined') ? ST_TIME_BLOCKS : [
      {id:'b00_03',label:'00–03',start:0,end:180},{id:'b03_06',label:'03–06',start:180,end:360},
      {id:'b06_09',label:'06–09',start:360,end:540},{id:'b09_12',label:'09–12',start:540,end:720},
      {id:'b12_15',label:'12–15',start:720,end:900},{id:'b15_18',label:'15–18',start:900,end:1080},
      {id:'b18_21',label:'18–21',start:1080,end:1260},{id:'b21_24',label:'21–24',start:1260,end:1440},
    ];
    const groups = TBL.map(b => ({
      block: b,
      tasks: filteredTasks.filter(t => (t.start_mins||0) >= b.start && (t.start_mins||0) < b.end)
    })).filter(g => g.tasks.length > 0);

    if (!groups.length) {
      tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:24px;color:var(--muted);font-size:0.82rem;">No demand windows match your filter.</td></tr>`;
      return;
    }

    const SCOL = ID_SKILL_COLOR || {};

    function staffNames(assigned) {
      return (assigned || []).map(s =>
        typeof s === 'string' ? s : (s.name || s.employee_name || s.EMPLOYEE_NAME || s['EMPLOYEE NAME'] || '')
      ).filter(Boolean);
    }

    function buildRows() {
      return groups.map(g => {
        const bt        = g.tasks;
        const totalPaxB = bt.reduce((s,t)=>s+(Number(t.passengers)||0),0);
        const { req: totalReq, asgn: totalAsgn } = _calcBlockFte(bt);
        const gaps      = bt.filter(t=>t.alert).length;
        const cov       = bt.length ? Math.round(((bt.length-gaps)/bt.length)*100) : 100;
        const bc        = gaps === 0 ? '#10b981' : gaps > 3 ? '#ef4444' : '#f59e0b';
        const isOpen    = expandedBlocks.has(g.block.id);
        const arrow     = `<span style="display:inline-block;transition:transform .2s;transform:${isOpen?'rotate(90deg)':'rotate(0)'};margin-right:6px;font-size:0.7rem">▶</span>`;

        const header = `<tr class="id-blk-hdr" data-blk="${g.block.id}"
            style="cursor:pointer;background:${bc}14;border-bottom:1px solid ${bc}28;">
          <td style="padding:9px 10px;font-weight:800;color:${bc};white-space:nowrap;font-size:0.8rem">
            ${arrow}${g.block.label}
          </td>
          <td style="padding:9px 6px;font-size:0.72rem;color:var(--muted)">—</td>
          <td style="padding:9px 6px;font-size:0.72rem;color:var(--muted)">All skills</td>
          <td style="padding:9px 6px;font-size:0.72rem;color:var(--muted)">—</td>
          <td style="padding:9px 6px;text-align:right;font-weight:700;color:var(--text);font-size:0.8rem">${totalPaxB.toLocaleString()}</td>
          <td style="padding:9px 6px;text-align:center;color:var(--muted);font-size:0.75rem">${totalReq}</td>
          <td style="padding:9px 6px;text-align:center;font-weight:800;color:${bc};font-size:0.8rem">${totalAsgn}</td>
          <td style="padding:9px 10px;min-width:90px;">
            <div style="display:flex;align-items:center;gap:5px;">
              <div style="flex:1;height:5px;border-radius:3px;background:var(--border);overflow:hidden;">
                <div style="width:${cov}%;height:100%;background:${bc};border-radius:3px"></div>
              </div>
              <span style="font-size:0.65rem;font-weight:800;color:${bc};min-width:28px">${cov}%</span>
            </div>
          </td>
          <td style="padding:9px 6px;text-align:center;">
            <span style="font-size:0.65rem;padding:2px 8px;border-radius:10px;font-weight:700;
              background:${gaps>0?'#ef444420':'#10b98120'};color:${gaps>0?'#ef4444':'#10b981'}">
              ${gaps>0?gaps+' gap'+(gaps>1?'s':''):'OK'}
            </span>
          </td>
        </tr>`;

        if (!isOpen) return header;

        const slotRows = [...bt]
          .sort((a,b)=>(a.start_mins||0)-(b.start_mins||0)||(a.skill||'').localeCompare(b.skill||''))
          .map(t => {
            const sk       = t.skill||t.role||t.task||'—';
            const skColor  = SCOL[sk] || '#888';
            const names    = staffNames(t.assigned);
            const asgn     = names.length || (t.assigned||[]).length;
            const req      = t.staff_needed || 0;
            const ok       = !t.alert;
            const covPct   = req > 0 ? Math.min(100,Math.round((asgn/req)*100)) : 100;
            const cc       = covPct >= 100 ? '#10b981' : covPct >= 70 ? '#f59e0b' : '#ef4444';
            const pax      = Number(t.passengers||0);
            const staffHtml = names.length
              ? names.map(n=>`<span style="font-size:0.6rem;padding:1px 5px;border-radius:6px;background:var(--border);color:var(--text);white-space:nowrap;display:inline-block">${n}</span>`).join(' ')
              : `<span style="color:var(--muted);font-size:0.68rem">—</span>`;
            return `<tr style="border-bottom:1px solid var(--border);background:${ok?'transparent':'#ef444406'}">
              <td style="padding:5px 10px 5px 30px;font-size:0.7rem;white-space:nowrap;color:var(--muted)">↳ ${t.start}–${t.end}</td>
              <td style="padding:5px 6px"><span style="font-size:0.62rem;padding:1px 5px;border-radius:8px;background:#7c3aed22;color:#7c3aed;font-weight:700">${t.terminal||'ALL'}</span></td>
              <td style="padding:5px 6px"><span style="font-size:0.72rem;font-weight:700;color:${skColor}">${sk}</span></td>
              <td style="padding:5px 6px;max-width:200px"><div style="display:flex;flex-wrap:wrap;gap:2px">${staffHtml}</div></td>
              <td style="padding:5px 6px;text-align:right;font-size:0.72rem;color:var(--text)">${pax>0?pax.toLocaleString():'—'}</td>
              <td style="padding:5px 6px;text-align:center;font-size:0.72rem;color:var(--muted)">${req}</td>
              <td style="padding:5px 6px;text-align:center;font-size:0.72rem;font-weight:700;color:${cc}">${asgn}</td>
              <td style="padding:5px 10px;min-width:90px;">
                <div style="display:flex;align-items:center;gap:5px;">
                  <div style="flex:1;height:4px;border-radius:2px;background:var(--border);overflow:hidden;">
                    <div style="width:${covPct}%;height:100%;background:${cc};border-radius:2px"></div>
                  </div>
                  <span style="font-size:0.62rem;font-weight:700;color:${cc};min-width:28px">${covPct}%</span>
                </div>
              </td>
              <td style="padding:5px 6px;text-align:center;">
                <span style="font-size:0.62rem;padding:2px 6px;border-radius:8px;font-weight:700;
                  background:${ok?'#10b98120':'#ef444420'};color:${ok?'#10b981':'#ef4444'}">
                  ${ok?'Covered':'Gap'}
                </span>
              </td>
            </tr>`;
          }).join('');

        return header + slotRows;
      }).join('');
    }

    function paint() {
      tbody.innerHTML = buildRows();
      tbody.querySelectorAll('.id-blk-hdr').forEach(row => {
        row.addEventListener('click', () => {
          const bid = row.dataset.blk;
          if (expandedBlocks.has(bid)) expandedBlocks.delete(bid);
          else expandedBlocks.add(bid);
          paint();
        });
      });
    }

    paint();
  }

  // ── Active filter state ────────────────────────────────────────
  let activeSkill = '';
  let searchQ = '';

  function applyFilters() {
    let filtered = tasks;
    if (activeSkill) filtered = filtered.filter(t => (t.skill||t.role||t.task) === activeSkill);
    if (searchQ)     filtered = filtered.filter(t =>
      (t.skill||t.role||t.task||'').toLowerCase().includes(searchQ) ||
      (t.terminal||'').toLowerCase().includes(searchQ));
    renderBlocks(filtered);
    renderTable(filtered);
    const lbl = document.getElementById('id-demand-table-label');
    if (lbl) lbl.textContent = activeSkill || 'All Skills';
  }

  // Skill filter buttons
  container.querySelectorAll('.id-skill-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.id-skill-filter-btn').forEach(b => {
        b.style.border = `1px solid ${(ID_SKILL_COLOR||{})[b.dataset.skill]||'var(--border)'}40`;
        b.style.fontWeight = '600';
        b.style.opacity = '0.7';
        b.classList.remove('active');
      });
      btn.style.border = `2px solid ${(ID_SKILL_COLOR||{})[btn.dataset.skill]||'var(--accent)'}`;
      btn.style.fontWeight = '800';
      btn.style.opacity = '1';
      btn.classList.add('active');
      activeSkill = btn.dataset.skill;
      applyFilters();
    });
  });

  // Search
  document.getElementById('id-demand-search').addEventListener('input', e => {
    searchQ = e.target.value.toLowerCase();
    applyFilters();
  });

  applyFilters();
}

// ── Reallocation helpers (shared with renderIDOptimization) ──────────────────
const _RL_BLOCKS = (typeof ST_TIME_BLOCKS !== 'undefined') ? ST_TIME_BLOCKS : [
  {id:'b00_03',label:'00–03',start:0,end:180},{id:'b03_06',label:'03–06',start:180,end:360},
  {id:'b06_09',label:'06–09',start:360,end:540},{id:'b09_12',label:'09–12',start:540,end:720},
  {id:'b12_15',label:'12–15',start:720,end:900},{id:'b15_18',label:'15–18',start:900,end:1080},
  {id:'b18_21',label:'18–21',start:1080,end:1260},{id:'b21_24',label:'21–24',start:1260,end:1440},
];
const _RL_HOUR_BLOCKS = Array.from({ length: 24 }, (_, h) => ({
  id: `h${String(h).padStart(2, '0')}`,
  label: `${String(h).padStart(2, '0')}:00`,
  start: h * 60,
  end: (h + 1) * 60,
}));


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
  'Checkin', 'Security', 'CBP', 'Lounge', 'Boarding', 'Immigration', 'Baggage',
  'GNIB', 'Mezz Operation', 'CBP Pre-clearance', 'Gate 335',
  'Bussing', 'Arr Customer Service', 'Transfer Corridor',
  'Check-in/Trolleys', 'T1/T2 Trolleys L/UL', 'Dep/Trolleys',
  'PBZ', 'Departures', 'Litter Picking'
];
// Default: show only PAX-derived skills in the coverage heatmap. User can toggle.
let ID_COVERAGE_PAX_ONLY = true;
const ID_COVERAGE_HOUR_START = 4;
const ID_COVERAGE_HOUR_END   = 23;

function buildCoverageData(tasks) {
  const hours = [];
  for (let h = ID_COVERAGE_HOUR_START; h <= ID_COVERAGE_HOUR_END; h++) hours.push(h);

  // Build dynamic skills list: either only the PAX skills (if toggled), or
  // merge base coverage skills with any PAX skills provided by the server.
  const baseSkills = Array.isArray(ID_COVERAGE_SKILLS) ? ID_COVERAGE_SKILLS.slice() : [];
  const paxSkills = Array.isArray(ID_DATA?.pax_coverage_skills) ? ID_DATA.pax_coverage_skills : [];
  let skills;
  if (ID_COVERAGE_PAX_ONLY && paxSkills.length) {
    skills = paxSkills.slice();
  } else {
    skills = [...new Set([...baseSkills, ...paxSkills])];
  }

  const data = {};
  skills.forEach(sk => {
    data[sk] = {};
    hours.forEach(h => { data[sk][h] = { req: 0, assigned: 0 }; });
  });

  (tasks || []).forEach(task => {
    let sk = task.role || task.task || task.skill || 'GNIB';
    if (!data[sk]) {
      // Fallback: extract base task name from "Task -- Terminal Dir" labels
      const base = sk.split(' -- ')[0];
      if (data[base]) sk = base;
      else if (!data[sk]) return;
    }
    const startH = Math.floor(task.start_mins / 60);
    const endH   = Math.floor((task.end_mins - 1) / 60);
    for (let h = Math.max(ID_COVERAGE_HOUR_START, startH); h <= Math.min(ID_COVERAGE_HOUR_END, endH); h++) {
      data[sk][h].req      += (task.staff_needed || 0);
      data[sk][h].assigned += (task.assigned ? task.assigned.length : 0);
    }
  });

  return { data, hours, skills };
}

function buildCoverageTableHTML(tasks) {
  const { data, hours, skills } = buildCoverageData(tasks);
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

  const bodyRows = skills.map(sk =>
    `<tr><td class="skill-label">${sk}</td>${hours.map(h => {
      const { req, assigned } = data[sk][h];
      const nowCls = h === nowH ? 'is-today' : '';
      if (req === 0) return `<td class="${nowCls}" style="opacity:0.3;">0/0</td>`;
      const tip = `Role: ${sk}\nHour: ${String(h).padStart(2,'0')}:00\nRequired: ${req}\nAssigned: ${assigned}`;
      return `<td class="${cellClass(req, assigned)} ${nowCls}" title="${tip}">${assigned}/${req}</td>`;
    }).join('')}</tr>`
  ).join('');

  const totalsReq      = hours.map(h => skills.reduce((s, sk) => s + data[sk][h].req,      0));
  const totalsAssigned = hours.map(h => skills.reduce((s, sk) => s + data[sk][h].assigned, 0));

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
        <th class="skill-col">PAX Work</th>${headCols}
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
        <div style="float:right;margin-left:12px">
          <label style="font-size:0.85rem;opacity:0.9"><input id="id-coverage-pax-only" type="checkbox" checked style="margin-right:6px">PAX only</label>
        </div>
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
    // Wire up PAX-only toggle
    setTimeout(() => {
      const paxToggle = document.getElementById('id-coverage-pax-only');
      if (paxToggle) {
        paxToggle.checked = !!ID_COVERAGE_PAX_ONLY;
        paxToggle.addEventListener('change', (e) => {
          ID_COVERAGE_PAX_ONLY = !!e.target.checked;
          const table = document.getElementById('id-hourly-heatmap');
          if (table) table.innerHTML = buildCoverageTableHTML(ID_DATA.tasks || []);
        });
      }
    }, 50);
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
// renderIDAlerts and window.initIntraday defined below
window.applyDelay = applyDelay;
window.applyCustomDelay = applyCustomDelay;
window.cancelFlight = cancelFlight;
window.showManageModal = showManageModal;
window.showManageModalForTask = showManageModalForTask;
window.closeManageModal = closeManageModal;
window.toggleStaffAssignment = toggleStaffAssignment;
window.unassignStaff = unassignStaff;


// ── Optimization Tab — Live Staff Reallocation ───────────────────
async function renderIDOptimization(container) {
  ID_DATA = normalizePaxDemandToHourly(ID_DATA);
  const SKILL_COLORS = (typeof ID_SKILL_COLOR !== 'undefined' && ID_SKILL_COLOR) ? ID_SKILL_COLOR : {
    'GNIB':'#3498DB','CBP Pre-clearance':'#9B59B6','Bussing':'#E8850A',
    'PBZ':'#2ECC71','Mezz Operation':'#1ABC9C','Litter Picking':'#E74C3C',
    'Gate 335':'#F39C12','Arr Customer Service':'#5DADE2',
    'Check-in/Trolleys':'#A9CCE3','Transfer Corridor':'#27AE60',
    'Dep/Trolleys':'#8E44AD','T1/T2 Trolleys L/UL':'#E91E63',
    'Departures':'#F1C40F'
  };

  if (!ID_DATA) {
    container.innerHTML = `<div class="panel mt-20"><div class="loading-spinner"><div class="spinner"></div><span>Loading data…</span></div></div>`;
    return;
  }

  const tasks    = ID_DATA.tasks  || [];
  const allStaff = ID_DATA.staff  || [];
  const staffById = {};
  allStaff.forEach(s => {
    const sid = String(s.id || s['EMPLOYEE NUMBER'] || '');
    if (sid) staffById[sid] = s;
  });

  // ── Data helpers ─────────────────────────────────────────────────
  function _skillColor(sk) {
    return SKILL_COLORS[sk] || '#6c757d';
  }

  function _staffName(id) {
    const s = staffById[String(id)] || {};
    return s.name || s['STAFF NAME'] || String(id);
  }

  function buildMatrixData() {
    // matrix[rowKey][blockId] = {req, asgn, gap, pct, skill, terminal, terms:Set, tasks:[]}
    // rowKey = skill + '||' + terminal  (one row per skill × terminal combination)
    const matrix = {};
    tasks.forEach(t => {
      const sk   = t.skill || t.skill1 || 'Unknown';
      const term = t.terminal || 'ALL';
      const rowKey = sk + '||' + term;
      const bId  = _blockForMins(t.start_mins || 0);
      if (!matrix[rowKey]) matrix[rowKey] = {};
      if (!matrix[rowKey][bId]) matrix[rowKey][bId] = {
        req:0, _slotReq:{}, _staffSet:new Set(),
        skill:sk, terminal:term, terms:new Set(), tasks:[]
      };
      const cell = matrix[rowKey][bId];
      cell.tasks.push(t);
      const sm = t.start_mins || 0;
      cell._slotReq[sm] = (cell._slotReq[sm] || 0) + (t.staff_needed || 0);
      (t.assigned || []).filter(Boolean).forEach(id => cell._staffSet.add(String(id)));
      cell.terms.add(term);
    });
    // Finalise req/asgn/gap/pct
    Object.values(matrix).forEach(byBlock => {
      Object.values(byBlock).forEach(cell => {
        const vals = Object.values(cell._slotReq);
        cell.req  = vals.length ? Math.max(...vals) : 0;
        cell.asgn = cell._staffSet.size;
        cell.gap  = Math.max(0, cell.req - cell.asgn);
        cell.pct  = cell.req > 0 ? Math.round((cell.asgn / cell.req) * 100) : 100;
      });
    });
    return matrix;
  }

  function _blockForMins(m) {
    for (const b of _RL_HOUR_BLOCKS) { if (m >= b.start && m < b.end) return b.id; }
    return _RL_HOUR_BLOCKS[_RL_HOUR_BLOCKS.length - 1].id;
  }

  function _cellColor(pct, gap) {
    if (gap === 0 && pct >= 100) return { bg:'#1a3a1a', border:'#2ecc71', text:'#2ecc71' };
    if (pct >= 100)              return { bg:'#1a3a1a', border:'#2ecc71', text:'#2ecc71' };
    if (pct >= 70)               return { bg:'#3a2a00', border:'#f39c12', text:'#f39c12' };
    return                              { bg:'#3a1a1a', border:'#e74c3c', text:'#e74c3c' };
  }

  function buildGapList(matrix) {
    const list = [];
    Object.entries(matrix).forEach(([rowKey, byBlock]) => {
      const [sk, term] = rowKey.split('||');
      Object.entries(byBlock).forEach(([bId, cell]) => {
        if (cell.gap > 0) {
          list.push({ rowKey, skill:sk, terminal:term, blockId:bId, ...cell });
        }
      });
    });
    list.sort((a,b) => a.pct - b.pct || b.gap - a.gap);
    return list;
  }

  function _escAttr(value) {
    return String(value ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function _taskAssignedCount(task) {
    return (task?.assigned || []).filter(Boolean).length;
  }

  function _taskGap(task) {
    return Math.max(0, (task?.staff_needed || 0) - _taskAssignedCount(task));
  }

  function _taskPct(task) {
    const req = task?.staff_needed || 0;
    return req ? Math.round((_taskAssignedCount(task) / req) * 100) : 100;
  }

  function _taskLabel(task) {
    if (!task) return 'Task';
    return task.task || task.skill || task.id || 'Task';
  }

  function _pickTaskForCell(cell, preferredTaskId) {
    const cellTasks = (cell?.tasks || []).slice();
    if (!cellTasks.length) return null;
    const preferred = cellTasks.find(t => String(t.id) === String(preferredTaskId || ''));
    if (preferred) return preferred;
    return cellTasks.sort((a, b) =>
      _taskGap(b) - _taskGap(a) ||
      _taskPct(a) - _taskPct(b) ||
      (a.start_mins || 0) - (b.start_mins || 0)
    )[0];
  }

  function _setSelection(skill, terminal, block, taskId) {
    _selSkill    = skill;
    _selTerminal = terminal;
    _selBlock    = block;
    _selTaskId   = taskId || null;
    _idReallocSelection = { skill, terminal, block, taskId: _selTaskId };
  }

  function _staffSkills(s) {
    return ['skill1', 'skill2', 'skill3', 'skill4']
      .map(k => (s?.[k] || '').trim())
      .filter(Boolean);
  }

  function _staffHasSkill(s, skill) {
    const selected = String(skill || '').trim().toLowerCase();
    return _staffSkills(s).some(sk => sk.toLowerCase() === selected);
  }

  function _fmtInt(value) {
    return Math.round(Number(value || 0)).toLocaleString();
  }

  function _fmtDelta(value) {
    const n = Math.round(Number(value || 0));
    return `${n >= 0 ? '+' : ''}${n.toLocaleString()}`;
  }

  function _deltaColor(value, inverse = false) {
    const n = Number(value || 0);
    if (n === 0) return 'var(--muted)';
    const isGood = inverse ? n < 0 : n > 0;
    return isGood ? 'var(--ok)' : 'var(--crit)';
  }

  function renderOverlayComparisonPanel() {
    const cmp = ID_DATA?.overlay_comparison;
    if (!cmp?.active) return '';

    const before = cmp.before || {};
    const after = cmp.after || {};
    const maxReq = Math.max(Number(before.required || 0), Number(after.required || 0), 1);
    const maxAssigned = Math.max(Number(before.assigned || 0), Number(after.assigned || 0), 1);
    const reqBeforeW = Math.max(4, Math.round((Number(before.required || 0) / maxReq) * 100));
    const reqAfterW = Math.max(4, Math.round((Number(after.required || 0) / maxReq) * 100));
    const asgBeforeW = Math.max(4, Math.round((Number(before.assigned || 0) / maxAssigned) * 100));
    const asgAfterW = Math.max(4, Math.round((Number(after.assigned || 0) / maxAssigned) * 100));
    const skillRows = (cmp.skills || []).slice(0, 8).map(row => {
      const skillColor = _skillColor(row.skill);
      const times = row.times || [];
      const maxSkillReq = Math.max(Number(row.before?.required || 0), Number(row.after?.required || 0), 1);
      const beforeSkillW = Math.max(4, Math.round((Number(row.before?.required || 0) / maxSkillReq) * 100));
      const afterSkillW = Math.max(4, Math.round((Number(row.after?.required || 0) / maxSkillReq) * 100));
      const timeCards = times.map(timeRow => {
        const maxTimeReq = Math.max(Number(timeRow.before?.required || 0), Number(timeRow.after?.required || 0), 1);
        const beforeTimeW = Math.max(4, Math.round((Number(timeRow.before?.required || 0) / maxTimeReq) * 100));
        const afterTimeW = Math.max(4, Math.round((Number(timeRow.after?.required || 0) / maxTimeReq) * 100));
        return `
          <div class="rl-impact-time-card">
            <div class="rl-impact-time-main">
              <strong>${_escAttr(timeRow.time || '')}</strong>
              <span>${_escAttr(timeRow.terminal || 'ALL')}</span>
            </div>
            <div class="rl-impact-time-bars">
              <div><span style="width:${beforeTimeW}%;background:rgba(148,163,184,0.58);"></span></div>
              <div><span style="width:${afterTimeW}%;background:${skillColor};"></span></div>
            </div>
            <div class="rl-impact-time-metrics">
              <span>Req <b>${_fmtInt(timeRow.before?.required)} -> ${_fmtInt(timeRow.after?.required)}</b> <em style="color:${_deltaColor(timeRow.delta_required)};">${_fmtDelta(timeRow.delta_required)}</em></span>
              <span>Asgn <b>${_fmtInt(timeRow.before?.assigned)} -> ${_fmtInt(timeRow.after?.assigned)}</b> <em style="color:${_deltaColor(timeRow.delta_assigned)};">${_fmtDelta(timeRow.delta_assigned)}</em></span>
              <span>Gap <b>${_fmtInt(timeRow.before?.gap)} -> ${_fmtInt(timeRow.after?.gap)}</b> <em style="color:${_deltaColor(timeRow.delta_gap, true)};">${_fmtDelta(timeRow.delta_gap)}</em></span>
            </div>
          </div>`;
      }).join('');
      return `
        <details class="rl-impact-skill-card">
          <summary>
            <div class="rl-impact-skill-main">
              <span class="rl-impact-skill-name"><span class="rl-impact-skill-dot" style="background:${skillColor};"></span>${_escAttr(row.skill)}</span>
              <span class="rl-impact-change-count">${times.length} changed time${times.length === 1 ? '' : 's'}</span>
            </div>
            <div class="rl-impact-skill-bars">
              <span style="width:${beforeSkillW}%;background:rgba(148,163,184,0.58);"></span>
              <span style="width:${afterSkillW}%;background:${skillColor};"></span>
            </div>
            <div class="rl-impact-skill-metrics">
              <span>Req <b>${_fmtInt(row.before?.required)} -> ${_fmtInt(row.after?.required)}</b> <em style="color:${_deltaColor(row.delta_required)};">${_fmtDelta(row.delta_required)}</em></span>
              <span>Asgn <b>${_fmtInt(row.before?.assigned)} -> ${_fmtInt(row.after?.assigned)}</b> <em style="color:${_deltaColor(row.delta_assigned)};">${_fmtDelta(row.delta_assigned)}</em></span>
              <span>Gap <b>${_fmtInt(row.before?.gap)} -> ${_fmtInt(row.after?.gap)}</b> <em style="color:${_deltaColor(row.delta_gap, true)};">${_fmtDelta(row.delta_gap)}</em></span>
            </div>
          </summary>
          <div class="rl-impact-time-wrap">
            ${timeCards || '<div class="rl-impact-empty">No hourly changes for this skill.</div>'}
          </div>
        </details>`;
    }).join('');

    return `
      <div class="rl-impact-panel">
        <div class="rl-impact-head">
          <div>
            <div class="rl-impact-title">Simulation Overlay Impact</div>
            <div class="rl-impact-sub">Before: ${_escAttr(cmp.before_source || 'short term PAX.xlsx')} | After: ${_escAttr(cmp.after_source || 'simulated_intraday_PAX.xlsx')}</div>
          </div>
          <div class="rl-impact-actions">
            <div class="rl-impact-badge">Overlay Active</div>
            <button class="rl-remove-overlay-btn" type="button">Remove Overlay</button>
          </div>
        </div>
        <div class="rl-impact-grid">
          <div class="rl-impact-card">
            <div class="rl-impact-label">FTE Required</div>
            <div class="rl-impact-values"><strong>${_fmtInt(before.required)}</strong><span>before</span><strong>${_fmtInt(after.required)}</strong><span>after</span><b style="color:${_deltaColor(cmp.delta_required)};">${_fmtDelta(cmp.delta_required)}</b></div>
            <div class="rl-impact-bars"><span style="width:${reqBeforeW}%;background:rgba(148,163,184,0.55);"></span><span style="width:${reqAfterW}%;background:var(--info);"></span></div>
          </div>
          <div class="rl-impact-card">
            <div class="rl-impact-label">FTE Assigned</div>
            <div class="rl-impact-values"><strong>${_fmtInt(before.assigned)}</strong><span>before</span><strong>${_fmtInt(after.assigned)}</strong><span>after</span><b style="color:${_deltaColor(cmp.delta_assigned)};">${_fmtDelta(cmp.delta_assigned)}</b></div>
            <div class="rl-impact-bars"><span style="width:${asgBeforeW}%;background:rgba(148,163,184,0.55);"></span><span style="width:${asgAfterW}%;background:var(--ok);"></span></div>
          </div>
          <div class="rl-impact-card rl-impact-gap-card">
            <div class="rl-impact-label">Open Gap</div>
            <div class="rl-impact-values"><strong>${_fmtInt(before.gap)}</strong><span>before</span><strong>${_fmtInt(after.gap)}</strong><span>after</span><b style="color:${_deltaColor(cmp.delta_gap, true)};">${_fmtDelta(cmp.delta_gap)}</b></div>
            <div class="rl-impact-note">Lower is better after the optimizer reallocates against simulated demand.</div>
          </div>
        </div>
        ${skillRows ? `
          <div class="rl-impact-skill-cards">
            ${skillRows}
          </div>` : ''}
      </div>`;
  }

  async function removeSimulationOverlay() {
    const btn = container.querySelector('.rl-remove-overlay-btn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Removing...';
    }
    try {
      const res = await fetch('/api/intraday/pax-demand/remove-simulation', { method: 'POST' });
      const payload = await res.json();
      if (!res.ok || payload.error) throw new Error(payload.error || `Remove failed: ${res.status}`);
      ID_DATA = await fetch('/api/intraday').then(r => r.json());
      _idReallocSelection = { skill: null, terminal: null, block: null, taskId: null };
      renderIntradayPage();
    } catch (err) {
      console.error(err);
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Remove Overlay';
      }
      alert(err.message || 'Unable to remove overlay.');
    }
  }

  // ── Summary stats ─────────────────────────────────────────────────
  const matrix  = buildMatrixData();
  const gapList = buildGapList(matrix);
  const totalOnDuty = new Set(tasks.flatMap(t => (t.assigned||[]).filter(Boolean))).size;
  const allCells = Object.values(matrix).flatMap(b => Object.values(b));
  const covPct   = allCells.length
    ? Math.round(allCells.reduce((a,c) => a + Math.min(c.pct, 100), 0) / allCells.length)
    : 100;
  const totalGaps = allCells.reduce((a,c) => a + c.gap, 0);
  // rowKeys sorted skill-first then terminal so rows appear grouped
  const rowKeys  = Object.keys(matrix).sort((a, b) => {
    const [ska, ta] = a.split('||');
    const [skb, tb] = b.split('||');
    return ska.localeCompare(skb) || ta.localeCompare(tb);
  });
  const allBlocks = _RL_HOUR_BLOCKS;
  const comparisonHtml = renderOverlayComparisonPanel();

  // ── State ─────────────────────────────────────────────────────────
  let _selSkill    = _idReallocSelection.skill;
  let _selTerminal = _idReallocSelection.terminal;
  let _selBlock    = _idReallocSelection.block;
  let _selTaskId   = _idReallocSelection.taskId;

  // ── Render shell ──────────────────────────────────────────────────
  container.innerHTML = `
  <div class="rl-shell">

    <!-- Header bar -->
    <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 20px 12px;border-bottom:1px solid var(--border);flex-shrink:0;">
      <div>
        <div style="font-size:1.25rem;font-weight:700;color:var(--text);">Live Staff Reallocation</div>
        <div style="font-size:0.8rem;color:var(--muted);margin-top:2px;">Click a cell to select a skill x hour gap, then assign or remove staff from the right panel</div>
      </div>
    </div>

    <!-- KPI strip -->
    <div style="display:flex;gap:0;border-bottom:1px solid var(--border);flex-shrink:0;">
      <div class="rl-kpi-tile" style="border-right:1px solid var(--border);">
        <div class="rl-kpi-val" style="color:var(--info);">${totalOnDuty}</div>
        <div class="rl-kpi-lbl">On Duty</div>
      </div>
      <div class="rl-kpi-tile" style="border-right:1px solid var(--border);">
        <div class="rl-kpi-val" style="color:${covPct>=90?'var(--ok)':covPct>=70?'var(--warn)':'var(--crit)'};">${covPct}%</div>
        <div class="rl-kpi-lbl">Avg Coverage</div>
      </div>
      <div class="rl-kpi-tile" style="border-right:1px solid var(--border);">
        <div class="rl-kpi-val" style="color:${totalGaps===0?'var(--ok)':'var(--crit)'};">${totalGaps}</div>
        <div class="rl-kpi-lbl">Total Gaps</div>
      </div>
      <div class="rl-kpi-tile" style="border-right:1px solid var(--border);">
        <div class="rl-kpi-val" style="color:var(--warn);">${gapList.length}</div>
        <div class="rl-kpi-lbl">Blocks w/ Gap</div>
      </div>
      <div class="rl-kpi-tile" style="flex:1;">
        <div style="display:flex;gap:14px;align-items:center;font-size:0.75rem;">
          <span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:#2ecc71;margin-right:4px;vertical-align:middle;"></span>≥100% covered</span>
          <span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:#f39c12;margin-right:4px;vertical-align:middle;"></span>70–99% covered</span>
          <span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:#e74c3c;margin-right:4px;vertical-align:middle;"></span>&lt;70% covered</span>
          <span style="margin-left:6px;color:var(--muted);">Cell format: <strong style="color:var(--text);">REQ / ASGN</strong></span>
        </div>
        <div class="rl-kpi-lbl" style="margin-top:4px;">Legend</div>
      </div>
    </div>

    ${comparisonHtml}

    <!-- Main body -->
    <div class="rl-main">

      <!-- Left: heatmap + gap list -->
      <div class="rl-left-pane">

        <!-- Heatmap -->
        <div class="rl-matrix-wrap" id="rl-matrix-wrap">
          <table style="border-collapse:collapse;width:100%;min-width:${132 + allBlocks.length * 48}px;font-size:0.72rem;" id="rl-matrix-table">
            <thead>
              <tr style="background:var(--surface-2,#1e1e1e);position:sticky;top:0;z-index:2;">
                <th class="rl-skill-head">Skill / Touchpoint</th>
                ${allBlocks.map(b => `<th class="rl-block-head">${b.label}</th>`).join('')}
              </tr>
            </thead>
            <tbody id="rl-matrix-body"></tbody>
          </table>
        </div>

        <!-- Gap priority list -->
        <div class="rl-gap-pane">
          <div style="padding:8px 12px 4px;font-size:0.7rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;position:sticky;top:0;background:var(--surface-2,#1e1e1e);z-index:1;">
            Gap Priority — worst first
          </div>
          <div id="rl-gap-list" style="padding:0 8px 8px;"></div>
        </div>
      </div>

      <!-- Right: staff panel + log -->
      <div class="rl-right-pane">

        <!-- Staff panel -->
        <div class="rl-staff-panel" id="rl-staff-panel">
          <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--muted);text-align:center;gap:8px;">
            <div style="font-size:2rem;opacity:0.3;">←</div>
            <div style="font-size:0.85rem;">Select a cell in the heatmap to manage staff for that block</div>
          </div>
        </div>

        <!-- Move log -->
        <div style="flex-shrink:0;border-top:1px solid var(--border);max-height:180px;overflow-y:auto;background:var(--surface-2,#141414);">
          <div style="padding:8px 14px 4px;font-size:0.7rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;background:var(--surface-2,#141414);z-index:1;">
            <span>Move History</span>
            <span id="rl-log-count" style="font-size:0.7rem;color:var(--info);">${_idReallocLog.length} moves</span>
          </div>
          <div id="rl-log-body" style="padding:0 14px 8px;font-size:0.75rem;"></div>
        </div>
      </div>

    </div><!-- /main body -->
  </div>`;

  // ── Sub-renders ───────────────────────────────────────────────────
  function renderMatrix(mx) {
    const tbody = document.getElementById('rl-matrix-body');
    if (!tbody) return;

    // Group rowKeys by skill for visual separation between groups
    const skillOrder = [...new Set(rowKeys.map(rk => rk.split('||')[0]))];
    let html = '';

    for (const sk of skillOrder) {
      const skColor   = _skillColor(sk);
      const termRows  = rowKeys.filter(rk => rk.split('||')[0] === sk);
      const multiTerm = termRows.length > 1;

      termRows.forEach((rowKey, idx) => {
        const term    = rowKey.split('||')[1];
        const byBlock = mx[rowKey] || {};
        const isFirst = idx === 0;

        const cells = allBlocks.map(b => {
          const cell = byBlock[b.id];
          if (!cell) return `<td style="padding:4px 2px;text-align:center;"><span style="font-size:0.65rem;color:var(--muted);opacity:.4;">—</span></td>`;
          const c     = _cellColor(cell.pct, cell.gap);
          const isSel = (_selSkill === sk && _selTerminal === term && _selBlock === b.id);
          return `<td style="padding:3px 2px;text-align:center;">
            <div class="rl-cell${isSel?' rl-cell-sel':''}"
              data-skill="${_escAttr(sk)}" data-terminal="${_escAttr(term)}" data-block="${b.id}"
              style="display:inline-block;min-width:40px;padding:4px 4px;border-radius:5px;
                background:${c.bg};border:1px solid ${isSel?'#fff':c.border};
                color:${c.text};font-size:0.7rem;font-weight:700;cursor:pointer;
                transition:transform .1s;${isSel?'transform:scale(1.08);box-shadow:0 0 0 2px #fff4;':''}">
              ${cell.req}/${cell.asgn}
            </div>
          </td>`;
        }).join('');

        // Left label always shows skill name in color + terminal badge when multi-terminal
        const termBadge = multiTerm
          ? ` <span style="font-size:0.6rem;font-weight:700;background:${skColor}25;color:${skColor};
                border:1px solid ${skColor}50;border-radius:3px;padding:1px 5px;margin-left:4px;">${term}</span>`
          : '';
        const rowLabel = `<span style="color:${skColor};font-weight:600;">${sk}</span>${termBadge}`;

        // Add a top border before the first row of each skill group
        const topBorder = isFirst ? 'border-top:1px solid var(--border);' : '';

        html += `<tr style="border-bottom:1px solid var(--border)05;${topBorder}">
          <td class="rl-skill-cell" title="${sk}${multiTerm?' — '+term:''}">${rowLabel}</td>
          ${cells}
        </tr>`;
      });
    }
    tbody.innerHTML = html;

    // Click handlers
    tbody.querySelectorAll('.rl-cell').forEach(el => {
      el.addEventListener('click', () => {
        _setSelection(el.dataset.skill, el.dataset.terminal, el.dataset.block, null);
        renderMatrix(mx);
        renderStaffPanel(mx);
        renderGapList(gapList);
      });
    });
  }

  function renderGapList(gl) {
    const el = document.getElementById('rl-gap-list');
    if (!el) return;
    if (!gl.length) { el.innerHTML = `<div style="padding:10px 4px;font-size:0.78rem;color:var(--ok);">✓ No gaps — all blocks covered</div>`; return; }
    el.innerHTML = gl.slice(0, 12).map(g => {
      const b     = allBlocks.find(x => x.id === g.blockId) || {};
      const c     = _cellColor(g.pct, g.gap);
      const isSel = (_selSkill === g.skill && _selTerminal === g.terminal && _selBlock === g.blockId);
      return `<div class="rl-gap-item${isSel?' rl-gap-sel':''}"
        data-skill="${_escAttr(g.skill)}" data-terminal="${_escAttr(g.terminal)}" data-block="${g.blockId}"
        style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;margin-bottom:3px;cursor:pointer;
          background:${isSel?'var(--surface-3,#2a2a2a)':'transparent'};border:1px solid ${isSel?'var(--border)':'transparent'};">
        <div style="width:7px;height:7px;border-radius:50%;background:${c.border};flex-shrink:0;"></div>
        <div style="flex:1;min-width:0;">
          <div style="font-size:0.72rem;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${g.skill}</div>
          <div style="font-size:0.65rem;color:var(--muted);">${b.label||g.blockId} · ${g.terminal}</div>
        </div>
        <div style="text-align:right;flex-shrink:0;">
          <div style="font-size:0.72rem;font-weight:700;color:${c.text};">${g.req}/${g.asgn}</div>
          <div style="font-size:0.65rem;color:var(--crit);">-${g.gap} staff</div>
        </div>
      </div>`;
    }).join('');

    el.querySelectorAll('.rl-gap-item').forEach(el2 => {
      el2.addEventListener('click', () => {
        _setSelection(el2.dataset.skill, el2.dataset.terminal, el2.dataset.block, null);
        renderMatrix(mx);
        renderStaffPanel(mx);
        renderGapList(gl);
      });
    });
  }

  function renderStaffPanel(mx) {
    const panel = document.getElementById('rl-staff-panel');
    if (!panel || !_selSkill || !_selTerminal || !_selBlock) return;

    const rowKey = _selSkill + '||' + _selTerminal;
    const cell = (mx[rowKey] || {})[_selBlock];
    const blk  = allBlocks.find(b => b.id === _selBlock) || {};

    if (!cell) {
      panel.innerHTML = `<div style="color:var(--muted);font-size:0.85rem;padding:20px;">No tasks in this block.</div>`;
      return;
    }

    _setSelection(_selSkill, _selTerminal, _selBlock, null);

    const c = _cellColor(cell.pct, cell.gap);
    const assignedIds = new Set(cell._staffSet);
    const blockStart = blk.start ?? 0;
    const blockEnd = blk.end ?? 1440;

    function isAssignedElsewhereInBlock(sid) {
      return tasks.some(t => {
        if (!(t.start_mins < blockEnd && t.end_mins > blockStart)) return false;
        return (t.assigned || []).map(String).includes(String(sid));
      });
    }

    // Eligible: on duty for this block, has this skill, and free in this period.
    let eligible = allStaff.filter(s => {
      const sid   = String(s.id || s['EMPLOYEE NUMBER'] || '');
      if (assignedIds.has(sid)) return false;
      if (isAssignedElsewhereInBlock(sid)) return false;
      const hasSkill = _staffHasSkill(s, _selSkill);
      const shStart = s.shift_start_mins ?? s.shift_start ?? 0;
      const shEnd   = s.shift_end_mins ?? s.shift_end ?? 1440;
      const onDuty  = shStart <= blockStart && shEnd >= blockEnd;
      return hasSkill && onDuty;
    });
    const assignedList = allStaff.filter(s => assignedIds.has(String(s.id || s['EMPLOYEE NUMBER'] || '')));

    const terms = _selTerminal || [...cell.terms].join(', ') || '—';
    const coverBar = Math.min(cell.pct, 100);

    panel.innerHTML = `
      <!-- Selected cell header -->
      <div style="background:var(--surface-2,#1e1e1e);border-radius:10px;padding:14px 16px;margin-bottom:16px;border:1px solid ${c.border}40;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px;">
          <div>
            <div style="font-size:0.72rem;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px;">Selected Hour</div>
            <div style="font-size:1rem;font-weight:700;color:${_skillColor(_selSkill)};">${_selSkill}</div>
            <div style="font-size:0.78rem;color:var(--muted);margin-top:2px;">${blk.label || _selBlock} &nbsp;·&nbsp; Terminal: ${terms}</div>
          </div>
          <div style="text-align:right;">
            <div style="font-size:1.6rem;font-weight:800;color:${c.text};line-height:1;">${cell.req}/${cell.asgn}</div>
            <div style="font-size:0.68rem;color:var(--muted);">REQ / ASGN</div>
          </div>
        </div>
        <!-- Coverage bar -->
        <div style="height:6px;border-radius:3px;background:var(--border);overflow:hidden;">
          <div style="width:${coverBar}%;height:100%;background:${c.border};border-radius:3px;transition:width .3s;"></div>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:0.65rem;color:var(--muted);margin-top:3px;">
          <span>${cell.pct}% coverage</span>
          <span>${cell.gap > 0 ? `<span style="color:var(--crit);">-${cell.gap} gap</span>` : '<span style="color:var(--ok);">✓ met</span>'}</span>
        </div>
      </div>

      <!-- Currently assigned -->
      <div style="margin-bottom:14px;">
        <div style="font-size:0.7rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px;">
          Currently Assigned (${assignedList.length})
        </div>
        ${assignedList.length === 0
          ? `<div style="font-size:0.78rem;color:var(--muted);padding:8px 0;">No staff assigned to this block yet.</div>`
          : assignedList.map(s => {
              const sid = String(s.id || s['EMPLOYEE NUMBER'] || '');
              const nm  = s.name || s['STAFF NAME'] || sid;
              const sk1 = s.skill1 || '—';
              const skillsLabel = _staffSkills(s).join(' / ') || sk1;
              return `<div style="display:flex;align-items:center;gap:10px;padding:7px 10px;background:var(--surface-2,#1e1e1e);border-radius:7px;margin-bottom:5px;border:1px solid var(--border);">
                <div style="width:28px;height:28px;border-radius:50%;background:${_skillColor(sk1)}20;display:flex;align-items:center;justify-content:center;font-size:0.65rem;font-weight:700;color:${_skillColor(sk1)};flex-shrink:0;">${(nm[0]||'?').toUpperCase()}</div>
                <div style="flex:1;min-width:0;">
                  <div style="font-size:0.78rem;font-weight:600;color:var(--text);">${nm}</div>
                  <div style="font-size:0.65rem;color:var(--muted);">${skillsLabel} · ID ${sid}</div>
                </div>
                <button class="rl-remove-btn" data-sid="${_escAttr(sid)}" data-sname="${_escAttr(nm)}"
                  style="padding:4px 10px;background:transparent;border:1px solid var(--crit);color:var(--crit);border-radius:5px;font-size:0.7rem;font-weight:600;cursor:pointer;">
                  ✕ Remove
                </button>
              </div>`;
            }).join('')}
      </div>

      <!-- Eligible to assign -->
      <div>
        <div style="font-size:0.7rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px;">
          Available to Assign (${eligible.length})
        </div>
        ${eligible.length === 0
          ? `<div style="font-size:0.78rem;color:var(--muted);padding:8px 0;">No eligible staff free for this hour.</div>`
          : eligible.map(s => {
              const sid = String(s.id || s['EMPLOYEE NUMBER'] || '');
              const nm  = s.name || s['STAFF NAME'] || sid;
              const sk1 = s.skill1 || '—';
              const skillsLabel = _staffSkills(s).join(' / ') || sk1;
              const util = s.utilisation_pct || 0;
              const uColor = util >= 85 ? 'var(--ok)' : util >= 50 ? 'var(--info)' : 'var(--muted)';
              return `<div style="display:flex;align-items:center;gap:10px;padding:7px 10px;background:var(--surface-2,#1e1e1e);border-radius:7px;margin-bottom:5px;border:1px solid var(--border);">
                <div style="width:28px;height:28px;border-radius:50%;background:${_skillColor(sk1)}20;display:flex;align-items:center;justify-content:center;font-size:0.65rem;font-weight:700;color:${_skillColor(sk1)};flex-shrink:0;">${(nm[0]||'?').toUpperCase()}</div>
                <div style="flex:1;min-width:0;">
                  <div style="font-size:0.78rem;font-weight:600;color:var(--text);">${nm}</div>
                  <div style="font-size:0.65rem;color:var(--muted);">${skillsLabel} · ID ${sid}</div>
                </div>
                <div style="font-size:0.65rem;color:${uColor};font-weight:600;margin-right:6px;">${util}% util</div>
                <button class="rl-assign-btn" data-sid="${_escAttr(sid)}" data-sname="${_escAttr(nm)}"
                  style="padding:4px 10px;background:var(--info);color:#fff;border:none;border-radius:5px;font-size:0.7rem;font-weight:600;cursor:pointer;">
                  + Assign
                </button>
              </div>`;
            }).join('')}
      </div>`;

    // Wire buttons
    panel.querySelectorAll('.rl-assign-btn').forEach(btn => {
      btn.addEventListener('click', () => _doMove('assign', btn.dataset.sid, btn.dataset.sname));
    });
    panel.querySelectorAll('.rl-remove-btn').forEach(btn => {
      btn.addEventListener('click', () => _doMove('unassign', btn.dataset.sid, btn.dataset.sname));
    });
  }

  function renderLog() {
    const el = document.getElementById('rl-log-body');
    const cnt = document.getElementById('rl-log-count');
    if (!el) return;
    if (cnt) cnt.textContent = `${_idReallocLog.length} moves`;
    if (!_idReallocLog.length) {
      el.innerHTML = `<div style="color:var(--muted);padding:6px 0;font-size:0.75rem;">No moves yet.</div>`;
      return;
    }
    el.innerHTML = [..._idReallocLog].reverse().map((lg, i) => {
      const icon = lg.action === 'assign' ? '+ ' : '✕ ';
      const col  = lg.action === 'assign' ? 'var(--ok)' : 'var(--crit)';
      return `<div style="display:flex;gap:8px;padding:4px 0;border-bottom:1px solid var(--border)05;">
        <span style="color:${col};font-weight:700;flex-shrink:0;">${icon}</span>
        <span style="flex:1;">${lg.staffName} → <strong>${lg.skill}</strong> ${lg.blockLabel}</span>
        <span style="color:var(--muted);flex-shrink:0;font-size:0.65rem;">${lg.time}</span>
      </div>`;
    }).join('');
  }

  async function _doMove(action, staffId, staffName) {
    const blk    = allBlocks.find(b => b.id === _selBlock) || {};
    const rowKey = _selSkill + '||' + _selTerminal;
    const cell   = (matrix[rowKey] || {})[_selBlock];
    if (!cell) return;
    // Send the currently-visible assigned IDs so the server uses them as the
    // authoritative crew base instead of snapshotting from a fresh optimizer run.
    const currentAssigned = [...(cell._staffSet || [])].map(String);
    const payload = {
      staff_id:         staffId,
      skill:            _selSkill,
      terminal:         _selTerminal,
      block_start:      blk.start,
      block_end:        blk.end,
      action:           action,
      current_assigned: currentAssigned,
    };

    // Disable all action buttons while in-flight
    document.querySelectorAll('.rl-assign-btn,.rl-remove-btn').forEach(b => { b.disabled = true; b.style.opacity = '0.5'; });

    try {
      const res  = await fetch('/api/intraday/assign-block', {
        method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Request failed');
      const moveStatus = data.move_status || {};
      if (moveStatus.applied === false) {
        throw new Error(moveStatus.error || 'Move was not applied to the selected hour.');
      }

      // Persist log entry
      _idReallocLog.push({
        action, staffId, staffName,
        skill: `${_selSkill} (${_selTerminal})`,
        blockLabel: blk.label || _selBlock,
        time: new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}),
      });

      // Update global data and refresh all intraday tabs instantly
      ID_DATA = data;
      try { renderIDKPIs(data.kpis); } catch (_) {}
      try { renderIDAlerts(data.alerts); } catch (_) {}

      // Re-render every non-opt sub-tab so Roster Timeline and PAX Demand
      // reflect the change immediately without requiring a manual tab switch.
      const prevTab = ID_ACTIVE_TAB;
      const subContent = document.getElementById('id-sub-content');
      if (subContent) {
        ['staff-timeline', 'demand'].forEach(tab => {
          if (tab !== prevTab) {
            ID_ACTIVE_TAB = tab;
            try { renderIDSubContent(); } catch (_) {}
          }
        });
        ID_ACTIVE_TAB = prevTab;
      }

      // Re-render the Staff Reallocation heatmap and restore the selected cell
      const savedSelection = { skill: _selSkill, terminal: _selTerminal, block: _selBlock, taskId: null };
      _idReallocSelection = savedSelection;
      renderIDOptimization(container);
      setTimeout(() => {
        const cell = container.querySelector(
          `.rl-cell[data-skill="${CSS.escape(savedSelection.skill)}"]` +
          `[data-terminal="${CSS.escape(savedSelection.terminal)}"]` +
          `[data-block="${savedSelection.block}"]`
        );
        if (cell) cell.click();
      }, 60);

    } catch (err) {
      const panel = document.getElementById('rl-staff-panel');
      if (panel) {
        const errDiv = document.createElement('div');
        errDiv.style.cssText = 'padding:8px 12px;background:#3a1a1a;border:1px solid var(--crit);border-radius:6px;font-size:0.78rem;color:var(--crit);margin-bottom:10px;';
        errDiv.textContent = '✕ ' + err.message;
        panel.prepend(errDiv);
      }
    } finally {
      document.querySelectorAll('.rl-assign-btn,.rl-remove-btn').forEach(b => { b.disabled = false; b.style.opacity = '1'; });
    }
  }

  // ── Initial paint ─────────────────────────────────────────────────
  renderMatrix(matrix);
  renderGapList(gapList);
  renderLog();
  container.querySelector('.rl-remove-overlay-btn')?.addEventListener('click', removeSimulationOverlay);
  if (_selSkill && _selTerminal && _selBlock) {
    renderStaffPanel(matrix);
  }

}

function renderIDRosterTimeline() {
  // kept for compatibility — delegates to the block table
  const el = document.getElementById('id-staff-timeline');
  if (!el || !ID_DATA) return;
  const q  = document.getElementById('id-staff-timeline-search')?.value.toLowerCase() || '';
  const sf = document.getElementById('id-staff-timeline-shift')?.value || '';
  const filtered = (ID_DATA.staff || []).filter(s => {
    const mq = !q || s.id.toLowerCase().includes(q) || (s.skill1||'').toLowerCase().includes(q);
    const ms = !sf || (s.shift||'').toLowerCase() === sf.toLowerCase();
    return mq && ms;
  });
  renderID3HrBlocksTable(el, filtered);
}

function renderID3HrBlocksTable(el, staffList) {
  if (!staffList || !staffList.length) {
    el.innerHTML = '<div class="muted small" style="padding:16px">No staff match your filter.</div>';
    return;
  }

  let TIME_BLOCKS = (typeof ST_TIME_BLOCKS !== 'undefined') ? ST_TIME_BLOCKS : [
    {id:'b00_03',label:'00–03',start:0,   end:180},
    {id:'b03_06',label:'03–06',start:180, end:360},
    {id:'b06_09',label:'06–09',start:360, end:540},
    {id:'b09_12',label:'09–12',start:540, end:720},
    {id:'b12_15',label:'12–15',start:720, end:900},
    {id:'b15_18',label:'15–18',start:900, end:1080},
    {id:'b18_21',label:'18–21',start:1080,end:1260},
    {id:'b21_24',label:'21–24',start:1260,end:1440},
  ];

  TIME_BLOCKS = _RL_HOUR_BLOCKS;

  const SKILL_COLOR = (typeof ID_SKILL_COLOR !== 'undefined') ? ID_SKILL_COLOR : {};

  function fmtSk(sk) {
    if (!sk) return '';
    const found = Object.keys(SKILL_COLOR).find(k => k.toLowerCase() === sk.toLowerCase());
    return found || sk.charAt(0).toUpperCase() + sk.slice(1);
  }

  function getBlockInfo(s, block) {
    const S = s.shift_start || 0;
    const E = s.shift_end   || (S + 720);
    if (!(S < block.end && E > block.start)) return null;
    const inBlock = (s.assignments || []).filter(a =>
      a.start_mins < block.end && a.end_mins > block.start);
    const blockBreaks = (s.breaks || []).filter(b =>
      b.start_mins < block.end && b.end_mins > block.start);
    if (!inBlock.length) return { skill: null, terminal: null, color: '#94a3b8', blockBreaks };
    const skillTime = {};
    inBlock.forEach(a => {
      const ov = Math.min(a.end_mins, block.end) - Math.max(a.start_mins, block.start);
      skillTime[a.skill] = (skillTime[a.skill] || 0) + ov;
    });
    const topSk = Object.entries(skillTime).sort((a,b) => b[1]-a[1])[0][0];
    const domAsgn = inBlock.filter(a => a.skill === topSk)
      .sort((a,b) => (Math.min(b.end_mins,block.end)-Math.max(b.start_mins,block.start)) -
                     (Math.min(a.end_mins,block.end)-Math.max(a.start_mins,block.start)))[0];
    return { skill: topSk, terminal: domAsgn?.terminal || null,
             color: SKILL_COLOR[topSk] || '#888', blockBreaks };
  }

  const rows = staffList.map(s => {
    const utilColor = (s.utilisation_pct||0) > 90 ? '#E74C3C' : (s.utilisation_pct||0) > 70 ? '#F39C12' : '#2ECC71';
    const sk1 = fmtSk(s.skill1);
    const grp = s.break_group || '';
    const grpColor = grp === 'A' ? '#2563EB' : '#059669';

    const cells = TIME_BLOCKS.map(b => {
      const info = getBlockInfo(s, b);
      if (!info) return `<td class="st3-cell st3-off">–</td>`;

      const brkRows = info.blockBreaks.map(br => {
        const isShort = (br.type || '').toLowerCase().includes('short');
        const icon  = isShort ? '☕' : '🍽';
        const color = isShort ? '#f97316' : '#dc2626';
        return `<div style="margin-top:3px;padding:2px 4px;border-radius:3px;
                            background:${color}22;border:1px solid ${color}66;
                            font-size:0.52rem;font-weight:800;color:${color};
                            white-space:nowrap;line-height:1.3">
                  ${icon} ${br.start}–${br.end}
                </div>`;
      }).join('');

      if (!info.skill) {
        return `<td class="st3-cell" style="background:#94a3b814;color:#94a3b8;
            border:1px solid #94a3b830;text-align:center;vertical-align:middle;padding:4px 3px"
            title="${b.label}: On shift">
          <div style="font-size:0.6rem;opacity:0.6">On shift</div>
          ${brkRows}
        </td>`;
      }

      const termBadge = info.terminal
        ? `<div style="font-size:0.58rem;font-weight:800;opacity:0.9;line-height:1.1">${info.terminal}</div>`
        : '';
      const brkAccent = info.blockBreaks.length
        ? `border-left:3px solid ${grpColor};`
        : `border-left:3px solid transparent;`;

      return `<td class="st3-cell" style="background:${info.color}20;color:${info.color};
          border:1px solid ${info.color}50;${brkAccent}
          text-align:center;vertical-align:middle;padding:3px 3px;min-width:68px"
          title="${b.label}: ${info.skill}${info.terminal?' @ '+info.terminal:''}">
        ${termBadge}
        <div style="font-size:0.62rem;font-weight:700;line-height:1.2">${info.skill}</div>
        ${brkRows}
      </td>`;
    }).join('');

    return `<tr>
      <td style="padding:6px 10px;font-weight:700;font-size:0.82rem;white-space:nowrap">${s.id}</td>
      <td style="padding:6px 10px;font-size:0.78rem"><span style="color:${SKILL_COLOR[sk1]||'#888'};font-weight:600">${sk1}</span></td>
      <td style="padding:6px 10px;font-size:0.75rem;white-space:nowrap">${s.shift_label || s.shift || '–'}</td>
      <td style="padding:6px 10px;font-size:0.75rem;font-weight:700;color:${utilColor}">${Math.round(s.utilisation_pct||0)}%</td>
      ${cells}
    </tr>`;
  }).join('');

  el.innerHTML = `<div style="overflow-x:auto">
    <table style="width:100%;min-width:${360 + TIME_BLOCKS.length * 68}px;border-collapse:collapse;font-size:0.82rem">
      <thead>
        <tr style="border-bottom:2px solid var(--border)">
          <th style="padding:8px 10px;text-align:left">Staff</th>
          <th style="padding:8px 10px;text-align:left">Skill</th>
          <th style="padding:8px 10px;text-align:left">Shift</th>
          <th style="padding:8px 10px;text-align:left">Util</th>
          ${TIME_BLOCKS.map(b=>`<th style="padding:6px 4px;text-align:center;font-size:0.72rem;white-space:nowrap">${b.label}</th>`).join('')}
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <div style="display:flex;gap:16px;flex-wrap:wrap;padding:10px 0 2px;font-size:0.72rem;color:var(--muted);align-items:center">
      <span><span style="display:inline-block;width:10px;height:6px;border-radius:2px;background:#f97316;margin-right:4px;vertical-align:middle"></span>☕ Short Break (30 min)</span>
      <span><span style="display:inline-block;width:10px;height:6px;border-radius:2px;background:#dc2626;margin-right:4px;vertical-align:middle"></span>🍽 Meal Break (60 min)</span>
      <span style="color:#2563EB;font-weight:700">| Grp A</span>
      <span style="color:#059669;font-weight:700">| Grp B</span>
      <span style="opacity:0.5">Colored left border = break in that block</span>
    </div>
  </div>`;
}

// ── Workforce Coverage Heatmap (Intraday) ────────────────────────
function buildIDCoverageData(tasks) {
  const hours = [];
  for (let h = 4; h <= 23; h++) hours.push(h);

  const paxSkills = Array.isArray(ID_DATA?.pax_coverage_skills) ? ID_DATA.pax_coverage_skills : [];
  const fallback  = ['Baggage','Boarding','CBP','Checkin','Immigration','Lounge','Security'];
  const skills    = paxSkills.length ? paxSkills.slice() : fallback;

  const hourData = {};
  skills.forEach(sk => {
    hourData[sk] = {};
    hours.forEach(h => { hourData[sk][h] = { req: 0, assigned: new Set() }; });
  });

  (tasks || []).forEach(task => {
    let sk = task.skill || task.role || task.task || '';
    if (!hourData[sk]) {
      const base = sk.split(' -- ')[0];
      if (hourData[base]) sk = base; else return;
    }
    const startHour = Math.floor((task.start_mins || 0) / 60);
    const endHour   = Math.ceil((task.end_mins || 0) / 60) - 1;
    const staffIds  = task.assigned || [];
    for (let h = startHour; h <= endHour; h++) {
      if (!hourData[sk][h]) continue;
      hourData[sk][h].req += (task.staff_needed || 0);
      staffIds.forEach(sid => hourData[sk][h].assigned.add(sid));
    }
  });

  const data = {};
  skills.forEach(sk => {
    data[sk] = {};
    hours.forEach(h => {
      const cell = hourData[sk][h];
      data[sk][h] = {
        req:      cell ? cell.req : 0,
        assigned: cell ? cell.assigned.size : 0,
      };
    });
  });

  return { data, hours, skills };
}

function buildIDCoverageTableHTML(tasks) {
  const { data, hours, skills } = buildIDCoverageData(tasks);

  function cellClass(req, assigned) {
    if (req === 0) return '';
    const gap = assigned - req;
    if (gap < -2) return 'cell-gap';
    if (gap < 0)  return 'cell-warning';
    if (gap > 1)  return 'cell-surplus';
    return 'cell-adequate';
  }

  const headCols = hours.map(h => `<th>${String(h).padStart(2,'0')}:00</th>`).join('');

  const bodyRows = skills.map(sk =>
    `<tr><td class="skill-label">${sk}</td>${hours.map(h => {
      const { req, assigned } = data[sk][h];
      if (req === 0) return `<td style="opacity:0.3;">0/0</td>`;
      const tip = `Role: ${sk}\nHour: ${String(h).padStart(2,'0')}:00\nRequired: ${req}\nAssigned: ${assigned}`;
      return `<td class="${cellClass(req, assigned)}" title="${tip}">${assigned}/${req}</td>`;
    }).join('')}</tr>`
  ).join('');

  const totalsReq      = hours.map(h => skills.reduce((s, sk) => s + data[sk][h].req,      0));
  const totalsAssigned = hours.map(h => skills.reduce((s, sk) => s + data[sk][h].assigned, 0));

  const fReq  = hours.map((_, i) => `<td style="font-weight:700;">${totalsReq[i] || '—'}</td>`).join('');
  const fAsgn = hours.map((_, i) => `<td style="font-weight:700;color:#3b82f6;">${totalsAssigned[i] || '—'}</td>`).join('');
  const fGap  = hours.map((_, i) => {
    if (!totalsReq[i]) return `<td>—</td>`;
    const g = totalsAssigned[i] - totalsReq[i];
    const color = g < 0 ? 'var(--crit)' : g > 1 ? 'var(--ok)' : 'var(--warn)';
    return `<td style="font-weight:700;color:${color};">${g > 0 ? '+' : ''}${g}</td>`;
  }).join('');

  return `
    <thead>
      <tr class="hm-header-row">
        <th class="skill-col">PAX Work</th>${headCols}
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
        <span class="section-hint">Assigned / Required per skill per hour. PAX touchpoints only.</span>
      </div>
      <div class="legend-row mb-12">
        <span class="leg surplus"></span><span>Surplus</span>
        <span class="leg adequate"></span><span>Adequate</span>
        <span class="leg warning"></span><span>Warning</span>
        <span class="leg gap"></span><span>Gap</span>
      </div>
      <div class="heatmap-wrapper" id="id-hourly-heatmap-wrapper" style="overflow-x:auto;">
        <table class="heatmap-table heatmap-table--fluid" id="id-hourly-heatmap"></table>
      </div>`;
    const panel = wrapper.querySelector('.panel');
    if (panel) panel.appendChild(section);
  }

  const table = document.getElementById('id-hourly-heatmap');
  if (table) table.innerHTML = buildIDCoverageTableHTML(ID_DATA?.tasks || []);
}

window.initIntraday = initIntraday;



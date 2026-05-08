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
  'Checkin': '#2563EB', 'Security': '#DC2626', 'CBP': '#7C3AED',
  'Lounge': '#059669', 'Boarding': '#D97706', 'Immigration': '#0891B2',
  'Baggage': '#4B5563',
  'GNIB': '#3498DB', 'CBP Pre-clearance': '#9B59B6', 'Bussing': '#E8850A',
  'PBZ': '#2ECC71', 'Mezz Operation': '#1ABC9C', 'Litter Picking': '#E74C3C',
  'Ramp / Marshalling': '#F39C12', 'Arr Customer Service': '#5DADE2',
  'Check-in/Trolleys': '#A9CCE3', 'Transfer Corridor': '#27AE60',
  'Dep / Trolleys': '#8E44AD', 'T1/T2 Trolleys L/UL': '#E91E63',
};

function fmtSkill(sk) {
  if (!sk) return '';
  const found = Object.keys(ST_SKILL_COLOR).find(k => k.toLowerCase() === sk.toLowerCase());
  if (found) return found;
  const allUpper = ['CBP','GNIB','PBZ'];
  if (allUpper.includes(sk.toUpperCase())) return sk.toUpperCase();
  return sk.charAt(0).toUpperCase() + sk.slice(1);
}

let ST_DATES = [];
let ST_CURRENT_DATE = null;
let ST_DATA = null;
let ST_ACTIVE_TAB = 'staff-timeline';
const ST_CHARTS = {};
let ST_OPT_RESULTS_CACHE = null; // persists across sub-tab switches

// Coverage heatmap defaults and skills (PAX-derived skills will be merged)
const ST_COVERAGE_SKILLS = [
  'Checkin', 'Security', 'CBP', 'Lounge', 'Boarding', 'Immigration', 'Baggage',
  'GNIB', 'Mezz Operation', 'CBP Pre-clearance', 'Gate 335',
  'Bussing', 'Arr Customer Service', 'Transfer Corridor',
  'Check-in/Trolleys', 'T1/T2 Trolleys L/UL', 'Dep/Trolleys',
  'PBZ', 'Departures', 'Litter Picking'
];
let ST_COVERAGE_PAX_ONLY = true;

// 3-hour block definitions shared across tabs
const ST_TIME_BLOCKS = [
  {id:'b00_03',label:'00–03',start:0,   end:180},
  {id:'b03_06',label:'03–06',start:180, end:360},
  {id:'b06_09',label:'06–09',start:360, end:540},
  {id:'b09_12',label:'09–12',start:540, end:720},
  {id:'b12_15',label:'12–15',start:720, end:900},
  {id:'b15_18',label:'15–18',start:900, end:1080},
  {id:'b18_21',label:'18–21',start:1080,end:1260},
  {id:'b21_24',label:'21–24',start:1260,end:1440},
];

// View-mode state (persists across date switches)
let _stStaffBlockView  = false;
let _stTimelineView    = '15min';


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
      <button class="sub-tab ${ST_ACTIVE_TAB==='staff-timeline'?'active':''}" data-sttab="staff-timeline">👤 Roster Timeline</button>
      <button class="sub-tab ${ST_ACTIVE_TAB==='roster-board'?'active':''}" data-sttab="roster-board">📋 Roster Board</button>
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
  const absentCls = kpis.absent > 3 ? 'kpi-card--warn' : '';
  const covPct = kpis.coverage_pct;
  const covCls = covPct < 50 ? 'kpi-card--crit' : covPct < 80 ? 'kpi-card--warn' : 'kpi-card--ok';
  const cards = [
    {
      iconHtml: `<div class="kpi-icon-bubble" style="--glow:#3b82f6;background:rgba(59,130,246,0.12);border:1.5px solid rgba(59,130,246,0.35)"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13M22 2L15 22l-4-9-9-4 19-7z"/></svg></div>`,
      label: 'Passenger Volume', value: (kpis.passengers_total || 0).toLocaleString(), cls: ''
    },
    {
      iconHtml: `<div class="kpi-icon-bubble" style="--glow:#8b5cf6;background:rgba(139,92,246,0.12);border:1.5px solid rgba(139,92,246,0.35)"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#8b5cf6" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg></div>`,
      label: 'Staff on Duty', value: kpis.staff_on_duty, cls: ''
    },
    {
      iconHtml: `<div class="kpi-icon-bubble" style="--glow:#ef4444;background:rgba(239,68,68,0.12);border:1.5px solid rgba(239,68,68,0.35)"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg></div>`,
      label: 'Absent', value: kpis.absent, cls: absentCls
    },
    {
      iconHtml: `<div class="kpi-icon-bubble" style="--glow:#0ea5e9;background:rgba(14,165,233,0.12);border:1.5px solid rgba(14,165,233,0.35)"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#0ea5e9" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="3" width="15" height="13" rx="2"/><path d="M16 8h4l3 3v5h-7V8z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg></div>`,
      label: 'Demand Windows', value: kpis.demand_windows_total ?? kpis.tasks_total, cls: ''
    },
    {
      iconHtml: `<div class="kpi-icon-bubble" style="--glow:#10b981;background:rgba(16,185,129,0.12);border:1.5px solid rgba(16,185,129,0.35)"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>`,
      label: 'PAX Windows Covered', value: `${kpis.demand_windows_covered ?? kpis.tasks_covered} / ${kpis.demand_windows_total ?? kpis.tasks_total}`, cls: ''
    },
    {
      iconHtml: `<div class="kpi-icon-bubble" style="--glow:#f97316;background:rgba(249,115,22,0.12);border:1.5px solid rgba(249,115,22,0.35)"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#f97316" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg></div>`,
      label: 'Coverage %', value: covPct + '%', cls: covCls
    },
  ];
  grid.innerHTML = cards.map(c => `
    <div class="kpi-card ${c.cls}">
      <div class="kpi-icon">${c.iconHtml}</div>
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
    panel.innerHTML = `<div class="alert-row alert-ok" style="padding:14px 18px;border-radius:var(--radius);font-size:0.83rem;">&#x2705; All tasks fully covered &mdash; no staffing gaps.</div>`;
    return;
  }

  const byCrit = alerts.filter(a => a.priority === 'Critical').length;
  const byHigh = alerts.filter(a => a.priority === 'High').length;
  const byMed  = alerts.filter(a => a.priority === 'Medium').length;
  const byLow  = alerts.filter(a => a.priority === 'Low').length;
  const total  = alerts.length;

  const severityCls = byCrit ? '--crit' : byHigh ? '--high' : byMed ? '--warn' : '--low';

  const countChips = [
    byCrit ? `<span class="badge badge-crit">${byCrit} Critical</span>` : '',
    byHigh ? `<span class="badge badge-high">${byHigh} High</span>` : '',
    byMed  ? `<span class="badge badge-warn">${byMed} Medium</span>` : '',
    byLow  ? `<span class="badge badge-ok">${byLow} Low</span>` : '',
  ].filter(Boolean).join('');

  const critDot = byCrit ? '<span class="alerts-crit-dot"></span>' : '';

  panel.innerHTML = `
    <div class="alerts-container alerts-container${severityCls}">
      <div class="alerts-header">
        ${critDot}
        <span style="font-size:1rem;line-height:1">&#x26A0;&#xFE0F;</span>
        <span class="alerts-title">Staffing Alerts &amp; Recommendations</span>
        <span style="display:flex;gap:5px;align-items:center">${countChips}</span>
        <button class="btn-ghost" id="st-alerts-toggle" style="margin-left:6px;white-space:nowrap">Show top 10 &#9660;</button>
      </div>
      <div id="st-alerts-list"></div>
    </div>`;

  const shown = alerts.slice(0, 10);
  let expanded = false;
  const list = document.getElementById('st-alerts-list');

  const CARD_CLASS  = { Critical: 'crit', High: 'high', Medium: 'warn', Low: 'low' };
  const BADGE_CLASS = { Critical: 'badge-crit', High: 'badge-high', Medium: 'badge-warn', Low: 'badge-ok' };

  function cleanTaskName(raw) {
    // Strip trailing " - HH:MM-HH:MM - ..." time/staffing info if present
    return (raw || '').replace(/\s*-\s*\d{2}:\d{2}-\d{2}:\d{2}.*$/, '').trim() || raw;
  }

  function renderAlertsList(items) {
    list.innerHTML = items.map((a, idx) => {
      const flights   = a.covered_flights || [];
      const flightStr = flights.length
        ? flights.slice(0, 3).map(f => f.flight_no).join(', ') + (flights.length > 3 ? ` +${flights.length - 3}` : '')
        : (a.flight_no || '');
      const cardCls  = CARD_CLASS[a.priority]  || 'warn';
      const badgeCls = BADGE_CLASS[a.priority] || 'badge-warn';
      const termLoc  = `${a.terminal || 'ALL'} / ${a.pier || 'ALL'}`;
      const taskName = cleanTaskName(a.task);
      const subDesc  = flightStr
        ? `&#x2708; ${flightStr} &mdash; ${a.message}`
        : (a.message || '');

      const staffPct = a.staff_needed > 0
        ? Math.min(100, Math.round((a.assigned_count / a.staff_needed) * 100))
        : 0;

      const recHtml = (a.rec_staff && a.rec_staff.length)
        ? `<div class="alert-rec-chips">${a.rec_staff.map(s => `<span class="alert-rec-chip">${s}</span>`).join('')}</div>
           <button class="btn-apply-rec"
             data-date="${date}"
             data-task="${a.task_id}"
             data-staff='${JSON.stringify(a.rec_staff)}'>&#x25B6; Apply</button>`
        : `<span class="alert-no-staff">No available staff</span>`;

      return `
        <div class="alert-card alert-card-${cardCls}" data-alert-idx="${idx}">
          <div class="alert-card-stripe"></div>
          <div class="alert-card-body">
            <div class="alert-card-toprow">
              <span class="badge ${badgeCls}" style="flex-shrink:0">${a.priority}</span>
              <span class="alert-task-label">${taskName}</span>
              <span class="alert-time-chip">${a.start}&ndash;${a.end}</span>
              <span class="alert-loc-chip">${termLoc}</span>
            </div>
            <div class="alert-card-subrow">${subDesc}</div>
          </div>
          <div class="alert-staffing-col">
            <div class="alert-staff-ratio">
              <span class="alert-staff-cur">${a.assigned_count}</span>
              <span class="alert-staff-total">/${a.staff_needed}</span>
            </div>
            <div class="alert-staffing-bar">
              <div class="alert-staffing-bar-fill" style="width:${staffPct}%"></div>
            </div>
            <div class="alert-staff-lbl">staff</div>
            <div class="alert-gap-pill">&minus;${a.gap} gap</div>
          </div>
          <div class="alert-rec-col">${recHtml}</div>
        </div>`;
    }).join('');

    list.querySelectorAll('.btn-apply-rec').forEach(btn =>
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        applySTRecommendation(btn);
      }));
    list.querySelectorAll('.alert-card[data-alert-idx]').forEach(card =>
      card.addEventListener('click', () => showSTAlertDetail(items[Number(card.dataset.alertIdx)])));
  }

  renderAlertsList(shown);

  document.getElementById('st-alerts-toggle').addEventListener('click', function() {
    expanded = !expanded;
    renderAlertsList(expanded ? alerts : shown);
    this.textContent = expanded ? 'Show top 10 ▲' : 'Show top 10 ▼';
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
  // guard: if legacy 'staff' tab was active, redirect to timeline
  if (ST_ACTIVE_TAB === 'staff') ST_ACTIVE_TAB = 'staff-timeline';
  if (ST_ACTIVE_TAB === 'demand') renderSTDemandTab(el);
  else if (ST_ACTIVE_TAB === 'staff-timeline') renderSTRosterTimeline(el);
  else if (ST_ACTIVE_TAB === 'roster-board') renderSTRosterBoard(el);
  else if (ST_ACTIVE_TAB === 'opt') renderSTOptimization(el);
}

// ── Roster Timeline Tab ──────────────────────────────────────────
async function renderSTRosterTimeline(container) {
  if (!ST_DATA) return;
  
  container.innerHTML = `
    <div class="panel mt-16">
      <div class="panel-title-row">
        <span class="panel-title">Operational Roster Timeline — ${ST_DATA.date_label}</span>
        <div class="filter-row" style="flex-wrap:wrap;gap:6px">
          <input class="search-input" id="st-staff-timeline-search" placeholder="Search staff ID / skill…" style="width:180px" />
          <select id="st-staff-timeline-shift" class="select-input">
            <option value="">All Shifts</option>
            ${[...new Set((ST_DATA.staff||[]).map(s=>s.shift).filter(Boolean))].sort().map(sh => {
              const samp = (ST_DATA.staff||[]).find(s=>s.shift===sh);
              const lbl  = samp?.shift_label || sh;
              return `<option value="${sh}">${lbl}</option>`;
            }).join('')}
          </select>
        </div>
      </div>
      <div id="st-staff-timeline" style="margin-top:16px;overflow-x:auto;"></div>
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
              <div style="font-size:0.55rem; color:var(--muted); font-weight:700; text-transform:uppercase; letter-spacing:0.02em">${fmtSkill(s.skill1)}</div>
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

  const doRefresh = () => {
    const q = searchInput.value.toLowerCase();
    const sf = shiftSelect.value;
    const filtered = (ST_DATA.staff || []).filter(s => {
      const mq = !q || s.id.toLowerCase().includes(q) || s.skill1.toLowerCase().includes(q);
      const ms = !sf || s.shift.toLowerCase() === sf.toLowerCase();
      return mq && ms;
    });
    const timelineEl = document.getElementById('st-staff-timeline');
    if (!timelineEl) return;
    renderST3HrBlocksTable(timelineEl, filtered);
  };

  searchInput.addEventListener('input', doRefresh);
  shiftSelect.addEventListener('change', doRefresh);
  doRefresh();

  // Render the Workforce Coverage heatmap beneath the roster timeline
  try {
    renderSTHourlyCoverage();
  } catch (e) {
    console.warn('Coverage render failed', e);
  }
}

// ── Roster Timeline 3-Hour Block Table ────────────────────────────
function renderST3HrBlocksTable(el, staffList) {
  if (!staffList.length) {
    el.innerHTML = '<div class="muted small" style="padding:16px">No staff match your filter.</div>';
    return;
  }

  function getBlockInfo(s, block) {
    const S = s.shift_start || 0;
    const E = s.shift_end   || (S + 720);
    if (!(S < block.end && E > block.start)) return null;
    const inBlock = (s.assignments || []).filter(a =>
      a.start_mins < block.end && a.end_mins > block.start
    );
    const blockBreaks = (s.breaks || []).filter(b =>
      b.start_mins < block.end && b.end_mins > block.start
    );
    if (!inBlock.length) return { skill: null, terminal: null, color: '#94a3b8', blockBreaks };
    const skillTime = {};
    inBlock.forEach(a => {
      const ov = Math.min(a.end_mins, block.end) - Math.max(a.start_mins, block.start);
      skillTime[a.skill] = (skillTime[a.skill] || 0) + ov;
    });
    const topSk = Object.entries(skillTime).sort((a,b)=>b[1]-a[1])[0][0];
    const domAsgn = inBlock.filter(a => a.skill === topSk)
      .sort((a,b) => (Math.min(b.end_mins,block.end)-Math.max(b.start_mins,block.start)) -
                     (Math.min(a.end_mins,block.end)-Math.max(a.start_mins,block.start)))[0];
    return { skill: topSk, terminal: domAsgn?.terminal || null, color: ST_SKILL_COLOR[topSk] || '#888', blockBreaks };
  }

  const rows = staffList.map(s => {
    const utilColor = s.utilisation_pct > 90 ? ST.crit : s.utilisation_pct > 70 ? ST.warn : ST.ok;
    const sk1 = fmtSkill(s.skill1);
    const grp = s.break_group || '';
    const grpColor = grp === 'A' ? '#2563EB' : '#059669';

    const cells = ST_TIME_BLOCKS.map(b => {
      const info = getBlockInfo(s, b);
      if (!info) return `<td class="st3-cell st3-off">–</td>`;

      // Build break rows to embed inside the cell
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

      // "No task, but on shift" cell
      if (!info.skill) {
        return `<td class="st3-cell" style="background:#94a3b814;color:#94a3b8;
            border:1px solid #94a3b830;text-align:center;vertical-align:middle;padding:4px 3px"
            title="${b.label}: On shift${info.blockBreaks.map(br=>' | '+br.type+' '+br.start+'–'+br.end).join('')}">
          <div style="font-size:0.6rem;opacity:0.6">On shift</div>
          ${brkRows}
        </td>`;
      }

      const termBadge = info.terminal
        ? `<div style="font-size:0.58rem;font-weight:800;opacity:0.9;line-height:1.1;letter-spacing:0.02em">${info.terminal}</div>`
        : '';
      // Thicker colored left border when a break falls in this block
      const brkAccent = info.blockBreaks.length
        ? `border-left:3px solid ${grpColor};`
        : `border-left:3px solid transparent;`;

      return `<td class="st3-cell" style="background:${info.color}20;color:${info.color};
          border:1px solid ${info.color}50;${brkAccent}
          text-align:center;vertical-align:middle;padding:3px 3px;min-width:68px"
          title="${b.label}: ${info.skill}${info.terminal?' @ '+info.terminal:''}${info.blockBreaks.map(br=>' | '+br.type+' '+br.start+'–'+br.end).join('')}">
        ${termBadge}
        <div style="font-size:0.62rem;font-weight:700;line-height:1.2">${info.skill}</div>
        ${brkRows}
      </td>`;
    }).join('');

    return `<tr>
      <td style="padding:6px 10px;font-weight:700;font-size:0.82rem;white-space:nowrap">${s.id}</td>
      <td style="padding:6px 10px;font-size:0.78rem"><span style="color:${ST_SKILL_COLOR[sk1]||'#888'};font-weight:600">${sk1}</span></td>
      <td style="padding:6px 10px;font-size:0.75rem;white-space:nowrap">${s.shift_label || s.shift}</td>
      <td style="padding:6px 10px;font-size:0.75rem;font-weight:700;color:${utilColor}">${Math.round(s.utilisation_pct)}%</td>
      ${cells}
    </tr>`;
  }).join('');

  el.innerHTML = `<div style="overflow-x:auto">
    <table style="width:100%;border-collapse:collapse;font-size:0.82rem">
      <thead>
        <tr style="border-bottom:2px solid var(--border)">
          <th style="padding:8px 10px;text-align:left">Staff</th>
          <th style="padding:8px 10px;text-align:left">Skill</th>
          <th style="padding:8px 10px;text-align:left">Shift</th>
          <th style="padding:8px 10px;text-align:left">Util</th>
          ${ST_TIME_BLOCKS.map(b=>`<th style="padding:6px 4px;text-align:center;font-size:0.72rem;white-space:nowrap">${b.label}</th>`).join('')}
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <div style="display:flex;gap:16px;flex-wrap:wrap;padding:10px 0 2px;font-size:0.72rem;color:var(--muted);align-items:center">
      <span><span style="display:inline-block;width:10px;height:6px;border-radius:2px;background:#f97316;margin-right:4px;vertical-align:middle"></span>☕ Short Break (30 min)</span>
      <span><span style="display:inline-block;width:10px;height:6px;border-radius:2px;background:#dc2626;margin-right:4px;vertical-align:middle"></span>🍽 Meal Break (60 min)</span>
      <span style="color:#2563EB;font-weight:700">| Grp A</span>
      <span style="color:#059669;font-weight:700">| Grp B</span>
      <span style="opacity:0.5">Colored left border = break falls in that block</span>
    </div>
  </div>`;
}

// ── Roster Board Tab ─────────────────────────────────────────────
async function renderSTRosterBoard(container) {
  container.innerHTML = `
    <div class="panel mt-16" style="min-height:200px">
      <div class="loading-spinner"><div class="spinner"></div><span>Loading optimised roster board…</span></div>
    </div>`;

  // Shift template colours (must match _ROSTER_SHIFTS in app.py)
  const TMPL = {
    Early:   { color:'#f97316', range:'00–12' },
    Mid:     { color:'#3b82f6', range:'06–18' },
    Late:    { color:'#8b5cf6', range:'12–24' },
    Evening: { color:'#10b981', range:'16–04' },
    Night:   { color:'#ec4899', range:'22–10' },
    LEAVE:   { color:'#6b7280', range:''      },
    OFF:     { color:'#374151', range:''      },
    OTHER:   { color:'#6b7280', range:''      },
  };

  const runOptimise = async (extendedShifts) => {
    const baseShifts = [
      [0, 720, '00:00'], [360, 1080, '06:00'], [720, 1440, '12:00'],
      [960, 1680, '16:00'], [1320, 2040, '22:00'],
    ];
    const extShifts = [
      ...baseShifts,
      [180, 900, '03:00'], [540, 1260, '09:00'], [900, 1620, '15:00'],
    ];
    const payload = {
      date: ST_CURRENT_DATE,
      use_mip: true, shift_duration_hrs: 12,
      b1_duration_mins: 30, b2_duration_mins: 60,
      tt_t1_t2: 15, tt_skill_switch: 10,
      use_primary_first: true, allow_overlaps: false,
      leave_types_excluded: [],
      permitted_shifts: extendedShifts ? extShifts : baseShifts,
    };
    ST_DATA = await fetch('/api/short-term/optimise', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(payload),
    }).then(r => r.json());
  };

  const draw = async () => {
    container.innerHTML = `<div class="panel mt-16" style="min-height:200px">
      <div class="loading-spinner"><div class="spinner"></div><span>Loading optimised roster board…</span></div>
    </div>`;
    try {
      const data = await fetch('/api/short-term/roster-board').then(r => r.json());
      if (data.error) throw new Error(data.error);
      const { dates, employees, day_stats = {} } = data;

      // Coverage header cells
      const covHtml = dates.map(d => {
        const st = day_stats[d.date] || {};
        const pct = st.coverage_pct || 0;
        const col = pct >= 85 ? 'var(--ok)' : pct >= 65 ? 'var(--warn)' : 'var(--crit)';
        return `<th style="padding:10px 12px;text-align:center;min-width:120px">
          <div style="font-weight:700;font-size:0.88rem">${d.label}</div>
          <div style="font-size:0.72rem;color:${col};font-weight:700;margin-top:2px">${pct}% coverage</div>
          <div style="font-size:0.67rem;color:var(--muted)">${st.staff_count||0} on duty · ${st.absent||0} absent</div>
        </th>`;
      }).join('');

      container.innerHTML = `
        <div class="panel mt-16">
          <div class="panel-title-row" style="margin-bottom:16px;border-bottom:1px solid var(--border);padding-bottom:14px;flex-wrap:wrap;gap:10px">
            <div>
              <h2 class="panel-title" style="margin:0;font-size:1.2rem;color:var(--text);text-transform:none;">📋 Roster Board — Optimised Shift Assignments</h2>
              <p class="section-hint" style="margin:5px 0 0;font-size:0.82rem">Shifts auto-assigned to maximise PAX coverage using 5 base shift windows (Early/Mid/Late/Evening/Night).</p>
            </div>
            <div style="display:flex;gap:8px;align-items:center;flex-shrink:0">
              <button id="rb-reopt-btn" class="btn-update-fluid" style="font-size:0.8rem;padding:7px 14px">⚡ Re-optimise</button>
              <button id="rb-ext-btn"  class="btn-ghost"         style="font-size:0.8rem" title="Add 3 extra shift windows for higher coverage">+ Extended Shifts</button>
            </div>
          </div>

          <!-- Shift template legend -->
          <div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:14px;padding:8px 0;border-bottom:1px solid var(--border)">
            ${Object.entries(TMPL).filter(([t])=>!['LEAVE','OFF','OTHER'].includes(t)).map(([t,v])=>`
              <div style="display:flex;align-items:center;gap:5px;font-size:0.78rem">
                <div style="width:12px;height:12px;border-radius:3px;background:${v.color}"></div>
                <strong>${t}</strong><span style="color:var(--muted)">${v.range}</span>
              </div>`).join('')}
            <div style="display:flex;align-items:center;gap:5px;font-size:0.78rem">
              <div style="width:12px;height:12px;border-radius:3px;background:#6b7280"></div><span style="color:var(--muted)">Leave / Other</span>
            </div>
            <div style="display:flex;align-items:center;gap:5px;font-size:0.78rem">
              <div style="width:12px;height:12px;border-radius:3px;background:#374151"></div><span style="color:var(--muted)">Off</span>
            </div>
          </div>

          <div style="overflow-x:auto">
            <table style="width:100%;border-collapse:collapse;font-size:0.82rem">
              <thead>
                <tr style="border-bottom:2px solid var(--border)">
                  <th style="padding:10px 12px;text-align:left;min-width:70px">Staff</th>
                  <th style="padding:10px 12px;text-align:left;min-width:80px">Skill</th>
                  ${covHtml}
                </tr>
              </thead>
              <tbody>
                ${employees.map(emp => `
                  <tr style="border-bottom:1px solid var(--border)">
                    <td style="padding:6px 12px;font-weight:700;font-size:0.82rem">${emp.id}</td>
                    <td style="padding:6px 12px;font-size:0.75rem;color:${ST_SKILL_COLOR[fmtSkill(emp.skill)]||ST_SKILL_COLOR[emp.skill]||'#888'};font-weight:600">${fmtSkill(emp.skill)}</td>
                    ${dates.map(d => {
                      const sh = emp.shifts[d.date] || {template_id:'OFF',timings:'',is_absent:false};
                      const tid = sh.template_id || (sh.is_absent ? 'LEAVE' : 'OFF');
                      const meta = TMPL[tid] || TMPL.OTHER;
                      const label = tid === 'OFF' ? 'Off' : tid === 'LEAVE' ? 'Leave' : tid;
                      return `<td style="padding:5px 8px">
                        <div style="background:${meta.color}20;border:1px solid ${meta.color}55;border-radius:5px;padding:5px 8px;text-align:center">
                          <div style="font-size:0.8rem;font-weight:700;color:${meta.color}">${label}</div>
                          ${sh.timings ? `<div style="font-size:0.65rem;color:var(--muted)">${sh.timings}</div>` : ''}
                        </div>
                      </td>`;
                    }).join('')}
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>

          <!-- Shift distribution summary -->
          <div style="margin-top:16px;padding-top:12px;border-top:1px solid var(--border);display:flex;gap:24px;flex-wrap:wrap">
            ${dates.map(d => {
              const cnt = {};
              employees.forEach(e => {
                const t = e.shifts[d.date]?.template_id || 'OFF';
                cnt[t] = (cnt[t]||0) + 1;
              });
              return `<div>
                <div style="font-size:0.78rem;font-weight:700;margin-bottom:6px">${d.label}</div>
                ${Object.entries(cnt).map(([t,n]) => {
                  const c = (TMPL[t]||TMPL.OTHER).color;
                  return `<div style="font-size:0.72rem;margin-bottom:3px;display:flex;align-items:center;gap:4px">
                    <span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${c}"></span>${t}: ${n}
                  </div>`;
                }).join('')}
              </div>`;
            }).join('')}
          </div>
        </div>`;

      const refreshAllTabs = async () => {
        // Re-render KPIs and alerts from the updated ST_DATA
        if (ST_DATA?.kpis) renderSTKPIs(ST_DATA.kpis);
        if (ST_DATA?.alerts !== undefined) renderSTAlerts(ST_DATA.alerts, ST_DATA.date);
        // Rebuild the Roster Board grid
        await draw();
        // If the user is currently on another sub-tab, refresh it too
        if (ST_ACTIVE_TAB !== 'roster-board') renderSTSubContent();
      };

      // Re-optimise current day button (MIP always on)
      document.getElementById('rb-reopt-btn')?.addEventListener('click', async () => {
        const btn = document.getElementById('rb-reopt-btn');
        btn.disabled = true;
        btn.innerHTML = '<span style="display:inline-block;width:10px;height:10px;border:2px solid #fff;border-top-color:transparent;border-radius:50%;animation:spin 0.6s linear infinite;vertical-align:middle;margin-right:5px"></span>Optimising…';
        await runOptimise(false);
        await refreshAllTabs();
      });

      // Extended shifts button
      document.getElementById('rb-ext-btn')?.addEventListener('click', async () => {
        const btn = document.getElementById('rb-ext-btn');
        btn.disabled = true; btn.textContent = 'Adding shifts…';
        await runOptimise(true);
        await refreshAllTabs();
      });

    } catch (err) {
      container.innerHTML = `<div class="panel mt-16" style="border-top:4px solid var(--crit)">
        <h2 class="panel-title">Roster Board Error</h2>
        <div style="padding:12px;border-radius:6px;background:var(--crit-light);color:var(--crit)">${err.message}</div>
      </div>`;
    }
  };

  await draw();
}

// ── Workforce Coverage (Hourly Heatmap) for Short-Term ─────────────
function buildSTCoverageData(tasks) {
  const hours = [];
  for (let h = 4; h <= 23; h++) hours.push(h);

  // Always PAX skills only
  const paxSkills = Array.isArray(ST_DATA?.pax_coverage_skills) ? ST_DATA.pax_coverage_skills : [];
  const skills = paxSkills.length ? paxSkills.slice()
    : Array.isArray(ST_COVERAGE_SKILLS) ? ST_COVERAGE_SKILLS.slice() : [];

  // Accumulate per-15-min slot (96 slots in a day)
  const slotData = {};
  skills.forEach(sk => {
    slotData[sk] = Array.from({length: 96}, () => ({ req: 0, assigned: new Set() }));
  });

  (tasks || []).forEach(task => {
    let sk = task.skill || task.role || task.task || '';
    if (!slotData[sk]) {
      const base = sk.split(' -- ')[0];
      if (slotData[base]) sk = base; else return;
    }
    const startSlot = Math.floor(task.start_mins / 15);
    const endSlot   = Math.ceil(task.end_mins / 15) - 1;
    const staffIds  = task.assigned || [];
    for (let slot = startSlot; slot <= endSlot; slot++) {
      if (slot < 0 || slot >= 96) continue;
      slotData[sk][slot].req += (task.staff_needed || 0);
      staffIds.forEach(sid => slotData[sk][slot].assigned.add(sid));
    }
  });

  // Aggregate to hourly: average the 4 slots within each hour
  const data = {};
  skills.forEach(sk => {
    data[sk] = {};
    hours.forEach(h => {
      let reqSum = 0, asgnSum = 0, filled = 0;
      for (let m = 0; m < 4; m++) {
        const slot = h * 4 + m;
        if (slot < 96) {
          reqSum  += slotData[sk][slot].req;
          asgnSum += slotData[sk][slot].assigned.size;
          filled++;
        }
      }
      data[sk][h] = {
        req:      filled ? Math.round(reqSum  / filled) : 0,
        assigned: filled ? Math.round(asgnSum / filled) : 0,
      };
    });
  });

  return { data, hours, skills };
}

function buildSTCoverageTableHTML(tasks) {
  const { data, hours, skills } = buildSTCoverageData(tasks);

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

  const fReq = hours.map((h, i) => `<td style="font-weight:700;">${totalsReq[i] || '—'}</td>`).join('');
  const fAsgn = hours.map((h, i) => `<td style="font-weight:700;color:#3b82f6;">${totalsAssigned[i] || '—'}</td>`).join('');
  const fGap = hours.map((h, i) => {
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

function renderSTHourlyCoverage() {
  const wrapper = document.getElementById('st-sub-content');
  if (!wrapper) return;

  let section = document.getElementById('st-hourly-coverage-section');
  if (!section) {
    section = document.createElement('div');
    section.id = 'st-hourly-coverage-section';
    section.className = 'mt-24';
    section.innerHTML = `
      <div class="section-header" style="margin-bottom:8px;">
        <h2 style="font-size:1rem;font-weight:700;color:var(--text);">Workforce Coverage — Short-Term</h2>
        <span class="section-hint">Assigned / Required per skill per hour. PAX touchpoints only.</span>
      </div>
      <div class="legend-row mb-12">
        <span class="leg surplus"></span><span>Surplus</span>
        <span class="leg adequate"></span><span>Adequate</span>
        <span class="leg warning"></span><span>Warning</span>
        <span class="leg gap"></span><span>Gap</span>
      </div>
      <div class="heatmap-wrapper" id="st-hourly-heatmap-wrapper" style="overflow-x:auto;">
        <table class="heatmap-table heatmap-table--fluid" id="st-hourly-heatmap"></table>
      </div>`;
    const panel = wrapper.querySelector('.panel');
    if (panel) panel.appendChild(section);
  }

  const table = document.getElementById('st-hourly-heatmap');
  if (table) table.innerHTML = buildSTCoverageTableHTML(ST_DATA.tasks || []);
}

// ── Optimization Tab ─────────────────────────────────────────────
async function renderSTOptimization(container) {
  const SHIFT_META = {
    Early:   { color:'#f97316', range:'00:00–12:00', s:0,    e:720  },
    Mid:     { color:'#3b82f6', range:'06:00–18:00', s:360,  e:1080 },
    Late:    { color:'#8b5cf6', range:'12:00–00:00', s:720,  e:1440 },
    Evening: { color:'#10b981', range:'16:00–04:00', s:960,  e:1680 },
    Night:   { color:'#ec4899', range:'22:00–10:00', s:1320, e:2040 },
  };

  // Load existing constraints for pre-fill
  container.innerHTML = `<div class="panel mt-20"><div class="loading-spinner"><div class="spinner"></div><span>Loading optimiser…</span></div></div>`;
  let constraints = {};
  try {
    const r = await fetch(`/api/short-term/constraints?date=${ST_CURRENT_DATE}`);
    constraints = await r.json();
  } catch (_) {}

  container.innerHTML = `
    <div class="panel mt-20" style="border-top:4px solid var(--accent);">
      <div class="panel-title-row" style="margin-bottom:20px;border-bottom:1px solid var(--border);padding-bottom:16px;flex-wrap:wrap;gap:10px;">
        <div>
          <h2 class="panel-title" style="margin:0;font-size:1.4rem;color:var(--text);text-transform:none;">⚙ Unified Optimiser — 3-Day Short Term</h2>
          <p class="section-hint" style="margin:6px 0 0;font-size:0.88rem;">
            Configure hard &amp; soft constraints, then run optimisation across all three short-term days.
            Results show day-by-day impact — apply selectively per day.
          </p>
        </div>
        <button class="btn-update-fluid" id="st-opt-run" style="min-width:200px;">⚡ Run All 3 Days</button>
      </div>

      <!-- ══ HARD CONSTRAINTS ══ -->
      <div style="margin-bottom:24px;">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;padding-bottom:8px;border-bottom:2px solid #ef444430;">
          <div style="width:4px;height:20px;border-radius:2px;background:#ef4444;flex-shrink:0;"></div>
          <span style="font-weight:800;font-size:0.88rem;color:#ef4444;text-transform:uppercase;letter-spacing:.05em;">Hard Constraints</span>
          <span style="font-size:0.78rem;color:var(--muted);">— must be satisfied during optimisation</span>
        </div>
        <div class="opt-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(255px,1fr));gap:16px;">

          <!-- Coverage & Time Rules -->
          <div class="opt-card" style="border-left:3px solid #ef4444;">
            <div class="opt-card-title"><span style="color:#ef4444">📊</span> Coverage &amp; Time Rules</div>
            <div style="display:flex;gap:10px;margin-bottom:10px;">
              <div style="flex:1"><label class="opt-label">Shift Duration (hrs)</label>
                <input type="number" id="opt-shift-hrs" class="select-input" value="${constraints.shift_duration_hrs||12}" min="6" max="16" style="width:100%"/></div>
              <div style="flex:1"><label class="opt-label">Min Rest (hrs)</label>
                <input type="number" id="opt-rest-hrs" class="select-input" value="${constraints.min_rest_hrs||11}" min="8" max="16" style="width:100%"/></div>
            </div>
            <div>
              <label class="opt-label">Min Coverage Threshold (%)</label>
              <input type="number" id="opt-min-cov" class="select-input" value="${constraints.min_coverage_pct||80}" min="50" max="100" style="width:100%;margin-top:4px"/>
              <p class="opt-hint" style="margin-top:4px">Days falling below this are flagged as LOW_COVERAGE.</p>
            </div>
          </div>

          <!-- Break Rules + Skill Eligibility -->
          <div class="opt-card" style="border-left:3px solid #ef4444;">
            <div class="opt-card-title"><span style="color:#ef4444">☕</span> Break Rules &amp; Skill Eligibility</div>
            <div style="display:flex;gap:10px;margin-bottom:12px;">
              <div style="flex:1"><label class="opt-label">Short Break (min)</label>
                <input type="number" id="opt-b1" class="select-input" value="${constraints.b1_duration_mins||30}" min="15" max="60" style="width:100%"/></div>
              <div style="flex:1"><label class="opt-label">Meal Break (min)</label>
                <input type="number" id="opt-b2" class="select-input" value="${constraints.b2_duration_mins||60}" min="30" max="120" style="width:100%"/></div>
            </div>
            <div style="display:flex;align-items:flex-start;gap:10px;padding:8px;background:#ef444410;border-radius:5px;border:1px solid #ef444425;">
              <input type="checkbox" id="opt-prim-first" style="width:16px;height:16px;accent-color:#ef4444;cursor:pointer;margin-top:2px;flex-shrink:0" ${constraints.use_primary_first!==false?'checked':''}/>
              <label for="opt-prim-first" style="font-size:0.82rem;cursor:pointer;color:var(--text)">
                <strong>Primary Skills First</strong><br>
                <span style="font-size:0.72rem;color:var(--muted)">Staff are assigned to tasks matching their primary skill before secondary skills are considered.</span>
              </label>
            </div>
          </div>

          <!-- Leave Exclusion -->
          <div class="opt-card" style="border-left:3px solid #ef4444;">
            <div class="opt-card-title"><span style="color:#ef4444">🚫</span> Leave Exclusion</div>
            <p class="opt-hint">Staff on these leave types are removed before optimisation runs.</p>
            <div id="opt-leave-toggles" style="display:flex;flex-direction:column;gap:8px;margin-top:10px;">
              ${["Annual Leave","Sick Leave","Jury Duty","Paternity Leave","Training"].map(lt => `
                <div style="display:flex;align-items:center;gap:10px;">
                  <input type="checkbox" id="opt-lt-${lt.replace(/\s+/g,'-')}" value="${lt}"
                    style="width:16px;height:16px;accent-color:#ef4444;cursor:pointer"
                    ${(constraints.leave_types_excluded||[]).includes(lt)?'checked':''}/>
                  <label for="opt-lt-${lt.replace(/\s+/g,'-')}" class="opt-label" style="margin:0;cursor:pointer;font-size:0.82rem">${lt}</label>
                </div>`).join('')}
            </div>
          </div>

          <!-- Permitted Shift Windows -->
          <div class="opt-card" style="border-left:3px solid #ef4444;">
            <div class="opt-card-title"><span style="color:#ef4444">📅</span> Permitted Shift Windows</div>
            <p class="opt-hint">Only ticked shift patterns will be assigned. Unchecked shifts become invalid for scheduling.</p>
            <div id="opt-shift-toggles" style="display:flex;flex-direction:column;gap:8px;margin-top:10px;">
              ${Object.entries(SHIFT_META).map(([name, m], i) => {
                const def = i < 3;
                const chk = (constraints.permitted_shifts||[]).some(p => p[0]===m.s && p[1]===m.e)
                          || (!constraints.permitted_shifts && def);
                return `<div style="display:flex;align-items:center;gap:10px;">
                  <input type="checkbox" class="opt-sh-chk" id="opt-sh-${i}"
                    data-label="${name}" data-start="${m.s}" data-end="${m.e}"
                    style="width:16px;height:16px;accent-color:${m.color};cursor:pointer" ${chk?'checked':''}/>
                  <label for="opt-sh-${i}" style="margin:0;cursor:pointer;font-size:0.82rem;display:flex;align-items:center;gap:7px;">
                    <span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${m.color};flex-shrink:0"></span>
                    <strong style="color:${m.color}">${name}</strong>
                    <span style="color:var(--muted)">${m.range}</span>
                  </label>
                </div>`;
              }).join('')}
            </div>
          </div>

        </div>
      </div>

      <!-- ══ SOFT CONSTRAINTS ══ -->
      <div style="margin-bottom:24px;">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;padding-bottom:8px;border-bottom:2px solid #3b82f630;">
          <div style="width:4px;height:20px;border-radius:2px;background:#3b82f6;flex-shrink:0;"></div>
          <span style="font-weight:800;font-size:0.88rem;color:#3b82f6;text-transform:uppercase;letter-spacing:.05em;">Soft Constraints</span>
          <span style="font-size:0.78rem;color:var(--muted);">— optimisation preferences &amp; objective weights</span>
        </div>
        <div class="opt-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(255px,1fr));gap:16px;">

          <!-- Solver -->
          <div class="opt-card" style="border-left:3px solid #3b82f6;">
            <div class="opt-card-title"><span style="color:#3b82f6">🧮</span> Solver</div>
            <p class="opt-hint">MIP (CBC) minimises skill mismatch + workload inequality after greedy pass. Requires PuLP.</p>
            <div style="display:flex;flex-direction:column;gap:10px;margin-top:12px;">
              <div style="display:flex;align-items:center;gap:10px;">
                <input type="checkbox" id="opt-mip" style="width:18px;height:18px;accent-color:#3b82f6;cursor:pointer" checked/>
                <label for="opt-mip" class="opt-label" style="margin:0;cursor:pointer">Enable MIP Refinement</label>
              </div>
              <div style="display:flex;align-items:center;gap:10px;">
                <input type="checkbox" id="opt-overlap" style="width:18px;height:18px;accent-color:#3b82f6;cursor:pointer" ${(constraints.allow_overlaps)?'checked':''}/>
                <label for="opt-overlap" class="opt-label" style="margin:0;cursor:pointer">Allow Schedule Overlaps</label>
              </div>
            </div>
          </div>

          <!-- Fairness & Overtime Minimisation -->
          <div class="opt-card" style="border-left:3px solid #3b82f6;">
            <div class="opt-card-title"><span style="color:#3b82f6">⚖</span> Fairness &amp; Overtime Minimisation</div>
            <div style="margin-bottom:14px;">
              <label class="opt-label">Fairness Weight</label>
              <div style="display:flex;align-items:center;gap:10px;margin-top:6px;">
                <input type="range" id="opt-fairness-weight" min="0" max="1" step="0.1"
                  value="${constraints.fairness_weight!=null?constraints.fairness_weight:0.5}"
                  style="flex:1;accent-color:#3b82f6;cursor:pointer"/>
                <span id="opt-fairness-val" style="font-size:0.88rem;font-weight:700;min-width:28px;text-align:right;color:#3b82f6">${constraints.fairness_weight!=null?(+constraints.fairness_weight).toFixed(1):'0.5'}</span>
              </div>
              <p class="opt-hint" style="margin-top:3px">0 = ignore fairness · 1 = maximise equal utilisation (Gini in MIP objective).</p>
            </div>
            <div>
              <label class="opt-label">Overtime Minimisation — Max Utilisation (%)</label>
              <input type="number" id="opt-max-util" class="select-input" value="${constraints.max_utilisation_pct||95}" min="50" max="100" style="width:100%;margin-top:4px"/>
              <p class="opt-hint" style="margin-top:3px">Staff exceeding this threshold are flagged as OVERTIME_RISK.</p>
            </div>
          </div>

          <!-- Secondary Skill Preference & Stability -->
          <div class="opt-card" style="border-left:3px solid #3b82f6;">
            <div class="opt-card-title"><span style="color:#3b82f6">🎓</span> Secondary Skill Preference</div>
            <div style="display:flex;align-items:flex-start;gap:10px;padding:8px;background:#3b82f610;border-radius:5px;border:1px solid #3b82f625;margin-bottom:12px;">
              <input type="checkbox" id="opt-allow-sec" style="width:16px;height:16px;accent-color:#3b82f6;cursor:pointer;margin-top:2px;flex-shrink:0" ${constraints.allow_secondary_skills!==false?'checked':''}/>
              <label for="opt-allow-sec" style="font-size:0.82rem;cursor:pointer;color:var(--text)">
                <strong>Allow Secondary Skills</strong><br>
                <span style="font-size:0.72rem;color:var(--muted)">When primary skill demand is met, staff can cover tasks using their secondary/tertiary skills.</span>
              </label>
            </div>
            <div style="padding:8px;background:#3b82f610;border-radius:5px;border-left:2px solid #3b82f6;">
              <p style="font-size:0.78rem;color:var(--muted);margin:0;">
                <strong style="color:#3b82f6">Stable Roster Patterns:</strong> D+1 to D+3 share the same permitted shift windows above, minimising pattern fragmentation across the 3-day horizon.
              </p>
            </div>
          </div>

          <!-- Travel Buffers -->
          <div class="opt-card" style="border-left:3px solid #3b82f6;">
            <div class="opt-card-title"><span style="color:#3b82f6">🚶</span> Travel Buffers (min)</div>
            <div style="margin-bottom:12px;">
              <label class="opt-label">T1 → T2 Transfer</label>
              <input type="number" id="opt-tt-t1t2" class="select-input" value="${constraints.tt_t1_t2||15}" min="0" max="60" style="width:100%;margin-top:4px"/>
            </div>
            <div>
              <label class="opt-label">Skill-Switch Transfer</label>
              <input type="number" id="opt-tt-sk" class="select-input" value="${constraints.tt_skill_switch||10}" min="0" max="60" style="width:100%;margin-top:4px"/>
            </div>
          </div>

        </div>
      </div>

      <!-- Results area -->
      <div id="opt-results"></div>
    </div>`;

  // Live fairness weight display
  const fwInput = document.getElementById('opt-fairness-weight');
  const fwVal   = document.getElementById('opt-fairness-val');
  if (fwInput && fwVal) {
    fwInput.addEventListener('input', () => { fwVal.textContent = parseFloat(fwInput.value).toFixed(1); });
  }

  // Restore cached results on tab re-visit
  if (ST_OPT_RESULTS_CACHE) {
    const resEl = document.getElementById('opt-results');
    if (resEl) _renderOptDayResults(resEl, ST_OPT_RESULTS_CACHE);
  }

  // ── Build payload for one date ─────────────────────────────────
  function _buildPayload(date) {
    const leaves = Array.from(document.querySelectorAll('#opt-leave-toggles input:checked')).map(cb => cb.value);
    const shifts  = Array.from(document.querySelectorAll('#opt-shift-toggles input:checked')).map(cb => [
      parseInt(cb.dataset.start, 10), parseInt(cb.dataset.end, 10), cb.dataset.label,
    ]);
    return {
      date,
      use_mip:               document.getElementById('opt-mip').checked,
      min_rest_hrs:          parseFloat(document.getElementById('opt-rest-hrs').value),
      shift_duration_hrs:    parseInt(document.getElementById('opt-shift-hrs').value, 10),
      b1_duration_mins:      parseInt(document.getElementById('opt-b1').value, 10),
      b2_duration_mins:      parseInt(document.getElementById('opt-b2').value, 10),
      tt_t1_t2:              parseInt(document.getElementById('opt-tt-t1t2').value, 10),
      tt_skill_switch:       parseInt(document.getElementById('opt-tt-sk').value, 10),
      use_primary_first:     document.getElementById('opt-prim-first').checked,
      allow_overlaps:        document.getElementById('opt-overlap').checked,
      leave_types_excluded:  leaves,
      permitted_shifts:      shifts,
      min_coverage_pct:      parseFloat(document.getElementById('opt-min-cov').value),
      max_utilisation_pct:   parseFloat(document.getElementById('opt-max-util').value),
      fairness_weight:       parseFloat(document.getElementById('opt-fairness-weight').value),
      allow_secondary_skills: document.getElementById('opt-allow-sec').checked,
    };
  }

  // ── Run All 3 Days ─────────────────────────────────────────────
  document.getElementById('st-opt-run').addEventListener('click', async () => {
    const btn   = document.getElementById('st-opt-run');
    const resEl = document.getElementById('opt-results');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner" style="width:12px;height:12px;border-width:2px;display:inline-block;vertical-align:middle;margin-right:6px"></span>Optimising 3 Days…';
    resEl.innerHTML = '<div class="loading-spinner"><div class="spinner"></div><span>Running optimisation across all 3 short-term days…</span></div>';

    const activeDates = ST_DATES.filter(d => d.has_data);

    try {
      // Fetch before-state and run all days in parallel
      const [boardData, ...dayResults] = await Promise.all([
        fetch('/api/short-term/roster-board').then(r => r.json()),
        ...activeDates.map(d =>
          fetch('/api/short-term/optimise', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(_buildPayload(d.date)),
          }).then(r => r.json()).then(data => ({ date: d.date, label: d.label, data }))
        ),
      ]);

      const before  = boardData.day_stats || {};
      const results = {};
      dayResults.forEach(({ date, data }) => { results[date] = data; });

      ST_OPT_RESULTS_CACHE = {
        dates:   activeDates.map(d => ({ date: d.date, label: d.label })),
        before,
        results,
        applied: {},
      };

      // Apply current date result to ST_DATA immediately
      if (results[ST_CURRENT_DATE]) ST_DATA = results[ST_CURRENT_DATE];

      _renderOptDayResults(resEl, ST_OPT_RESULTS_CACHE);

    } catch (err) {
      resEl.innerHTML = `<div class="panel mt-8" style="padding:16px;border-left:4px solid var(--crit);">
        <strong style="color:var(--crit)">✕ Optimiser error</strong><br/>
        <span style="font-size:0.85rem">${err.message}</span></div>`;
    } finally {
      btn.disabled = false;
      btn.innerHTML = '⚡ Run All 3 Days';
    }
  });

  // ── Render per-day impact cards ────────────────────────────────
  function _renderOptDayResults(el, cache) {
    const { dates, before, results, applied } = cache;

    const dayCardsHtml = dates.map(({ date, label }) => {
      const bef    = before[date] || {};
      const res    = results[date] || {};
      const roster = res.roster   || {};
      const kpis   = res.kpis     || {};
      const fair   = roster.fairness || {};

      const covB = typeof bef.coverage_pct  === 'number' ? bef.coverage_pct  : null;
      const covA = typeof kpis.coverage_pct === 'number' ? kpis.coverage_pct : null;
      const covDelta = (covB !== null && covA !== null) ? (covA - covB) : null;
      const covColor = covA === null ? '#6b7280' : covA >= 90 ? '#10b981' : covA >= 75 ? '#f59e0b' : '#ef4444';

      const staffCount = (res.staff || []).length;
      const absCount   = bef.absent ?? 0;
      const flags      = roster.flags || [];
      const flagCount  = flags.length;
      const gini       = typeof fair.gini_coefficient === 'number' ? fair.gini_coefficient.toFixed(3) : '—';
      const giniInterp = fair.interpretation || '';
      const giniColor  = giniInterp === 'excellent' ? '#10b981' : giniInterp === 'good' ? '#3b82f6' : giniInterp === 'moderate' ? '#f59e0b' : '#6b7280';
      const solver     = roster.solver_used || '—';
      const isMIP      = solver.toLowerCase().includes('mip') || solver.toLowerCase().includes('cbc');

      // Shift distribution
      const shiftCounts = {};
      (res.staff || []).forEach(s => {
        const sh = s.shift || 'Other';
        shiftCounts[sh] = (shiftCounts[sh] || 0) + 1;
      });
      const shiftBadges = Object.entries(shiftCounts).map(([sh, n]) => {
        const c = (SHIFT_META[sh] || {}).color || '#6b7280';
        return `<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:10px;background:${c}20;border:1px solid ${c}40;font-size:0.72rem;font-weight:700;color:${c}">
          <span style="width:7px;height:7px;border-radius:50%;background:${c};display:inline-block;"></span>${sh}&nbsp;${n}
        </span>`;
      }).join('');

      // Flag previews
      const flagHtml = flagCount
        ? `<div style="margin-bottom:10px;padding:8px;background:#ef444410;border-radius:5px;border-left:2px solid #ef4444;">
            <div style="font-size:0.72rem;font-weight:700;color:#ef4444;margin-bottom:4px;">⚠ ${flagCount} Flag${flagCount>1?'s':''}</div>
            ${flags.slice(0, 3).map(f => `<div style="font-size:0.72rem;color:var(--muted);padding:1px 0;">${f.flag_id}: ${f.detail}</div>`).join('')}
            ${flagCount > 3 ? `<div style="font-size:0.7rem;color:var(--muted);">+${flagCount-3} more</div>` : ''}
          </div>`
        : `<div style="margin-bottom:10px;padding:6px 10px;background:#10b98110;border-radius:5px;border-left:2px solid #10b981;font-size:0.75rem;color:#10b981;font-weight:600;">✓ No flags</div>`;

      const isApplied = !!applied[date];
      const noResult  = !Object.keys(res).length;

      return `
        <div class="opt-card" style="border-top:3px solid ${covColor};min-width:230px;flex:1 1 230px;display:flex;flex-direction:column;gap:0;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
            <div style="font-weight:800;font-size:0.95rem;color:var(--text)">📅 ${label}</div>
            ${isApplied ? `<span style="font-size:0.72rem;padding:2px 8px;border-radius:10px;background:#10b98120;border:1px solid #10b98140;color:#10b981;font-weight:700;">✓ Applied</span>` : ''}
          </div>

          <!-- Coverage before/after -->
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px;">
            <div style="padding:8px;background:var(--surface);border-radius:6px;text-align:center;">
              <div style="font-size:0.65rem;color:var(--muted);margin-bottom:2px;">Before</div>
              <div style="font-size:1.05rem;font-weight:700;color:var(--muted)">${covB !== null ? covB.toFixed(1)+'%' : '—'}</div>
            </div>
            <div style="padding:8px;background:${covColor}18;border-radius:6px;text-align:center;border:1px solid ${covColor}35;">
              <div style="font-size:0.65rem;color:var(--muted);margin-bottom:2px;">After</div>
              <div style="font-size:1.05rem;font-weight:700;color:${covColor}">${covA !== null ? covA.toFixed(1)+'%' : '—'}</div>
              ${covDelta !== null ? `<div style="font-size:0.68rem;font-weight:700;color:${covDelta>=0?'#10b981':'#ef4444'}">${covDelta>=0?'+':''}${covDelta.toFixed(1)}%</div>` : ''}
            </div>
          </div>

          <!-- Key metrics -->
          <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:5px;margin-bottom:10px;">
            <div style="padding:5px 4px;background:var(--surface);border-radius:5px;text-align:center;">
              <div style="font-size:0.6rem;color:var(--muted);">Staff</div>
              <div style="font-weight:700;font-size:0.88rem;">${staffCount||'—'}</div>
            </div>
            <div style="padding:5px 4px;background:var(--surface);border-radius:5px;text-align:center;">
              <div style="font-size:0.6rem;color:var(--muted);">Absent</div>
              <div style="font-weight:700;font-size:0.88rem;">${absCount}</div>
            </div>
            <div style="padding:5px 4px;background:${flagCount>0?'#ef444415':'#10b98115'};border-radius:5px;text-align:center;border:1px solid ${flagCount>0?'#ef444430':'#10b98130'};">
              <div style="font-size:0.6rem;color:var(--muted);">Flags</div>
              <div style="font-weight:700;font-size:0.88rem;color:${flagCount>0?'#ef4444':'#10b981'}">${noResult?'—':flagCount}</div>
            </div>
            <div style="padding:5px 4px;background:${isMIP?'#3b82f615':'var(--surface)'};border-radius:5px;text-align:center;">
              <div style="font-size:0.6rem;color:var(--muted);">Solver</div>
              <div style="font-weight:700;font-size:0.72rem;color:${isMIP?'#3b82f6':'var(--muted)'}">${isMIP?'MIP':'Greedy'}</div>
            </div>
          </div>

          <!-- Gini -->
          ${gini !== '—' ? `
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;padding:6px 10px;background:var(--surface);border-radius:5px;">
            <span style="font-size:0.75rem;color:var(--muted)">Fairness (Gini)</span>
            <span style="font-weight:700;font-size:0.82rem;color:${giniColor}">${gini} <span style="font-size:0.68rem">(${giniInterp||'—'})</span></span>
          </div>` : ''}

          <!-- Flags -->
          ${flagHtml}

          <!-- Shift distribution -->
          ${shiftBadges ? `
          <div style="margin-bottom:12px;">
            <div style="font-size:0.7rem;color:var(--muted);font-weight:600;margin-bottom:5px;">Shift Distribution</div>
            <div style="display:flex;flex-wrap:wrap;gap:4px;">${shiftBadges}</div>
          </div>` : ''}

          <!-- Apply button -->
          <div style="margin-top:auto;padding-top:10px;">
            <button class="opt-apply-btn ${isApplied?'btn-ghost':'btn-update-fluid'}"
              data-date="${date}" data-label="${label}"
              style="width:100%;font-size:0.82rem;padding:7px 12px;"
              ${noResult ? 'disabled' : ''}>
              ${isApplied ? '✓ Applied — Switch to this Day' : `Apply to ${label}`}
            </button>
          </div>
        </div>`;
    }).join('');

    el.innerHTML = `
      <div style="margin-top:24px;padding-top:20px;border-top:2px solid var(--border);">
        <div style="font-weight:800;font-size:1rem;margin-bottom:4px;color:var(--text);">📊 Optimisation Results — Day-by-Day Impact</div>
        <div style="font-size:0.8rem;color:var(--muted);margin-bottom:16px;">Click <strong>Apply</strong> on any day to activate its optimised schedule across all tabs.</div>
        <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:stretch;">${dayCardsHtml}</div>
      </div>`;

    // Apply button handlers
    el.querySelectorAll('.opt-apply-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const date  = btn.dataset.date;
        const label = btn.dataset.label;
        const res   = cache.results[date];
        if (!res) return;

        // Switch global state to this day
        ST_CURRENT_DATE = date;
        ST_DATA         = res;

        // Update day-tab highlight
        document.querySelectorAll('.day-tab').forEach(b =>
          b.classList.toggle('active', b.dataset.date === date));

        // Refresh KPIs + alerts inline
        if (ST_DATA.kpis)              renderSTKPIs(ST_DATA.kpis);
        if (ST_DATA.alerts !== undefined) renderSTAlerts(ST_DATA.alerts, ST_DATA.date);

        // Mark applied and re-render cards
        cache.applied[date] = true;
        _renderOptDayResults(el, cache);
      });
    });
  }
}

// ──────────────────────────────────────────────────────────────────
// LEGACY SKILL COLORS (kept for compatibility with older references)
// ──────────────────────────────────────────────────────────────────
const _OPT_SKILL_COLORS = {
  'GNIB':'#3498DB','CBP Pre-clearance':'#9B59B6','Bussing':'#E8850A',
    'PBZ':'#2ECC71','Mezz Operation':'#1ABC9C','Litter Picking':'#E74C3C',
    'Ramp / Marshalling':'#F39C12','Arr Customer Service':'#5DADE2',
    'Check-in/Trolleys':'#A9CCE3','Transfer Corridor':'#27AE60',
    'Dep / Trolleys':'#8E44AD','T1/T2 Trolleys L/UL':'#E91E63',
  };



function renderSTDemandTab(container) {
  const tasks = ST_DATA.tasks || [];
  container.innerHTML = `
    <div class="panel mt-16">
      <div class="panel-title-row">
        <span class="panel-title">Passenger Demand Coverage</span>
        <div class="filter-row">
          <input class="search-input" id="st-demand-search" placeholder="Search work / terminal..." />
        </div>
      </div>
      <div class="table-scroll">
        <table class="data-table">
          <thead>
            <tr><th>Time</th><th>Terminal</th><th>Work</th><th>PAX</th><th>PAX/FTE/15m</th><th>FTE Req</th><th>Assigned</th><th>Status</th></tr>
          </thead>
          <tbody id="st-demand-tbody"></tbody>
        </table>
      </div>
    </div>`;

  function renderRows(rows) {
    const tbody = document.getElementById('st-demand-tbody');
    if (!tbody) return;
    tbody.innerHTML = rows.map(t => {
      const assigned = (t.assigned || []).length;
      const ok = !t.alert;
      return `<tr class="${ok ? '' : 'row-warn'}">
        <td class="time-cell">${t.start}-${t.end}</td>
        <td><span class="terminal-badge">${t.terminal || 'ALL'}</span></td>
        <td>${t.skill || t.role || t.task}</td>
        <td>${Number(t.passengers || 0).toLocaleString()}</td>
        <td>${t.pax_rate || '-'}</td>
        <td>${t.staff_needed || 0}</td>
        <td>${assigned}</td>
        <td><span class="badge ${ok ? 'badge-ok' : 'badge-warn'}">${ok ? 'Covered' : 'Gap'}</span></td>
      </tr>`;
    }).join('');
  }

  renderRows(tasks);
  document.getElementById('st-demand-search').addEventListener('input', e => {
    const q = e.target.value.toLowerCase();
    renderRows(tasks.filter(t =>
      !q || (t.task || '').toLowerCase().includes(q) ||
      (t.skill || '').toLowerCase().includes(q) ||
      (t.terminal || '').toLowerCase().includes(q)
    ));
  });
}

// ── Flights Tab ────────────────────────────────────────────────
function renderSTFlightsTab(container) {
  const flights = ST_DATA.flights;
  container.innerHTML = `
    <div class="panel mt-16">
      <div class="panel-title-row">
        <span class="panel-title">Flight Schedule &amp; PAX Demand Coverage</span>
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
              <th>A/C</th><th>Gate</th><th>Terminal</th><th>Pier</th><th>Type</th><th>Tasks</th><th>Status</th>
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
      || f.origin.toLowerCase().includes(q) || f.airline_name.toLowerCase().includes(q)
      || (f.terminal || '').toLowerCase().includes(q)
      || (f.pier || '').toLowerCase().includes(q);
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
      <td><span class="terminal-badge">${f.terminal || '—'}</span></td>
      <td><span class="pier-badge">${f.pier || '—'}</span></td>
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
                ? t.assigned.map(id => {
                    const isMismatch = (t.mismatch_assigned || []).includes(id);
                    return isMismatch
                      ? `<span class="staff-chip mismatch-chip" title="Skill mismatch — cross-skill assigned">⚠ ${id}</span>`
                      : `<span class="staff-chip">${id}</span>`;
                  }).join('')
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

  // Build unique shift options from actual staff data
  const uniqueShifts = [...new Set(staff.map(s => s.shift).filter(Boolean))].sort();

  container.innerHTML = `
    <div class="panel mt-16">
      <div class="panel-title-row">
        <span class="panel-title">Staff Roster — ${ST_DATA.date_label}</span>
        <div class="filter-row" style="flex-wrap:wrap;gap:6px">
          <input class="search-input" id="st-staff-search" placeholder="Search by ID, skill…" />
          <select id="st-shift-filter" class="select-input">
            <option value="">All Shifts</option>
            ${uniqueShifts.map(sh => {
              const sample = staff.find(s => s.shift === sh);
              return `<option value="${sh}">${sample?.shift_label || sh}</option>`;
            }).join('')}
          </select>
        </div>
      </div>
      <div id="st-staff-grid"></div>
    </div>
    ${absent.length ? `
      <div class="panel mt-16">
        <div class="panel-title">Absent Staff (${absent.length})</div>
        <div class="absent-chips">
          ${absent.map(a => `
            <div class="absent-card">
              <div class="absent-id">${a.id}</div>
              <div class="absent-skill">
                ${[a.skill1, a.skill2, a.skill3, a.skill4].filter(Boolean).map(fmtSkill).join(' • ')}
              </div>
              <div class="badge badge-warn">${a.leave_type}</div>
            </div>`).join('')}
        </div>
      </div>` : ''}`;

  filterSTStaff();
  document.getElementById('st-staff-search').addEventListener('input', filterSTStaff);
  document.getElementById('st-shift-filter').addEventListener('change', filterSTStaff);
}
function renderSTStaff3HourBlocks(staffList) {
  const grid = document.getElementById('st-staff-grid');
  if (!grid) return;
  if (!staffList.length) {
    grid.innerHTML = '<div class="muted small" style="padding:16px">No staff match your search.</div>';
    return;
  }

  function getBlockInfo(s, block) {
    const S = s.shift_start || 0;
    const E = s.shift_end   || (S + 720);
    if (!(S < block.end && E > block.start)) return null;
    const inBlock = (s.assignments || []).filter(a =>
      a.start_mins < block.end && a.end_mins > block.start
    );
    if (!inBlock.length) return { skill: null, terminal: null, color: '#94a3b8' };
    const skillTime = {};
    inBlock.forEach(a => {
      const ov = Math.min(a.end_mins, block.end) - Math.max(a.start_mins, block.start);
      skillTime[a.skill] = (skillTime[a.skill] || 0) + ov;
    });
    const topSk = Object.entries(skillTime).sort((a,b)=>b[1]-a[1])[0][0];
    const domAsgn = inBlock.filter(a => a.skill === topSk)
      .sort((a,b) => (Math.min(b.end_mins,block.end)-Math.max(b.start_mins,block.start)) -
                     (Math.min(a.end_mins,block.end)-Math.max(a.start_mins,block.start)))[0];
    return { skill: topSk, terminal: domAsgn?.terminal || null, color: ST_SKILL_COLOR[topSk] || '#888' };
  }

  const rows = staffList.map(s => {
    const utilColor = s.utilisation_pct > 90 ? ST.crit : s.utilisation_pct > 70 ? ST.warn : ST.ok;
    const sk1 = fmtSkill(s.skill1);
    const cells = ST_TIME_BLOCKS.map(b => {
      const info = getBlockInfo(s, b);
      if (!info) return `<td class="st3-cell st3-off">–</td>`;
      if (!info.skill) return `<td class="st3-cell" style="background:#94a3b820;color:#94a3b8;border:1px solid #94a3b840;text-align:center;padding:4px 2px" title="${b.label}: On shift"><div style="font-size:0.6rem;opacity:0.7">On</div></td>`;
      const termBadge = info.terminal
        ? `<div style="font-size:0.58rem;font-weight:800;letter-spacing:0.03em;opacity:0.85;line-height:1.1">${info.terminal}</div>`
        : '';
      return `<td class="st3-cell" style="background:${info.color}22;color:${info.color};border:1px solid ${info.color}55;text-align:center;vertical-align:middle;padding:3px 2px" title="${b.label}: ${info.skill}${info.terminal ? ' @ '+info.terminal : ''}">${termBadge}<div style="font-size:0.62rem;font-weight:700;line-height:1.2">${info.skill}</div></td>`;
    }).join('');
    return `<tr>
      <td style="padding:6px 10px;font-weight:700;font-size:0.82rem;white-space:nowrap">${s.id}</td>
      <td style="padding:6px 10px;font-size:0.78rem"><span style="color:${ST_SKILL_COLOR[sk1]||ST_SKILL_COLOR[s.skill1]||'#888'};font-weight:600">${sk1}</span></td>
      <td style="padding:6px 10px;font-size:0.75rem;white-space:nowrap">${s.shift_label || s.shift}</td>
      <td style="padding:6px 10px;font-size:0.75rem;font-weight:700;color:${utilColor}">${Math.round(s.utilisation_pct)}%</td>
      ${cells}
    </tr>`;
  }).join('');

  grid.innerHTML = `<div style="overflow-x:auto">
    <table style="width:100%;border-collapse:collapse;font-size:0.82rem">
      <thead>
        <tr style="border-bottom:2px solid var(--border)">
          <th style="padding:8px 10px;text-align:left">Staff</th>
          <th style="padding:8px 10px;text-align:left">Skill</th>
          <th style="padding:8px 10px;text-align:left">Shift</th>
          <th style="padding:8px 10px;text-align:left">Util</th>
          ${ST_TIME_BLOCKS.map(b=>`<th style="padding:6px 4px;text-align:center;font-size:0.72rem;white-space:nowrap">${b.label}</th>`).join('')}
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
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
  renderSTStaff3HourBlocks(filtered);
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


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
let ST_ACTIVE_TAB = 'summary';
let _stAllocSelection = { skill: null, terminal: null, block: null };
const _stAllocLog = [];
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

const ST_HOUR_BLOCKS = Array.from({ length: 24 }, (_, h) => ({
  id: `h${String(h).padStart(2, '0')}`,
  label: `${String(h).padStart(2, '0')}:00`,
  start: h * 60,
  end: (h + 1) * 60,
}));

// View-mode state (persists across date switches)
let _stStaffBlockView  = false;
let _stTimelineView    = '15min';

function normalizePaxDemandToHourly(data) {
  if (!data || !Array.isArray(data.tasks)) return data;

  const isPaxRow = row =>
    String(row?.sharing_mode || '').startsWith('pax') ||
    row?.flight_no === 'PAX' ||
    Number(row?.passengers || 0) > 0;

  const paxTasks = data.tasks.filter(isPaxRow);
  if (!paxTasks.length) return data;

  const fmtMins = mins => {
    mins = Math.round(mins || 0);
    const hh = Math.floor(mins / 60) % 24;
    const mm = mins % 60;
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  };
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
        base.start = fmtMins(hourStart);
        base.end = fmtMins(hourEnd);
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
  ST_DATA = normalizePaxDemandToHourly(ST_DATA);
  const d = ST_DATA;
  const el = document.getElementById('st-content');
  const carriedBanner = d.staff_data_carried_forward
    ? `<div style="display:flex;align-items:center;gap:8px;padding:8px 14px;margin-bottom:12px;
                   background:#78350f22;border:1px solid #f59e0b55;border-radius:8px;">
         <span style="font-size:1rem;">⚠️</span>
         <span style="font-size:0.8rem;color:#f59e0b;">
           No roster data available for this date — showing carried-forward schedule from
           <strong>${d.staff_data_carried_forward}</strong>.
           Upload the updated Staff_schedule.csv to see actual assignments.
         </span>
       </div>` : '';

  el.innerHTML = `
    <div class="page-header" style="margin-bottom:12px">
      <h2 class="page-title" style="font-size:1.3rem">${d.date_label}</h2>
    </div>
    ${carriedBanner}
    <!-- KPI Cards -->
    <div class="kpi-grid st-kpi-grid" id="st-kpis"></div>
    <!-- Alerts -->
    <div id="st-alerts-panel"></div>
    <!-- Sub-tabs -->
    <div class="sub-tabs" style="margin-top:20px">
      <button class="sub-tab ${ST_ACTIVE_TAB==='summary'?'active':''}" data-sttab="summary">Summary</button>
      <button class="sub-tab ${ST_ACTIVE_TAB==='staff-timeline'?'active':''}" data-sttab="staff-timeline">👤 Task Allocation</button>
      <button class="sub-tab ${ST_ACTIVE_TAB==='staff-allocation'?'active':''}" data-sttab="staff-allocation">📊 Staff Allocation</button>
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
  const covPct = kpis.coverage_pct;
  const cards = [
    {
      iconHtml: `<div class="kpi-icon-bubble" style="--glow:#3b82f6;background:rgba(59,130,246,0.12);border:1.5px solid rgba(59,130,246,0.35)"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13M22 2L15 22l-4-9-9-4 19-7z"/></svg></div>`,
      label: 'Passenger Volume', value: (kpis.passengers_total || 0).toLocaleString(), accent: '#3b82f6'
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
      label: 'Demand Windows', value: kpis.demand_windows_total ?? kpis.tasks_total, accent: '#0ea5e9'
    },
    {
      iconHtml: `<div class="kpi-icon-bubble" style="--glow:#10b981;background:rgba(16,185,129,0.12);border:1.5px solid rgba(16,185,129,0.35)"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>`,
      label: 'PAX Windows Covered', value: `${kpis.demand_windows_covered ?? kpis.tasks_covered} / ${kpis.demand_windows_total ?? kpis.tasks_total}`, accent: '#10b981'
    },
    {
      iconHtml: `<div class="kpi-icon-bubble" style="--glow:#f97316;background:rgba(249,115,22,0.12);border:1.5px solid rgba(249,115,22,0.35)"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#f97316" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg></div>`,
      label: 'Coverage %', value: covPct + '%', accent: '#f97316'
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

// ── Alerts Panel ───────────────────────────────────────────────
function renderSTAlerts(alerts, date) {
  const panel = document.getElementById('st-alerts-panel');
  if (!alerts || alerts.length === 0) {
    panel.innerHTML = `<div class="alert-panel alert-ok">
      <span>✅</span> All tasks fully covered — no staffing gaps.</div>`;
    return;
  }

  const timeToMins = t => {
    if (!t) return 0;
    const [h, m] = (t + ':00').split(':').map(Number);
    return h * 60 + (m || 0);
  };

  // Bucket every alert into a 3-hour block
  const blockMap = {};
  ST_TIME_BLOCKS.forEach(b => { blockMap[b.id] = { block: b, alerts: [] }; });

  alerts.forEach(a => {
    const sm = timeToMins(a.start);
    const hit = ST_TIME_BLOCKS.find(b => sm >= b.start && sm < b.end)
             || ST_TIME_BLOCKS[ST_TIME_BLOCKS.length - 1];
    blockMap[hit.id].alerts.push(a);
  });

  const activeBlocks = ST_TIME_BLOCKS
    .map(b => blockMap[b.id])
    .filter(b => b.alerts.length > 0);

  const totalCrit = alerts.filter(a => a.priority === 'Critical').length;
  const totalHigh = alerts.filter(a => a.priority !== 'Critical').length;

  // Mini timeline bar: all 8 blocks coloured by severity
  const timelineHtml = ST_TIME_BLOCKS.map(b => {
    const bA = blockMap[b.id].alerts;
    const hasCrit = bA.some(a => a.priority === 'Critical');
    const hasHigh = bA.length > 0;
    const bg  = hasCrit ? '#ef4444' : hasHigh ? '#f59e0b' : 'var(--border)';
    const tip = hasCrit ? `${bA.filter(a=>a.priority==='Critical').length} Critical`
              : hasHigh ? `${bA.length} High` : 'OK';
    return `<div title="${b.label.replace('–',':00–')}:00 — ${tip}" style="
      flex:1;height:8px;border-radius:3px;background:${bg};
      opacity:${hasHigh||hasCrit?1:0.25};cursor:default;position:relative;
      transition:opacity .2s;" data-block="${b.id}"></div>`;
  }).join('');

  const timelineLabels = ST_TIME_BLOCKS.map((b, i) =>
    i % 2 === 0 ? `<div style="flex:1;font-size:0.6rem;color:var(--muted);text-align:center">${b.label.split('–')[0]}:00</div>` : '<div style="flex:1"></div>'
  ).join('');

  panel.innerHTML = `
    <div class="alerts-container">
      <div class="alerts-header" style="flex-wrap:wrap;gap:8px;">
        <span class="alerts-title">⚠ Staffing Alerts &amp; Recommendations</span>
        <span class="alerts-count" style="display:flex;gap:6px;align-items:center;">
          ${totalCrit ? `<span class="badge badge-crit">${totalCrit} Critical</span>` : ''}
          ${totalHigh ? `<span class="badge badge-warn">${totalHigh} High</span>` : ''}
          <span style="font-size:0.72rem;color:var(--muted)">${activeBlocks.length}/8 blocks affected · ${alerts.length} gaps total</span>
        </span>
        <button class="alerts-toggle collapsed" id="st-alerts-toggle" title="Collapse / expand">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
        </button>
      </div>
      <div class="alerts-body collapsed" id="st-alerts-body">
        <div style="margin:10px 0 4px;display:flex;gap:3px;">${timelineHtml}</div>
        <div style="display:flex;gap:3px;margin-bottom:12px;">${timelineLabels}</div>
        <div id="st-alerts-blocks" style="display:flex;flex-direction:row;gap:10px;width:100%;"></div>
      </div>
    </div>`;

  const blocksEl = document.getElementById('st-alerts-blocks');

  activeBlocks.forEach(({ block, alerts: bAlerts }) => {
    const bCrit  = bAlerts.filter(a => a.priority === 'Critical');
    const bHigh  = bAlerts.filter(a => a.priority !== 'Critical');
    const hasCrit = bCrit.length > 0;
    const accent  = hasCrit ? '#ef4444' : '#f59e0b';

    // Aggregate by skill: worst gap, total tasks, rec staff union
    const skillMap = {};
    bAlerts.forEach(a => {
      const sk = a.skill || a.task || 'Unknown';
      if (!skillMap[sk]) {
        skillMap[sk] = { skill: sk, needed: 0, assigned: 0, gap: 0,
                         slots: 0, priority: 'High', recSet: new Set(),
                         assignedSet: new Set(), firstAlert: a, allAlerts: [] };
      }
      const e = skillMap[sk];
      e.gap      = Math.max(e.gap, a.gap || 0);
      e.needed   = Math.max(e.needed, a.staff_needed || 0);
      e.assigned = Math.max(e.assigned, a.assigned_count || 0);
      e.slots++;
      if (a.priority === 'Critical') e.priority = 'Critical';
      (a.rec_staff || []).forEach(s => e.recSet.add(s));
      (a.assigned_staff || []).forEach(s => e.assignedSet.add(s));
      e.allAlerts.push(a);
    });

    const skills    = Object.values(skillMap).sort((a, b) => b.gap - a.gap);
    const blockLbl  = block.label.replace('–', ':00 – ') + ':00';

    // Worst-gap bar (relative to total needed across block)
    const maxGap    = Math.max(...skills.map(s => s.gap));
    const maxNeeded = Math.max(...skills.map(s => s.needed));

    const skillRows = skills.map((s, si) => {
      const c        = s.priority === 'Critical' ? '#ef4444' : '#f59e0b';
      const barPct   = s.needed > 0 ? Math.round((s.assigned / s.needed) * 100) : 100;
      const gapPct   = 100 - barPct;
      const detailKey = `${block.id}__${si}`;
      _stSkillDetailMap[detailKey] = { skill: s, blockLabel: block.label };

      return `
        <div class="st-skill-row" data-detail-key="${detailKey}"
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

  // Wire skill-row click → detail modal
  blocksEl.querySelectorAll('.st-skill-row').forEach(row => {
    row.addEventListener('click', () => {
      const entry = _stSkillDetailMap[row.dataset.detailKey];
      if (entry) showSTSkillBlockDetail(entry.skill, entry.blockLabel, date);
    });
  });

  // Collapse toggle
  const stToggleBtn = document.getElementById('st-alerts-toggle');
  const stAlertsBody = document.getElementById('st-alerts-body');
  if (stToggleBtn && stAlertsBody) {
    stToggleBtn.addEventListener('click', () => {
      const collapsed = stAlertsBody.classList.toggle('collapsed');
      stToggleBtn.classList.toggle('collapsed', collapsed);
    });
  }
}

const _stSkillDetailMap = {};

function _generateAlertSuggestions(s, blockLabel, totalPax, avgPaxRate) {
  const tips = [];
  const skill = s.skill;
  const gap   = s.gap;
  const slots = s.slots;
  const recCount = s.recSet.size;
  const assignedCount = s.assignedSet.size;
  const isCrit = s.priority === 'Critical';
  const blockTime = blockLabel; // e.g. "06–09"

  // 1 — Forecast / awareness
  if (totalPax > 500) {
    tips.push({ icon: '📊', text: `High PAX volume (${totalPax.toLocaleString()}) expected during ${blockTime} — plan for peak demand on ${skill}.` });
  } else if (totalPax > 0) {
    tips.push({ icon: '📊', text: `${totalPax.toLocaleString()} PAX expected in the ${blockTime} block — monitor ${skill} capacity closely.` });
  }

  // 2 — Add staff
  if (gap >= 5) {
    tips.push({ icon: '👥', text: `Add at least ${gap} more agents to the ${skill} shift covering ${blockTime} to close the coverage gap.` });
  } else if (gap > 0) {
    tips.push({ icon: '👥', text: `Bring in ${gap} additional ${skill} staff for the ${blockTime} window to meet demand.` });
  }

  // 3 — Rebalance from over-staffed area
  if (assignedCount > 0 && gap > 0) {
    tips.push({ icon: '🔄', text: `Check if other skills are over-staffed in ${blockTime} — redeploy available agents to ${skill}.` });
  }

  // 4 — Secondary skills
  if (recCount === 0 && gap > 0) {
    tips.push({ icon: '🎯', text: `No direct ${skill} staff available — assign secondary-skilled agents who are qualified for this task.` });
  } else if (recCount > 0 && recCount < gap) {
    tips.push({ icon: '🎯', text: `Only ${recCount} recommended staff found — consider secondary-skilled staff to fill the remaining ${gap - recCount} gap.` });
  }

  // 5 — Shift adjustment
  if (slots >= 4) {
    tips.push({ icon: '🕐', text: `Gap persists across ${slots} consecutive slots in ${blockTime} — consider starting a ${skill} shift earlier to cover this window.` });
  }

  // 6 — Critical escalation
  if (isCrit) {
    tips.push({ icon: '🚨', text: `Critical shortage — escalate to shift supervisor and pre-authorise overtime for ${skill} staff if no cover is found.` });
  }

  // 7 — Roster optimisation
  if (gap > 2 || isCrit) {
    tips.push({ icon: '⚙️', text: `Run roster optimisation for this day to automatically redistribute staff and minimise gaps across all skills.` });
  }

  return tips;
}

function showSTSkillBlockDetail(s, blockLabel, date) {
  const overlay = _getSTAlertOverlay();
  const box = document.getElementById('st-alert-detail-box');
  if (!box) return;

  const accent = s.priority === 'Critical' ? '#ef4444' : '#f59e0b';
  const recArr = [...s.recSet];
  const assignedArr = [...s.assignedSet];

  // Aggregate PAX data across all alerts for this skill
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

  box.innerHTML = `
    <div class="modal-header" style="border-bottom:3px solid ${accent}">
      <div style="flex:1">
        <div class="modal-title">${s.skill} · ${blockLabel}</div>
        <div class="fd-meta" style="margin-top:4px;color:rgba(255,255,255,0.75)">
          ${s.slots} time slot${s.slots>1?'s':''} · Max gap: ${s.gap} · ${s.priority}
        </div>
      </div>
      <button class="fd-close" onclick="closeSTAlertDetail()">✕</button>
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
                   ST_DATA = await fetch('/api/short-term/apply-rec',{method:'POST',
                     headers:{'Content-Type':'application/json'},
                     body:JSON.stringify({date:'${date}',task_id:'${s.firstAlert.task_id}',
                       staff_ids:${JSON.stringify(recArr.slice(0,5))}})
                   }).then(r=>r.json());
                   closeSTAlertDetail();
                   renderShortTermDay();
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
            <div style="flex:1;min-width:120px;padding:10px;background:var(--surface);border-radius:6px;text-align:center;">
              <div style="font-size:1.3rem;font-weight:800;color:var(--text)">${totalPax.toLocaleString()}</div>
              <div style="font-size:0.7rem;color:var(--muted)">Total PAX in block</div>
            </div>
            <div style="flex:1;min-width:120px;padding:10px;background:var(--surface);border-radius:6px;text-align:center;">
              <div style="font-size:1.3rem;font-weight:800;color:var(--text)">${avgPaxRate}</div>
              <div style="font-size:0.7rem;color:var(--muted)">Avg PAX / staff / hour</div>
            </div>
            ${peakSlot.passengers ? `
            <div style="flex:1;min-width:120px;padding:10px;background:var(--surface);border-radius:6px;text-align:center;">
              <div style="font-size:1.3rem;font-weight:800;color:${accent}">${Number(peakSlot.passengers).toLocaleString()}</div>
              <div style="font-size:0.7rem;color:var(--muted)">Peak PAX (${peakSlot.start})</div>
            </div>` : ''}
          </div>
          <div>
            ${s.allAlerts.sort((a,b)=>(a.start||'').localeCompare(b.start||'')).map(a => {
              const pax = Number(a.passengers) || 0;
              const maxP = Math.max(...s.allAlerts.map(x => Number(x.passengers)||0)) || 1;
              const pct = Math.round((pax / maxP) * 100);
              return `
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:5px;">
                  <span style="font-size:0.7rem;color:var(--muted);min-width:90px">${a.start}–${a.end}</span>
                  <div style="flex:1;height:8px;border-radius:4px;background:var(--border);overflow:hidden;">
                    <div style="width:${pct}%;height:100%;background:${accent};opacity:0.75;border-radius:4px;"></div>
                  </div>
                  <span style="font-size:0.7rem;font-weight:700;color:var(--text);min-width:50px;text-align:right">${pax.toLocaleString()} PAX</span>
                </div>`;
            }).join('')}
          </div>`
        : '<div class="muted small">No PAX data available for this skill.</div>'}
      </div>

      <div class="staff-detail-section">
        <div class="staff-detail-section-title" style="color:#60a5fa;">💡 Suggestions</div>
        <div style="display:flex;flex-direction:column;gap:8px;margin-top:6px;">
          ${_generateAlertSuggestions(s, blockLabel, totalPax, avgPaxRate).map(t => `
            <div style="display:flex;gap:10px;align-items:flex-start;padding:10px 12px;
                        background:var(--surface);border-radius:8px;
                        border-left:3px solid #3b82f6;">
              <span style="font-size:1rem;flex-shrink:0;">${t.icon}</span>
              <span style="font-size:0.8rem;color:var(--text);line-height:1.45;">${t.text}</span>
            </div>`).join('')}
        </div>
      </div>
    </div>`;

  overlay.classList.remove('hidden');
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
  if (ST_ACTIVE_TAB === 'summary') renderSTSummary(el);
  else if (ST_ACTIVE_TAB === 'demand') renderSTDemandTab(el);
  else if (ST_ACTIVE_TAB === 'staff-timeline') renderSTRosterTimeline(el);
  else if (ST_ACTIVE_TAB === 'roster-board') renderSTRosterBoard(el);
  else if (ST_ACTIVE_TAB === 'opt') renderSTOptimization(el);
  else if (ST_ACTIVE_TAB === 'staff-allocation') renderSTStaffAllocation(el);
}

function renderSTSummary(container) {
  container.innerHTML = `
    <div class="stpax-module" style="margin-top:16px">
      <section class="stpax-outlook-panel">
        <div class="stpax-brand-row">
          <span class="stpax-pill">Pulse</span>
          <h2>PAX Flow Digital Twin</h2>
        </div>
        <div class="stpax-section-title">
          <span id="stpax-title">3-Day Strategic Outlook</span>
          <em id="stpax-subtitle">passenger numbers engineered based on actual next 3-day flight schedules</em>
        </div>
        <article class="stpax-chart-card" style="--pax-accent:#0ea5e9">
          <div class="stpax-card-title pax-card-title-row">
            <div class="pax-icon-bubble pax-icon-bubble-sm" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="m7 16 3-4 4 3 5-7"/></svg>
            </div>
            <span>Passenger Flow Outlook</span>
          </div>
          <div class="stpax-chart-wrap">
            <canvas id="stpax-outlook-chart"></canvas>
          </div>
        </article>
        <div class="stpax-insight-grid" id="stpax-insight-grid"></div>
      </section>
    </div>

    <div class="mt-24" style="margin-top:28px">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:8px;">
        <div class="section-header" style="margin-bottom:0">
          <h2 style="font-size:1rem;font-weight:700;color:var(--text);">Workforce Coverage — Short-Term</h2>
          <span class="section-hint">Assigned / Required per skill per hour. PAX touchpoints only.</span>
        </div>
        <div id="st-coverage-terminal-filter" style="display:flex;gap:6px;">
          <button class="st-term-btn active" data-term="ALL">All</button>
          <button class="st-term-btn" data-term="T1">T1</button>
          <button class="st-term-btn" data-term="T2">T2</button>
        </div>
      </div>
      <div class="legend-row mb-12">
        <span class="leg surplus"></span><span>Surplus</span>
        <span class="leg adequate"></span><span>Adequate</span>
        <span class="leg warning"></span><span>Warning</span>
        <span class="leg gap"></span><span>Gap</span>
      </div>
      <div class="heatmap-wrapper" style="overflow-x:auto;">
        <table class="heatmap-table heatmap-table--fluid" id="st-summary-heatmap"></table>
      </div>
    </div>
  `;
  if (typeof initShortTermPaxDemand === 'function') initShortTermPaxDemand({ date: ST_CURRENT_DATE });

  function refreshSTCoverageTable(terminal) {
    const tbl = document.getElementById('st-summary-heatmap');
    if (tbl && ST_DATA) {
      try { tbl.innerHTML = buildSTCoverageTableHTML(ST_DATA.tasks || [], terminal); } catch (e) { console.warn('Coverage render failed', e); }
    }
  }
  refreshSTCoverageTable('ALL');

  const filterBar = document.getElementById('st-coverage-terminal-filter');
  if (filterBar) {
    filterBar.addEventListener('click', e => {
      const btn = e.target.closest('.st-term-btn');
      if (!btn) return;
      filterBar.querySelectorAll('.st-term-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      refreshSTCoverageTable(btn.dataset.term);
    });
  }
}

// ── Roster Timeline Tab ──────────────────────────────────────────
async function renderSTRosterTimeline(container) {
  if (!ST_DATA) return;
  
  container.innerHTML = `
    <div class="panel mt-16">
      <div class="panel-title-row">
        <span class="panel-title">Operational Roster Timeline — ${ST_DATA.date_label}</span>
        <div style="display:flex;align-items:center;flex-wrap:wrap;gap:8px">
          <input class="search-input" id="st-staff-timeline-search" placeholder="Search staff ID / skill…" style="width:180px" />
          <select id="st-staff-timeline-shift" class="select-input">
            <option value="">All Shifts</option>
            ${[...new Set((ST_DATA.staff||[]).map(s=>s.shift).filter(Boolean))].sort().map(sh => {
              const samp = (ST_DATA.staff||[]).find(s=>s.shift===sh);
              const lbl  = samp?.shift_label || sh;
              return `<option value="${sh}">${lbl}</option>`;
            }).join('')}
          </select>
          <button id="rt-reopt-btn" class="btn-update-fluid" style="font-size:0.8rem;padding:7px 14px">⚡ Re-optimise</button>
          <button id="rt-ext-btn"  class="btn-ghost"        style="font-size:0.8rem" title="Add 3 extra shift windows for higher coverage">+ Extended Shifts</button>
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
      const mq = !q || s.id.toLowerCase().includes(q) || [s.skill1, s.skill2, s.skill3, s.skill4].some(sk => (sk || '').toLowerCase().includes(q));
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

  // Proxy buttons → delegate to Roster Board buttons once they're rendered
  document.getElementById('rt-reopt-btn')?.addEventListener('click', () => document.getElementById('rb-reopt-btn')?.click());
  document.getElementById('rt-ext-btn')?.addEventListener('click',   () => document.getElementById('rb-ext-btn')?.click());

  // Append Shift Assignment below
  const boardContainer = document.createElement('div');
  container.appendChild(boardContainer);
  renderSTRosterBoard(boardContainer);
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
    const allSkills = [s.skill1, s.skill2, s.skill3, s.skill4].filter(Boolean).map(fmtSkill);
    const grp = s.break_group || '';
    const grpColor = grp === 'A' ? '#2563EB' : '#059669';

    const cells = ST_HOUR_BLOCKS.map(b => {
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
      <td style="padding:6px 10px;font-size:0.75rem;font-weight:600">${allSkills.map((sk, i) => `<span style="color:${ST_SKILL_COLOR[sk]||'#888'}">${sk}</span>`).join('<span style="color:var(--muted)">, </span>')}</td>
      <td style="padding:6px 10px;font-size:0.75rem;white-space:nowrap">${s.shift_label || s.shift}</td>
      <td style="padding:6px 10px;font-size:0.75rem;font-weight:700;color:${utilColor}">${Math.round(s.utilisation_pct)}%</td>
      ${cells}
    </tr>`;
  }).join('');

  el.innerHTML = `<div style="overflow-x:auto">
    <table style="width:100%;min-width:${360 + ST_HOUR_BLOCKS.length * 68}px;border-collapse:collapse;font-size:0.82rem">
      <thead>
        <tr style="border-bottom:2px solid var(--border)">
          <th style="padding:8px 10px;text-align:left">Staff</th>
          <th style="padding:8px 10px;text-align:left">Skill</th>
          <th style="padding:8px 10px;text-align:left">Shift</th>
          <th style="padding:8px 10px;text-align:left">Util</th>
          ${ST_HOUR_BLOCKS.map(b=>`<th style="padding:6px 4px;text-align:center;font-size:0.72rem;white-space:nowrap">${b.label}</th>`).join('')}
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
    Early:   { color:'#f97316', range:'00:00-12:00' },
    Mid:     { color:'#3b82f6', range:'06:00-18:00' },
    Late:    { color:'#8b5cf6', range:'12:00-00:00' },
    Evening: { color:'#10b981', range:'16:00-04:00' },
    Night:   { color:'#ec4899', range:'22:00-10:00' },
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
          <div style="margin-bottom:16px;border-bottom:1px solid var(--border);padding-bottom:14px;">
            <h2 class="panel-title" style="margin:0;font-size:1.2rem;color:var(--text);text-transform:none;">📋 Roster Board — Optimised Shift Assignments</h2>
            <p class="section-hint" style="margin:5px 0 0;font-size:0.82rem">Shifts auto-assigned to maximise PAX coverage using 5 base shift windows (Early/Mid/Late/Evening/Night).</p>
            <button id="rb-reopt-btn" style="display:none"></button>
            <button id="rb-ext-btn"  style="display:none"></button>
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
                  ${covHtml}
                </tr>
              </thead>
              <tbody>
                ${employees.map(emp => `
                  <tr style="border-bottom:1px solid var(--border)">
                    <td style="padding:6px 12px;font-weight:700;font-size:0.82rem">${emp.id}</td>
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
function buildSTCoverageData(tasks, terminal) {
  const hours = [];
  for (let h = 4; h <= 23; h++) hours.push(h);

  // Always PAX skills only
  const paxSkills = Array.isArray(ST_DATA?.pax_coverage_skills) ? ST_DATA.pax_coverage_skills : [];
  const skills = paxSkills.length ? paxSkills.slice()
    : Array.isArray(ST_COVERAGE_SKILLS) ? ST_COVERAGE_SKILLS.slice() : [];

  // Accumulate directly per hour. PAX demand rows are hourly at the API layer.
  const hourData = {};
  skills.forEach(sk => {
    hourData[sk] = {};
    hours.forEach(h => { hourData[sk][h] = { req: 0, assigned: new Set() }; });
  });

  (tasks || []).forEach(task => {
    // Terminal filter: skip tasks that don't match (treat 'ALL' task terminal as matching any)
    const taskTerm = (task.terminal || 'ALL').toUpperCase();
    if (terminal && terminal !== 'ALL') {
      if (taskTerm !== 'ALL' && taskTerm !== terminal.toUpperCase()) return;
    }

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

function buildSTCoverageTableHTML(tasks, terminal) {
  const { data, hours, skills } = buildSTCoverageData(tasks, terminal);

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

    const activeDates = ST_DATES.filter(d => d.has_data);

    try {
      // ── Phase 1: capture baseline BEFORE any optimisation changes the backend ──
      resEl.innerHTML = '<div class="loading-spinner"><div class="spinner"></div><span>Capturing baseline schedule…</span></div>';
      const beforeFetches = await Promise.all(
        activeDates.map(d => fetch(`/api/short-term/${d.date}`).then(r => r.json())
          .then(data => ({ date: d.date, data })))
      );

      // Build rich "before" snapshot: shifts, util, coverage, tasks
      const before = {};
      beforeFetches.forEach(({ date, data }) => {
        const staff = data.staff || [];
        const shiftCounts = {};
        let utilSum = 0;
        staff.forEach(s => {
          const sh = s.shift || 'Other';
          shiftCounts[sh] = (shiftCounts[sh] || 0) + 1;
          utilSum += (s.utilisation_pct || 0);
        });
        before[date] = {
          coverage_pct:   data.kpis?.coverage_pct ?? null,
          tasks_covered:  data.kpis?.tasks_covered ?? null,
          tasks_total:    data.kpis?.tasks_total   ?? null,
          staff_count:    staff.length,
          absent:         (data.absent_staff || []).length,
          mean_util:      staff.length ? (utilSum / staff.length) : null,
          shifts:         shiftCounts,
        };
      });

      // ── Phase 2: run optimisation for all days in parallel ──
      resEl.innerHTML = '<div class="loading-spinner"><div class="spinner"></div><span>Running MIP optimisation across all 3 days…</span></div>';
      const dayResults = await Promise.all(
        activeDates.map(d =>
          fetch('/api/short-term/optimise', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(_buildPayload(d.date)),
          }).then(r => r.json()).then(data => ({ date: d.date, label: d.label, data }))
        )
      );

      const results = {};
      dayResults.forEach(({ date, data }) => { results[date] = data; });

      ST_OPT_RESULTS_CACHE = {
        dates:   activeDates.map(d => ({ date: d.date, label: d.label })),
        before,
        results,
        applied: {},
      };

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

    // Helper: delta chip
    const deltaChip = (val, unit='%', invert=false) => {
      if (val === null || val === undefined || isNaN(val)) return '';
      const pos = invert ? val < 0 : val > 0;
      const neg = invert ? val > 0 : val < 0;
      const col = pos ? '#10b981' : neg ? '#ef4444' : '#6b7280';
      const sign = val > 0 ? '+' : '';
      return `<span style="font-size:0.68rem;font-weight:800;color:${col}">${sign}${typeof val==='number'?val.toFixed(unit==='%'?1:0):val}${unit}</span>`;
    };

    const dayCardsHtml = dates.map(({ date, label }) => {
      const bef    = before[date] || {};
      const res    = results[date] || {};
      const roster = res.roster   || {};
      const kpis   = res.kpis     || {};
      const fair   = roster.fairness || {};

      // Coverage
      const covB = bef.coverage_pct ?? null;
      const covA = kpis.coverage_pct ?? null;
      const covD = (covB !== null && covA !== null) ? (covA - covB) : null;
      const covColor = covA === null ? '#6b7280' : covA >= 90 ? '#10b981' : covA >= 75 ? '#f59e0b' : '#ef4444';

      // Tasks covered
      const tasksCovB = bef.tasks_covered ?? null;
      const tasksTotB = bef.tasks_total   ?? null;
      const tasksCovA = kpis.tasks_covered ?? null;
      const tasksTotA = kpis.tasks_total   ?? null;
      const tasksD = (tasksCovB !== null && tasksCovA !== null) ? (tasksCovA - tasksCovB) : null;

      // Staff / absent
      const staffB = bef.staff_count  || 0;
      const staffA = (res.staff || []).length;
      const absB   = bef.absent ?? 0;
      const absA   = (res.absent_staff || []).length;

      // Utilisation
      const utilB = bef.mean_util ?? null;
      let utilASum = 0, utilACnt = 0;
      (res.staff || []).forEach(s => { utilASum += (s.utilisation_pct||0); utilACnt++; });
      const utilA = utilACnt ? (utilASum / utilACnt) : null;
      const utilD = (utilB !== null && utilA !== null) ? (utilA - utilB) : null;

      // Flags
      const flags     = roster.flags || [];
      const flagCount = flags.length;

      // Gini
      const gini      = typeof fair.gini_coefficient === 'number' ? fair.gini_coefficient.toFixed(3) : '—';
      const giniInterp= fair.interpretation || '';
      const giniColor = giniInterp==='excellent'?'#10b981':giniInterp==='good'?'#3b82f6':giniInterp==='moderate'?'#f59e0b':'#6b7280';

      // Solver
      const solver = roster.solver_used || '—';
      const isMIP  = solver.toLowerCase().includes('mip') || solver.toLowerCase().includes('cbc');

      // ── Shift distribution before & after ──
      const shiftsB = bef.shifts || {};
      const shiftsA = {};
      (res.staff || []).forEach(s => {
        const sh = s.shift || 'Other';
        shiftsA[sh] = (shiftsA[sh] || 0) + 1;
      });
      const allShifts = [...new Set([...Object.keys(SHIFT_META), ...Object.keys(shiftsB), ...Object.keys(shiftsA)])];
      const shiftRows = allShifts
        .map(sh => ({ sh, b: shiftsB[sh]||0, a: shiftsA[sh]||0, d: (shiftsA[sh]||0)-(shiftsB[sh]||0) }))
        .filter(r => r.b > 0 || r.a > 0);

      const shiftTableHtml = shiftRows.map(r => {
        const c   = (SHIFT_META[r.sh]||{}).color || '#6b7280';
        const col = r.d > 0 ? '#10b981' : r.d < 0 ? '#ef4444' : '#6b7280';
        const arr = r.d > 0 ? '↑' : r.d < 0 ? '↓' : '—';
        return `<tr>
          <td style="padding:3px 6px;font-size:0.75rem;font-weight:700;color:${c};white-space:nowrap;">
            <span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${c};margin-right:4px;vertical-align:middle;"></span>${r.sh}
          </td>
          <td style="padding:3px 6px;font-size:0.75rem;text-align:center;color:var(--muted);">${r.b||'—'}</td>
          <td style="padding:3px 4px;font-size:0.65rem;color:var(--muted);">→</td>
          <td style="padding:3px 6px;font-size:0.75rem;text-align:center;font-weight:700;">${r.a||'—'}</td>
          <td style="padding:3px 6px;font-size:0.75rem;text-align:right;font-weight:800;color:${col};">${r.d!==0?(r.d>0?'+':'')+r.d+' '+arr:'—'}</td>
        </tr>`;
      }).join('');

      // Flag previews
      const flagHtml = flagCount
        ? `<div style="padding:8px;background:#ef444410;border-radius:5px;border-left:2px solid #ef4444;margin-bottom:10px;">
            <div style="font-size:0.72rem;font-weight:700;color:#ef4444;margin-bottom:4px;">⚠ ${flagCount} Flag${flagCount>1?'s':''}</div>
            ${flags.slice(0,3).map(f=>`<div style="font-size:0.7rem;color:var(--muted);padding:1px 0">${f.flag_id}: ${f.detail}</div>`).join('')}
            ${flagCount>3?`<div style="font-size:0.68rem;color:var(--muted)">+${flagCount-3} more</div>`:''}
          </div>`
        : `<div style="padding:5px 10px;background:#10b98110;border-radius:5px;border-left:2px solid #10b981;font-size:0.73rem;color:#10b981;font-weight:600;margin-bottom:10px;">✓ No flags</div>`;

      const isApplied = !!applied[date];
      const noResult  = !Object.keys(res).length;

      return `
        <div class="opt-card" style="border-top:3px solid ${covColor};min-width:260px;flex:1 1 260px;display:flex;flex-direction:column;">

          <!-- Header -->
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
            <div style="font-weight:800;font-size:0.95rem;color:var(--text)">📅 ${label}</div>
            <div style="display:flex;gap:6px;align-items:center;">
              ${isMIP ? `<span style="font-size:0.65rem;padding:2px 6px;border-radius:8px;background:#3b82f615;border:1px solid #3b82f640;color:#3b82f6;font-weight:700">MIP</span>` : ''}
              ${isApplied ? `<span style="font-size:0.65rem;padding:2px 6px;border-radius:8px;background:#10b98120;border:1px solid #10b98140;color:#10b981;font-weight:700">✓ Applied</span>` : ''}
            </div>
          </div>

          <!-- Coverage comparison -->
          <div style="display:grid;grid-template-columns:1fr auto 1fr;gap:4px;align-items:center;margin-bottom:10px;padding:8px;background:var(--surface);border-radius:7px;">
            <div style="text-align:center;">
              <div style="font-size:0.62rem;color:var(--muted);margin-bottom:1px;">Coverage Before</div>
              <div style="font-size:1.2rem;font-weight:800;color:var(--muted)">${covB!==null?covB.toFixed(1)+'%':'—'}</div>
            </div>
            <div style="text-align:center;padding:0 6px;">
              ${covD!==null ? `<div style="font-size:0.72rem;font-weight:800;color:${covD>=0?'#10b981':'#ef4444'};white-space:nowrap;">${covD>=0?'+':''}${covD.toFixed(1)}%</div><div style="font-size:1rem;color:${covD>=0?'#10b981':'#ef4444'}">${covD>=0?'▲':'▼'}</div>` : `<div style="color:var(--muted)">→</div>`}
            </div>
            <div style="text-align:center;padding:8px;background:${covColor}18;border-radius:5px;border:1px solid ${covColor}35;">
              <div style="font-size:0.62rem;color:var(--muted);margin-bottom:1px;">Coverage After</div>
              <div style="font-size:1.2rem;font-weight:800;color:${covColor}">${covA!==null?covA.toFixed(1)+'%':'—'}</div>
            </div>
          </div>

          <!-- Key metrics row -->
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:5px;margin-bottom:10px;">
            <div style="padding:6px 4px;background:var(--surface);border-radius:5px;text-align:center;">
              <div style="font-size:0.58rem;color:var(--muted);margin-bottom:1px;">Staff on Duty</div>
              <div style="font-weight:700;font-size:0.88rem;">${staffA||'—'}</div>
              ${staffA!==staffB&&staffB>0 ? `<div style="font-size:0.62rem;color:${staffA>staffB?'#10b981':'#ef4444'}">${staffA>staffB?'+':''}${staffA-staffB}</div>` : ''}
            </div>
            <div style="padding:6px 4px;background:var(--surface);border-radius:5px;text-align:center;">
              <div style="font-size:0.58rem;color:var(--muted);margin-bottom:1px;">Mean Util</div>
              <div style="font-weight:700;font-size:0.88rem;">${utilA!==null?utilA.toFixed(1)+'%':'—'}</div>
              ${utilD!==null&&Math.abs(utilD)>0.05 ? deltaChip(utilD) : ''}
            </div>
            <div style="padding:6px 4px;background:${flagCount>0?'#ef444415':'#10b98115'};border-radius:5px;text-align:center;border:1px solid ${flagCount>0?'#ef444430':'#10b98130'};">
              <div style="font-size:0.58rem;color:var(--muted);margin-bottom:1px;">Flags</div>
              <div style="font-weight:700;font-size:0.88rem;color:${flagCount>0?'#ef4444':'#10b981'}">${noResult?'—':flagCount}</div>
            </div>
          </div>

          <!-- Tasks covered -->
          ${tasksCovA!==null&&tasksTotA!==null ? `
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;padding:5px 8px;background:var(--surface);border-radius:5px;">
            <span style="font-size:0.72rem;color:var(--muted);">Tasks Covered</span>
            <span style="font-size:0.78rem;font-weight:700;">
              ${tasksCovB!==null?`<span style="color:var(--muted)">${tasksCovB}/${tasksTotB}</span> → `:''}<span style="color:${covColor}">${tasksCovA}/${tasksTotA}</span>
              ${tasksD!==null&&tasksD!==0?deltaChip(tasksD,'',false):''}
            </span>
          </div>` : ''}

          <!-- Fairness -->
          ${gini!=='—' ? `
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;padding:5px 8px;background:var(--surface);border-radius:5px;">
            <span style="font-size:0.72rem;color:var(--muted);">Fairness (Gini)</span>
            <span style="font-weight:700;font-size:0.78rem;color:${giniColor}">${gini} <span style="font-size:0.66rem;font-weight:600;">(${giniInterp||'—'})</span></span>
          </div>` : ''}

          <!-- Flags -->
          ${flagHtml}

          <!-- Shift movement table -->
          ${shiftTableHtml ? `
          <div style="margin-bottom:10px;">
            <div style="font-size:0.7rem;color:var(--muted);font-weight:700;margin-bottom:5px;text-transform:uppercase;letter-spacing:.04em;">Shift Movement</div>
            <table style="width:100%;border-collapse:collapse;">
              <thead>
                <tr style="border-bottom:1px solid var(--border);">
                  <th style="padding:2px 6px;font-size:0.62rem;color:var(--muted);text-align:left;font-weight:600;">Shift</th>
                  <th style="padding:2px 6px;font-size:0.62rem;color:var(--muted);text-align:center;font-weight:600;">Before</th>
                  <th></th>
                  <th style="padding:2px 6px;font-size:0.62rem;color:var(--muted);text-align:center;font-weight:600;">After</th>
                  <th style="padding:2px 6px;font-size:0.62rem;color:var(--muted);text-align:right;font-weight:600;">Change</th>
                </tr>
              </thead>
              <tbody>${shiftTableHtml}</tbody>
            </table>
          </div>` : ''}

          <!-- Apply button -->
          <div style="margin-top:auto;padding-top:8px;">
            <button class="opt-apply-btn ${isApplied?'btn-ghost':'btn-update-fluid'}"
              data-date="${date}" data-label="${label}"
              style="width:100%;font-size:0.82rem;padding:7px 12px;"
              ${noResult?'disabled':''}>
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
            <tr><th>Time</th><th>Terminal</th><th>Work</th><th>PAX</th><th>PAX/FTE/hour</th><th>FTE Req</th><th>Assigned</th><th>Status</th></tr>
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
    const cells = ST_HOUR_BLOCKS.map(b => {
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
    <table style="width:100%;min-width:${360 + ST_HOUR_BLOCKS.length * 68}px;border-collapse:collapse;font-size:0.82rem">
      <thead>
        <tr style="border-bottom:2px solid var(--border)">
          <th style="padding:8px 10px;text-align:left">Staff</th>
          <th style="padding:8px 10px;text-align:left">Skill</th>
          <th style="padding:8px 10px;text-align:left">Shift</th>
          <th style="padding:8px 10px;text-align:left">Util</th>
          ${ST_HOUR_BLOCKS.map(b=>`<th style="padding:6px 4px;text-align:center;font-size:0.72rem;white-space:nowrap">${b.label}</th>`).join('')}
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


// ── Staff Allocation Tab ────────────────────────────────────────
function renderSTStaffAllocation(container) {
  if (!ST_DATA) {
    container.innerHTML = `<div class="panel mt-16"><div class="loading-spinner"><div class="spinner"></div><span>Loading data…</span></div></div>`;
    return;
  }

  const tasks    = ST_DATA.tasks  || [];
  const allStaff = ST_DATA.staff  || [];
  const date     = ST_DATA.date   || '';
  const staffById = {};
  allStaff.forEach(s => { const sid = String(s.id || ''); if (sid) staffById[sid] = s; });

  // ── helpers ──────────────────────────────────────────────────
  function _skillColor(sk) {
    const found = Object.keys(ST_SKILL_COLOR).find(k => k.toLowerCase() === (sk||'').toLowerCase());
    return found ? ST_SKILL_COLOR[found] : '#6c757d';
  }
  function _escAttr(v) {
    return String(v ?? '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  function _staffSkills(s) {
    return ['skill1','skill2','skill3','skill4'].map(k=>(s?.[k]||'').trim()).filter(Boolean);
  }
  function _staffHasSkill(s, skill) {
    return _staffSkills(s).some(sk => sk.toLowerCase() === (skill||'').toLowerCase());
  }

  function buildMatrixData() {
    const matrix = {};
    tasks.forEach(t => {
      const sk  = t.skill || 'Unknown';
      const term = t.terminal || 'ALL';
      const rowKey = sk + '||' + term;
      const h = Math.floor((t.start_mins || 0) / 60);
      const bId = `h${String(h).padStart(2,'0')}`;
      if (!matrix[rowKey]) matrix[rowKey] = {};
      if (!matrix[rowKey][bId]) matrix[rowKey][bId] = {
        req:0, _slotReq:{}, _staffSet:new Set(), skill:sk, terminal:term, tasks:[]
      };
      const cell = matrix[rowKey][bId];
      cell.tasks.push(t);
      const sm = t.start_mins || 0;
      cell._slotReq[sm] = (cell._slotReq[sm]||0) + (t.staff_needed||0);
      (t.assigned||[]).filter(Boolean).forEach(id => cell._staffSet.add(String(id)));
    });
    Object.values(matrix).forEach(byBlock => Object.values(byBlock).forEach(cell => {
      const vals = Object.values(cell._slotReq);
      cell.req  = vals.length ? Math.max(...vals) : 0;
      cell.asgn = cell._staffSet.size;
      cell.gap  = Math.max(0, cell.req - cell.asgn);
      cell.pct  = cell.req > 0 ? Math.round((cell.asgn / cell.req) * 100) : 100;
    }));
    return matrix;
  }

  function buildGapList(matrix) {
    const list = [];
    Object.entries(matrix).forEach(([rowKey, byBlock]) => {
      const [sk, term] = rowKey.split('||');
      Object.entries(byBlock).forEach(([bId, cell]) => {
        if (cell.gap > 0) list.push({ rowKey, skill:sk, terminal:term, blockId:bId, ...cell });
      });
    });
    list.sort((a,b) => a.pct - b.pct || b.gap - a.gap);
    return list;
  }

  function _cellColor(pct, gap) {
    if (gap === 0 && pct >= 100) return { bg:'#1a3a1a', border:'#2ecc71', text:'#2ecc71' };
    if (pct >= 100)              return { bg:'#1a3a1a', border:'#2ecc71', text:'#2ecc71' };
    if (pct >= 70)               return { bg:'#3a2a00', border:'#f39c12', text:'#f39c12' };
    return                              { bg:'#3a1a1a', border:'#e74c3c', text:'#e74c3c' };
  }

  const matrix   = buildMatrixData();
  const gapList  = buildGapList(matrix);
  const rowKeys  = Object.keys(matrix).sort((a,b) => {
    const [ska,ta] = a.split('||'); const [skb,tb] = b.split('||');
    return ska.localeCompare(skb) || ta.localeCompare(tb);
  });
  const allBlocks = ST_HOUR_BLOCKS;
  const allCells  = Object.values(matrix).flatMap(b => Object.values(b));
  const covPct    = allCells.length ? Math.round(allCells.reduce((a,c)=>a+Math.min(c.pct,100),0)/allCells.length) : 100;
  const totalGaps = allCells.reduce((a,c)=>a+c.gap,0);
  const totalOnDuty = new Set(tasks.flatMap(t=>(t.assigned||[]).filter(Boolean))).size;

  let _selSkill    = _stAllocSelection.skill;
  let _selTerminal = _stAllocSelection.terminal;
  let _selBlock    = _stAllocSelection.block;

  function _setSelection(skill, terminal, block) {
    _selSkill = skill; _selTerminal = terminal; _selBlock = block;
    _stAllocSelection = { skill, terminal, block };
  }

  container.innerHTML = `
  <div class="rl-shell">
    <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 20px 12px;border-bottom:1px solid var(--border);flex-shrink:0;">
      <div>
        <div style="font-size:1.25rem;font-weight:700;color:var(--text);">Staff Allocation — ${date}</div>
        <div style="font-size:0.8rem;color:var(--muted);margin-top:2px;">Click a cell to select a skill × hour block, then assign or remove staff · Use Shift Move to change a staff member's shift window</div>
      </div>
    </div>
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
          <span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:#2ecc71;margin-right:4px;vertical-align:middle;"></span>≥100%</span>
          <span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:#f39c12;margin-right:4px;vertical-align:middle;"></span>70–99%</span>
          <span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:#e74c3c;margin-right:4px;vertical-align:middle;"></span>&lt;70%</span>
          <span style="margin-left:6px;color:var(--muted);">Cell: <strong style="color:var(--text);">REQ / ASGN</strong></span>
        </div>
        <div class="rl-kpi-lbl" style="margin-top:4px;">Legend</div>
      </div>
    </div>
    <div class="st-shift-move-toolbar">
      <div class="st-shift-move-copy">
        <div class="st-shift-move-title">Shift Move</div>
        <div class="st-shift-move-hint">Move a staff member to a better shift window, then re-optimise this day.</div>
      </div>
      <div class="st-shift-move-controls">
        <select id="st-shift-move-staff">
          <option value="">Select staff member</option>
          ${allStaff.map(s => {
            const sid = String(s.id||'');
            const nm  = s.name || sid;
            const sh  = s.shift_label || s.shift || '';
            return `<option value="${_escAttr(sid)}">${_escAttr(nm)} (${_escAttr(sh)})</option>`;
          }).join('')}
        </select>
        <select id="st-shift-move-preset">
          <option value="">Select new shift</option>
          <option value="00:00|12:00">Early 00:00-12:00</option>
          <option value="06:00|18:00">Mid 06:00-18:00</option>
          <option value="12:00|00:00">Late 12:00-00:00</option>
          <option value="16:00|04:00">Evening 16:00-04:00</option>
          <option value="22:00|10:00">Night 22:00-10:00</option>
        </select>
        <button id="st-shift-move-btn" type="button">Move Shift</button>
      </div>
      <div id="st-shift-move-msg" class="st-shift-move-msg"></div>
    </div>
    <div class="rl-main">
      <div class="rl-left-pane">
        <div class="rl-matrix-wrap" id="st-rl-matrix-wrap">
          <table style="border-collapse:collapse;width:100%;min-width:${132+allBlocks.length*48}px;font-size:0.72rem;" id="st-rl-matrix-table">
            <thead>
              <tr style="background:var(--surface-2,#1e1e1e);position:sticky;top:0;z-index:2;">
                <th class="rl-skill-head">Skill / Touchpoint</th>
                ${allBlocks.map(b=>`<th class="rl-block-head">${b.label}</th>`).join('')}
              </tr>
            </thead>
            <tbody id="st-rl-matrix-body"></tbody>
          </table>
        </div>
        <div class="rl-gap-pane">
          <div style="padding:8px 12px 4px;font-size:0.7rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;position:sticky;top:0;background:var(--surface-2,#1e1e1e);z-index:1;">
            Gap Priority — worst first
          </div>
          <div id="st-rl-gap-list" style="padding:0 8px 8px;"></div>
        </div>
      </div>
      <div class="rl-right-pane">
        <div class="rl-staff-panel" id="st-rl-staff-panel">
          <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--muted);text-align:center;gap:8px;">
            <div style="font-size:2rem;opacity:0.3;">←</div>
            <div style="font-size:0.85rem;">Select a cell in the heatmap to manage staff for that block</div>
          </div>
        </div>
        <!-- Move log -->
        <div style="flex-shrink:0;border-top:1px solid var(--border);max-height:160px;overflow-y:auto;background:var(--surface-2,#141414);">
          <div style="padding:8px 14px 4px;font-size:0.7rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;background:var(--surface-2,#141414);z-index:1;">
            <span>Move History</span>
            <span id="st-rl-log-count" style="font-size:0.7rem;color:var(--info);">${_stAllocLog.length} moves</span>
          </div>
          <div id="st-rl-log-body" style="padding:0 14px 8px;font-size:0.75rem;"></div>
        </div>
      </div>
    </div>
  </div>`;

  // ── Heatmap render ─────────────────────────────────────────────
  function renderMatrix(mx) {
    const tbody = document.getElementById('st-rl-matrix-body');
    if (!tbody) return;
    const skillOrder = [...new Set(rowKeys.map(rk=>rk.split('||')[0]))];
    let html = '';
    for (const sk of skillOrder) {
      const skColor  = _skillColor(sk);
      const termRows = rowKeys.filter(rk=>rk.split('||')[0]===sk);
      const multiTerm = termRows.length > 1;
      termRows.forEach((rowKey, idx) => {
        const term    = rowKey.split('||')[1];
        const byBlock = mx[rowKey] || {};
        const isFirst = idx === 0;
        const cells = allBlocks.map(b => {
          const cell = byBlock[b.id];
          if (!cell) return `<td style="padding:4px 2px;text-align:center;"><span style="font-size:0.65rem;color:var(--muted);opacity:.4;">—</span></td>`;
          const c     = _cellColor(cell.pct, cell.gap);
          const isSel = (_selSkill===sk && _selTerminal===term && _selBlock===b.id);
          return `<td style="padding:3px 2px;text-align:center;">
            <div class="rl-cell${isSel?' rl-cell-sel':''}"
              data-skill="${_escAttr(sk)}" data-terminal="${_escAttr(term)}" data-block="${b.id}"
              style="display:inline-block;min-width:40px;padding:4px 4px;border-radius:5px;
                background:${c.bg};border:1px solid ${isSel?'#fff':c.border};
                color:${c.text};font-size:0.7rem;font-weight:700;cursor:pointer;
                transition:transform .1s;${isSel?'transform:scale(1.08);box-shadow:0 0 0 2px #fff4;':''}">
              ${cell.req}/${cell.asgn}
            </div></td>`;
        }).join('');
        const termBadge = multiTerm
          ? ` <span style="font-size:0.6rem;font-weight:700;background:${skColor}25;color:${skColor};border:1px solid ${skColor}50;border-radius:3px;padding:1px 5px;margin-left:4px;">${term}</span>` : '';
        const rowLabel = `<span style="color:${skColor};font-weight:600;">${sk}</span>${termBadge}`;
        const topBorder = isFirst ? 'border-top:1px solid var(--border);' : '';
        html += `<tr style="border-bottom:1px solid var(--border)05;${topBorder}">
          <td class="rl-skill-cell" title="${sk}${multiTerm?' — '+term:''}">${rowLabel}</td>${cells}</tr>`;
      });
    }
    tbody.innerHTML = html;
    tbody.querySelectorAll('.rl-cell').forEach(el2 => {
      el2.addEventListener('click', () => {
        _setSelection(el2.dataset.skill, el2.dataset.terminal, el2.dataset.block);
        renderMatrix(mx);
        renderStaffPanel(mx);
        renderGapList(gapList);
      });
    });
  }

  // ── Gap list render ────────────────────────────────────────────
  function renderGapList(gl) {
    const el2 = document.getElementById('st-rl-gap-list');
    if (!el2) return;
    if (!gl.length) { el2.innerHTML = `<div style="padding:10px 4px;font-size:0.78rem;color:var(--ok);">✓ No gaps — all blocks covered</div>`; return; }
    el2.innerHTML = gl.slice(0, 12).map(g => {
      const b    = allBlocks.find(x=>x.id===g.blockId)||{};
      const c    = _cellColor(g.pct, g.gap);
      const isSel = (_selSkill===g.skill && _selTerminal===g.terminal && _selBlock===g.blockId);
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
    el2.querySelectorAll('.rl-gap-item').forEach(el3 => {
      el3.addEventListener('click', () => {
        _setSelection(el3.dataset.skill, el3.dataset.terminal, el3.dataset.block);
        renderMatrix(mx);
        renderStaffPanel(mx);
        renderGapList(gl);
      });
    });
  }

  // ── Staff panel render ─────────────────────────────────────────
  function renderStaffPanel(mx) {
    const panel = document.getElementById('st-rl-staff-panel');
    if (!panel || !_selSkill || !_selTerminal || !_selBlock) return;
    const rowKey = _selSkill + '||' + _selTerminal;
    const cell   = (mx[rowKey]||{})[_selBlock];
    const blk    = allBlocks.find(b=>b.id===_selBlock)||{};
    if (!cell) { panel.innerHTML = `<div style="color:var(--muted);font-size:0.85rem;padding:20px;">No tasks in this block.</div>`; return; }
    const c = _cellColor(cell.pct, cell.gap);
    const assignedIds  = new Set(cell._staffSet);
    const blockStart   = blk.start ?? 0;
    const blockEnd     = blk.end ?? 1440;
    function isAssignedElsewhere(sid) {
      return tasks.some(t => !(t.start_mins < blockEnd && t.end_mins > blockStart) ? false :
        (t.assigned||[]).map(String).includes(String(sid)));
    }
    let eligible = allStaff.filter(s => {
      const sid = String(s.id||'');
      if (assignedIds.has(sid)) return false;
      if (isAssignedElsewhere(sid)) return false;
      const shStart = s.shift_start_mins ?? s.shift_start ?? 0;
      const shEnd   = s.shift_end_mins ?? s.shift_end ?? 1440;
      return _staffHasSkill(s, _selSkill) && shStart <= blockStart && shEnd >= blockEnd;
    });
    const assignedList = allStaff.filter(s => assignedIds.has(String(s.id||'')));
    const terms     = _selTerminal || '—';
    const coverBar  = Math.min(cell.pct, 100);
    panel.innerHTML = `
      <div style="background:var(--surface-2,#1e1e1e);border-radius:10px;padding:14px 16px;margin-bottom:16px;border:1px solid ${c.border}40;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px;">
          <div>
            <div style="font-size:0.72rem;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px;">Selected Hour</div>
            <div style="font-size:1rem;font-weight:700;color:${_skillColor(_selSkill)};">${_selSkill}</div>
            <div style="font-size:0.78rem;color:var(--muted);margin-top:2px;">${blk.label||_selBlock} &nbsp;·&nbsp; Terminal: ${terms}</div>
          </div>
          <div style="text-align:right;">
            <div style="font-size:1.6rem;font-weight:800;color:${c.text};line-height:1;">${cell.req}/${cell.asgn}</div>
            <div style="font-size:0.68rem;color:var(--muted);">REQ / ASGN</div>
          </div>
        </div>
        <div style="height:6px;border-radius:3px;background:var(--border);overflow:hidden;">
          <div style="width:${coverBar}%;height:100%;background:${c.border};border-radius:3px;transition:width .3s;"></div>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:0.65rem;color:var(--muted);margin-top:3px;">
          <span>${cell.pct}% coverage</span>
          <span>${cell.gap>0?`<span style="color:var(--crit);">-${cell.gap} gap</span>`:'<span style="color:var(--ok);">✓ met</span>'}</span>
        </div>
      </div>
      <div style="margin-bottom:14px;">
        <div style="font-size:0.7rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px;">Currently Assigned (${assignedList.length})</div>
        ${assignedList.length===0
          ? `<div style="font-size:0.78rem;color:var(--muted);padding:8px 0;">No staff assigned yet.</div>`
          : assignedList.map(s=>{
              const sid=String(s.id||''); const nm=s.name||sid; const sk1=s.skill1||'—';
              return `<div style="display:flex;align-items:center;gap:10px;padding:7px 10px;background:var(--surface-2,#1e1e1e);border-radius:7px;margin-bottom:5px;border:1px solid var(--border);">
                <div style="width:28px;height:28px;border-radius:50%;background:${_skillColor(sk1)}20;display:flex;align-items:center;justify-content:center;font-size:0.65rem;font-weight:700;color:${_skillColor(sk1)};flex-shrink:0;">${(nm[0]||'?').toUpperCase()}</div>
                <div style="flex:1;min-width:0;"><div style="font-size:0.78rem;font-weight:600;color:var(--text);">${nm}</div><div style="font-size:0.65rem;color:var(--muted);">${_staffSkills(s).join(' / ')||sk1} · ID ${sid}</div></div>
                <button class="rl-remove-btn" data-sid="${_escAttr(sid)}" data-sname="${_escAttr(nm)}"
                  style="padding:4px 10px;background:transparent;border:1px solid var(--crit);color:var(--crit);border-radius:5px;font-size:0.7rem;font-weight:600;cursor:pointer;">✕ Remove</button>
              </div>`;
            }).join('')}
      </div>
      <div>
        <div style="font-size:0.7rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px;">Available to Assign (${eligible.length})</div>
        ${eligible.length===0
          ? `<div style="font-size:0.78rem;color:var(--muted);padding:8px 0;">No eligible staff free for this hour.</div>`
          : eligible.map(s=>{
              const sid=String(s.id||''); const nm=s.name||sid; const sk1=s.skill1||'—';
              const util=s.utilisation_pct||0;
              const uColor=util>=85?'var(--ok)':util>=50?'var(--info)':'var(--muted)';
              return `<div style="display:flex;align-items:center;gap:10px;padding:7px 10px;background:var(--surface-2,#1e1e1e);border-radius:7px;margin-bottom:5px;border:1px solid var(--border);">
                <div style="width:28px;height:28px;border-radius:50%;background:${_skillColor(sk1)}20;display:flex;align-items:center;justify-content:center;font-size:0.65rem;font-weight:700;color:${_skillColor(sk1)};flex-shrink:0;">${(nm[0]||'?').toUpperCase()}</div>
                <div style="flex:1;min-width:0;"><div style="font-size:0.78rem;font-weight:600;color:var(--text);">${nm}</div><div style="font-size:0.65rem;color:var(--muted);">${_staffSkills(s).join(' / ')||sk1} · ID ${sid}</div></div>
                <div style="font-size:0.65rem;color:${uColor};font-weight:600;margin-right:6px;">${util}% util</div>
                <button class="rl-assign-btn" data-sid="${_escAttr(sid)}" data-sname="${_escAttr(nm)}"
                  style="padding:4px 10px;background:var(--info);color:#fff;border:none;border-radius:5px;font-size:0.7rem;font-weight:600;cursor:pointer;">+ Assign</button>
              </div>`;
            }).join('')}
      </div>`;
    panel.querySelectorAll('.rl-assign-btn').forEach(btn =>
      btn.addEventListener('click', () => _doMove('assign', btn.dataset.sid, btn.dataset.sname)));
    panel.querySelectorAll('.rl-remove-btn').forEach(btn =>
      btn.addEventListener('click', () => _doMove('unassign', btn.dataset.sid, btn.dataset.sname)));
  }

  // ── Log render ─────────────────────────────────────────────────
  function renderLog() {
    const el2  = document.getElementById('st-rl-log-body');
    const cnt  = document.getElementById('st-rl-log-count');
    if (!el2) return;
    if (cnt) cnt.textContent = `${_stAllocLog.length} moves`;
    if (!_stAllocLog.length) { el2.innerHTML = `<div style="color:var(--muted);padding:6px 0;">No moves yet.</div>`; return; }
    el2.innerHTML = [..._stAllocLog].reverse().map(lg => {
      const col = lg.action==='assign'?'var(--ok)':'var(--crit)';
      return `<div style="display:flex;gap:8px;padding:4px 0;border-bottom:1px solid var(--border)05;">
        <span style="color:${col};font-weight:700;flex-shrink:0;">${lg.action==='assign'?'+ ':'✕ '}</span>
        <span style="flex:1;">${lg.staffName} → <strong>${lg.skill}</strong> ${lg.blockLabel}</span>
        <span style="color:var(--muted);flex-shrink:0;font-size:0.65rem;">${lg.time}</span>
      </div>`;
    }).join('');
  }

  // ── Assign/Unassign action ─────────────────────────────────────
  async function _doMove(action, staffId, staffName) {
    const blk    = allBlocks.find(b=>b.id===_selBlock)||{};
    const rowKey = _selSkill + '||' + _selTerminal;
    const cell   = (matrix[rowKey]||{})[_selBlock];
    if (!cell) return;
    const currentAssigned = [...(cell._staffSet||[])].map(String);
    const payload = {
      date, staff_id: staffId, skill: _selSkill, terminal: _selTerminal,
      block_start: blk.start, block_end: blk.end,
      action, current_assigned: currentAssigned,
    };
    document.querySelectorAll('.rl-assign-btn,.rl-remove-btn').forEach(b => { b.disabled=true; b.style.opacity='0.5'; });
    try {
      const res  = await fetch('/api/short-term/assign-block', {
        method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error||'Request failed');
      const ms = data.move_status||{};
      if (ms.applied===false) throw new Error(ms.error||'Move was not applied.');
      _stAllocLog.push({
        action, staffId, staffName,
        skill: `${_selSkill} (${_selTerminal})`,
        blockLabel: blk.label||_selBlock,
        time: new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}),
      });
      ST_DATA = data;
      try { renderSTKPIs(data.kpis); } catch(_) {}
      try { renderSTAlerts(data.alerts, data.date); } catch(_) {}
      const saved = { skill: _selSkill, terminal: _selTerminal, block: _selBlock };
      _stAllocSelection = saved;
      renderSTStaffAllocation(container);
      setTimeout(() => {
        const c2 = container.querySelector(
          `.rl-cell[data-skill="${CSS.escape(saved.skill)}"][data-terminal="${CSS.escape(saved.terminal)}"][data-block="${saved.block}"]`
        );
        if (c2) c2.click();
      }, 60);
    } catch (err) {
      const panel = document.getElementById('st-rl-staff-panel');
      if (panel) {
        const errDiv = document.createElement('div');
        errDiv.style.cssText = 'padding:8px 12px;background:#3a1a1a;border:1px solid var(--crit);border-radius:6px;font-size:0.78rem;color:var(--crit);margin-bottom:10px;';
        errDiv.textContent = '✕ ' + err.message;
        panel.prepend(errDiv);
      }
    } finally {
      document.querySelectorAll('.rl-assign-btn,.rl-remove-btn').forEach(b => { b.disabled=false; b.style.opacity='1'; });
    }
  }

  // ── Shift Move action ──────────────────────────────────────────
  const shiftMoveBtn = document.getElementById('st-shift-move-btn');
  if (shiftMoveBtn) {
    shiftMoveBtn.addEventListener('click', async () => {
      const staffId    = document.getElementById('st-shift-move-staff')?.value||'';
      const presetVal  = document.getElementById('st-shift-move-preset')?.value||'';
      const [newStart, newEnd] = presetVal ? presetVal.split('|') : ['',''];
      const msgEl      = document.getElementById('st-shift-move-msg');
      if (!staffId)  { if (msgEl) { msgEl.style.color='var(--crit)'; msgEl.textContent='Select a staff member.'; } return; }
      if (!presetVal) { if (msgEl) { msgEl.style.color='var(--crit)'; msgEl.textContent='Select a shift.'; } return; }
      shiftMoveBtn.disabled = true; shiftMoveBtn.textContent = 'Moving…';
      if (msgEl) msgEl.textContent = '';
      try {
        const res = await fetch('/api/short-term/shift-move', {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ date, staff_id: staffId, new_shift_start: newStart, new_shift_end: newEnd }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error||'Shift move failed');
        const staff = allStaff.find(s=>String(s.id||'')===staffId);
        const nm    = staff ? (staff.name||staffId) : staffId;
        _stAllocLog.push({
          action: 'shift-move', staffId, staffName: nm,
          skill: `Shift → ${newStart}–${newEnd}`,
          blockLabel: date,
          time: new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}),
        });
        if (msgEl) { msgEl.style.color='var(--ok)'; msgEl.textContent=`✓ Shift moved to ${newStart}–${newEnd}`; }
        ST_DATA = data;
        try { renderSTKPIs(data.kpis); } catch(_) {}
        try { renderSTAlerts(data.alerts, data.date); } catch(_) {}
        _stAllocSelection = { skill: null, terminal: null, block: null };
        renderSTStaffAllocation(container);
      } catch (err) {
        if (msgEl) { msgEl.style.color='var(--crit)'; msgEl.textContent='✕ '+err.message; }
      } finally {
        shiftMoveBtn.disabled = false; shiftMoveBtn.textContent = 'Move Shift';
      }
    });
  }

  // ── Initial paint ──────────────────────────────────────────────
  renderMatrix(matrix);
  renderGapList(gapList);
  renderLog();
  if (_selSkill && _selTerminal && _selBlock) renderStaffPanel(matrix);
}


// ── Expose to global ───────────────────────────────────────────
// Final clean override to avoid mojibake in the alerts header/toggle text.
window.initShortTerm = initShortTerm;


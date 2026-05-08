/* ═══════════════════════════════════════════════════════════
   scenario.js — Constraint-based Scenario Planning
   Long-term FTE planning with Hard / Soft / Heuristic constraints
   ═══════════════════════════════════════════════════════════ */

'use strict';

(function () {

const PAX_SKILLS = ['Checkin', 'Security', 'CBP', 'Lounge', 'Boarding', 'Immigration', 'Baggage'];
const SKILL_COLORS = {
  Checkin:     '#f97316',
  Security:    '#3b82f6',
  CBP:         '#8b5cf6',
  Lounge:      '#10b981',
  Boarding:    '#ec4899',
  Immigration: '#f59e0b',
  Baggage:     '#06b6d4',
};
const COMP_COLORS = ['#3b82f6', '#f97316', '#10b981', '#8b5cf6', '#ec4899'];

let _scenarios   = [];
let _compareSet  = new Set();
let _fteChart    = null;
let _compChart   = null;
let _currentResult = null;
let _initialized = false;

window.addEventListener('themeChanged', () => {
  if (_currentResult) _renderFteChart(_currentResult);
});

/* ── Init ── */
function initScenario() {
  if (_initialized) return;
  _initialized = true;
  _buildUI();
  _loadScenarios();
}

/* ── Build UI ── */
function _buildUI() {
  const root = document.getElementById('sub-scenario');
  if (!root) return;

  root.innerHTML = `
    <div class="sc-layout">

      <!-- LEFT: Constraint Editor -->
      <div class="sc-left">
        <div class="panel sc-editor-panel">
          <div class="panel-title">Scenario Planner</div>

          <div class="sc-field-group">
            <label class="sc-label">Scenario Name</label>
            <input id="sc-name" class="sc-input" type="text" placeholder="e.g. Summer Peak — Extra Security" />
          </div>
          <div class="sc-field-row">
            <div class="sc-field-half">
              <label class="sc-label">Start Date</label>
              <input id="sc-start-date" class="sc-input sc-input-sm" type="date" />
            </div>
            <div class="sc-field-half">
              <label class="sc-label">End Date</label>
              <input id="sc-end-date" class="sc-input sc-input-sm" type="date" />
            </div>
          </div>

          <!-- ── Hard Constraints ── -->
          <div class="sc-constraint-group sc-group-hard">
            <div class="sc-group-header">
              <span class="sc-group-badge sc-badge-hard">Hard</span>
              <div>
                <div class="sc-group-title">Hard Constraints</div>
                <div class="sc-group-hint">Regulatory &amp; contractual — non-negotiable limits</div>
              </div>
            </div>

            <div class="sc-slider-row">
              <label class="sc-label">Minimum Rest Between Shifts
                <span class="sc-hint">Regulatory minimum hours off between consecutive shifts (EU Working Time Directive)</span>
              </label>
              <div class="sc-slider-wrap">
                <input type="range" id="sl-min-rest" min="8" max="16" step="1" value="11"
                  oninput="document.getElementById('sv-min-rest').textContent=this.value+'h'">
                <span class="sc-slider-val" id="sv-min-rest">11h</span>
              </div>
            </div>

            <div class="sc-slider-row">
              <label class="sc-label">Maximum Consecutive Working Days
                <span class="sc-hint">Legal/contractual cap — after this many days a rest day is mandatory</span>
              </label>
              <div class="sc-slider-wrap">
                <input type="range" id="sl-max-consec" min="4" max="7" step="1" value="5"
                  oninput="document.getElementById('sv-max-consec').textContent=this.value+' days'">
                <span class="sc-slider-val" id="sv-max-consec">5 days</span>
              </div>
            </div>

            <div class="sc-slider-row">
              <label class="sc-label">Minimum SLA Coverage Floor
                <span class="sc-hint">Contractual minimum: available headcount must cover at least this fraction of demand</span>
              </label>
              <div class="sc-slider-wrap">
                <input type="range" id="sl-cov-floor" min="0.70" max="1.00" step="0.01" value="0.85"
                  oninput="document.getElementById('sv-cov-floor').textContent=(parseFloat(this.value)*100).toFixed(0)+'%'">
                <span class="sc-slider-val" id="sv-cov-floor">85%</span>
              </div>
            </div>
          </div>

          <!-- ── Soft Constraints ── -->
          <div class="sc-constraint-group sc-group-soft">
            <div class="sc-group-header">
              <span class="sc-group-badge sc-badge-soft">Soft</span>
              <div>
                <div class="sc-group-title">Soft Constraints</div>
                <div class="sc-group-hint">Operational targets — adjustable by planning team</div>
              </div>
            </div>

            <div class="sc-slider-row">
              <label class="sc-label">Absence Rate
                <span class="sc-hint">Expected daily absence rate per staff member (sick leave, unplanned absence)</span>
              </label>
              <div class="sc-slider-wrap">
                <input type="range" id="sl-absence-rate" min="0" max="0.20" step="0.005" value="0.06"
                  oninput="document.getElementById('sv-absence-rate').textContent=(parseFloat(this.value)*100).toFixed(1)+'%'">
                <span class="sc-slider-val" id="sv-absence-rate">6.0%</span>
              </div>
            </div>

            <div class="sc-slider-row">
              <label class="sc-label">Overtime Allowance
                <span class="sc-hint">Additional available capacity from authorised overtime as % of base headcount</span>
              </label>
              <div class="sc-slider-wrap">
                <input type="range" id="sl-overtime" min="0" max="0.20" step="0.01" value="0.00"
                  oninput="document.getElementById('sv-overtime').textContent=(parseFloat(this.value)*100).toFixed(0)+'%'">
                <span class="sc-slider-val" id="sv-overtime">0%</span>
              </div>
            </div>

            <div class="sc-slider-row">
              <label class="sc-label">Target Staff Utilisation
                <span class="sc-hint">Productive utilisation rate accounting for breaks, admin, and training time</span>
              </label>
              <div class="sc-slider-wrap">
                <input type="range" id="sl-utilisation" min="0.50" max="1.00" step="0.05" value="0.80"
                  oninput="document.getElementById('sv-utilisation').textContent=(parseFloat(this.value)*100).toFixed(0)+'%'">
                <span class="sc-slider-val" id="sv-utilisation">80%</span>
              </div>
            </div>

            <div class="sc-slider-row">
              <label class="sc-label">Peak Period Buffer
                <span class="sc-hint">Extra FTE headroom added on top of demand forecast during peak periods</span>
              </label>
              <div class="sc-slider-wrap">
                <input type="range" id="sl-peak-buffer" min="0" max="0.30" step="0.01" value="0.10"
                  oninput="document.getElementById('sv-peak-buffer').textContent=(parseFloat(this.value)*100).toFixed(0)+'%'">
                <span class="sc-slider-val" id="sv-peak-buffer">10%</span>
              </div>
            </div>

            <div class="sc-slider-row">
              <label class="sc-label">Cross-Training Rate
                <span class="sc-hint">Fraction of workforce multi-skilled and flexibly deployable across touchpoints</span>
              </label>
              <div class="sc-slider-wrap">
                <input type="range" id="sl-cross-train" min="0" max="0.50" step="0.05" value="0.15"
                  oninput="document.getElementById('sv-cross-train').textContent=(parseFloat(this.value)*100).toFixed(0)+'%'">
                <span class="sc-slider-val" id="sv-cross-train">15%</span>
              </div>
            </div>
          </div>

          <!-- ── Operational Heuristics ── -->
          <div class="sc-constraint-group sc-group-heuristic">
            <div class="sc-group-header">
              <span class="sc-group-badge sc-badge-heuristic">Heuristic</span>
              <div>
                <div class="sc-group-title">Operational Heuristics</div>
                <div class="sc-group-hint">Experience-based planning assumptions for scenario modelling</div>
              </div>
            </div>

            <div class="sc-slider-row">
              <label class="sc-label">Surge Demand Multiplier
                <span class="sc-hint">Apply demand uplift for events, disruptions, or contingency planning</span>
              </label>
              <div class="sc-slider-wrap">
                <input type="range" id="sl-surge" min="1.0" max="2.5" step="0.05" value="1.0"
                  oninput="document.getElementById('sv-surge').textContent=parseFloat(this.value).toFixed(2)+'×'">
                <span class="sc-slider-val" id="sv-surge">1.00×</span>
              </div>
            </div>

            <div class="sc-slider-row">
              <label class="sc-label">New Hire Fraction
                <span class="sc-hint">New hires operate at ~70% of a fully trained agent's output capacity</span>
              </label>
              <div class="sc-slider-wrap">
                <input type="range" id="sl-new-hire" min="0" max="0.50" step="0.05" value="0.00"
                  oninput="document.getElementById('sv-new-hire').textContent=(parseFloat(this.value)*100).toFixed(0)+'%'">
                <span class="sc-slider-val" id="sv-new-hire">0%</span>
              </div>
            </div>

            <div class="sc-slider-row">
              <label class="sc-label">Senior Staff on Peak Days
                <span class="sc-hint">Target ratio of experienced staff rostered for peak-traffic periods</span>
              </label>
              <div class="sc-slider-wrap">
                <input type="range" id="sl-senior-ratio" min="0.10" max="0.50" step="0.05" value="0.30"
                  oninput="document.getElementById('sv-senior-ratio').textContent=(parseFloat(this.value)*100).toFixed(0)+'%'">
                <span class="sc-slider-val" id="sv-senior-ratio">30%</span>
              </div>
            </div>
          </div>

          <button class="btn-run-scenario" id="btn-run-sc" onclick="scRunScenario()">
            ▶ Run Scenario Optimisation
          </button>
          <div id="sc-run-status" class="sc-run-status"></div>
        </div>
      </div>

      <!-- RIGHT: Results + Saved Scenarios -->
      <div class="sc-right">

        <!-- Result panel (hidden until first run) -->
        <div id="sc-result-panel" class="panel sc-result-panel hidden">
          <div class="panel-title" id="sc-result-title">Scenario Results</div>
          <div id="sc-result-kpis" class="sc-result-kpis"></div>

          <!-- Skill filter -->
          <div class="sc-filters" id="sc-skill-filter" style="display:flex;flex-wrap:wrap;gap:10px;font-size:11px;margin-top:12px;"></div>

          <!-- FTE chart -->
          <div style="position:relative;height:260px;margin-top:12px;">
            <canvas id="sc-fte-chart"></canvas>
          </div>

          <!-- Gap table -->
          <div class="table-scroll mt-16">
            <table class="data-table sc-gap-table">
              <thead id="sc-gap-thead"></thead>
              <tbody id="sc-gap-tbody"></tbody>
            </table>
          </div>
        </div>

        <!-- Saved Scenarios -->
        <div class="panel mt-16" id="sc-saved-panel">
          <div class="panel-title-row">
            <span class="panel-title" style="margin:0">Saved Scenarios</span>
            <span class="sc-compare-hint" id="sc-compare-hint">Select 2–3 scenarios to compare</span>
            <button class="btn-compare-sc" id="btn-compare" onclick="scShowCompare()" disabled>⚖ Compare Selected</button>
          </div>
          <div class="table-scroll mt-8">
            <table class="data-table" id="sc-table">
              <thead>
                <tr>
                  <th></th>
                  <th>Name</th>
                  <th>Period</th>
                  <th>Avg Req FTE</th>
                  <th>Avg Avail FTE</th>
                  <th>Avg Gap</th>
                  <th>Risk</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody id="sc-table-body">
                <tr><td colspan="8" class="empty-state small">No scenarios yet. Configure constraints and run one above.</td></tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- Comparison panel -->
        <div id="sc-compare-panel" class="panel mt-16 hidden">
          <div class="panel-title-row">
            <span class="panel-title" style="margin:0">Scenario Comparison</span>
            <button class="sc-close-btn" onclick="scCloseCompare()">✕ Close</button>
          </div>
          <div style="position:relative;height:280px;margin-top:12px;">
            <canvas id="sc-comp-chart"></canvas>
          </div>
          <div class="table-scroll mt-16" id="sc-comp-table-wrap"></div>
        </div>

      </div>
    </div>
  `;

  const today = new Date();
  document.getElementById('sc-start-date').value = today.toISOString().slice(0, 10);
  document.getElementById('sc-end-date').value = '2026-12-31';

  // Skill filter checkboxes
  document.getElementById('sc-skill-filter').innerHTML = PAX_SKILLS.map(sk =>
    `<label><input type="checkbox" value="${sk}" checked onchange="scUpdateChart()"> <span style="color:${SKILL_COLORS[sk]}">${sk}</span></label>`
  ).join('');
}

/* ── Gather constraints ── */
function _gatherConstraints() {
  return {
    min_rest_hours:       parseInt(document.getElementById('sl-min-rest').value),
    max_consecutive_days: parseInt(document.getElementById('sl-max-consec').value),
    min_coverage_floor:   parseFloat(document.getElementById('sl-cov-floor').value),
    absence_rate:         parseFloat(document.getElementById('sl-absence-rate').value),
    overtime_allowance:   parseFloat(document.getElementById('sl-overtime').value),
    staff_utilisation:    parseFloat(document.getElementById('sl-utilisation').value),
    peak_buffer:          parseFloat(document.getElementById('sl-peak-buffer').value),
    cross_training_rate:  parseFloat(document.getElementById('sl-cross-train').value),
    surge_demand_factor:  parseFloat(document.getElementById('sl-surge').value),
    new_hire_fraction:    parseFloat(document.getElementById('sl-new-hire').value),
    senior_staff_ratio:   parseFloat(document.getElementById('sl-senior-ratio').value),
  };
}

/* ── Run Scenario ── */
window.scRunScenario = async function () {
  const name      = (document.getElementById('sc-name').value || '').trim();
  const startDate = document.getElementById('sc-start-date').value;
  const endDate   = document.getElementById('sc-end-date').value;
  if (!name)                    { _setStatus('error', 'Please enter a scenario name.'); return; }
  if (!startDate || !endDate)   { _setStatus('error', 'Please select start and end dates.'); return; }

  const constraints = _gatherConstraints();
  const btn = document.getElementById('btn-run-sc');
  btn.disabled = true;
  btn.textContent = '⏳ Computing…';
  _setStatus('running', 'Applying constraints and computing FTE projections…');

  try {
    const res = await fetch('/api/long-term/scenario', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, start_date: startDate, end_date: endDate, constraints }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Server error');
    _setStatus('ok', `✓ Scenario "${name}" saved.`);
    _currentResult = data;
    _renderResultPanel(data);
    _scenarios.unshift(_summarise(data));
    _renderScenariosTable();
  } catch (e) {
    _setStatus('error', '✕ ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '▶ Run Scenario Optimisation';
  }
};

function _setStatus(type, msg) {
  const el = document.getElementById('sc-run-status');
  if (!el) return;
  el.className = 'sc-run-status sc-status-' + type;
  el.textContent = msg;
}

/* ── Render result panel ── */
function _renderResultPanel(data) {
  document.getElementById('sc-result-panel').classList.remove('hidden');
  document.getElementById('sc-result-title').textContent = `Results — ${data.name}`;

  const results   = data.results || {};
  const months    = results.months || [];
  const breakdown = results.monthly_breakdown || {};
  const totReq    = (results.total_required || []).reduce((a, b) => a + b, 0);
  const totAvail  = (results.total_available || []).reduce((a, b) => a + b, 0);
  const avgReq    = months.length ? totReq / months.length : 0;
  const avgAvail  = months.length ? totAvail / months.length : 0;
  const avgGap    = avgAvail - avgReq;
  const riskLevel = avgGap >= 0 ? 'Low' : avgGap > -5 ? 'Medium' : avgGap > -15 ? 'High' : 'Critical';
  const riskCls   = { Low: 'low', Medium: 'med', High: 'high', Critical: 'crit' }[riskLevel] || 'low';
  const gapColor  = avgGap >= 0 ? 'var(--green, #10b981)' : 'var(--red, #ef4444)';

  document.getElementById('sc-result-kpis').innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:4px">
      <div class="sc-res-kpi"><div class="sc-res-val">${avgReq.toFixed(1)}</div><div class="sc-res-lbl">Avg Req FTE / month</div></div>
      <div class="sc-res-kpi"><div class="sc-res-val">${avgAvail.toFixed(1)}</div><div class="sc-res-lbl">Avg Avail FTE / month</div></div>
      <div class="sc-res-kpi"><div class="sc-res-val" style="color:${gapColor}">${avgGap >= 0 ? '+' : ''}${avgGap.toFixed(1)}</div><div class="sc-res-lbl">Avg Gap FTE / month</div></div>
      <div class="sc-res-kpi"><div class="sc-res-val sc-risk-${riskCls}">${riskLevel}</div><div class="sc-res-lbl">Risk Level</div></div>
    </div>
  `;

  _renderFteChart(data);
  _renderGapTable(data);
}

/* ── FTE Chart ── */
window.scUpdateChart = function () {
  if (_currentResult) _renderFteChart(_currentResult);
};

function _renderFteChart(data) {
  const ctx = document.getElementById('sc-fte-chart');
  if (!ctx) return;
  if (_fteChart) { _fteChart.destroy(); _fteChart = null; }

  const results   = data.results || {};
  const months    = results.months || [];
  const breakdown = results.monthly_breakdown || {};

  const checks   = document.querySelectorAll('#sc-skill-filter input:checked');
  const selected = Array.from(checks).map(c => c.value);

  const isDark   = window.getCurrentTheme && window.getCurrentTheme() === 'dark';
  const tickClr  = isDark ? '#ffffff' : '#374151';
  const gridClr  = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.06)';

  const reqData   = months.map(m => selected.length
    ? selected.reduce((s, sk) => s + (breakdown[m]?.required?.[sk] || 0), 0)
    : (breakdown[m]?.total_required || 0));
  const availData = months.map(m => selected.length
    ? selected.reduce((s, sk) => s + (breakdown[m]?.available?.[sk] || 0), 0)
    : (breakdown[m]?.total_available || 0));

  _fteChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: months,
      datasets: [
        { type: 'bar',  label: 'Required FTE',  data: reqData,   backgroundColor: 'rgba(239,68,68,0.55)', borderColor: '#ef4444', borderWidth: 1, order: 2 },
        { type: 'line', label: 'Available FTE',  data: availData, borderColor: '#10b981', backgroundColor: '#10b981', borderWidth: 2, pointRadius: 4, fill: false, order: 1 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: tickClr, font: { size: 10 }, boxWidth: 12 } },
        tooltip: { callbacks: { label: c => `${c.dataset.label}: ${c.raw.toFixed(1)} FTE` } },
      },
      scales: {
        x: { ticks: { color: tickClr, font: { size: 10 } }, grid: { color: gridClr } },
        y: { ticks: { color: tickClr, font: { size: 10 } }, grid: { color: gridClr },
             title: { display: true, text: 'FTE', color: tickClr, font: { size: 10 } }, min: 0 },
      },
    },
  });
}

/* ── Gap Table ── */
function _renderGapTable(data) {
  const results   = data.results || {};
  const months    = results.months || [];
  const breakdown = results.monthly_breakdown || {};
  const skills    = results.skills || PAX_SKILLS;

  const thead = document.getElementById('sc-gap-thead');
  const tbody = document.getElementById('sc-gap-tbody');
  if (!thead || !tbody) return;

  thead.innerHTML = `<tr>
    <th>Month</th>
    ${skills.map(sk => `<th style="color:${SKILL_COLORS[sk] || '#888'}">${sk}</th>`).join('')}
    <th>Total Req</th><th>Total Avail</th><th>Gap</th>
  </tr>`;

  tbody.innerHTML = months.map(m => {
    const mb       = breakdown[m] || {};
    const req      = mb.required  || {};
    const avail    = mb.available || {};
    const totReq   = mb.total_required  || 0;
    const totAvail = mb.total_available || 0;
    const totGap   = totAvail - totReq;
    const gapCls   = totGap >= 0 ? 'sc-imbalance-neg' : 'sc-imbalance-pos';
    const skillCells = skills.map(sk => {
      const g = (avail[sk] || 0) - (req[sk] || 0);
      return `<td class="${g < 0 ? 'sc-imbalance-pos' : ''}" title="Req: ${(req[sk]||0).toFixed(1)} / Avail: ${(avail[sk]||0).toFixed(1)}">${g >= 0 ? '+' : ''}${g.toFixed(1)}</td>`;
    }).join('');
    return `<tr>
      <td>${m}</td>
      ${skillCells}
      <td>${totReq.toFixed(1)}</td>
      <td>${totAvail.toFixed(1)}</td>
      <td class="${gapCls}"><strong>${totGap >= 0 ? '+' : ''}${totGap.toFixed(1)}</strong></td>
    </tr>`;
  }).join('');
}

/* ── Load saved scenarios ── */
async function _loadScenarios() {
  try {
    const res = await fetch('/api/scenarios?type=long_term');
    if (!res.ok) return;
    const raw = await res.json();
    _scenarios = raw.map(_summarise).reverse();
    _renderScenariosTable();
  } catch (e) { /* silent */ }
}

function _summarise(data) {
  const results  = data.results || {};
  const months   = results.months || [];
  const totReq   = results.total_required  || [];
  const totAvail = results.total_available || [];
  const avgReq   = totReq.length   ? totReq.reduce((a, b) => a + b, 0)   / totReq.length   : 0;
  const avgAvail = totAvail.length ? totAvail.reduce((a, b) => a + b, 0) / totAvail.length : 0;
  const avgGap   = avgAvail - avgReq;
  const riskLevel = avgGap >= 0 ? 'Low' : avgGap > -5 ? 'Medium' : avgGap > -15 ? 'High' : 'Critical';
  return {
    id:         data.id,
    name:       data.name,
    start_date: data.start_date,
    end_date:   data.end_date,
    avg_req:    avgReq,
    avg_avail:  avgAvail,
    avg_gap:    avgGap,
    risk_level: riskLevel,
    _data:      data,
  };
}

function _renderScenariosTable() {
  const tbody = document.getElementById('sc-table-body');
  if (!tbody) return;
  if (!_scenarios.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-state small">No scenarios yet. Configure constraints and run one above.</td></tr>';
    return;
  }
  tbody.innerHTML = _scenarios.map(sc => {
    const riskCls = { Low: 'low', Medium: 'med', High: 'high', Critical: 'crit' }[sc.risk_level] || 'low';
    const gapCls  = sc.avg_gap >= 0 ? 'sc-imbalance-neg' : 'sc-imbalance-pos';
    const checked = _compareSet.has(sc.id) ? 'checked' : '';
    return `<tr>
      <td><input type="checkbox" ${checked} onchange="scToggleCompare('${sc.id}', this.checked)" /></td>
      <td><strong>${sc.name}</strong></td>
      <td style="font-size:0.78rem">${(sc.start_date || '').slice(0, 7)} – ${(sc.end_date || '').slice(0, 7)}</td>
      <td>${sc.avg_req.toFixed(1)}</td>
      <td>${sc.avg_avail.toFixed(1)}</td>
      <td class="${gapCls}"><strong>${sc.avg_gap >= 0 ? '+' : ''}${sc.avg_gap.toFixed(1)}</strong></td>
      <td><span class="sc-risk-badge sc-risk-${riskCls}">${sc.risk_level}</span></td>
      <td class="sc-actions">
        <button class="btn-sc-detail" onclick="scShowDetail('${sc.id}')">Detail</button>
        <button class="btn-sc-delete" onclick="scDelete('${sc.id}')">Delete</button>
      </td>
    </tr>`;
  }).join('');

  const btn = document.getElementById('btn-compare');
  if (btn) btn.disabled = _compareSet.size < 2;
}

window.scToggleCompare = function (id, checked) {
  if (checked) _compareSet.add(id); else _compareSet.delete(id);
  const btn  = document.getElementById('btn-compare');
  const hint = document.getElementById('sc-compare-hint');
  if (btn)  btn.disabled   = _compareSet.size < 2;
  if (hint) hint.textContent = _compareSet.size >= 2 ? `${_compareSet.size} selected` : 'Select 2–3 scenarios to compare';
};

window.scShowDetail = function (id) {
  const sc = _scenarios.find(s => s.id === id);
  if (!sc || !sc._data) return;
  _currentResult = sc._data;
  _renderResultPanel(sc._data);
  document.getElementById('sc-result-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
};

window.scDelete = function (id) {
  const sc = _scenarios.find(s => s.id === id);
  if (!sc || !confirm(`Delete scenario "${sc.name}"?`)) return;
  fetch(`/api/scenarios/${id}`, { method: 'DELETE' }).catch(() => {});
  _scenarios = _scenarios.filter(s => s.id !== id);
  _compareSet.delete(id);
  _renderScenariosTable();
  const btn = document.getElementById('btn-compare');
  if (btn) btn.disabled = _compareSet.size < 2;
};

/* ── Scenario Comparison ── */
window.scShowCompare = function () {
  if (_compareSet.size < 2) return;
  const selected = _scenarios.filter(s => _compareSet.has(s.id));
  const panel = document.getElementById('sc-compare-panel');
  panel.classList.remove('hidden');
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  _renderCompareChart(selected);
  _renderCompareTable(selected);
};

window.scCloseCompare = function () {
  document.getElementById('sc-compare-panel').classList.add('hidden');
};

function _renderCompareChart(scenarios) {
  const ctx = document.getElementById('sc-comp-chart');
  if (!ctx) return;
  if (_compChart) { _compChart.destroy(); _compChart = null; }

  const allMonths = [...new Set(scenarios.flatMap(sc => sc._data?.results?.months || []))]
    .sort((a, b) => new Date('1 ' + a) - new Date('1 ' + b));

  const isDark  = window.getCurrentTheme && window.getCurrentTheme() === 'dark';
  const tickClr = isDark ? '#ffffff' : '#374151';
  const gridClr = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.06)';

  const datasets = scenarios.flatMap((sc, i) => {
    const bd    = sc._data?.results?.monthly_breakdown || {};
    const color = COMP_COLORS[i % COMP_COLORS.length];
    return [
      { type: 'bar',  label: `${sc.name} — Req`,
        data: allMonths.map(m => bd[m]?.total_required  || 0),
        backgroundColor: color + '55', borderColor: color, borderWidth: 1, order: 3 },
      { type: 'line', label: `${sc.name} — Avail`,
        data: allMonths.map(m => bd[m]?.total_available || 0),
        borderColor: color, backgroundColor: color, borderWidth: 2, pointRadius: 3, fill: false, order: i + 1 },
    ];
  });

  _compChart = new Chart(ctx, {
    type: 'bar',
    data: { labels: allMonths, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: tickClr, font: { size: 9 }, boxWidth: 10 } } },
      scales: {
        x: { ticks: { color: tickClr, font: { size: 10 } }, grid: { color: gridClr } },
        y: { ticks: { color: tickClr, font: { size: 10 } }, grid: { color: gridClr }, min: 0 },
      },
    },
  });
}

function _renderCompareTable(scenarios) {
  const wrap = document.getElementById('sc-comp-table-wrap');
  if (!wrap) return;

  const allMonths = [...new Set(scenarios.flatMap(sc => sc._data?.results?.months || []))]
    .sort((a, b) => new Date('1 ' + a) - new Date('1 ' + b));

  const hdrCols  = scenarios.map(sc => `<th colspan="3" style="text-align:center">${sc.name}</th>`).join('');
  const subCols  = scenarios.map(() => '<th>Req</th><th>Avail</th><th>Gap</th>').join('');

  const rows = allMonths.map(m => {
    const cells = scenarios.map(sc => {
      const mb    = sc._data?.results?.monthly_breakdown?.[m] || {};
      const req   = mb.total_required  || 0;
      const avail = mb.total_available || 0;
      const gap   = avail - req;
      const cls   = gap < 0 ? 'sc-imbalance-pos' : '';
      return `<td>${req.toFixed(1)}</td><td>${avail.toFixed(1)}</td><td class="${cls}">${gap >= 0 ? '+' : ''}${gap.toFixed(1)}</td>`;
    }).join('');
    return `<tr><td>${m}</td>${cells}</tr>`;
  }).join('');

  wrap.innerHTML = `
    <table class="sc-compare-table">
      <thead class="sc-sticky-header">
        <tr><th rowspan="2">Month</th>${hdrCols}</tr>
        <tr>${subCols}</tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

/* ── Expose ── */
window.initScenario = initScenario;

})();

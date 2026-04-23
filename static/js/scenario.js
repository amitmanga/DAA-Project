/* ═══════════════════════════════════════════════════════════
   scenario.js — Constraint-based Scenario Planning
   Monte Carlo simulation frontend
   ═══════════════════════════════════════════════════════════ */

'use strict';

(function () {

/* ── State ── */
let _scenarios = [];
let _compareSet = new Set(); // scenario IDs selected for comparison
let _compChart  = null;
let _histChart  = null;
let _skillChart = null;

/* -- Theme Support -- */
window.addEventListener('themeChanged', () => {
    if (_initialized && _currentRenderedScenario) {
        _renderMonthlyRisk(_currentRenderedScenario);
    }
});

/* ── Init ── */
let _initialized = false;
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
      <!-- LEFT: Constraint Editor + Run -->
      <div class="sc-left">
        <div class="panel sc-editor-panel">
          <div class="panel-title">Constraint Editor</div>

          <div class="sc-field-group">
            <label class="sc-label">Scenario Name</label>
            <input id="sc-name" class="sc-input" type="text" placeholder="e.g. Summer Peak +10 GNIB" />
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

          <div class="sc-section-title">Demand & Variability</div>

          <div class="sc-slider-row">
            <label class="sc-label">Surge Demand Multiplier
              <span class="sc-hint">How much demand increases during a surge event</span>
            </label>
            <div class="sc-slider-wrap">
              <input type="range" id="sl-surge-factor" min="1.0" max="2.5" step="0.05" value="1.0"
                     oninput="document.getElementById('sv-surge-factor').textContent=parseFloat(this.value).toFixed(2)+'×'">
              <span class="sc-slider-val" id="sv-surge-factor">1.0×</span>
            </div>
          </div>

          <div class="sc-section-title">Absence & Workforce</div>

          <div class="sc-slider-row">
            <label class="sc-label">Target Staff Utilisation
              <span class="sc-hint">Expected maximum practical utilisation rate (1.0 = 100%)</span>
            </label>
            <div class="sc-slider-wrap">
              <input type="range" id="sl-staff-util" min="0.50" max="1.0" step="0.05" value="0.80"
                     oninput="document.getElementById('sv-staff-util').textContent=(parseFloat(this.value)*100).toFixed(0)+'%'">
              <span class="sc-slider-val" id="sv-staff-util">80%</span>
            </div>
          </div>

          <div class="sc-slider-row">
            <label class="sc-label">Absence Rate
              <span class="sc-hint">Mean daily absence probability per staff member</span>
            </label>
            <div class="sc-slider-wrap">
              <input type="range" id="sl-absence-rate" min="0" max="0.20" step="0.005" value="0.06"
                     oninput="document.getElementById('sv-absence-rate').textContent=(parseFloat(this.value)*100).toFixed(1)+'%'">
              <span class="sc-slider-val" id="sv-absence-rate">6.0%</span>
            </div>
          </div>

          <div class="sc-slider-row">
            <label class="sc-label">Absence Variability (CV)
              <span class="sc-hint">Run-to-run spread of the absence rate</span>
            </label>
            <div class="sc-slider-wrap">
              <input type="range" id="sl-absence-cv" min="0" max="0.15" step="0.005" value="0.02"
                     oninput="document.getElementById('sv-absence-cv').textContent=parseFloat(this.value).toFixed(3)">
              <span class="sc-slider-val" id="sv-absence-cv">0.020</span>
            </div>
          </div>

          <div class="sc-slider-row">
            <label class="sc-label">New Hire Fraction
              <span class="sc-hint">Fraction of workforce who are new hires — they deliver ~70% of a trained member's output</span>
            </label>
            <div class="sc-slider-wrap">
              <input type="range" id="sl-new-hire" min="0" max="0.50" step="0.05" value="0.00"
                     oninput="document.getElementById('sv-new-hire').textContent=(parseFloat(this.value)*100).toFixed(0)+'%'">
              <span class="sc-slider-val" id="sv-new-hire">0%</span>
            </div>
          </div>

          <div class="sc-slider-row">
            <label class="sc-label">Cross-Training Rate
              <span class="sc-hint">Fraction of each skill pool cross-trained in another skill</span>
            </label>
            <div class="sc-slider-wrap">
              <input type="range" id="sl-cross-train" min="0" max="0.50" step="0.05" value="0.15"
                     oninput="document.getElementById('sv-cross-train').textContent=(parseFloat(this.value)*100).toFixed(0)+'%'">
              <span class="sc-slider-val" id="sv-cross-train">15%</span>
            </div>
          </div>

          <div class="sc-section-title">Permanent Extra Staff by Skill
            <span class="sc-hint" style="font-weight:400;font-size:11px;margin-left:6px">100% reliable additional hires</span>
          </div>
          <div class="sc-extra-grid" id="sc-extra-grid">
            ${['GNIB','CBP Pre-clearance','Arr Customer Service','Check-in/Trolleys','Dep / Trolleys','T1/T2 Trolleys L/UL','Transfer Corridor','Ramp / Marshalling','Bussing','PBZ','Mezz Operation','Litter Picking'].map(sk => `
            <div class="sc-extra-row">
              <span class="sc-extra-skill">${sk}</span>
              <div class="sc-spinner-wrap">
                <button class="sc-spin-btn" onclick="scExtraAdj('extra','${sk}',-1)">−</button>
                <span class="sc-spin-val" id="sc-extra-${sk.replace(/ /g,'_').replace(/\//g,'_')}">0</span>
                <button class="sc-spin-btn" onclick="scExtraAdj('extra','${sk}',+1)">+</button>
              </div>
            </div>`).join('')}
          </div>

          <div class="sc-section-title">Contract / Agency Staff by Skill
            <span class="sc-hint" style="font-weight:400;font-size:11px;margin-left:6px">85% ± 10% attendance reliability per run</span>
          </div>
          <div class="sc-extra-grid" id="sc-contr-grid">
            ${['GNIB','CBP Pre-clearance','Arr Customer Service','Check-in/Trolleys','Dep / Trolleys','T1/T2 Trolleys L/UL','Transfer Corridor','Ramp / Marshalling','Bussing','PBZ','Mezz Operation','Litter Picking'].map(sk => `
            <div class="sc-extra-row">
              <span class="sc-extra-skill">${sk}</span>
              <div class="sc-spinner-wrap">
                <button class="sc-spin-btn" onclick="scExtraAdj('contr','${sk}',-1)">−</button>
                <span class="sc-spin-val" id="sc-contr-${sk.replace(/ /g,'_').replace(/\//g,'_')}">0</span>
                <button class="sc-spin-btn" onclick="scExtraAdj('contr','${sk}',+1)">+</button>
              </div>
            </div>`).join('')}
          </div>

          <div class="sc-section-title">Shift Parameters</div>
          <div class="sc-field-row">
            <div class="sc-field-half">
              <label class="sc-label">Min Rest (hrs)</label>
              <input id="sc-min-rest" class="sc-input sc-input-sm" type="number" min="8" max="16" value="11" />
            </div>
            <div class="sc-field-half">
              <label class="sc-label" style="opacity: 0.5;">Overtime Limit (Disabled)</label>
              <input id="sc-overtime" class="sc-input sc-input-sm" type="number" value="0" disabled style="opacity: 0.5;" />
            </div>
          </div>

          <div class="sc-field-group">
            <label class="sc-label">Simulation Runs</label>
            <select id="sc-n-runs" class="sc-select">
              <option value="100">100 (fast)</option>
              <option value="250">250</option>
              <option value="500" selected>500 (default)</option>
              <option value="1000">1 000 (precise)</option>
            </select>
          </div>

          <button class="btn-run-scenario" id="btn-run-sc" onclick="scRunSimulation()">
            ▶ Run Monte Carlo Simulation
          </button>
          <div id="sc-run-status" class="sc-run-status"></div>
        </div>
      </div>

      <!-- RIGHT: Results + Saved Scenarios -->
      <div class="sc-right">

        <!-- Latest result panel (hidden until first run) -->
        <div id="sc-result-panel" class="panel sc-result-panel hidden">
          <div class="panel-title" id="sc-result-title">Simulation Results</div>
          <div class="sc-result-kpis" id="sc-result-kpis"></div>
          <div class="row-1col mt-16" style="display:grid; grid-template-columns: 1fr;">
            <div class="panel-inner">
              <div class="panel-title-row" style="margin-bottom:8px; display:block">
                 <div class="panel-title-sm" style="margin:0 0 8px 0">Monthly FTE: Required vs Available</div>
                 <div class="sc-filters" id="sc-monthly-skill-filter" style="display:flex; flex-wrap:wrap; gap:8px; font-size:11px;">
                   <label><input type="checkbox" value="GNIB" checked onchange="scUpdateMonthlyRiskFilter()"> GNIB</label>
                   <label><input type="checkbox" value="CBP Pre-clearance" checked onchange="scUpdateMonthlyRiskFilter()"> CBP Pre-clearance</label>
                   <label><input type="checkbox" value="Arr Customer Service" checked onchange="scUpdateMonthlyRiskFilter()"> Arr Customer Service</label>
                   <label><input type="checkbox" value="Check-in/Trolleys" checked onchange="scUpdateMonthlyRiskFilter()"> Check-in/Trolleys</label>
                   <label><input type="checkbox" value="Dep / Trolleys" checked onchange="scUpdateMonthlyRiskFilter()"> Dep / Trolleys</label>
                   <label><input type="checkbox" value="T1/T2 Trolleys L/UL" checked onchange="scUpdateMonthlyRiskFilter()"> T1/T2 Trolleys L/UL</label>
                   <label><input type="checkbox" value="Transfer Corridor" checked onchange="scUpdateMonthlyRiskFilter()"> Transfer Corridor</label>
                   <label><input type="checkbox" value="Ramp / Marshalling" checked onchange="scUpdateMonthlyRiskFilter()"> Ramp / Marshalling</label>
                   <label><input type="checkbox" value="Bussing" checked onchange="scUpdateMonthlyRiskFilter()"> Bussing</label>
                   <label><input type="checkbox" value="PBZ" checked onchange="scUpdateMonthlyRiskFilter()"> PBZ</label>
                   <label><input type="checkbox" value="Mezz Operation" checked onchange="scUpdateMonthlyRiskFilter()"> Mezz Operation</label>
                   <label><input type="checkbox" value="Litter Picking" checked onchange="scUpdateMonthlyRiskFilter()"> Litter Picking</label>
                 </div>
              </div>
              <div style="position:relative; height: 250px; width: 100%;">
                <canvas id="sc-monthly-risk-chart"></canvas>
              </div>
            </div>
        </div>

        <!-- Saved Scenarios Table -->
        <div class="panel mt-16" id="sc-saved-panel">
          <div class="panel-title-row">
            <span class="panel-title" style="margin:0">Saved Scenarios</span>
            <span class="sc-compare-hint" id="sc-compare-hint">Select 2+ scenarios to compare</span>
            <button class="btn-compare-sc" id="btn-compare" onclick="scShowCompare()" disabled>⚖ Compare Selected</button>
          </div>
          <div class="table-scroll mt-8">
            <table class="data-table" id="sc-table">
              <thead>
                <tr>
                  <th></th><!-- checkbox -->
                  <th>Name</th>
                  <th>Start Date</th>
                  <th>End Date</th>
                  <th>Runs</th>
                  <th>Median Coverage</th>
                  <th>Avg Utilisation</th>
                  <th>Risk Score</th>
                  <th>Risk Level</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody id="sc-table-body">
                <tr><td colspan="10" class="empty-state small">No scenarios yet. Run a simulation to create one.</td></tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- Comparison Table (hidden until compare) -->
        <div id="sc-compare-panel" class="panel mt-16 hidden">
          <div class="panel-title-row">
            <span class="panel-title" style="margin:0">Scenario Monthly Comparison</span>
            <button class="sc-close-btn" onclick="scCloseCompare()">✕ Close</button>
          </div>
          <div class="panel-inner mt-16">
            <div class="sc-compare-table-wrap mt-8" id="sc-compare-table-container">
               <!-- Dynamic Table Rendered Here -->
            </div>
          </div>
        </div>

      </div>
    </div>
  `;

  // Set default dates
  const today = new Date();
  document.getElementById('sc-start-date').value = today.toISOString().slice(0, 10);
  document.getElementById('sc-end-date').value = '2026-12-31';
}

/* ── Staff spinners (extra permanent + contractor) ── */
window.scExtraAdj = function(type, skill, delta) {
  const prefix = type === 'contr' ? 'sc-contr-' : 'sc-extra-';
  const id = prefix + skill.replace(/ /g, '_');
  const el = document.getElementById(id);
  if (!el) return;
  const v = Math.max(0, Math.min(50, parseInt(el.textContent || '0') + delta));
  el.textContent = v;
};

/* ── Collect constraints from UI ── */
function _gatherConstraints() {
  const SKILLS = ['GNIB','CBP Pre-clearance','Arr Customer Service','Check-in/Trolleys','Dep / Trolleys','T1/T2 Trolleys L/UL','Transfer Corridor','Ramp / Marshalling','Bussing','PBZ','Mezz Operation','Litter Picking'];
  const extra = {}, contr = {};
  SKILLS.forEach(sk => {
    const key = sk.replace(/ /g, '_');
    const eEl = document.getElementById('sc-extra-' + key);
    const cEl = document.getElementById('sc-contr-' + key);
    extra[sk] = eEl ? parseInt(eEl.textContent || '0') : 0;
    contr[sk] = cEl ? parseInt(cEl.textContent || '0') : 0;
  });
  return {
    surge_demand_factor: parseFloat(document.getElementById('sl-surge-factor').value),
    staff_utilisation:   parseFloat(document.getElementById('sl-staff-util').value),
    absence_rate:        parseFloat(document.getElementById('sl-absence-rate').value),
    absence_cv:          parseFloat(document.getElementById('sl-absence-cv').value),
    new_hire_fraction:   parseFloat(document.getElementById('sl-new-hire').value),
    cross_training_rate: parseFloat(document.getElementById('sl-cross-train').value),
    extra_staff:         extra,
    contractor_staff:    contr,
    n_runs:              parseInt(document.getElementById('sc-n-runs').value),
  };
}

/* ── Run Simulation ── */
window.scRunSimulation = async function() {
  const name = (document.getElementById('sc-name').value || '').trim();
  const startDate = document.getElementById('sc-start-date').value;
  const endDate = document.getElementById('sc-end-date').value;
  if (!name) { _setStatus('error', 'Please enter a scenario name.'); return; }
  if (!startDate || !endDate) { _setStatus('error', 'Please select start and end dates.'); return; }

  const constraints = _gatherConstraints();
  const btn = document.getElementById('btn-run-sc');
  btn.disabled = true;
  btn.textContent = '⏳ Running…';
  _setStatus('running', `Running ${constraints.n_runs} Monte Carlo iterations…`);

  try {
    const res = await fetch('/api/scenarios/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, start_date: startDate, end_date: endDate, constraints })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Server error');
    _setStatus('ok', `✓ Scenario "${name}" saved (${constraints.n_runs} runs).`);
    _renderResultPanel(_normalizeScenario(data));
    await _loadScenarios();
  } catch(e) {
    _setStatus('error', '✕ ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '▶ Run Monte Carlo Simulation';
  }
};

function _setStatus(type, msg) {
  const el = document.getElementById('sc-run-status');
  if (!el) return;
  el.className = 'sc-run-status sc-status-' + type;
  el.textContent = msg;
}

let _currentRenderedScenario = null;

/* ── Render result panel ── */
function _renderResultPanel(sc) {
  _currentRenderedScenario = sc;
  const panel = document.getElementById('sc-result-panel');
  panel.classList.remove('hidden');
  document.getElementById('sc-result-title').textContent = `Results — ${sc.name}`;

  const riskClass = _riskClass(sc.risk_level);
  document.getElementById('sc-result-kpis').outerHTML = `
    <div class="sc-result-kpis" id="sc-result-kpis" style="display:grid; grid-template-columns: repeat(4, 1fr); gap: 16px;">
      <div class="sc-res-kpi"><div class="sc-res-val">${(sc.overall_coverage * 100).toFixed(1)}%</div><div class="sc-res-lbl">Overall Coverage</div></div>
      <div class="sc-res-kpi"><div class="sc-res-val">${((sc.average_utilisation || 0) * 100).toFixed(1)}%</div><div class="sc-res-lbl">Average Utilisation</div></div>
      <div class="sc-res-kpi"><div class="sc-res-val sc-risk-${riskClass}">${(sc.risk_score || 0).toFixed(0)}</div><div class="sc-res-lbl">Risk Score</div></div>
      <div class="sc-res-kpi"><div class="sc-res-val sc-risk-${riskClass}">${sc.risk_level || 'Low'}</div><div class="sc-res-lbl">Risk Level</div></div>
    </div>
  `;

  _renderMonthlyRisk(sc);
}

window.scUpdateMonthlyRiskFilter = function() {
  if (_currentRenderedScenario) _renderMonthlyRisk(_currentRenderedScenario);
};

function _renderMonthlyRisk(sc) {
  const ctx = document.getElementById('sc-monthly-risk-chart');
  if (!ctx) return;
  if (_histChart) { _histChart.destroy(); _histChart = null; }
  
  const monthlyData = sc.monthly_fte_breakdown || {};
  // Sort months chronologically to prevent alphabetical sorting by JSON/browser
  const months = Object.keys(monthlyData).sort((a, b) => new Date(a) - new Date(b));
  if (!months.length) return;

  const skills = ['GNIB','CBP Pre-clearance','Arr Customer Service','Check-in/Trolleys','Dep / Trolleys','T1/T2 Trolleys L/UL','Transfer Corridor','Ramp / Marshalling','Bussing','PBZ','Mezz Operation','Litter Picking'];
  
  // Get all checked skills
  const checks = document.querySelectorAll('#sc-monthly-skill-filter input:checked');
  const selectedSkills = Array.from(checks).map(cb => cb.value);

  // If none selected, fallback to empty to clear chart
  const reqData = [];
  const availData = [];
  const baseReqData = [];
  const baseAvailData = [];
  const allSkillsSelected = selectedSkills.length === skills.length;

  months.forEach(m => {
      let r = 0, a = 0, br = 0, ba = 0;
      if (allSkillsSelected) {
          r = monthlyData[m].scenario_total_req ?? 0;
          a = monthlyData[m].scenario_total_avail ?? 0;
          br = monthlyData[m].base_total_req ?? 0;
          ba = monthlyData[m].base_total_avail ?? 0;
      } else {
          selectedSkills.forEach(sk => {
              r += (monthlyData[m].req[sk] || 0);
              a += (monthlyData[m].avail[sk] || 0);
              br += ((monthlyData[m].base_req && monthlyData[m].base_req[sk]) || 0);
              ba += ((monthlyData[m].base_avail && monthlyData[m].base_avail[sk]) || 0);
          });
      }
      reqData.push(r);
      availData.push(a);
      baseReqData.push(br);
      baseAvailData.push(ba);
  });

  const labelSuffix = selectedSkills.length === skills.length ? ' (All Skills)' : (selectedSkills.length === 1 ? ` (${selectedSkills[0]})` : ' (Selected Skills)');

  _histChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: months,
      datasets: [
        {
            type: 'bar',
            label: 'Scenario Required FTE' + labelSuffix,
            data: reqData,
            backgroundColor: 'rgba(231, 76, 60, 0.7)',
            borderColor: '#E74C3C',
            borderWidth: 1,
            order: 3
        },
        {
            type: 'line',
            label: 'Scenario Available FTE' + labelSuffix,
            data: availData,
            borderColor: '#2ECC71',
            backgroundColor: '#2ECC71',
            borderWidth: 2,
            pointRadius: 4,
            fill: false,
            order: 1
        },
        {
            type: 'line',
            label: 'Base Available FTE' + labelSuffix,
            data: baseAvailData,
            borderColor: '#3498DB',
            backgroundColor: '#3498DB',
            borderWidth: 2,
            borderDash: [5, 5],
            pointRadius: 4,
            fill: false,
            order: 2
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: (window.getCurrentTheme && window.getCurrentTheme() === 'dark' ? '#ffffff' : '#000000'), font: { size: 10 }, boxWidth: 10 }, position: 'top' },
        tooltip: {
            callbacks: {
                title: (ctx) => ctx[0].label + ' FTE',
                label: (ctx) => `${ctx.dataset.label}: ${ctx.raw.toFixed(1)}`
            }
        }
      },
      scales: {
        x: { 
            ticks: { color: (window.getCurrentTheme && window.getCurrentTheme() === 'dark' ? '#ffffff' : '#000000'), font: { size: 10 } }, 
            grid: { color: (window.getCurrentTheme && window.getCurrentTheme() === 'dark' ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.04)') } 
        },
        y: { 
          ticks: { color: (window.getCurrentTheme && window.getCurrentTheme() === 'dark' ? '#ffffff' : '#000000'), font: { size: 10 } }, 
          grid: { color: (window.getCurrentTheme && window.getCurrentTheme() === 'dark' ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.07)') },
          title: { display: true, text: 'FTE', color: (window.getCurrentTheme && window.getCurrentTheme() === 'dark' ? '#ffffff' : '#000000'), font: {size: 10}},
          min: 0
        }
      }
    }
  });
}
  // old code removed.
/* ── Load + render saved scenarios table ── */
async function _loadScenarios() {
  try {
    const res = await fetch('/api/scenarios');
    const raw = await res.json();
    _scenarios = raw.map(_normalizeScenario);
    _renderScenariosTable();
  } catch(e) {
    console.error('Failed to load scenarios', e);
  }
}

function _renderScenariosTable() {
  const tbody = document.getElementById('sc-table-body');
  if (!tbody) return;

  if (!_scenarios.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="empty-state small">No scenarios yet. Run a simulation to create one.</td></tr>';
    return;
  }

  tbody.innerHTML = _scenarios.map(sc => {
    const rc = _riskClass(sc.risk_level);
    const statusBadge = sc.status === 'finalised'
      ? '<span class="sc-badge-finalised">✓ Finalised</span>'
      : '<span class="sc-badge-active">Active</span>';
    const checked = _compareSet.has(sc.id) ? 'checked' : '';
    return `<tr class="${sc.status === 'finalised' ? 'sc-row-finalised' : ''}">
      <td><input type="checkbox" class="sc-cmp-chk" ${checked} onchange="scToggleCompare('${sc.id}', this.checked)" /></td>
      <td class="sc-name-cell"><strong>${sc.name}</strong></td>
      <td>${(sc.start_date || sc.base_date).substring(0,10)}</td>
      <td>${(sc.end_date || sc.base_date).substring(0,10)}</td>
      <td>${sc.n_runs}</td>
      <td><strong>${((sc.p50_coverage || 0) * 100).toFixed(1)}%</strong></td>
      <td>${((sc.average_utilisation || 0) * 100).toFixed(1)}%</td>
      <td class="sc-risk-${rc}">${(sc.risk_score || 0).toFixed(0)}</td>
      <td><span class="sc-risk-badge sc-risk-${rc}">${sc.risk_level}</span></td>
      <td>${statusBadge}</td>
      <td class="sc-actions">
        <button class="btn-sc-detail" onclick="scShowDetail('${sc.id}')">Detail</button>
        ${sc.status !== 'finalised' ? `<button class="btn-sc-finalise" onclick="scFinalise('${sc.id}')">Finalise</button>` : ''}
        <button class="btn-sc-delete" onclick="scDelete('${sc.id}')">Delete</button>
      </td>
    </tr>`;
  }).join('');

  // Update compare button state
  const btn = document.getElementById('btn-compare');
  if (btn) btn.disabled = _compareSet.size < 2;
}

window.scToggleCompare = function(id, checked) {
  if (checked) _compareSet.add(id); else _compareSet.delete(id);
  const btn = document.getElementById('btn-compare');
  if (btn) btn.disabled = _compareSet.size < 2;
  const hint = document.getElementById('sc-compare-hint');
  if (hint) hint.textContent = _compareSet.size >= 2 ? `${_compareSet.size} selected` : 'Select 2+ scenarios to compare';
};

/* ── Show detail for a specific scenario ── */
window.scShowDetail = async function(id) {
  try {
    const res = await fetch(`/api/scenarios/${id}`);
    const raw = await res.json();
    _renderResultPanel(_normalizeScenario(raw));
    document.getElementById('sc-result-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch(e) {
    alert('Failed to load scenario: ' + e.message);
  }
};

/* ── Finalise scenario ── */
window.scFinalise = async function(id) {
  const sc = _scenarios.find(s => s.id === id);
  if (!sc) return;
  if (!confirm(`Finalise scenario "${sc.name}"? All other scenarios will remain active.`)) return;
  try {
    await fetch(`/api/scenarios/${id}/finalise`, { method: 'POST' });
    await _loadScenarios();
  } catch(e) {
    alert('Failed to finalise: ' + e.message);
  }
};

/* ── Delete scenario ── */
window.scDelete = async function(id) {
  const sc = _scenarios.find(s => s.id === id);
  if (!sc) return;
  if (!confirm(`Delete scenario "${sc.name}"?`)) return;
  try {
    await fetch(`/api/scenarios/${id}`, { method: 'DELETE' });
    _compareSet.delete(id);
    await _loadScenarios();
  } catch(e) {
    alert('Failed to delete: ' + e.message);
  }
};

/* ── Scenario Comparison ── */
window.scShowCompare = async function() {
  if (_compareSet.size < 2) return;

  const ids = [..._compareSet];
  const scenariosToCompare = _scenarios.filter(s => ids.includes(s.id));

  const panel = document.getElementById('sc-compare-panel');
  panel.classList.remove('hidden');
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });

  // Fetch full details for each selected scenario
  const details = await Promise.all(ids.map(id => fetch(`/api/scenarios/${id}`).then(r => r.json()).then(_normalizeScenario)));

  _renderCompareTable(details);
};

window.scCloseCompare = function() {
  const panel = document.getElementById('sc-compare-panel');
  panel.classList.add('hidden');
};

function _renderCompareChart() {}

function _renderCompareTable(details) {
  const container = document.getElementById('sc-compare-table-container');
  if (!container) return;

  // 1. Identify all unique months across selected scenarios
  const allMonthsSet = new Set();
  details.forEach(sc => {
      if (sc.comparison_data && sc.comparison_data.months) {
          sc.comparison_data.months.forEach(m => allMonthsSet.add(m));
      }
  });
  // Sort months chronologically
  const sortedMonths = Array.from(allMonthsSet).sort((a, b) => new Date(a) - new Date(b));

  // 2. Build row data
  const rows = [];
  const totals = { baseAvail: 0, baseGap: 0, scenarios: details.map(() => 0), imbalances: details.map(() => 0) };

  sortedMonths.forEach(m => {
      let baseAvail = 0;
      let baseReq = 0;
      details.forEach(sc => {
          if (!sc.comparison_data) return;
          const idx = sc.comparison_data.months.indexOf(m);
          if (idx !== -1) {
              baseAvail = sc.comparison_data.current_fte[idx];
              baseReq = sc.comparison_data.demand_fte[idx];
          }
      });

      const scValues = details.map(sc => {
          if (!sc.comparison_data) return baseAvail;
          const idx = sc.comparison_data.months.indexOf(m);
          return idx !== -1 ? sc.comparison_data.scenario_fte_avail[idx] : baseAvail;
      });

      const imbalances = details.map(sc => {
          if (!sc.comparison_data) return baseAvail - baseReq;
          const idx = sc.comparison_data.months.indexOf(m);
          if (idx === -1) return baseAvail - baseReq;
          return sc.comparison_data.scenario_fte_avail[idx] - sc.comparison_data.scenario_fte_req[idx];
      });
      const baseGap = baseAvail - baseReq;
      const differs = imbalances.some(imb => Math.abs(imb - baseGap) > 0.01);
      
      if (differs) {
          rows.push({ month: m, baseAvail: baseAvail, baseGap: baseGap, values: scValues, imbalances: imbalances });
          totals.baseAvail += baseAvail;
          totals.baseGap += baseGap;
          scValues.forEach((v, i) => totals.scenarios[i] += v);
          imbalances.forEach((imb, i) => totals.imbalances[i] += imb);
      }
  });

  if (rows.length === 0) {
      container.innerHTML = `<div class="empty-state">No gap differences found across the selected date ranges.</div>`;
      return;
  }

  // 3. Render Table
  const scenarioHeaders = details.map(sc => `<th>${sc.name} (Avail)</th>`).join('');
  const imbalanceHeaders = details.map(sc => `<th>${sc.name} Gap</th>`).join('');

  const gapCell = (v) => {
      const sign = v > 0 ? '+' : '';
      const cls = v > 0 ? 'sc-imbalance-neg' : (v < 0 ? 'sc-imbalance-pos' : '');
      return `<td class="${cls}">${sign}${v.toFixed(1)}</td>`;
  };

  const tableBody = rows.map(r => `
    <tr>
      <td>${r.month}</td>
      <td>${r.baseAvail.toFixed(1)}</td>
      ${r.values.map(v => `<td>${v.toFixed(1)}</td>`).join('')}
      ${gapCell(r.baseGap)}
      ${r.imbalances.map(imb => gapCell(imb)).join('')}
    </tr>
  `).join('');

  container.innerHTML = `
    <table class="sc-compare-table">
      <thead class="sc-sticky-header">
        <tr>
          <th>Month</th>
          <th>Base Available</th>
          ${scenarioHeaders}
          <th>Base Gap</th>
          ${imbalanceHeaders}
        </tr>
      </thead>
      <tbody>
        ${tableBody}
      </tbody>
      <tfoot class="sc-sticky-footer">
        <tr>
          <td>TOTAL</td>
          <td>${totals.baseAvail.toFixed(1)}</td>
          ${totals.scenarios.map(v => `<td>${v.toFixed(1)}</td>`).join('')}
          ${gapCell(totals.baseGap)}
          ${totals.imbalances.map(imb => gapCell(imb)).join('')}
        </tr>
      </tfoot>
    </table>
  `;
}



/* ── Normalize API shapes ── */
function _normalizeScenario(raw) {
  if (raw.results) {
    const r = raw.results;
    return {
      ...raw,
      coverage: r.coverage,
      monthly_risk: r.monthly_risk,
      monthly_fte_breakdown: r.monthly_fte_breakdown,
      comparison_data: r.comparison_data,
      risk_score: r.risk_score,
      risk_level: r.risk_level,
      average_utilisation: r.average_utilisation,
      n_runs: r.n_runs,
      p50: r.median_coverage || 0,
      overall_coverage: r.overall_coverage || r.median_coverage || 0
    };
  }
  return {
    ...raw,
    p50: raw.p50_coverage || 0,
    average_utilisation: raw.average_utilisation || 0,
    n_runs: raw.n_runs || 0,
  };
}

/* ── Helpers ── */
function _riskClass(level) {
  if (!level) return 'low';
  const l = level.toLowerCase();
  if (l === 'critical') return 'crit';
  if (l === 'high') return 'high';
  if (l === 'medium') return 'med';
  return 'low';
}

function _coverageClass(p50) {
  if (p50 < 0.50) return 'sc-cov-crit';
  if (p50 < 0.70) return 'sc-cov-warn';
  if (p50 < 0.90) return 'sc-cov-ok';
  return 'sc-cov-great';
}

/* ── Expose init ── */
window.initScenario = initScenario;

})();

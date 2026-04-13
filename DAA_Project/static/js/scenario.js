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

          <div class="sc-field-group">
            <label class="sc-label">Base Date</label>
            <input id="sc-base-date" class="sc-input" type="date" />
          </div>

          <div class="sc-section-title">Demand & Variability</div>

          <div class="sc-slider-row">
            <label class="sc-label">Demand Variability (CV)
              <span class="sc-hint">How much daily flight count varies around forecast</span>
            </label>
            <div class="sc-slider-wrap">
              <input type="range" id="sl-demand-cv" min="0" max="0.30" step="0.01" value="0.08"
                     oninput="document.getElementById('sv-demand-cv').textContent=parseFloat(this.value).toFixed(2)">
              <span class="sc-slider-val" id="sv-demand-cv">0.08</span>
            </div>
          </div>

          <div class="sc-slider-row">
            <label class="sc-label">Surge Event Probability
              <span class="sc-hint">Chance of a demand spike on this day (match, bank holiday, diversion)</span>
            </label>
            <div class="sc-slider-wrap">
              <input type="range" id="sl-surge-prob" min="0" max="0.30" step="0.01" value="0.05"
                     oninput="document.getElementById('sv-surge-prob').textContent=(parseFloat(this.value)*100).toFixed(0)+'%'">
              <span class="sc-slider-val" id="sv-surge-prob">5%</span>
            </div>
          </div>

          <div class="sc-slider-row">
            <label class="sc-label">Surge Demand Multiplier
              <span class="sc-hint">How much demand increases during a surge event</span>
            </label>
            <div class="sc-slider-wrap">
              <input type="range" id="sl-surge-factor" min="1.0" max="2.5" step="0.05" value="1.35"
                     oninput="document.getElementById('sv-surge-factor').textContent=parseFloat(this.value).toFixed(2)+'×'">
              <span class="sc-slider-val" id="sv-surge-factor">1.35×</span>
            </div>
          </div>

          <div class="sc-slider-row">
            <label class="sc-label">Airline Punctuality
              <span class="sc-hint">Fraction of flights on time — lower = task bunching, more staff needed concurrently</span>
            </label>
            <div class="sc-slider-wrap">
              <input type="range" id="sl-punctuality" min="0.40" max="1.00" step="0.05" value="0.75"
                     oninput="document.getElementById('sv-punctuality').textContent=(parseFloat(this.value)*100).toFixed(0)+'%'">
              <span class="sc-slider-val" id="sv-punctuality">75%</span>
            </div>
          </div>

          <div class="sc-slider-row">
            <label class="sc-label">Task Duration Variability (CV)
              <span class="sc-hint">Variability in individual task durations</span>
            </label>
            <div class="sc-slider-wrap">
              <input type="range" id="sl-duration-cv" min="0" max="0.30" step="0.01" value="0.10"
                     oninput="document.getElementById('sv-duration-cv').textContent=parseFloat(this.value).toFixed(2)">
              <span class="sc-slider-val" id="sv-duration-cv">0.10</span>
            </div>
          </div>

          <div class="sc-section-title">Absence & Workforce</div>

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
              <span class="sc-hint">Fraction of each skill pool cross-trained in another skill — creates a shared flex pool to cover shortages</span>
            </label>
            <div class="sc-slider-wrap">
              <input type="range" id="sl-cross-train" min="0" max="0.50" step="0.05" value="0.15"
                     oninput="document.getElementById('sv-cross-train').textContent=(parseFloat(this.value)*100).toFixed(0)+'%'">
              <span class="sc-slider-val" id="sv-cross-train">15%</span>
            </div>
          </div>

          <div class="sc-slider-row">
            <label class="sc-label">Fatigue Factor
              <span class="sc-hint">Sustained high-demand fatigue penalty on effective capacity (0 = none, 0.20 = severe)</span>
            </label>
            <div class="sc-slider-wrap">
              <input type="range" id="sl-fatigue" min="0" max="0.20" step="0.01" value="0.00"
                     oninput="document.getElementById('sv-fatigue').textContent=(parseFloat(this.value)*100).toFixed(0)+'%'">
              <span class="sc-slider-val" id="sv-fatigue">0%</span>
            </div>
          </div>

          <div class="sc-section-title">Permanent Extra Staff by Skill
            <span class="sc-hint" style="font-weight:400;font-size:11px;margin-left:6px">100% reliable additional hires</span>
          </div>
          <div class="sc-extra-grid" id="sc-extra-grid">
            ${['GNIB','CBP Pre-clearance','Bussing','PBZ','Mezz Operation','Litter Picking'].map(sk => `
            <div class="sc-extra-row">
              <span class="sc-extra-skill">${sk}</span>
              <div class="sc-spinner-wrap">
                <button class="sc-spin-btn" onclick="scExtraAdj('extra','${sk}',-1)">−</button>
                <span class="sc-spin-val" id="sc-extra-${sk.replace(/ /g,'_')}">0</span>
                <button class="sc-spin-btn" onclick="scExtraAdj('extra','${sk}',+1)">+</button>
              </div>
            </div>`).join('')}
          </div>

          <div class="sc-section-title">Contract / Agency Staff by Skill
            <span class="sc-hint" style="font-weight:400;font-size:11px;margin-left:6px">85% ± 10% attendance reliability per run</span>
          </div>
          <div class="sc-extra-grid" id="sc-contr-grid">
            ${['GNIB','CBP Pre-clearance','Bussing','PBZ','Mezz Operation','Litter Picking'].map(sk => `
            <div class="sc-extra-row">
              <span class="sc-extra-skill">${sk}</span>
              <div class="sc-spinner-wrap">
                <button class="sc-spin-btn" onclick="scExtraAdj('contr','${sk}',-1)">−</button>
                <span class="sc-spin-val" id="sc-contr-${sk.replace(/ /g,'_')}">0</span>
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
              <label class="sc-label">Overtime Limit (hrs/day)</label>
              <input id="sc-overtime" class="sc-input sc-input-sm" type="number" min="0" max="4" value="0" />
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
          <div class="row-2col mt-16">
            <div class="panel-inner">
              <div class="panel-title-sm">Coverage Distribution (p10–p90)</div>
              <canvas id="sc-hist-chart" height="220"></canvas>
            </div>
            <div class="panel-inner">
              <div class="panel-title-sm">Risk by Skill</div>
              <canvas id="sc-skill-chart" height="220"></canvas>
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
                  <th>Base Date</th>
                  <th>Runs</th>
                  <th>p50 Coverage</th>
                  <th>p10 Coverage</th>
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

        <!-- Comparison Chart (hidden until compare) -->
        <div id="sc-compare-panel" class="panel mt-16 hidden">
          <div class="panel-title-row">
            <span class="panel-title" style="margin:0">Scenario Comparison — Coverage Distribution</span>
            <button class="sc-close-btn" onclick="scCloseCompare()">✕ Close</button>
          </div>
          <canvas id="sc-comp-chart" height="300"></canvas>
          <div id="sc-comp-table" class="mt-16"></div>
        </div>

      </div>
    </div>
  `;

  // Set default base date to tomorrow
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  document.getElementById('sc-base-date').value = tomorrow.toISOString().slice(0, 10);
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
  const SKILLS = ['GNIB','CBP Pre-clearance','Bussing','PBZ','Mezz Operation','Litter Picking'];
  const extra = {}, contr = {};
  SKILLS.forEach(sk => {
    const key = sk.replace(/ /g, '_');
    const eEl = document.getElementById('sc-extra-' + key);
    const cEl = document.getElementById('sc-contr-' + key);
    extra[sk] = eEl ? parseInt(eEl.textContent || '0') : 0;
    contr[sk] = cEl ? parseInt(cEl.textContent || '0') : 0;
  });
  return {
    demand_cv:           parseFloat(document.getElementById('sl-demand-cv').value),
    surge_probability:   parseFloat(document.getElementById('sl-surge-prob').value),
    surge_demand_factor: parseFloat(document.getElementById('sl-surge-factor').value),
    airline_punctuality: parseFloat(document.getElementById('sl-punctuality').value),
    duration_cv:         parseFloat(document.getElementById('sl-duration-cv').value),
    absence_rate:        parseFloat(document.getElementById('sl-absence-rate').value),
    absence_cv:          parseFloat(document.getElementById('sl-absence-cv').value),
    new_hire_fraction:   parseFloat(document.getElementById('sl-new-hire').value),
    cross_training_rate: parseFloat(document.getElementById('sl-cross-train').value),
    fatigue_factor:      parseFloat(document.getElementById('sl-fatigue').value),
    extra_staff:         extra,
    contractor_staff:    contr,
    min_rest_hrs:        parseInt(document.getElementById('sc-min-rest').value),
    overtime_daily_hrs:  parseInt(document.getElementById('sc-overtime').value),
    n_runs:              parseInt(document.getElementById('sc-n-runs').value),
  };
}

/* ── Run Simulation ── */
window.scRunSimulation = async function() {
  const name = (document.getElementById('sc-name').value || '').trim();
  const baseDate = document.getElementById('sc-base-date').value;
  if (!name) { _setStatus('error', 'Please enter a scenario name.'); return; }
  if (!baseDate) { _setStatus('error', 'Please select a base date.'); return; }

  const constraints = _gatherConstraints();
  const btn = document.getElementById('btn-run-sc');
  btn.disabled = true;
  btn.textContent = '⏳ Running…';
  _setStatus('running', `Running ${constraints.n_runs} Monte Carlo iterations…`);

  try {
    const res = await fetch('/api/scenarios/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, base_date: baseDate, constraints })
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

/* ── Render result panel ── */
function _renderResultPanel(sc) {
  const panel = document.getElementById('sc-result-panel');
  panel.classList.remove('hidden');
  document.getElementById('sc-result-title').textContent = `Results — ${sc.name}`;

  const cov = sc.coverage;
  const riskClass = _riskClass(sc.risk_level);
  document.getElementById('sc-result-kpis').innerHTML = `
    <div class="sc-res-kpi"><div class="sc-res-val">${(cov.p50 * 100).toFixed(1)}%</div><div class="sc-res-lbl">p50 Coverage</div></div>
    <div class="sc-res-kpi"><div class="sc-res-val">${(cov.p10 * 100).toFixed(1)}%</div><div class="sc-res-lbl">p10 Coverage</div></div>
    <div class="sc-res-kpi"><div class="sc-res-val">${(cov.p90 * 100).toFixed(1)}%</div><div class="sc-res-lbl">p90 Coverage</div></div>
    <div class="sc-res-kpi"><div class="sc-res-val">${(sc.prob_adequate * 100).toFixed(1)}%</div><div class="sc-res-lbl">Prob. Adequate (≥80%)</div></div>
    <div class="sc-res-kpi"><div class="sc-res-val sc-risk-${riskClass}">${sc.risk_score.toFixed(0)}</div><div class="sc-res-lbl">Risk Score</div></div>
    <div class="sc-res-kpi"><div class="sc-res-val sc-risk-${riskClass}">${sc.risk_level}</div><div class="sc-res-lbl">Risk Level</div></div>
  `;

  // Histogram
  _renderHistogram(sc);
  // Skill breakdown
  _renderSkillChart(sc);
}

function _renderHistogram(sc) {
  const ctx = document.getElementById('sc-hist-chart');
  if (!ctx) return;
  if (_histChart) { _histChart.destroy(); _histChart = null; }

  const hist = sc.coverage_histogram || [];
  const labels = hist.map(b => `${(b.lo * 100).toFixed(0)}–${(b.hi * 100).toFixed(0)}%`);
  const values = hist.map(b => b.count);

  // Color bars: red if coverage<60%, amber if <80%, green otherwise
  const colors = hist.map(b => {
    const mid = (b.lo + b.hi) / 2;
    if (mid < 0.60) return 'rgba(231,76,60,0.7)';
    if (mid < 0.80) return 'rgba(243,156,18,0.7)';
    return 'rgba(46,204,113,0.7)';
  });

  _histChart = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ label: 'Runs', data: values, backgroundColor: colors, borderWidth: 0 }] },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        annotation: {}, // skip
        tooltip: { callbacks: { title: t => t[0].label + ' coverage', label: t => t.parsed.y + ' runs' } }
      },
      scales: {
        x: { ticks: { color: '#8BA5C0', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.04)' } },
        y: { ticks: { color: '#8BA5C0', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.07)' } }
      }
    }
  });

  // Draw p10/p50/p90 vertical markers by drawing on the canvas after render
  _histChart.options.animation = { onComplete: () => _drawPercentileLines(_histChart, sc.coverage, hist) };
  _histChart.update();
}

function _drawPercentileLines(chart, cov, hist) {
  const ctx = chart.ctx;
  if (!ctx || !hist.length) return;
  const xScale = chart.scales.x;
  const yScale = chart.scales.y;
  const top = yScale.top, bottom = yScale.bottom;

  function getX(val) {
    // Find which bucket contains val
    for (let i = 0; i < hist.length; i++) {
      if (val >= hist[i].lo && val <= hist[i].hi) {
        const frac = (val - hist[i].lo) / (hist[i].hi - hist[i].lo);
        const barLeft = xScale.getPixelForValue(i) - xScale.width / hist.length / 2;
        return barLeft + frac * (xScale.width / hist.length);
      }
    }
    return null;
  }

  [[cov.p10, '#E74C3C', 'p10'], [cov.p50, '#E8850A', 'p50'], [cov.p90, '#2ECC71', 'p90']].forEach(([v, color, lbl]) => {
    const x = getX(v);
    if (!x) return;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.font = 'bold 10px Segoe UI';
    ctx.textAlign = 'center';
    ctx.fillText(lbl, x, top - 4);
    ctx.restore();
  });
}

function _renderSkillChart(sc) {
  const ctx = document.getElementById('sc-skill-chart');
  if (!ctx) return;
  if (_skillChart) { _skillChart.destroy(); _skillChart = null; }

  const breakdown = sc.skill_breakdown || {};
  const skills = Object.keys(breakdown);
  if (!skills.length) return;

  const p50vals = skills.map(s => parseFloat((breakdown[s].p50 * 100).toFixed(1)));
  const p10vals = skills.map(s => parseFloat((breakdown[s].p10 * 100).toFixed(1)));

  _skillChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: skills,
      datasets: [
        { label: 'p50 Coverage %', data: p50vals, backgroundColor: 'rgba(52,152,219,0.7)', borderWidth: 0 },
        { label: 'p10 Coverage %', data: p10vals, backgroundColor: 'rgba(231,76,60,0.5)', borderWidth: 0 },
      ]
    },
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: '#8BA5C0', font: { size: 10 } } } },
      scales: {
        x: { ticks: { color: '#8BA5C0', font: { size: 9 }, maxRotation: 30 }, grid: { color: 'rgba(255,255,255,0.04)' } },
        y: {
          min: 0, max: 100,
          ticks: { color: '#8BA5C0', font: { size: 10 }, callback: v => v + '%' },
          grid: { color: 'rgba(255,255,255,0.07)' }
        }
      }
    }
  });
}

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
      <td>${sc.base_date}</td>
      <td>${sc.n_runs}</td>
      <td><strong>${(sc.p50 * 100).toFixed(1)}%</strong></td>
      <td>${(sc.p10 * 100).toFixed(1)}%</td>
      <td class="sc-risk-${rc}">${sc.risk_score.toFixed(0)}</td>
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

  _renderCompareChart(details);
  _renderCompareTable(details);
};

window.scCloseCompare = function() {
  const panel = document.getElementById('sc-compare-panel');
  panel.classList.add('hidden');
  if (_compChart) { _compChart.destroy(); _compChart = null; }
};

function _renderCompareChart(details) {
  const ctx = document.getElementById('sc-comp-chart');
  if (!ctx) return;
  if (_compChart) { _compChart.destroy(); _compChart = null; }

  const COLORS = ['#3498DB','#E8850A','#2ECC71','#9B59B6','#E74C3C','#1ABC9C'];

  const datasets = details.map((sc, i) => {
    const cov = sc.coverage;
    const color = COLORS[i % COLORS.length];
    // Floating bar: [p10, p90], median marker
    return {
      label: sc.name,
      data: [{ x: sc.name, y: [parseFloat((cov.p10*100).toFixed(1)), parseFloat((cov.p90*100).toFixed(1))] }],
      backgroundColor: color + '44',
      borderColor: color,
      borderWidth: 2,
      borderSkipped: false,
    };
  });

  // Also add p50 as scatter overlay
  const p50Dataset = {
    type: 'scatter',
    label: 'p50 (median)',
    data: details.map(sc => ({ x: sc.name, y: parseFloat((sc.coverage.p50 * 100).toFixed(1)) })),
    backgroundColor: '#ECEFF4',
    pointRadius: 6,
    pointHoverRadius: 8,
    showLine: false,
  };

  _compChart = new Chart(ctx, {
    type: 'bar',
    data: { datasets: [...datasets, p50Dataset] },
    options: {
      responsive: true,
      plugins: {
        legend: { labels: { color: '#8BA5C0' } },
        tooltip: { callbacks: { label: ctx => {
          if (Array.isArray(ctx.parsed.y)) return `${ctx.dataset.label}: p10=${ctx.parsed.y[0]}% – p90=${ctx.parsed.y[1]}%`;
          return `${ctx.dataset.label}: ${ctx.parsed.y}%`;
        }}}
      },
      scales: {
        x: { ticks: { color: '#8BA5C0' }, grid: { color: 'rgba(255,255,255,0.04)' } },
        y: {
          min: 0, max: 100,
          ticks: { color: '#8BA5C0', callback: v => v + '%' },
          grid: { color: 'rgba(255,255,255,0.07)' },
          title: { display: true, text: 'Coverage %', color: '#8BA5C0' }
        }
      }
    }
  });
}

function _renderCompareTable(details) {
  const container = document.getElementById('sc-comp-table');
  const COLORS = ['#3498DB','#E8850A','#2ECC71','#9B59B6','#E74C3C','#1ABC9C'];

  // Collect all skills from all scenarios
  const allSkills = new Set();
  details.forEach(sc => { if (sc.skill_breakdown) Object.keys(sc.skill_breakdown).forEach(s => allSkills.add(s)); });

  const skillRows = [...allSkills].map(skill => {
    const cells = details.map(sc => {
      const sb = sc.skill_breakdown && sc.skill_breakdown[skill];
      if (!sb) return '<td>—</td>';
      const rc = _coverageClass(sb.p50);
      return `<td class="${rc}">${(sb.p50*100).toFixed(1)}% <span class="sc-cmp-p10">(p10: ${(sb.p10*100).toFixed(1)}%)</span></td>`;
    }).join('');
    return `<tr><td class="sc-cmp-skill">${skill}</td>${cells}</tr>`;
  }).join('');

  container.innerHTML = `
    <table class="data-table">
      <thead>
        <tr>
          <th>Metric</th>
          ${details.map((sc, i) => `<th style="color:${COLORS[i % COLORS.length]}">${sc.name}</th>`).join('')}
        </tr>
      </thead>
      <tbody>
        <tr><td>p50 Coverage</td>${details.map(sc => `<td><strong>${(sc.coverage.p50*100).toFixed(1)}%</strong></td>`).join('')}</tr>
        <tr><td>p10 Coverage</td>${details.map(sc => `<td>${(sc.coverage.p10*100).toFixed(1)}%</td>`).join('')}</tr>
        <tr><td>p90 Coverage</td>${details.map(sc => `<td>${(sc.coverage.p90*100).toFixed(1)}%</td>`).join('')}</tr>
        <tr><td>Prob. Adequate</td>${details.map(sc => `<td>${(sc.prob_adequate*100).toFixed(1)}%</td>`).join('')}</tr>
        <tr><td>Risk Score</td>${details.map(sc => `<td class="sc-risk-${_riskClass(sc.risk_level)}">${sc.risk_score.toFixed(0)}</td>`).join('')}</tr>
        <tr><td>Risk Level</td>${details.map(sc => `<td><span class="sc-risk-badge sc-risk-${_riskClass(sc.risk_level)}">${sc.risk_level}</span></td>`).join('')}</tr>
        <tr><td colspan="${details.length+1}" class="sc-divider">Per-Skill p50 Coverage</td></tr>
        ${skillRows}
      </tbody>
    </table>
  `;
}

/* ── Normalize API shapes ── */
// run endpoint returns {id, name, base_date, status, results:{coverage,histogram,...}}
// list endpoint returns {id, name, p50_coverage, p10_coverage, risk_score, ...}
// We normalize both to a flat shape for rendering.
function _normalizeScenario(raw) {
  if (raw.results) {
    // Full scenario from run/get endpoint
    const r = raw.results;
    return {
      ...raw,
      coverage: r.coverage,
      coverage_histogram: r.histogram,
      skill_breakdown: r.skill_breakdown,
      risk_score: r.risk_score,
      risk_level: r.risk_level,
      prob_adequate: r.prob_adequate,
      prob_critical: r.prob_critical,
      n_runs: r.n_runs,
      p50: r.coverage ? r.coverage.p50 : 0,
      p10: r.coverage ? r.coverage.p10 : 0,
    };
  }
  // List summary from GET /api/scenarios
  return {
    ...raw,
    p50: raw.p50_coverage || 0,
    p10: raw.p10_coverage || 0,
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

// ── Config tab ────────────────────────────────────────────────────────────────
// Renders PAX Config assumptions + Staff Skills editor.
// initConfig() is called from longterm.js whenever the user opens this tab.

let _cfgLoaded = false;   // prevents re-fetching when tab is revisited

async function initConfig() {
  const container = document.getElementById('config-content');
  if (!container) return;

  // Re-render on every visit so edits from a save are visible immediately.
  _cfgLoaded = false;
  container.innerHTML = `<div style="display:flex;align-items:center;gap:10px;padding:40px;color:var(--muted);font-size:0.85rem;">
    <div class="spinner" style="width:18px;height:18px;border-width:2px;"></div> Loading configuration…
  </div>`;

  try {
    const [paxRes, skillsRes] = await Promise.all([
      fetch('/api/config/pax').then(r => r.json()),
      fetch('/api/config/staff-skills').then(r => r.json()),
    ]);
    renderConfigPage(container, paxRes, skillsRes);
    _cfgLoaded = true;
  } catch (err) {
    container.innerHTML = `<div style="padding:40px;color:var(--crit);font-size:0.85rem;">
      Failed to load configuration: ${err.message}
    </div>`;
  }
}

// ── Toast helper ──────────────────────────────────────────────────────────────
function _cfgToast(msg, type = 'ok') {
  const colours = { ok: 'var(--ok)', error: 'var(--crit)', warn: 'var(--warn)' };
  const icons   = { ok: '✓', error: '✕', warn: '⚠' };
  const t = document.createElement('div');
  t.style.cssText = `position:fixed;bottom:28px;right:28px;z-index:9999;
    background:var(--surface-2);border:1px solid ${colours[type]};
    color:var(--text);border-radius:8px;padding:12px 18px;font-size:0.82rem;
    display:flex;align-items:center;gap:10px;box-shadow:var(--shadow-md);
    animation:fadeInUp .2s ease;max-width:380px;`;
  t.innerHTML = `<span style="color:${colours[type]};font-weight:700;font-size:1rem;">${icons[type]}</span>
    <span>${msg}</span>`;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

// ── Full page render ──────────────────────────────────────────────────────────
function renderConfigPage(container, paxData, skillsData) {
  container.innerHTML = '';

  // ── PAX Config card ───────────────────────────────────────────────────────
  const paxCard = document.createElement('div');
  paxCard.className = 'panel mt-0';
  paxCard.style.marginBottom = '24px';
  paxCard.innerHTML = _buildPaxCard(paxData);
  container.appendChild(paxCard);

  // Wire PAX save
  paxCard.querySelector('#cfg-pax-save')?.addEventListener('click', () =>
    _savePaxConfig(paxCard, paxData)
  );
  paxCard.querySelector('#cfg-pax-reset')?.addEventListener('click', () => {
    paxCard.querySelectorAll('.cfg-rate-input').forEach(inp => {
      inp.value = parseFloat(inp.dataset.original).toFixed(1);
      inp.classList.remove('cfg-dirty');
    });
    _updatePaxDirtyBadge(paxCard);
  });
  paxCard.querySelectorAll('.cfg-rate-input').forEach(inp => {
    inp.addEventListener('input', () => {
      inp.classList.toggle('cfg-dirty', inp.value !== inp.dataset.original);
      _updatePaxDirtyBadge(paxCard);
    });
  });

  // ── Staff Skills card ──────────────────────────────────────────────────────
  const skillCard = document.createElement('div');
  skillCard.className = 'panel';
  skillCard.style.marginBottom = '24px';
  container.appendChild(skillCard);
  _renderSkillsCard(skillCard, skillsData);
}

// ── PAX Config card HTML ──────────────────────────────────────────────────────
function _buildPaxCard(paxData) {
  const rows = paxData.rows || [];
  // Group by terminal
  const byTerminal = {};
  rows.forEach(r => {
    const t = r.terminal || 'Other';
    if (!byTerminal[t]) byTerminal[t] = [];
    byTerminal[t].push(r);
  });

  const tableRows = rows.map(r => `
    <tr style="border-bottom:1px solid var(--border);">
      <td style="padding:9px 12px;">
        <span style="font-size:0.72rem;font-weight:700;color:var(--accent);background:var(--accent)18;
          border-radius:4px;padding:2px 7px;">${r.terminal}</span>
      </td>
      <td style="padding:9px 12px;font-size:0.82rem;color:var(--muted);">${r.skill}</td>
      <td style="padding:9px 12px;text-align:right;">
        <input type="number" class="cfg-rate-input"
          data-col="${r.col}"
          data-original="${r.rate}"
          value="${r.rate.toFixed(1)}"
          min="1" max="9999" step="0.5"
          style="width:90px;padding:5px 8px;background:var(--surface-2);border:1px solid var(--border-2);
            border-radius:5px;color:var(--text);font-size:0.82rem;text-align:right;outline:none;
            transition:border-color .15s;" />
      </td>
    </tr>`).join('');

  return `
    <div class="panel-title-row">
      <span class="panel-title">PAX Productivity Assumptions</span>
      <div style="display:flex;align-items:center;gap:8px;">
        <span id="cfg-pax-dirty-badge" style="display:none;font-size:0.72rem;color:var(--warn);
          background:var(--warn-light);border-radius:4px;padding:2px 8px;font-weight:600;">
          unsaved changes
        </span>
        <button id="cfg-pax-reset" class="btn-outline" style="padding:5px 12px;font-size:0.78rem;">
          Reset
        </button>
        <button id="cfg-pax-save" class="btn-primary" style="padding:5px 14px;font-size:0.78rem;">
          Save Rates
        </button>
      </div>
    </div>
    <p style="font-size:0.78rem;color:var(--muted);margin:6px 0 16px;">
      Passengers handled by <strong style="color:var(--text-2);">one FTE per 15-minute slot</strong>.
      Changes affect demand forecasts across all planning views.
    </p>
    <div style="overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;font-size:0.82rem;">
        <thead>
          <tr style="border-bottom:2px solid var(--border-2);">
            <th style="padding:8px 12px;text-align:left;font-size:0.7rem;text-transform:uppercase;
              letter-spacing:.06em;color:var(--muted);font-weight:600;">Terminal</th>
            <th style="padding:8px 12px;text-align:left;font-size:0.7rem;text-transform:uppercase;
              letter-spacing:.06em;color:var(--muted);font-weight:600;">Touchpoint</th>
            <th style="padding:8px 12px;text-align:right;font-size:0.7rem;text-transform:uppercase;
              letter-spacing:.06em;color:var(--muted);font-weight:600;">Pax / FTE / 15 min</th>
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>`;
}

function _updatePaxDirtyBadge(paxCard) {
  const dirty = paxCard.querySelectorAll('.cfg-rate-input.cfg-dirty').length;
  const badge = paxCard.querySelector('#cfg-pax-dirty-badge');
  if (!badge) return;
  badge.style.display = dirty > 0 ? '' : 'none';
  badge.textContent = `${dirty} unsaved change${dirty !== 1 ? 's' : ''}`;
}

async function _savePaxConfig(paxCard, paxData) {
  const dirtyInputs = paxCard.querySelectorAll('.cfg-rate-input.cfg-dirty');
  if (!dirtyInputs.length) { _cfgToast('No changes to save.', 'warn'); return; }

  const updates = {};
  dirtyInputs.forEach(inp => { updates[inp.dataset.col] = parseFloat(inp.value); });

  const btn = paxCard.querySelector('#cfg-pax-save');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

  try {
    const res = await fetch('/api/config/pax', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Save failed');

    // Update originals so dirty-check resets
    paxCard.querySelectorAll('.cfg-rate-input').forEach(inp => {
      inp.dataset.original = inp.value;
      inp.classList.remove('cfg-dirty');
    });
    _updatePaxDirtyBadge(paxCard);

    await _globalCacheReload();
    _cfgToast(`PAX rates saved (${data.changed} column${data.changed !== 1 ? 's' : ''} updated). All views will use new rates.`);
  } catch (err) {
    _cfgToast('Save failed: ' + err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Save Rates'; }
  }
}

// ── Staff Skills card ─────────────────────────────────────────────────────────
function _renderSkillsCard(card, skillsData) {
  const allStaff      = (skillsData.staff || []).slice();
  const validSkills   = (skillsData.valid_skills || []);
  // dirty map: {id → {skill1, skill2, skill3, skill4}}
  const dirtyMap      = {};

  function _optionsHtml(currentVal) {
    const empty = `<option value="">— none —</option>`;
    const opts  = validSkills.map(sk =>
      `<option value="${sk}"${sk === currentVal ? ' selected' : ''}>${sk}</option>`
    ).join('');
    return empty + opts;
  }

  function _buildTable(staff) {
    if (!staff.length) {
      return `<tr><td colspan="7" style="padding:24px;text-align:center;color:var(--muted);font-size:0.82rem;">
        No staff match this search.</td></tr>`;
    }
    return staff.map(s => {
      const isDirty = !!dirtyMap[s.id];
      return `<tr data-empid="${s.id}" style="border-bottom:1px solid var(--border);${isDirty ? 'background:var(--warn-light);' : ''}">
        <td style="padding:8px 12px;font-size:0.78rem;font-weight:600;color:var(--text-2);white-space:nowrap;">
          ${s.id}${isDirty ? ' <span style="color:var(--warn);font-size:0.65rem;font-weight:700;">●</span>' : ''}
        </td>
        <td style="padding:8px 10px;font-size:0.72rem;color:var(--muted);">${s.employment_type || '—'}</td>
        ${['skill1','skill2','skill3','skill4'].map((sk, i) => {
          const cur = (dirtyMap[s.id] || s)[sk];
          return `<td style="padding:6px 8px;">
            <select class="cfg-skill-sel" data-empid="${s.id}" data-skillkey="${sk}"
              style="width:110px;padding:4px 6px;background:var(--surface-2);border:1px solid var(--border-2);
                border-radius:5px;color:var(--text);font-size:0.75rem;outline:none;">
              ${_optionsHtml(cur)}
            </select>
          </td>`;
        }).join('')}
      </tr>`;
    }).join('');
  }

  function _dirty() { return Object.keys(dirtyMap).length; }

  function _refresh(filterVal = '') {
    const q   = filterVal.toLowerCase().trim();
    const vis = q ? allStaff.filter(s => s.id.toLowerCase().includes(q)) : allStaff;
    tbody.innerHTML = _buildTable(vis);

    // Wire skill selects
    tbody.querySelectorAll('.cfg-skill-sel').forEach(sel => {
      sel.addEventListener('change', () => {
        const empId   = sel.dataset.empid;
        const skillKey = sel.dataset.skillkey;
        const orig    = allStaff.find(s => s.id === empId);
        if (!orig) return;

        if (!dirtyMap[empId]) dirtyMap[empId] = { ...orig };
        dirtyMap[empId][skillKey] = sel.value;

        // Check if row still differs from original
        const d = dirtyMap[empId];
        if (d.skill1 === orig.skill1 && d.skill2 === orig.skill2 &&
            d.skill3 === orig.skill3 && d.skill4 === orig.skill4) {
          delete dirtyMap[empId];
        }

        _updateSkillDirtyBadge();
        // Re-highlight this row
        const row = tbody.querySelector(`tr[data-empid="${empId}"]`);
        if (row) row.style.background = dirtyMap[empId] ? 'var(--warn-light)' : '';
        const idCell = row?.querySelector('td:first-child');
        if (idCell) {
          idCell.innerHTML = empId + (dirtyMap[empId]
            ? ' <span style="color:var(--warn);font-size:0.65rem;font-weight:700;">●</span>'
            : '');
        }
      });
    });
  }

  function _updateSkillDirtyBadge() {
    const n = _dirty();
    badge.style.display = n > 0 ? '' : 'none';
    badge.textContent   = `${n} unsaved change${n !== 1 ? 's' : ''}`;
    saveBtn.disabled    = n === 0;
    saveBtn.style.opacity = n > 0 ? '1' : '0.5';
  }

  // Build card HTML shell
  card.innerHTML = `
    <div class="panel-title-row">
      <span class="panel-title">Staff Skill Assignments</span>
      <div style="display:flex;align-items:center;gap:8px;">
        <span id="cfg-skill-dirty-badge" style="display:none;font-size:0.72rem;color:var(--warn);
          background:var(--warn-light);border-radius:4px;padding:2px 8px;font-weight:600;"></span>
        <button id="cfg-skill-reset" class="btn-outline" style="padding:5px 12px;font-size:0.78rem;">
          Reset All
        </button>
        <button id="cfg-skill-save" class="btn-primary" style="padding:5px 14px;font-size:0.78rem;
          opacity:0.5;" disabled>
          Save Skills
        </button>
      </div>
    </div>
    <p style="font-size:0.78rem;color:var(--muted);margin:6px 0 16px;">
      Each staff member can have up to <strong style="color:var(--text-2);">4 skills</strong>
      (Skill 1 = primary). Changes update the roster and intraday optimizer immediately after saving.
    </p>
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;">
      <input id="cfg-skill-search" type="text" placeholder="Search by employee ID…"
        class="search-input" style="width:220px;" />
      <span style="font-size:0.75rem;color:var(--muted);">${allStaff.length} staff members</span>
    </div>
    <div style="overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;font-size:0.82rem;">
        <thead>
          <tr style="border-bottom:2px solid var(--border-2);">
            <th style="padding:8px 12px;text-align:left;font-size:0.7rem;text-transform:uppercase;
              letter-spacing:.06em;color:var(--muted);font-weight:600;white-space:nowrap;">Employee ID</th>
            <th style="padding:8px 12px;text-align:left;font-size:0.7rem;text-transform:uppercase;
              letter-spacing:.06em;color:var(--muted);font-weight:600;">Type</th>
            <th style="padding:8px 12px;text-align:left;font-size:0.7rem;text-transform:uppercase;
              letter-spacing:.06em;color:var(--accent);font-weight:600;">Skill 1 ★</th>
            <th style="padding:8px 12px;text-align:left;font-size:0.7rem;text-transform:uppercase;
              letter-spacing:.06em;color:var(--muted);font-weight:600;">Skill 2</th>
            <th style="padding:8px 12px;text-align:left;font-size:0.7rem;text-transform:uppercase;
              letter-spacing:.06em;color:var(--muted);font-weight:600;">Skill 3</th>
            <th style="padding:8px 12px;text-align:left;font-size:0.7rem;text-transform:uppercase;
              letter-spacing:.06em;color:var(--muted);font-weight:600;">Skill 4</th>
          </tr>
        </thead>
        <tbody id="cfg-skill-tbody"></tbody>
      </table>
    </div>`;

  const tbody  = card.querySelector('#cfg-skill-tbody');
  const badge  = card.querySelector('#cfg-skill-dirty-badge');
  const saveBtn = card.querySelector('#cfg-skill-save');
  const resetBtn = card.querySelector('#cfg-skill-reset');
  const searchIn = card.querySelector('#cfg-skill-search');

  _refresh('');

  searchIn?.addEventListener('input', () => _refresh(searchIn.value));

  resetBtn?.addEventListener('click', () => {
    Object.keys(dirtyMap).forEach(k => delete dirtyMap[k]);
    _updateSkillDirtyBadge();
    _refresh(searchIn?.value || '');
  });

  saveBtn?.addEventListener('click', async () => {
    if (!_dirty()) return;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';

    const updates = Object.values(dirtyMap);
    try {
      const res  = await fetch('/api/config/staff-skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');

      // Commit dirty values back into allStaff
      updates.forEach(upd => {
        const idx = allStaff.findIndex(s => s.id === upd.id);
        if (idx !== -1) Object.assign(allStaff[idx], upd);
        delete dirtyMap[upd.id];
      });

      _updateSkillDirtyBadge();
      _refresh(searchIn?.value || '');

      await _globalCacheReload();
      _cfgToast(`${data.changed} skill assignment${data.changed !== 1 ? 's' : ''} saved. Optimizer will use new skills in the next run.`);
    } catch (err) {
      _cfgToast('Save failed: ' + err.message, 'error');
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save Skills';
      _updateSkillDirtyBadge();
    }
  });
}

// ── Global cache reload ───────────────────────────────────────────────────────
// Clears server caches AND resets client-side live data so every view
// re-fetches on next open.
async function _globalCacheReload() {
  try {
    await fetch('/api/config/reload', { method: 'POST' });
  } catch (_) {}

  // Reset client-side data so views re-initialize with fresh data
  if (typeof ID_DATA !== 'undefined') {
    // eslint-disable-next-line no-global-assign
    try { ID_DATA = null; } catch (_) {}
  }
}

"""
roster_optimizer.py
~~~~~~~~~~~~~~~~~~~~
Two-phase roster optimisation: shift-pattern generation → staff assignment.

Phase 1  Candidate Shift-Pattern Generation
  Builds feasible patterns from demand-coverage analysis.
  Resolution    60-minute start-time grid, 12-hour maximum length
  Break slots   pre-computed per Roster_constraints.json rules
  Pruning       only patterns covering ≥1 active demand window survive
  Score         Σ demand-minutes × priority_weight covered per pattern

  Note on column generation: true CG iterates a master LP and a pricing
  sub-problem to grow columns on demand. For ≤24 candidate patterns
  (60-min grid × 12-h max) a full enumeration is cheaper and sufficient
  at this scale. The architecture mirrors CG so the pricing step can be
  wired in later without restructuring.

Phase 2  Staff Assignment
  (a) Greedy pass — O(patterns × staff), scales to 100+ employees.
      Sorts patterns by coverage_score DESC; assigns staff respecting:
        • 11-hour rest between consecutive shifts (hard)
        • Primary > secondary skill preference (soft, penalised)
        • Load balance: assigns least-loaded staff first
  (b) MIP refinement via PuLP/CBC (optional, behind `use_mip` flag).
      Re-optimises the greedy assignment to minimise:
        • Skill mismatch cost (primary vs secondary)
        • L1 deviation from mean utilisation (fairness)
        • Demand coverage gaps (weighted by priority)

Public API
----------
  from roster_optimizer import generate_roster, SOLVER_AVAILABLE

  result = generate_roster(demand_windows, staff_list, constraints, use_mip=True)

  Keys in result:
    patterns          list[dict]   — candidate patterns with scores
    roster            list[dict]   — one entry per staff member
    utilisation       dict         — per-staff utilisation stats
    fairness          dict         — Gini coefficient + workload stats
    coverage          dict         — demand coverage by skill/priority
    flags             list[dict]   — REST_BREACH, SECONDARY_SKILL_USED …
    solver_used       str
"""
from __future__ import annotations

import logging
import math
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Optional solver
# ---------------------------------------------------------------------------
_PULP_AVAILABLE = False
try:
    import pulp
    _PULP_AVAILABLE = True
except ImportError:
    logger.warning("PuLP not installed — MIP refinement disabled; greedy only. "
                   "Run: pip install pulp")

SOLVER_AVAILABLE = _PULP_AVAILABLE    # exposed for caller feature-detection

# ---------------------------------------------------------------------------
# Constraint defaults  (mirrored from Roster_constraints.json)
# ---------------------------------------------------------------------------
_MAX_SHIFT_MINS     = 720   # 12 h hard ceiling
_MIN_REST_MINS      = 660   # 11 h between consecutive shifts
_B1_MINS            = 30    # first break (Short Break)
_B2_MINS            = 60    # second break (Meal Break)
_B1_EARLIEST_AFTER  = 120   # earliest after shift-start break-1 may begin
_B1_LATEST_AFTER    = 360   # latest  after shift-start break-1 must begin
_B2_EARLIEST_AFTER_B1_END = 120   # gap before break-2 may start
_NET_WORKING_MINS   = 630   # gross 720 − 30 − 60

_PATTERN_RESOLUTION = 60    # candidate window spacing (minutes)
_MAX_PATTERNS       = 18    # upper cap on pruned candidate set per day

# Objective-function weights
_PRIORITY_WEIGHT = {"Critical": 8, "High": 4, "Medium": 2, "Low": 1}
_DEFAULT_PW      = 2
_SECONDARY_PENALTY   = 15   # MIP cost per secondary-skill assignment
_COVERAGE_GAP_COST   = 500  # MIP cost per FTE-demand not covered
_FAIRNESS_WEIGHT     = 1    # MIP weight on L1 workload deviation


# ===========================================================================
# Data structures
# ===========================================================================

@dataclass
class ShiftPattern:
    """One candidate shift window with pre-computed break positions."""
    pat_id:     str
    start_mins: int
    end_mins:   int          # may exceed 1440 for night-side windows
    label:      str          # e.g. "00:00–12:00"
    b1_start:   int          # first break start (absolute mins)
    b1_end:     int
    b2_start:   int
    b2_end:     int
    net_working_mins: int    # gross − breaks
    coverage_score: float = 0.0
    demand_profile: dict = field(default_factory=dict)  # {skill: fte_covered}


@dataclass
class DemandWindow:
    """A single staffing demand slot derived from a flight task."""
    start:    int
    end:      int
    skill:    str
    needed:   int            # headcount required
    priority: str
    task_id:  str = ""


# ===========================================================================
# Phase 1 — Shift Pattern Generation
# ===========================================================================

def generate_shift_patterns(
    demand_windows: list[DemandWindow],
    constraints:    dict,
) -> list[ShiftPattern]:
    """Build and score all feasible shift patterns for a single day.

    The function generates every 60-minute-offset window of
    MAX_SHIFT_MINS length, pre-schedules breaks, scores each pattern
    by demand coverage, then prunes to at most MAX_PATTERNS candidates.

    Always guarantees the two canonical DAY (00:00–12:00) and NIGHT
    (12:00–24:00) patterns survive pruning so the output is never empty.
    """
    b1_mins = int(constraints.get("b1_duration_mins", _B1_MINS))
    b2_mins = int(constraints.get("b2_duration_mins", _B2_MINS))
    max_shift = int(constraints.get("max_shift_mins", _MAX_SHIFT_MINS))
    b1_earliest = _B1_EARLIEST_AFTER
    b1_latest   = _B1_LATEST_AFTER
    b2_gap      = _B2_EARLIEST_AFTER_B1_END

    patterns: list[ShiftPattern] = []

    for start in range(0, 1440, _PATTERN_RESOLUTION):
        end = start + max_shift   # e.g. start=240 → end=960

        # Breaks placed at earliest mandatory trigger to maximise
        # available task time at start-of-shift.
        b1_start = start + b1_earliest
        b1_end   = b1_start + b1_mins
        b2_start = b1_end + b2_gap
        b2_end   = b2_start + b2_mins

        # Sanity: breaks must fit inside the shift
        if b2_end > end:
            continue

        net_mins = max_shift - b1_mins - b2_mins

        # Label uses %H:%M notation; wrap-around to next day shown as >24:00
        def _fmt(m: int) -> str:
            h, mn = divmod(m, 60)
            return f"{h:02d}:{mn:02d}"

        label = f"{_fmt(start)}–{_fmt(end)}"
        pat_id = f"P{start:04d}"

        pat = ShiftPattern(
            pat_id=pat_id,
            start_mins=start,
            end_mins=end,
            label=label,
            b1_start=b1_start,
            b1_end=b1_end,
            b2_start=b2_start,
            b2_end=b2_end,
            net_working_mins=net_mins,
        )

        # Score by weighted demand coverage
        pat.coverage_score, pat.demand_profile = _score_pattern(pat, demand_windows)
        patterns.append(pat)

    # Always keep the two canonical shifts (even if demand is zero)
    canonical = {0, 720}   # DAY=00:00, NIGHT=12:00
    canonical_pats = [p for p in patterns if p.start_mins in canonical]
    other_pats = sorted(
        [p for p in patterns if p.start_mins not in canonical],
        key=lambda p: -p.coverage_score,
    )

    # Prune: top (MAX_PATTERNS − len(canonical)) non-canonical + all canonical
    keep_extra = max(0, _MAX_PATTERNS - len(canonical_pats))
    pruned = canonical_pats + other_pats[:keep_extra]

    # Only keep patterns with positive coverage (except canonical anchors)
    result = [
        p for p in pruned
        if p.start_mins in canonical or p.coverage_score > 0
    ]

    # Final sort: DAY first, NIGHT second, others by start time
    result.sort(key=lambda p: (p.start_mins not in canonical, p.start_mins))
    logger.info(
        "Pattern generation: %d candidates → %d after pruning",
        len(patterns), len(result),
    )
    return result


def _score_pattern(
    pat: ShiftPattern,
    demand_windows: list[DemandWindow],
) -> tuple[float, dict]:
    """Compute weighted demand-coverage score for one shift pattern.

    Score = Σ_window  overlap_minutes × priority_weight × staff_needed
    where overlap is the intersection of the pattern window and the
    demand window (break slots excluded from the pattern's working time).

    Returns (score, {skill: coverage_fte}) pair.
    """
    # Build the working segments of this pattern (excluding break slots)
    working_segs = _working_segments(pat)

    total_score = 0.0
    skill_coverage: dict[str, float] = defaultdict(float)

    for dw in demand_windows:
        # Demand window may wrap midnight: normalise to absolute minutes
        dw_start = dw.start
        dw_end   = dw.end
        if dw_end <= dw_start:
            dw_end += 1440   # wrap

        pw = _PRIORITY_WEIGHT.get(dw.priority, _DEFAULT_PW)

        overlap = sum(
            max(0, min(seg_end, dw_end) - max(seg_start, dw_start))
            for seg_start, seg_end in working_segs
        )
        demand_dur = max(1, dw_end - dw_start)
        # Coverage fraction of the demand window that this pattern covers
        frac = min(overlap / demand_dur, 1.0)

        contribution = frac * pw * dw.needed
        total_score += contribution
        if contribution > 0:
            skill_coverage[dw.skill] += frac * dw.needed

    return total_score, dict(skill_coverage)


def _working_segments(pat: ShiftPattern) -> list[tuple[int, int]]:
    """Return list of (start, end) working segments for a pattern,
    with break slots removed.
    """
    return [
        (pat.start_mins, pat.b1_start),
        (pat.b1_end,     pat.b2_start),
        (pat.b2_end,     pat.end_mins),
    ]


# ===========================================================================
# Phase 2a — Greedy Staff Assignment
# ===========================================================================

def assign_greedy(
    patterns:          list[ShiftPattern],
    staff:             list[dict],
    prev_shift_ends:   dict[str, int],
    constraints:       dict,
) -> dict[str, str]:
    """Greedy staff-to-pattern assignment.

    Algorithm
    ---------
    1. Sort patterns by coverage_score DESC (highest-value patterns first).
    2. For each pattern, collect candidate staff ordered by:
          a. Rest compliance  — pattern.start >= prev_end + 660
          b. Skill fit score  — primary=2, secondary=1, none=0 per demanded skill
          c. Current load     — ascending gross assigned minutes (load balance)
    3. Assign as many staff as each pattern's peak demand requires.
    4. Staff already assigned to a pattern are skipped.

    Returns
    -------
    {staff_id: pattern.pat_id}
    """
    min_rest = int(constraints.get("min_rest_mins", _MIN_REST_MINS))

    # Build demand totals per pattern to know how many staff each needs
    pattern_demand: dict[str, int] = {}
    for p in patterns:
        pattern_demand[p.pat_id] = max(1, int(sum(p.demand_profile.values())))

    # Sort patterns: highest coverage first
    sorted_pats = sorted(patterns, key=lambda p: -p.coverage_score)

    assignment: dict[str, str] = {}       # staff_id → pat_id
    staff_load: dict[str, int] = {}       # staff_id → gross_assigned_mins (starts at 0)

    for s in staff:
        staff_load[s["id"]] = 0

    unassigned = {s["id"] for s in staff}

    for pat in sorted_pats:
        needed = pattern_demand.get(pat.pat_id, 1)
        if needed <= 0 or not unassigned:
            break

        # Score each unassigned staff member for this pattern
        candidates = []
        for s in staff:
            sid = s["id"]
            if sid not in unassigned:
                continue

            # Hard: 11-hour rest rule
            prev_end = prev_shift_ends.get(sid, 0)
            rest_gap = (pat.start_mins - prev_end) % 1440
            if rest_gap < min_rest:
                continue  # rest breach — skip

            # Skill fit: score 2 for primary match, 1 for any secondary match
            skill_fit = _skill_fit(s, pat.demand_profile)

            candidates.append((
                -skill_fit,             # higher fit → smaller sort key
                staff_load[sid],        # lower load → smaller sort key (balance)
                sid,
                s,
            ))

        candidates.sort()

        assigned_this = 0
        for _, _, sid, _ in candidates:
            if assigned_this >= needed:
                break
            assignment[sid] = pat.pat_id
            staff_load[sid] += pat.net_working_mins
            unassigned.discard(sid)
            assigned_this += 1

    # Remaining unassigned staff: give them the canonical DAY shift (P0000)
    # so they still appear in the roster with a valid shift window.
    canonical_day_id = "P0000"
    fallback_pat = next((p for p in patterns if p.pat_id == canonical_day_id), patterns[0])
    for sid in list(unassigned):
        prev_end = prev_shift_ends.get(sid, 0)
        rest_gap = (fallback_pat.start_mins - prev_end) % 1440
        if rest_gap >= min_rest:
            assignment[sid] = fallback_pat.pat_id
            staff_load[sid] += fallback_pat.net_working_mins

    return assignment


def _skill_fit(staff_member: dict, demand_profile: dict[str, float]) -> int:
    """Return a 0-4 integer skill-fit score for a staff↔pattern pair.

    • +2 for each skill in demand_profile that the staff member holds as primary
    • +1 for each skill held as secondary (skill2-4)
    Higher is better.
    """
    if not demand_profile:
        return 1   # no skill data: neutral

    primary = staff_member.get("skill1", "").strip()
    secondary = {
        staff_member.get(f"skill{k}", "").strip()
        for k in range(2, 5)
        if staff_member.get(f"skill{k}", "").strip()
    }

    score = 0
    for skill in demand_profile:
        if skill == primary:
            score += 2
        elif skill in secondary:
            score += 1
    return score


# ===========================================================================
# Phase 2b — MIP Refinement (PuLP / CBC)
# ===========================================================================

def refine_with_mip(
    greedy_assignment: dict[str, str],
    patterns:          list[ShiftPattern],
    staff:             list[dict],
    demand_windows:    list[DemandWindow],
    prev_shift_ends:   dict[str, int],
    constraints:       dict,
) -> tuple[dict[str, str], str]:
    """Improve the greedy solution with a set-partitioning MIP.

    Model
    -----
    Variables
      y[s,p] ∈ {0,1}   — staff s assigned to pattern p
      gap[s] ≥ 0        — L1 deviation of staff s from mean utilisation
      cov_gap[d] ≥ 0    — unmet demand headcount for window d

    Constraints
      (1) Each staff to exactly one pattern            Σ_p y[s,p] = 1
      (2) Rest rule: y[s,p] = 0 if rest gap < 660 min (pre-filtered)
      (3) Workload mean  T = (Σ_{s,p} y[s,p]·net_mins) / n_staff
          Linearised:    gap[s] ≥  assigned_mins[s] - T
                         gap[s] ≥ -(assigned_mins[s] - T)
          where T is a free variable

    Objective
      Minimise:
        Σ_s Σ_p  y[s,p] · skill_mismatch_cost[s,p]   (prefer primary skill)
        + FAIRNESS_WEIGHT · Σ_s gap[s]                (workload balance)
        + COVERAGE_GAP_COST · Σ_d cov_gap[d]          (meet demand)

    Returns (improved_assignment, solver_status_string).
    """
    if not _PULP_AVAILABLE:
        return greedy_assignment, "PuLP_unavailable"

    min_rest = int(constraints.get("min_rest_mins", _MIN_REST_MINS))
    total_staff = len(staff)
    if total_staff == 0 or not patterns:
        return greedy_assignment, "trivial"

    prob = pulp.LpProblem("roster_mip", pulp.LpMinimize)

    # -------------------------------------------------------------------
    # Feasibility filter: which (staff, pattern) combinations are allowed?
    # (rest rule pre-applied to avoid adding infeasible y variables)
    # -------------------------------------------------------------------
    feasible: dict[tuple[str, str], pulp.LpVariable] = {}
    for s in staff:
        sid = s["id"]
        prev_end = prev_shift_ends.get(sid, 0)
        for p in patterns:
            rest_gap = (p.start_mins - prev_end) % 1440
            if rest_gap >= min_rest:
                var_name = f"y_{sid.replace('-','_')}_{p.pat_id}"
                feasible[sid, p.pat_id] = pulp.LpVariable(var_name, cat="Binary")

    if not feasible:
        return greedy_assignment, "no_feasible_vars"

    # -------------------------------------------------------------------
    # Constraint (1): each staff assigned to exactly one feasible pattern
    # -------------------------------------------------------------------
    pat_ids = {p.pat_id for p in patterns}
    for s in staff:
        sid = s["id"]
        staff_vars = [feasible[sid, pid] for pid in pat_ids if (sid, pid) in feasible]
        if staff_vars:
            prob += pulp.lpSum(staff_vars) == 1, f"one_pattern_{sid.replace('-','_')}"

    # -------------------------------------------------------------------
    # Workload balance via L1 deviation from mean
    # T = mean utilisation (free continuous var)
    # gap[s] >= |assigned_mins[s] - T|
    # -------------------------------------------------------------------
    T = pulp.LpVariable("target_util", lowBound=0)
    gap_vars: dict[str, pulp.LpVariable] = {}

    for s in staff:
        sid = s["id"]
        g = pulp.LpVariable(f"gap_{sid.replace('-','_')}", lowBound=0)
        gap_vars[sid] = g

        # Σ_p y[s,p] × net_mins[p]  →  assigned_mins
        terms = [
            feasible[sid, p.pat_id] * p.net_working_mins
            for p in patterns
            if (sid, p.pat_id) in feasible
        ]
        if terms:
            assigned_mins = pulp.lpSum(terms)
            prob += g >= assigned_mins - T, f"gap_pos_{sid.replace('-','_')}"
            prob += g >= T - assigned_mins, f"gap_neg_{sid.replace('-','_')}"

    # -------------------------------------------------------------------
    # Demand coverage gap (soft: penalised but not hard)
    # For each demand window: Σ_s Σ_p y[s,p] × covers[p,dw] × skill_ok[s,dw]
    #   ≥ dw.needed − cov_gap[dw]
    # -------------------------------------------------------------------
    cov_gap_vars: list[pulp.LpVariable] = []
    for di, dw in enumerate(demand_windows[:40]):  # cap at 40 to keep model lean
        cg = pulp.LpVariable(f"cov_gap_{di}", lowBound=0, upBound=dw.needed)
        cov_gap_vars.append(cg)
        pw = _PRIORITY_WEIGHT.get(dw.priority, _DEFAULT_PW)

        cover_terms = []
        for s in staff:
            sid = s["id"]
            primary   = s.get("skill1", "").strip()
            secondary = {s.get(f"skill{k}", "").strip() for k in range(2, 5) if s.get(f"skill{k}", "")}

            if dw.skill not in ({primary} | secondary):
                continue

            for p in patterns:
                if (sid, p.pat_id) not in feasible:
                    continue
                # Check if this pattern's working window covers the demand window
                segs = _working_segments(p)
                dw_dur = max(1, dw.end - dw.start)
                overlap = sum(
                    max(0, min(se, dw.end) - max(ss, dw.start))
                    for ss, se in segs
                )
                if overlap / dw_dur >= 0.5:   # covers ≥50% of demand window
                    cover_terms.append(feasible[sid, p.pat_id])

        if cover_terms:
            prob += (
                pulp.lpSum(cover_terms) + cg >= dw.needed,
                f"demand_cov_{di}",
            )

    # -------------------------------------------------------------------
    # Objective
    # -------------------------------------------------------------------
    # Term 1: skill mismatch cost (prefer primary)
    mismatch_cost = []
    for s in staff:
        sid = s["id"]
        primary = s.get("skill1", "").strip()
        for p in patterns:
            if (sid, p.pat_id) not in feasible:
                continue
            # Primary skill in pattern demand → no penalty; secondary → penalty
            prim_covered  = p.demand_profile.get(primary, 0)
            total_demand  = sum(p.demand_profile.values()) or 1
            sec_fraction  = max(0, 1 - prim_covered / total_demand)
            cost_coeff    = int(sec_fraction * _SECONDARY_PENALTY)
            if cost_coeff > 0:
                mismatch_cost.append(feasible[sid, p.pat_id] * cost_coeff)

    # Term 2: fairness (L1 deviation from mean)
    fairness_terms = [_FAIRNESS_WEIGHT * g for g in gap_vars.values()]

    # Term 3: coverage gaps
    gap_priority_terms = []
    for di, dw in enumerate(demand_windows[:40]):
        pw = _PRIORITY_WEIGHT.get(dw.priority, _DEFAULT_PW)
        gap_priority_terms.append(cov_gap_vars[di] * _COVERAGE_GAP_COST * pw)

    prob += (
        pulp.lpSum(mismatch_cost)
        + pulp.lpSum(fairness_terms)
        + pulp.lpSum(gap_priority_terms)
    ), "total_cost"

    # -------------------------------------------------------------------
    # Solve (time-limited; warm-start from greedy)
    # -------------------------------------------------------------------
    # Warm-start: fix greedy assignment as initial hint
    for s in staff:
        sid = s["id"]
        greedy_pid = greedy_assignment.get(sid)
        for p in patterns:
            if (sid, p.pat_id) in feasible:
                feasible[sid, p.pat_id].setInitialValue(
                    1 if p.pat_id == greedy_pid else 0
                )

    solver = pulp.PULP_CBC_CMD(msg=0, timeLimit=90, warmStart=True)
    prob.solve(solver)

    status = pulp.LpStatus[prob.status]
    logger.info("MIP refinement  status=%-10s  obj=%.0f", status, pulp.value(prob.objective) or 0)

    if prob.status not in (1,):  # 1 = Optimal
        logger.warning("MIP did not reach optimality; returning greedy solution")
        return greedy_assignment, status

    # -------------------------------------------------------------------
    # Extract solution
    # -------------------------------------------------------------------
    improved: dict[str, str] = {}
    for s in staff:
        sid = s["id"]
        assigned_pat = greedy_assignment.get(sid)   # fallback
        for p in patterns:
            if (sid, p.pat_id) in feasible and pulp.value(feasible[sid, p.pat_id]) > 0.5:
                assigned_pat = p.pat_id
                break
        if assigned_pat:
            improved[sid] = assigned_pat

    return improved, status


# ===========================================================================
# Metrics
# ===========================================================================

def compute_fairness_gini(utilisation_list: list[float]) -> float:
    """Compute the Gini coefficient of the utilisation distribution.

    Gini = 0  →  all staff equally utilised (perfect fairness)
    Gini = 1  →  one staff member carries all work (total inequality)
    """
    n = len(utilisation_list)
    if n < 2:
        return 0.0
    vals = sorted(max(0.0, v) for v in utilisation_list)
    total = sum(vals) or 1e-9
    cum = 0.0
    gini_sum = 0.0
    for i, v in enumerate(vals, 1):
        cum += v
        gini_sum += (2 * i - n - 1) * v
    return round(gini_sum / (n * total), 4)


def compute_demand_coverage(
    assignment:     dict[str, str],
    pat_by_id:      dict[str, ShiftPattern],
    staff_by_id:    dict[str, dict],
    demand_windows: list[DemandWindow],
) -> dict:
    """Return per-skill and per-priority coverage statistics."""
    coverage: dict[str, dict] = defaultdict(lambda: {"needed": 0, "covered": 0})

    for dw in demand_windows:
        key = dw.skill
        coverage[key]["needed"] += dw.needed

        matched = 0
        for sid, pid in assignment.items():
            p = pat_by_id.get(pid)
            if not p:
                continue
            s = staff_by_id.get(sid)
            if not s:
                continue
            all_skills = {s.get(f"skill{k}", "").strip() for k in range(1, 5) if s.get(f"skill{k}", "")}
            if dw.skill not in all_skills:
                continue
            segs = _working_segments(p)
            overlap = sum(
                max(0, min(se, dw.end) - max(ss, dw.start))
                for ss, se in segs
            )
            if overlap >= (dw.end - dw.start) * 0.5:
                matched += 1
        coverage[key]["covered"] += min(matched, dw.needed)

    return {
        k: {
            **v,
            "coverage_pct": round(v["covered"] / v["needed"] * 100, 1) if v["needed"] else 100.0,
        }
        for k, v in coverage.items()
    }


# ===========================================================================
# Main entry point
# ===========================================================================

def generate_roster(
    demand_windows:  list[DemandWindow],
    staff_list:      list[dict],
    constraints:     dict | None = None,
    prev_shift_ends: dict[str, int] | None = None,
    use_mip:         bool = True,
) -> dict:
    """Full two-phase roster optimisation for one day.

    Parameters
    ----------
    demand_windows  — list of DemandWindow objects derived from flight tasks
    staff_list      — staff dicts (same schema as get_staff_for_date output)
    constraints     — override dict (b1_duration_mins, min_rest_mins, …)
    prev_shift_ends — {staff_id: shift_end_mins_yesterday} for rest-rule check
    use_mip         — run PuLP refinement after greedy (ignored if PuLP absent)

    Returns
    -------
    dict with keys:
        patterns, roster, utilisation, fairness, coverage, flags, solver_used
    """
    cfg             = constraints or {}
    prev_ends       = prev_shift_ends or {}
    apply_mip       = use_mip and _PULP_AVAILABLE

    # Step 1: generate and score shift patterns
    patterns = generate_shift_patterns(demand_windows, cfg)
    pat_by_id = {p.pat_id: p for p in patterns}

    # Step 2a: greedy assignment
    assignment = assign_greedy(patterns, staff_list, prev_ends, cfg)

    # Step 2b: MIP refinement (optional)
    solver_status = "greedy_only"
    if apply_mip and staff_list and demand_windows:
        assignment, solver_status = refine_with_mip(
            assignment, patterns, staff_list, demand_windows, prev_ends, cfg
        )

    # Step 3: build per-staff roster entries
    staff_by_id = {s["id"]: s for s in staff_list}
    roster: list[dict] = []
    util_pcts: list[float] = []

    for s in staff_list:
        sid   = s["id"]
        pid   = assignment.get(sid)
        pat   = pat_by_id.get(pid) if pid else None
        if pat is None:
            # Unassigned: mark as on-roster but no shift
            roster.append(_make_roster_entry(s, None, "unassigned"))
            util_pcts.append(0.0)
            continue

        # Determine if primary or secondary skill dominates this pattern
        primary  = s.get("skill1", "").strip()
        sec_set  = {s.get(f"skill{k}", "").strip() for k in range(2, 5) if s.get(f"skill{k}", "")}
        prim_cov = pat.demand_profile.get(primary, 0)
        any_cov  = sum(
            v for sk, v in pat.demand_profile.items()
            if sk == primary or sk in sec_set
        )
        skill_match = "primary" if prim_cov > 0 else ("secondary" if any_cov > 0 else "none")

        # Utilisation = net_working_mins / shift_duration
        util = round(pat.net_working_mins / max(1, pat.end_mins - pat.start_mins) * 100, 1)
        util_pcts.append(util)

        # Pre-compute break list in the format schedule_breaks() produces
        breaks = [
            {"type": "Short Break",  "start": pat.b1_start, "end": pat.b1_end,
             "start_str": _fmt_mins(pat.b1_start), "end_str": _fmt_mins(pat.b1_end)},
            {"type": "Meal Break",   "start": pat.b2_start, "end": pat.b2_end,
             "start_str": _fmt_mins(pat.b2_start), "end_str": _fmt_mins(pat.b2_end)},
        ]

        roster.append(_make_roster_entry(s, pat, skill_match, util, breaks))

    # Step 4: per-staff utilisation dict
    utilisation: dict[str, dict] = {}
    for entry in roster:
        sid = entry["id"]
        utilisation[sid] = {
            "gross_mins":       entry["shift_duration_mins"],
            "net_working_mins": entry["net_working_mins"],
            "utilisation_pct":  entry["utilisation_pct"],
            "pattern_id":       entry["pattern_id"],
            "skill_match":      entry["skill_match"],
        }

    # Step 5: fairness metrics
    gini = compute_fairness_gini(util_pcts)
    gross_list = [entry["shift_duration_mins"] for entry in roster if entry["shift_duration_mins"] > 0]
    mean_util = sum(util_pcts) / len(util_pcts) if util_pcts else 0
    std_util  = math.sqrt(
        sum((u - mean_util) ** 2 for u in util_pcts) / max(1, len(util_pcts))
    )
    fairness = {
        "gini_coefficient": gini,
        "mean_utilisation_pct": round(mean_util, 1),
        "std_utilisation_pct":  round(std_util, 1),
        "min_utilisation_pct":  round(min(util_pcts, default=0), 1),
        "max_utilisation_pct":  round(max(util_pcts, default=0), 1),
        "interpretation": (
            "excellent" if gini < 0.10 else
            "good"      if gini < 0.20 else
            "moderate"  if gini < 0.35 else
            "poor"
        ),
    }

    # Step 6: demand coverage
    coverage = compute_demand_coverage(assignment, pat_by_id, staff_by_id, demand_windows)

    # Step 7: roster flags
    flags = _build_flags(roster, assignment, pat_by_id, prev_ends, cfg)

    # Step 8: pattern summary for API response
    pattern_summary = [
        {
            "id":            p.pat_id,
            "label":         p.label,
            "start_mins":    p.start_mins,
            "end_mins":      p.end_mins,
            "net_mins":      p.net_working_mins,
            "coverage_score": round(p.coverage_score, 2),
            "demand_profile": {k: round(v, 2) for k, v in p.demand_profile.items()},
            "staff_count":   sum(1 for pid in assignment.values() if pid == p.pat_id),
        }
        for p in patterns
    ]

    return {
        "patterns":     pattern_summary,
        "roster":       roster,
        "utilisation":  utilisation,
        "fairness":     fairness,
        "coverage":     coverage,
        "flags":        flags,
        "solver_used":  f"CBC (PuLP MIP)" if apply_mip and solver_status not in ("PuLP_unavailable", "greedy_only") else "Greedy",
        "mip_status":   solver_status,
        "staff_count":  len(staff_list),
        "pattern_count": len(patterns),
    }


def format_as_on_duty(roster_result: dict) -> list[dict]:
    """Convert roster optimizer output to the on_duty list format
    expected by get_staff_for_date() and optimize_day().

    Each entry matches the schema:
      {id, skill1-4, employment, shift, shift_start, shift_end,
       shift_label, assignments, breaks, utilisation_pct}
    """
    on_duty = []
    for entry in roster_result.get("roster", []):
        if entry.get("pattern_id") == "unassigned":
            continue
        on_duty.append({
            "id":             entry["id"],
            "skill1":         entry["skill1"],
            "skill2":         entry["skill2"],
            "skill3":         entry["skill3"],
            "skill4":         entry["skill4"],
            "employment":     entry["employment"],
            "shift":          entry["shift_label"].upper()[:12],
            "shift_start":    entry["shift_start"],
            "shift_end":      entry["shift_end"],
            "shift_label":    entry["shift_label"],
            "assignments":    [],
            "breaks":         entry.get("breaks", []),
            "utilisation_pct": entry["utilisation_pct"],
        })
    return on_duty


# ===========================================================================
# Private helpers
# ===========================================================================

def _make_roster_entry(
    s:           dict,
    pat:         ShiftPattern | None,
    skill_match: str,
    util_pct:    float = 0.0,
    breaks:      list  = None,
) -> dict:
    if pat is None:
        return {
            "id": s["id"], "skill1": s.get("skill1", ""),
            "skill2": s.get("skill2", ""), "skill3": s.get("skill3", ""),
            "skill4": s.get("skill4", ""), "employment": s.get("employment", ""),
            "pattern_id": "unassigned", "shift_label": "Unassigned",
            "shift_start": 0, "shift_end": 0,
            "shift_duration_mins": 0, "net_working_mins": 0,
            "utilisation_pct": 0.0, "skill_match": "none",
            "breaks": [], "assignments": [],
        }

    return {
        "id":                 s["id"],
        "skill1":             s.get("skill1", ""),
        "skill2":             s.get("skill2", ""),
        "skill3":             s.get("skill3", ""),
        "skill4":             s.get("skill4", ""),
        "employment":         s.get("employment", ""),
        "pattern_id":         pat.pat_id,
        "shift_label":        pat.label,
        "shift_start":        pat.start_mins,
        "shift_end":          pat.end_mins,
        "shift_duration_mins": pat.end_mins - pat.start_mins,
        "net_working_mins":   pat.net_working_mins,
        "utilisation_pct":    util_pct,
        "skill_match":        skill_match,
        "breaks":             breaks or [],
        "assignments":        [],
    }


def _build_flags(
    roster:      list[dict],
    assignment:  dict[str, str],
    pat_by_id:   dict[str, ShiftPattern],
    prev_ends:   dict[str, int],
    constraints: dict,
) -> list[dict]:
    """Generate RFC-style flags for the roster output."""
    min_rest = int(constraints.get("min_rest_mins", _MIN_REST_MINS))
    flags = []

    for entry in roster:
        sid = entry["id"]
        pid = assignment.get(sid)
        if not pid or pid == "unassigned":
            continue
        pat = pat_by_id.get(pid)
        if not pat:
            continue

        # REST_BREACH check
        prev_end = prev_ends.get(sid, 0)
        rest_gap = (pat.start_mins - prev_end) % 1440
        if 0 < rest_gap < min_rest:
            flags.append({
                "flag_id":  "REST_BREACH",
                "severity": "CRITICAL",
                "staff_id": sid,
                "detail":   f"Only {rest_gap} min rest (need {min_rest}). "
                            f"Previous shift ended {_fmt_mins(prev_end)}, "
                            f"new shift starts {_fmt_mins(pat.start_mins)}.",
            })

        # SECONDARY_SKILL_USED
        if entry.get("skill_match") == "secondary":
            flags.append({
                "flag_id":  "SECONDARY_SKILL_USED",
                "severity": "INFO",
                "staff_id": sid,
                "detail":   f"Staff {sid} assigned to pattern {pid} using secondary skill.",
            })

    return flags


def _fmt_mins(m: int) -> str:
    """Format integer minutes as HH:MM (wraps at 1440 for night shifts)."""
    h, mn = divmod(m % 1440, 60)
    return f"{h:02d}:{mn:02d}"


# ===========================================================================
# Convenience: build DemandWindows from optimize_day() task list
# ===========================================================================

def tasks_to_demand_windows(tasks: list[dict]) -> list[DemandWindow]:
    """Convert a list of task dicts (from optimize_day / _generate_day_tasks)
    into DemandWindow objects suitable for the roster optimizer.

    Only tasks that are not past (no 'is_past' flag) are included.
    """
    windows = []
    for t in tasks:
        if t.get("is_past"):
            continue
        dw = DemandWindow(
            start    = int(t.get("start_mins", 0)),
            end      = int(t.get("end_mins",   0)),
            skill    = t.get("skill", "GNIB"),
            needed   = int(t.get("staff_needed", 1)),
            priority = t.get("priority", "Medium"),
            task_id  = t.get("id", ""),
        )
        if dw.end > dw.start:   # skip zero-length tasks
            windows.append(dw)
    return windows

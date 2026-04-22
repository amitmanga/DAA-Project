"""
intraday_optimizer.py
~~~~~~~~~~~~~~~~~~~~~
CP-SAT based intraday staff-assignment optimiser for the DAA workforce tool.

Uses Google OR-Tools CP-SAT to globally minimise, in priority order:
  1. Unassigned / under-staffed tasks  (weighted by task priority)
  2. Secondary-skill usage             (prefer primary skill)
  3. Staff overtime                    (soft: penalise excess minutes)

Entry point
-----------
    from intraday_optimizer import optimize_intraday_assignments, ORTOOLS_AVAILABLE

    result = optimize_intraday_assignments(tasks, staff, constraints)

The function is designed to be called from optimize_day() in app.py when the
'use_cpsat' flag is set in custom_constraints.  A greedy fallback in app.py
handles the case where OR-Tools is unavailable or the solver returns no
feasible solution.
"""
from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Optional OR-Tools import — module still loads if package is absent
# ---------------------------------------------------------------------------
try:
    from ortools.sat.python import cp_model  # type: ignore
    ORTOOLS_AVAILABLE = True
except ImportError:  # pragma: no cover
    ORTOOLS_AVAILABLE = False
    logger.warning(
        "OR-Tools is not installed — CP-SAT optimiser unavailable. "
        "Install with:  pip install ortools"
    )

# ---------------------------------------------------------------------------
# Objective function weights
# ---------------------------------------------------------------------------
# Unassigned task penalties are much heavier than skill/overtime penalties
# so coverage is always the dominant objective.
_PRIORITY_WEIGHT: dict[str, int] = {
    "Critical": 10_000,
    "High":      5_000,
    "Medium":    2_000,
    "Low":         500,
}
_SECONDARY_SKILL_WEIGHT = 100   # per assignment that uses a secondary skill
_OVERTIME_WEIGHT        =   5   # per overtime minute above net capacity

# Maximum solver wall-clock time before returning the best feasible solution
_SOLVER_TIME_LIMIT_SECS = 60


# ===========================================================================
# Public API
# ===========================================================================

def optimize_intraday_assignments(
    tasks: list[dict],
    staff: list[dict],
    constraints: dict,
) -> dict:
    """Solve the intraday staff-assignment problem with CP-SAT.

    Parameters
    ----------
    tasks : list[dict]
        Task objects from ``_generate_day_tasks`` / ``optimize_day``.
        Required keys: ``id``, ``skill``, ``priority``, ``start_mins``,
        ``end_mins``, ``staff_needed``, ``terminal``.
    staff : list[dict]
        Staff objects from ``get_staff_for_date``.
        Required keys: ``id``, ``skill1``–``skill4``, ``shift_start``,
        ``shift_end`` (integer minutes since midnight).
    constraints : dict
        Subset of the roster constraints dict.  Recognised keys:
        ``tt_t1_t2``, ``tt_skill_switch``, ``break_mins``,
        ``max_overtime_per_day_hrs``.

    Returns
    -------
    dict with keys:
        ``assignments``      – list[dict], one entry per task
        ``unassigned_tasks`` – list[dict], tasks not fully covered
        ``utilisation``      – dict[staff_id → {gross_mins, net_mins, …}]
        ``objective_value``  – float
        ``solver_status``    – str  ('OPTIMAL', 'FEASIBLE', 'INFEASIBLE', …)
        ``gap_pct``          – float, optimality gap % (0 = proven optimal)
    """
    if not ORTOOLS_AVAILABLE:
        raise RuntimeError(
            "OR-Tools is not installed.  Run:  pip install ortools"
        )

    # ------------------------------------------------------------------
    # 0.  Extract constraint parameters
    # ------------------------------------------------------------------
    tt_t1_t2    = int(constraints.get("tt_t1_t2", 15))
    tt_skill_sw = int(constraints.get("tt_skill_switch", 10))
    break_mins  = int(constraints.get("break_mins", 90))
    max_ot_mins = int(float(constraints.get("max_overtime_per_day_hrs", 2)) * 60)

    T = len(tasks)
    S = len(staff)
    if T == 0 or S == 0:
        return _empty_result("No tasks or staff provided")

    # ------------------------------------------------------------------
    # 1.  Pre-compute shift bounds (integer minutes) for each staff member
    # ------------------------------------------------------------------
    shift_start = [_get_shift_mins(s, "start") for s in staff]
    shift_end   = [_get_shift_mins(s, "end")   for s in staff]
    # Total shift duration (handles night-shift midnight wrap)
    shift_dur   = [_shift_duration(shift_start[j], shift_end[j]) for j in range(S)]
    # Net usable minutes after deducting mandatory break time
    net_cap     = [max(0, shift_dur[j] - break_mins) for j in range(S)]

    # ------------------------------------------------------------------
    # 2.  Feasibility matrix
    #     can_assign[j][i]  = True  if staff j CAN do task i
    #     skill_match[j][i] = 'primary' | 'secondary' | None
    #
    #     Checks: (a) task window falls within staff shift, AND
    #             (b) staff has the required skill
    # ------------------------------------------------------------------
    can_assign:  list[list[bool]]        = [[False] * T for _ in range(S)]
    skill_match: list[list[str | None]]  = [[None]  * T for _ in range(S)]

    for j, s in enumerate(staff):
        s_start = shift_start[j]
        s_dur   = shift_dur[j]

        # Primary skill set
        prim: set[str] = set()
        raw_s1 = s.get("skill1", "").strip()
        if raw_s1:
            prim.add(raw_s1)

        # Secondary skill set (skill2 – skill4)
        sec: set[str] = set()
        for k in range(2, 5):
            sk = s.get(f"skill{k}", "").strip()
            if sk:
                sec.add(sk)

        for i, t in enumerate(tasks):
            t_start = t.get("start_mins", 0)
            t_end   = t.get("end_mins",   0)
            t_skill = t.get("skill", "")

            # ── Shift containment (mirrors the available() logic in app.py) ──
            # Uses modular arithmetic to handle night shifts that wrap midnight.
            t_dur  = (t_end - t_start) % 1440
            if t_dur == 0 and t_end != t_start:
                t_dur = 1440
            ts_rel = (t_start - s_start) % 1440
            if ts_rel + t_dur > s_dur:
                continue   # task falls outside this staff member's shift

            # ── Skill feasibility ──
            if t_skill in prim:
                skill_match[j][i] = "primary"
                can_assign[j][i]  = True
            elif t_skill in sec:
                skill_match[j][i] = "secondary"
                can_assign[j][i]  = True

    # ------------------------------------------------------------------
    # 3.  Build CP-SAT model
    # ------------------------------------------------------------------
    model = cp_model.CpModel()

    # Decision variables: x[j][i] = 1 iff staff j is assigned to task i
    x: list[list[Any]] = [[None] * T for _ in range(S)]
    for j in range(S):
        for i in range(T):
            if can_assign[j][i]:
                x[j][i] = model.NewBoolVar(f"x_{j}_{i}")

    # ------------------------------------------------------------------
    # 4.  Hard constraint — staffing coverage
    #
    #     sum(x[j,i] for j) + gap[i] == staff_needed[i]
    #
    #     gap[i] ≥ 0 represents under-staffing.  It is penalised heavily
    #     in the objective so the solver fills gaps before optimising
    #     secondary objectives (skill preference, overtime).
    # ------------------------------------------------------------------
    gap = [
        model.NewIntVar(0, max(1, tasks[i].get("staff_needed", 1)), f"gap_{i}")
        for i in range(T)
    ]

    for i, t in enumerate(tasks):
        needed = t.get("staff_needed", 1)
        feasible_vars = [x[j][i] for j in range(S) if x[j][i] is not None]

        if feasible_vars:
            assigned_sum = cp_model.LinearExpr.Sum(feasible_vars)
            # gap fills the difference between needed and actual assignments
            model.Add(assigned_sum + gap[i] == needed)
            # No over-staffing: never assign more than needed
            model.Add(assigned_sum <= needed)
        else:
            # Nobody qualifies for this task; gap is forced to staff_needed
            model.Add(gap[i] == needed)

    # ------------------------------------------------------------------
    # 5.  Hard constraint — no double-booking (including travel buffers)
    #
    #     For each staff j, no two tasks assigned to j may overlap once
    #     the required travel / skill-switch buffer is accounted for.
    #
    #     Implementation: pairwise mutual exclusion for task pairs whose
    #     time windows conflict for a given staff member (after applying
    #     the buffer determined by terminal and skill differences).
    #
    #     Pairs that always have sufficient clearance are skipped to keep
    #     the model lean (most pairs don't overlap).
    # ------------------------------------------------------------------
    for j in range(S):
        feasible_i = [i for i in range(T) if x[j][i] is not None]
        for a in range(len(feasible_i)):
            i1 = feasible_i[a]
            t1 = tasks[i1]
            for b in range(a + 1, len(feasible_i)):
                i2 = feasible_i[b]
                t2 = tasks[i2]

                # Required buffer: terminal change + skill-switch (max of both)
                buf = _travel_buffer(t1, t2, tt_t1_t2, tt_skill_sw)

                # Order the pair so earlier_end / later_start are unambiguous
                if t1["start_mins"] <= t2["start_mins"]:
                    earlier_end  = t1["end_mins"]
                    later_start  = t2["start_mins"]
                else:
                    earlier_end  = t2["end_mins"]
                    later_start  = t1["start_mins"]

                # If the gap between the two tasks always exceeds the buffer,
                # these tasks can never conflict → no constraint needed.
                if earlier_end + buf <= later_start:
                    continue

                # Otherwise: staff j cannot be assigned to both tasks
                model.Add(x[j][i1] + x[j][i2] <= 1)

    # ------------------------------------------------------------------
    # 6.  Hard constraint — shift capacity (break-aware)
    #
    #     Total assigned minutes per staff ≤ net_cap + max overtime.
    #     This prevents scheduling more work than a shift can physically hold.
    # ------------------------------------------------------------------
    for j in range(S):
        feasible_i = [i for i in range(T) if x[j][i] is not None]
        if not feasible_i:
            continue
        durations = [_task_duration(tasks[i]) for i in feasible_i]
        total_mins_expr = cp_model.LinearExpr.WeightedSum(
            [x[j][i] for i in feasible_i],
            durations,
        )
        model.Add(total_mins_expr <= net_cap[j] + max_ot_mins)

    # ------------------------------------------------------------------
    # 7.  Objective function
    #     Minimise: Σ gap_penalty  +  Σ secondary_skill_penalty  +  Σ overtime
    # ------------------------------------------------------------------
    obj_terms: list[Any] = []

    # Term 1 — under-staffing penalty (dominant objective)
    for i, t in enumerate(tasks):
        w = _PRIORITY_WEIGHT.get(t.get("priority", "Low"), _PRIORITY_WEIGHT["Low"])
        obj_terms.append(gap[i] * w)

    # Term 2 — secondary-skill usage penalty (prefer primary skill assignments)
    for j in range(S):
        for i in range(T):
            if x[j][i] is not None and skill_match[j][i] == "secondary":
                obj_terms.append(x[j][i] * _SECONDARY_SKILL_WEIGHT)

    # Term 3 — overtime penalty (soft: minimise excess hours beyond net capacity)
    for j in range(S):
        feasible_i = [i for i in range(T) if x[j][i] is not None]
        if not feasible_i:
            continue
        durations = [_task_duration(tasks[i]) for i in feasible_i]
        total_mins_expr = cp_model.LinearExpr.WeightedSum(
            [x[j][i] for i in feasible_i],
            durations,
        )
        ot = model.NewIntVar(0, max_ot_mins, f"ot_{j}")
        # ot ≥ total_assigned - net_cap  (naturally minimised in objective)
        model.Add(ot >= total_mins_expr - net_cap[j])
        obj_terms.append(ot * _OVERTIME_WEIGHT)

    model.Minimize(cp_model.LinearExpr.Sum(obj_terms))

    # ------------------------------------------------------------------
    # 8.  Solve
    # ------------------------------------------------------------------
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = _SOLVER_TIME_LIMIT_SECS
    solver.parameters.num_search_workers  = 4
    solver.parameters.log_search_progress = False

    status      = solver.Solve(model)
    status_name = solver.StatusName(status)

    logger.info(
        "CP-SAT  status=%-10s  obj=%.0f  wall=%.2fs  tasks=%d  staff=%d",
        status_name,
        solver.ObjectiveValue() if status in (cp_model.OPTIMAL, cp_model.FEASIBLE) else 0,
        solver.WallTime(),
        T, S,
    )

    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return _empty_result(f"Solver status: {status_name} — no feasible solution")

    # ------------------------------------------------------------------
    # 9.  Extract solution
    # ------------------------------------------------------------------
    # Per-task: collect the staff members assigned by the solver
    task_staff: dict[int, list[str]] = {i: [] for i in range(T)}
    for j in range(S):
        for i in range(T):
            if x[j][i] is not None and solver.Value(x[j][i]) == 1:
                task_staff[i].append(staff[j]["id"])

    assignments:     list[dict] = []
    unassigned_tasks: list[dict] = []

    for i, t in enumerate(tasks):
        needed       = t.get("staff_needed", 1)
        assigned_ids = task_staff[i]
        covered      = len(assigned_ids)

        assignments.append({
            "task_id":    t["id"],
            "task_name":  t.get("task", ""),
            "start_mins": t["start_mins"],
            "end_mins":   t["end_mins"],
            "staff_ids":  assigned_ids,
            "needed":     needed,
            "covered":    covered,
            "alert": (
                f"GAP: need {needed}, assigned {covered} (gap {needed - covered})"
                if covered < needed else None
            ),
        })
        if covered < needed:
            unassigned_tasks.append({**t, "assigned": assigned_ids, "gap": needed - covered})

    # Per-staff: compute utilisation metrics
    utilisation: dict[str, dict] = {}
    for j, s in enumerate(staff):
        s_dur_safe = max(1, shift_dur[j])
        assigned_i = [
            i for i in range(T)
            if x[j][i] is not None and solver.Value(x[j][i]) == 1
        ]
        gross_mins = sum(_task_duration(tasks[i]) for i in assigned_i)
        utilisation[s["id"]] = {
            "gross_mins": gross_mins,
            "net_mins":   gross_mins,
            "shift_mins": s_dur_safe,
            "pct":        round(100 * gross_mins / s_dur_safe, 1),
            "task_ids":   [tasks[i]["id"] for i in assigned_i],
        }

    return {
        "assignments":       assignments,
        "unassigned_tasks":  unassigned_tasks,
        "utilisation":       utilisation,
        "objective_value":   solver.ObjectiveValue(),
        "solver_status":     status_name,
        "gap_pct":           _gap_pct(solver, status),
    }


# ===========================================================================
# Private helpers
# ===========================================================================

def _get_shift_mins(s: dict, endpoint: str) -> int:
    """Return shift start or end as minutes since midnight.

    Reads ``shift_start`` / ``shift_end`` from the staff dict (integer or
    'HH:MM' string).  Falls back to DAY/NIGHT shift defaults derived from
    ``shift_label`` if the key is missing.
    """
    key = f"shift_{endpoint}"
    val = s.get(key)
    if isinstance(val, (int, float)):
        return int(val)
    if isinstance(val, str) and ":" in val:
        h, m = val.split(":", 1)
        return int(h) * 60 + int(m)
    # Fallback: infer from shift_label
    label = s.get("shift_label", "DAY").upper()
    if "NIGHT" in label:
        return 960 if endpoint == "start" else 240   # 16:00 → 04:00 next day
    return 240 if endpoint == "start" else 960        # 04:00 → 16:00


def _shift_duration(s_start: int, s_end: int) -> int:
    """Positive shift duration in minutes, handling midnight wrap."""
    dur = (s_end - s_start) % 1440
    return dur if dur > 0 else 1440


def _task_duration(t: dict) -> int:
    """Task duration in minutes, handling midnight wrap."""
    dur = (t["end_mins"] - t["start_mins"]) % 1440
    return dur if dur > 0 else 1440


def _travel_buffer(t1: dict, t2: dict, tt_t1_t2: int, tt_skill_sw: int) -> int:
    """Minimum required gap (minutes) between two tasks for the same staff.

    Applies the larger of the terminal-change buffer and the skill-switch
    buffer, matching the logic in ``available()`` in app.py.
    """
    buf = 0
    term1 = t1.get("terminal", "ALL")
    term2 = t2.get("terminal", "ALL")
    # Terminal-change buffer: skip if either side is 'ALL' (any terminal)
    if term1 != term2 and "ALL" not in (term1, term2):
        buf = max(buf, tt_t1_t2)
    # Skill-switch buffer
    if t1.get("skill") != t2.get("skill"):
        buf = max(buf, tt_skill_sw)
    return buf


def _gap_pct(solver: "cp_model.CpSolver", status: int) -> float:
    """Return the optimality gap percentage (0.0 = proven optimal)."""
    try:
        if status == cp_model.FEASIBLE:
            obj   = solver.ObjectiveValue()
            bound = solver.BestObjectiveBound()
            if abs(obj) > 1e-9:
                return round(100.0 * abs(obj - bound) / abs(obj), 2)
    except Exception:
        pass
    return 0.0


def _empty_result(reason: str) -> dict:
    """Return a well-formed empty result dict with a diagnostic message."""
    logger.warning("CP-SAT returned empty result: %s", reason)
    return {
        "assignments":       [],
        "unassigned_tasks":  [],
        "utilisation":       {},
        "objective_value":   0.0,
        "solver_status":     "EMPTY",
        "gap_pct":           0.0,
        "reason":            reason,
    }

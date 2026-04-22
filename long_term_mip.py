"""
long_term_mip.py
~~~~~~~~~~~~~~~~
Mixed-Integer Programme (MIP) for long-term weekly workforce optimisation.

Minimises — in priority order:
  1. Skill shortages          (weighted by operational criticality)
  2. Overtime usage           (cost per hour across all staff)
  3. Excess / idle staffing   (minor; discourages wasteful over-assignment)

Decision variables
------------------
  x[w, s]      INTEGER  headcount assigned to skill s in week w
  short[w, s]  continuous  FTE shortfall when demand > assigned headcount
  excess[w, s] continuous  FTE surplus  when assigned headcount > demand
  ot_hrs[w]    continuous  total overtime hours used across all staff in week w

Constraints
-----------
  C1  Coverage:      x[w,s] + short[w,s] >= demand[w,s]     (every skill, every week)
  C2  Availability:  x[w,s] <= skill_available[w,s]          (can't exceed headcount pool)
  C3  Total cap:     Σ_s x[w,s] <= total_available[w]        (each person counted once)
                                 + ot_hrs[w] / reg_hrs_pw    (+ overtime FTE equivalent)
  C4  OT cap:        ot_hrs[w] <= total_available[w] × max_ot_hrs_pp   (per-person OT limit)
  C5  Excess def:    excess[w,s] >= x[w,s] - demand[w,s]

Solver chain
------------
  1. PuLP + CBC (bundled MIP solver)  — primary
  2. scipy HiGHS (LP relaxation)      — fallback when PuLP absent
  3. Error / graceful degradation     — if neither available

Entry point
-----------
  from long_term_mip import optimize_weekly_staffing, MIP_AVAILABLE
"""
from __future__ import annotations

import logging
from collections import defaultdict
from typing import Any

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Solver availability
# ---------------------------------------------------------------------------
_PULP_AVAILABLE   = False
_SCIPY_AVAILABLE  = False

try:
    import pulp
    # Verify CBC is actually bundled (some stripped installs omit it)
    _test = pulp.LpProblem("_test", pulp.LpMinimize)
    _v = pulp.LpVariable("_v", lowBound=0)
    _test += _v
    _test.solve(pulp.PULP_CBC_CMD(msg=0))
    _PULP_AVAILABLE = True
    del _test, _v
except Exception as _pulp_err:
    logger.warning("PuLP/CBC unavailable (%s). Run: pip install pulp", _pulp_err)

if not _PULP_AVAILABLE:
    try:
        import numpy as np
        from scipy.optimize import linprog
        _SCIPY_AVAILABLE = True
        logger.info("Using scipy HiGHS as LP fallback (continuous relaxation)")
    except ImportError:
        logger.warning("Neither PuLP nor scipy found — MIP optimiser disabled")

MIP_AVAILABLE = _PULP_AVAILABLE or _SCIPY_AVAILABLE

# ---------------------------------------------------------------------------
# Objective-function coefficients
# ---------------------------------------------------------------------------

# Shortage cost per FTE below demand (priority-weighted by operational impact)
SKILL_SHORTAGE_COST: dict[str, float] = {
    "GNIB":                 1_000,
    "GNIB / Immigration":     900,   # alias present in some skill pools
    "CBP Pre-clearance":    1_000,
    "Ramp / Marshalling":     800,
    "Arr Customer Service":   700,
    "Bussing":                600,
    "Check-in/Trolleys":      600,
    "Dep / Trolleys":         500,
    "Transfer Corridor":      500,
    "Mezz Operation":         400,
    "PBZ":                    400,
    "Litter Picking":         300,
    "T1/T2 Trolleys L/UL":    300,
}
_DEFAULT_SHORTAGE_COST  = 500.0    # fallback for unlisted skills
_OVERTIME_COST_PER_HR   =  50.0    # per total overtime hour (all staff combined)
_EXCESS_COST_PER_FTE    =   5.0    # light penalty to deter gratuitous over-assignment

# Workforce time constants (from Roster_constraints.json)
_REGULAR_HRS_PER_WEEK   = 40.0     # regular contracted hours per FTE per week
_MAX_OT_HRS_PER_PERSON  =  8.0     # max overtime hours per person per week
_MAX_WEEKLY_HRS_TOTAL   = 48.0     # hard ceiling: regular + OT per person per week


# ===========================================================================
# Public API
# ===========================================================================

def optimize_weekly_staffing(
    skill_demand:       dict[str, dict[str, float]],
    total_demand:       dict[str, float],
    skill_availability: dict[str, dict[str, int]],
    total_availability: dict[str, int],
    constraints:        dict | None = None,
) -> dict:
    """Weekly workforce MIP/LP optimiser.

    Parameters
    ----------
    skill_demand       {week_key → {skill → fte_required}}     from _skill_req
    total_demand       {week_key → total_fte_required}          from _staff_req
    skill_availability {week_key → {skill → headcount}}         from _skill_avail
    total_availability {week_key → total_headcount}             from _staff_avail
    constraints        optional overrides:
                         max_ot_hrs_per_person_per_week  (default 8)
                         regular_hrs_per_week            (default 40)
                         surge_demand_factor             (default 1.0)

    Returns
    -------
    dict with keys:
        status           str   — 'Optimal' | 'Infeasible' | 'Not Solved'
        solver           str   — solver name used
        objective_value  float
        use_optimisation bool  — always True on success
        weeks            {week_key → week_result}
        summary          {aggregate statistics + per-skill breakdown}
    """
    if not MIP_AVAILABLE:
        raise RuntimeError(
            "No MIP/LP solver available.\n"
            "Install PuLP:  pip install pulp\n"
            "or scipy:      pip install scipy"
        )

    # Apply surge demand factor if specified
    surge = float((constraints or {}).get("surge_demand_factor", 1.0))
    if surge != 1.0:
        skill_demand  = {
            w: {s: v * surge for s, v in sd.items()}
            for w, sd in skill_demand.items()
        }
        total_demand  = {w: v * surge for w, v in total_demand.items()}

    if _PULP_AVAILABLE:
        return _solve_pulp(
            skill_demand, total_demand,
            skill_availability, total_availability,
            constraints,
        )
    return _solve_scipy(
        skill_demand, total_demand,
        skill_availability, total_availability,
        constraints,
    )


# ===========================================================================
# PuLP MIP implementation
# ===========================================================================

def _solve_pulp(
    skill_demand, total_demand,
    skill_availability, total_availability,
    constraints,
) -> dict:
    cfg        = constraints or {}
    max_ot_pp  = float(cfg.get("max_ot_hrs_per_person_per_week", _MAX_OT_HRS_PER_PERSON))
    reg_hrs    = float(cfg.get("regular_hrs_per_week",           _REGULAR_HRS_PER_WEEK))

    weeks  = sorted(skill_demand.keys())
    skills = sorted({s for wd in skill_demand.values() for s in wd})

    if not weeks or not skills:
        return _empty_result("No weeks or skills to optimise")

    prob = pulp.LpProblem("long_term_workforce_mip", pulp.LpMinimize)

    # ------------------------------------------------------------------
    # Decision variables
    # ------------------------------------------------------------------

    # x[w,s]: INTEGER headcount assigned to skill s in week w.
    # Upper-bound = available headcount for that (week, skill) pair.
    x = {
        (w, s): pulp.LpVariable(
            f"x_{w}_{s}",
            lowBound=0,
            upBound=max(int(skill_availability.get(w, {}).get(s, 0)), 0),
            cat="Integer",
        )
        for w in weeks for s in skills
    }

    # short[w,s]: FTE shortfall (demand not covered by assigned headcount).
    # Penalised heavily in the objective — drives the solver to fill gaps.
    short = {
        (w, s): pulp.LpVariable(f"short_{w}_{s}", lowBound=0)
        for w in weeks for s in skills
    }

    # excess[w,s]: FTE surplus when more headcount is assigned than demanded.
    # Lightly penalised to discourage over-assignment.
    excess = {
        (w, s): pulp.LpVariable(f"excess_{w}_{s}", lowBound=0)
        for w in weeks for s in skills
    }

    # ot_hrs[w]: total overtime hours consumed by all staff in week w.
    # Upper bound derived from per-person overtime cap × headcount available.
    ot_hrs = {
        w: pulp.LpVariable(
            f"ot_{w}",
            lowBound=0,
            upBound=max(float(total_availability.get(w, 0)) * max_ot_pp, 0.0),
        )
        for w in weeks
    }

    # ------------------------------------------------------------------
    # Objective function
    # ------------------------------------------------------------------

    # Term 1: skill shortages (dominant — highest weights)
    shortage_terms = pulp.lpSum(
        SKILL_SHORTAGE_COST.get(s, _DEFAULT_SHORTAGE_COST) * short[w, s]
        for w in weeks for s in skills
    )

    # Term 2: overtime cost (moderate — discourages over-reliance on OT)
    overtime_terms = pulp.lpSum(_OVERTIME_COST_PER_HR * ot_hrs[w] for w in weeks)

    # Term 3: excess / idle staffing (minor — nudges solution toward lean fit)
    excess_terms = pulp.lpSum(
        _EXCESS_COST_PER_FTE * excess[w, s]
        for w in weeks for s in skills
    )

    prob += shortage_terms + overtime_terms + excess_terms, "minimise_total_cost"

    # ------------------------------------------------------------------
    # Constraints
    # ------------------------------------------------------------------
    for w in weeks:
        tot_avail = int(total_availability.get(w, 0))

        for s in skills:
            dem   = float(skill_demand.get(w, {}).get(s, 0.0))
            avail = int(skill_availability.get(w, {}).get(s, 0))

            # C1 — Coverage: assigned + shortfall >= demand
            # The shortfall variable absorbs any gap when demand cannot be met.
            prob += (
                x[w, s] + short[w, s] >= dem,
                f"C1_cov_{w}_{s}",
            )

            # C2 — Availability cap: cannot assign more than the available headcount
            prob += (x[w, s] <= avail, f"C2_avail_{w}_{s}")

            # C5 — Excess definition: excess >= assigned − demand  (excess >= 0 already set)
            prob += (
                excess[w, s] >= x[w, s] - dem,
                f"C5_excess_{w}_{s}",
            )

        # C3 — Weekly total cap: sum of all assigned headcount ≤ available + OT FTE
        # OT hours are converted to FTE equivalent (ot_hrs / regular_hrs_per_week).
        prob += (
            pulp.lpSum(x[w, s] for s in skills)
            <= tot_avail + ot_hrs[w] / reg_hrs,
            f"C3_total_cap_{w}",
        )
        # C4 — OT cap is enforced via the ot_hrs upper bound (set in variable definition)

    # ------------------------------------------------------------------
    # Solve
    # ------------------------------------------------------------------
    solver = pulp.PULP_CBC_CMD(msg=0, timeLimit=120)
    prob.solve(solver)

    status = pulp.LpStatus[prob.status]
    obj_val = pulp.value(prob.objective) or 0.0
    logger.info("MIP  status=%-12s  obj=%.0f  weeks=%d  skills=%d",
                status, obj_val, len(weeks), len(skills))

    if prob.status not in (1,):  # 1 = Optimal
        logger.warning("MIP did not reach optimality: %s", status)

    # ------------------------------------------------------------------
    # Extract solution
    # ------------------------------------------------------------------
    week_results: dict[str, dict] = {}

    for w in weeks:
        skill_rows: dict[str, dict] = {}
        for s in skills:
            dem   = float(skill_demand.get(w, {}).get(s, 0.0))
            avail = int(skill_availability.get(w, {}).get(s, 0))
            if dem <= 0 and avail <= 0:
                continue   # skip skills irrelevant to this week

            assigned = int(round(pulp.value(x[w, s])     or 0.0))
            shortage = max(float(pulp.value(short[w, s])  or 0.0), 0.0)
            exc      = max(float(pulp.value(excess[w, s]) or 0.0), 0.0)
            cov_pct  = min(assigned / dem * 100.0, 100.0) if dem > 0 else 100.0

            skill_rows[s] = {
                "demand_fte":   round(dem, 2),
                "available":    avail,
                "assigned":     assigned,
                "shortage_fte": round(shortage, 2),
                "excess_fte":   round(exc, 2),
                "coverage_pct": round(cov_pct, 1),
            }

        ot_val     = max(float(pulp.value(ot_hrs[w]) or 0.0), 0.0)
        tot_avail  = int(total_availability.get(w, 0))
        tot_dem    = float(total_demand.get(w, 0.0))
        tot_assgnd = sum(r["assigned"]     for r in skill_rows.values())
        tot_short  = sum(r["shortage_fte"] for r in skill_rows.values())
        tot_excess = sum(r["excess_fte"]   for r in skill_rows.values())

        week_results[w] = {
            "total_demand_fte":   round(tot_dem, 1),
            "total_available":    tot_avail,
            "total_assigned":     tot_assgnd,
            "total_shortage_fte": round(tot_short, 2),
            "total_excess_fte":   round(tot_excess, 2),
            "overtime_hrs":       round(ot_val, 1),
            "overtime_fte":       round(ot_val / reg_hrs, 2),
            "utilisation_pct":    round(tot_assgnd / tot_avail * 100 if tot_avail else 0, 1),
            "gap":                round(tot_avail - tot_dem, 1),   # mirrors existing heatmap field
            "status_flag":        _week_flag(tot_short, tot_dem),
            "skills":             skill_rows,
        }

    return {
        "status":           status,
        "solver":           "CBC via PuLP (MIP)",
        "objective_value":  round(obj_val, 2),
        "use_optimisation": True,
        "weeks":            week_results,
        "summary":          _build_summary(week_results, obj_val),
    }


# ===========================================================================
# scipy HiGHS LP fallback (continuous relaxation — integer constraints dropped)
# ===========================================================================

def _solve_scipy(
    skill_demand, total_demand,
    skill_availability, total_availability,
    constraints,
) -> dict:
    """LP relaxation via scipy HiGHS.  No integer constraints on x."""
    import numpy as np
    from scipy.optimize import linprog

    cfg     = constraints or {}
    max_ot  = float(cfg.get("max_ot_hrs_per_person_per_week", _MAX_OT_HRS_PER_PERSON))
    reg_hrs = float(cfg.get("regular_hrs_per_week",           _REGULAR_HRS_PER_WEEK))

    weeks  = sorted(skill_demand.keys())
    skills = sorted({s for wd in skill_demand.values() for s in wd})
    W, S   = len(weeks), len(skills)

    if W == 0 or S == 0:
        return _empty_result("No weeks or skills to optimise")

    # Variable layout (size = 3·W·S + W):
    #   [0           .. W·S-1      ]  x[w,s]      assigned (continuous)
    #   [W·S         .. 2·W·S-1    ]  short[w,s]  shortage
    #   [2·W·S       .. 3·W·S-1    ]  excess[w,s] surplus
    #   [3·W·S       .. 3·W·S+W-1  ]  ot_hrs[w]   overtime hours
    def _xi(wi, si):   return wi * S + si
    def _si(wi, si):   return W * S + wi * S + si
    def _ei(wi, si):   return 2 * W * S + wi * S + si
    def _oi(wi):       return 3 * W * S + wi

    N = 3 * W * S + W

    # Objective vector
    c = np.zeros(N)
    for wi, w in enumerate(weeks):
        for si, s in enumerate(skills):
            c[_si(wi, si)] = SKILL_SHORTAGE_COST.get(s, _DEFAULT_SHORTAGE_COST)
            c[_ei(wi, si)] = _EXCESS_COST_PER_FTE
        c[_oi(wi)] = _OVERTIME_COST_PER_HR

    # Bounds
    bounds = []
    for wi, w in enumerate(weeks):
        for si, s in enumerate(skills):
            av = max(float(skill_availability.get(w, {}).get(s, 0)), 0.0)
            bounds.append((0.0, av))            # x[w,s]
    for _ in range(W * S):
        bounds.append((0.0, None))              # short[w,s]
    for _ in range(W * S):
        bounds.append((0.0, None))              # excess[w,s]
    for wi, w in enumerate(weeks):
        ot_cap = float(total_availability.get(w, 0)) * max_ot
        bounds.append((0.0, max(ot_cap, 0.0)))  # ot_hrs[w]

    # Inequality constraints  A_ub @ z ≤ b_ub
    A_ub_rows, b_ub = [], []

    for wi, w in enumerate(weeks):
        tot_avail = float(total_availability.get(w, 0))

        for si, s in enumerate(skills):
            dem = float(skill_demand.get(w, {}).get(s, 0.0))

            # C1 — Coverage:  -x - short ≤ -dem
            row = np.zeros(N)
            row[_xi(wi, si)] = -1.0
            row[_si(wi, si)] = -1.0
            A_ub_rows.append(row); b_ub.append(-dem)

            # C5 — Excess:  x - excess ≤ dem
            row = np.zeros(N)
            row[_xi(wi, si)] = 1.0
            row[_ei(wi, si)] = -1.0
            A_ub_rows.append(row); b_ub.append(dem)

        # C3 — Total cap:  Σ_s x[w,s] - ot/reg ≤ tot_avail
        row = np.zeros(N)
        for si in range(S):
            row[_xi(wi, si)] = 1.0
        row[_oi(wi)] = -1.0 / reg_hrs
        A_ub_rows.append(row); b_ub.append(tot_avail)

    A_ub = np.array(A_ub_rows, dtype=float) if A_ub_rows else None
    b_ub = np.array(b_ub,      dtype=float) if b_ub      else None

    res = linprog(c, A_ub=A_ub, b_ub=b_ub, bounds=bounds, method="highs")

    if res.status != 0:
        logger.warning("scipy linprog status=%d: %s", res.status, res.message)
        return _empty_result(f"scipy HiGHS: {res.message}")

    z = res.x
    week_results: dict[str, dict] = {}

    for wi, w in enumerate(weeks):
        skill_rows: dict[str, dict] = {}
        for si, s in enumerate(skills):
            dem   = float(skill_demand.get(w, {}).get(s, 0.0))
            avail = int(skill_availability.get(w, {}).get(s, 0))
            if dem <= 0 and avail <= 0:
                continue

            assigned = max(float(z[_xi(wi, si)]), 0.0)
            shortage = max(float(z[_si(wi, si)]), 0.0)
            exc      = max(float(z[_ei(wi, si)]), 0.0)
            cov_pct  = min(assigned / dem * 100.0, 100.0) if dem > 0 else 100.0

            skill_rows[s] = {
                "demand_fte":   round(dem, 2),
                "available":    avail,
                "assigned":     round(assigned, 2),
                "shortage_fte": round(shortage, 2),
                "excess_fte":   round(exc, 2),
                "coverage_pct": round(cov_pct, 1),
            }

        ot_val     = max(float(z[_oi(wi)]), 0.0)
        tot_avail  = int(total_availability.get(w, 0))
        tot_dem    = float(total_demand.get(w, 0.0))
        tot_assgnd = sum(r["assigned"]     for r in skill_rows.values())
        tot_short  = sum(r["shortage_fte"] for r in skill_rows.values())
        tot_excess = sum(r["excess_fte"]   for r in skill_rows.values())

        week_results[w] = {
            "total_demand_fte":   round(tot_dem, 1),
            "total_available":    tot_avail,
            "total_assigned":     round(tot_assgnd, 2),
            "total_shortage_fte": round(tot_short, 2),
            "total_excess_fte":   round(tot_excess, 2),
            "overtime_hrs":       round(ot_val, 1),
            "overtime_fte":       round(ot_val / reg_hrs, 2),
            "utilisation_pct":    round(tot_assgnd / tot_avail * 100 if tot_avail else 0, 1),
            "gap":                round(tot_avail - tot_dem, 1),
            "status_flag":        _week_flag(tot_short, tot_dem),
            "skills":             skill_rows,
        }

    return {
        "status":           "Optimal",
        "solver":           "HiGHS via scipy (LP relaxation — continuous)",
        "objective_value":  round(float(res.fun), 2),
        "use_optimisation": True,
        "weeks":            week_results,
        "summary":          _build_summary(week_results, float(res.fun)),
    }


# ===========================================================================
# Shared helpers
# ===========================================================================

def _week_flag(shortage_fte: float, total_demand: float) -> str:
    """Severity flag matching the intraday alert style."""
    if shortage_fte <= 0.05:
        return "ok"
    pct = shortage_fte / total_demand * 100 if total_demand > 0 else 100
    if pct >= 20:
        return "critical"
    if pct >= 10:
        return "warning"
    return "minor"


def _build_summary(week_results: dict, obj_val: float) -> dict:
    """Aggregate statistics over all weeks."""
    if not week_results:
        return {}

    total_short  = sum(r["total_shortage_fte"] for r in week_results.values())
    total_excess = sum(r["total_excess_fte"]   for r in week_results.values())
    total_ot     = sum(r["overtime_hrs"]        for r in week_results.values())
    weeks_short  = sum(1 for r in week_results.values() if r["total_shortage_fte"] > 0.05)
    peak_short_wk = max(week_results, key=lambda w: week_results[w]["total_shortage_fte"])
    peak_ot_wk    = max(week_results, key=lambda w: week_results[w]["overtime_hrs"])
    avg_util      = (
        sum(r["utilisation_pct"] for r in week_results.values()) / len(week_results)
    )

    # Per-skill aggregates across all weeks
    all_skills: set[str] = set()
    for r in week_results.values():
        all_skills.update(r.get("skills", {}).keys())

    skill_summary: dict[str, dict] = {}
    for s in sorted(all_skills):
        rows = [
            r["skills"][s]
            for r in week_results.values()
            if s in r.get("skills", {})
        ]
        if not rows:
            continue
        dem_vals    = [row["demand_fte"]   for row in rows]
        short_vals  = [row["shortage_fte"] for row in rows]
        assgn_vals  = [row["assigned"]     for row in rows]
        cov_vals    = [row["coverage_pct"] for row in rows]

        skill_summary[s] = {
            "avg_demand_fte":   round(sum(dem_vals)   / len(dem_vals),   2),
            "avg_assigned":     round(sum(assgn_vals) / len(assgn_vals), 2),
            "total_shortage":   round(sum(short_vals), 2),
            "avg_coverage_pct": round(sum(cov_vals)   / len(cov_vals),   1),
            "weeks_at_risk":    sum(1 for v in short_vals if v > 0.05),
            "shortage_cost":    SKILL_SHORTAGE_COST.get(s, _DEFAULT_SHORTAGE_COST),
        }

    return {
        "total_shortage_fte":  round(total_short,  2),
        "total_excess_fte":    round(total_excess,  2),
        "total_overtime_hrs":  round(total_ot,      1),
        "weeks_with_shortage": weeks_short,
        "weeks_ok":            len(week_results) - weeks_short,
        "peak_shortage_week":  peak_short_wk,
        "peak_overtime_week":  peak_ot_wk,
        "avg_utilisation_pct": round(avg_util, 1),
        "objective_value":     round(obj_val, 2),
        "skills":              skill_summary,
    }


def _empty_result(reason: str) -> dict:
    logger.error("MIP returned empty result: %s", reason)
    return {
        "status":           "FAILED",
        "solver":           "none",
        "objective_value":  0.0,
        "use_optimisation": False,
        "weeks":            {},
        "summary":          {},
        "reason":           reason,
    }

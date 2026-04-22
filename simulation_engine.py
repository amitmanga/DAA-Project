"""
simulation_engine.py
~~~~~~~~~~~~~~~~~~~~
Intraday Monte Carlo simulation for airport staffing plan stress-testing.

This is a pure VALIDATION layer — it does not call or modify any
optimisation logic.  It perturbs the operating environment (flight delays,
staff absences, passenger surge) and evaluates how well the original
optimised plan survives across hundreds of random scenarios.

How it works
------------
Phase 0  Plan extraction
    Task windows, staff shifts, skill sets, and original assignments are
    cached once so every simulation run is O(tasks × avg_assigned_per_task).

Phase 1  Per-run perturbation  (for run_id = 0 … num_runs-1)
    a. Absence draw — sample absence_rate ∈ [min, max] for the run via
       a Beta-approximated distribution, then mark each staff member absent
       independently with that probability.
    b. Delay draw — each flight gets a delay delta drawn from a
       truncated-Normal(0, σ_delay); shared tasks take the worst delay
       among their covered flights (pessimistic/conservative).
    c. Surge draw — a log-normal surge_factor per run, so expected value is
       1.0 and values ≥ 1.0 by construction.  Applied uniformly to all tasks'
       staff_needed for that run.

Phase 2  Coverage evaluation  (no optimiser re-run)
    For each task:
        new_window  = [start + delay, end + delay]
        new_needed  = ceil(original_needed × surge_factor)
        surviving   = assigned staff who are (a) not absent AND
                      (b) whose shift window still covers new_window
        gap         = max(0, new_needed − len(surviving))
        is_served   = (gap == 0)

Phase 3  Aggregation
    Distributions, bottleneck ranking, risk score, worst-case detail.

Public API
----------
    from simulation_engine import run_simulation

    # Minimal call — uses default parameters
    result = run_simulation(plan, num_runs=200)

    # Full parameter control
    result = run_simulation(plan, num_runs=500, params={
        "delay_sigma_mins": 15,    # std-dev of delay distribution
        "delay_max_mins":   30,    # absolute cap on delay magnitude
        "delay_prob":       0.25,  # fraction of flights delayed each run
        "absence_rate_min": 0.05,  # minimum per-run absence rate
        "absence_rate_max": 0.15,  # maximum per-run absence rate
        "surge_mean":       1.0,   # expected surge multiplier
        "surge_sigma":      0.10,  # log-normal sigma for surge
        "seed":             None,  # int for reproducibility, None = random
    })

    Keys in result
    --------------
    summary          dict   — aggregate statistics (mean/P10/P50/P90/P99)
    risk_score       float  — 0-100 composite risk index
    risk_level       str    — "Low" | "Medium" | "High" | "Critical"
    worst_case       dict   — full detail of the single most-degraded run
    bottlenecks      dict   — tasks and skills ranked by failure frequency
    distributions    dict   — histogram data for chart rendering
    run_log          list   — condensed per-run records
    baseline         dict   — base-plan coverage before any perturbation
    params_used      dict   — the perturbation parameters used
    meta             dict   — timing, counts, engine version
"""
from __future__ import annotations

import logging
import math
import random
import time
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Version / constants
# ---------------------------------------------------------------------------
_ENGINE_VERSION = "1.0.0"

_PRIORITY_ORDER = {"Critical": 4, "High": 3, "Medium": 2, "Low": 1}
_DEFAULT_PRIORITY_WEIGHT = 2

# Risk-score weights (sum to 100)
_RISK_W_P90_UNSERVED  = 35   # P90 unserved task rate
_RISK_W_CRIT_FAIL     = 30   # critical-task failure probability
_RISK_W_WORST         = 20   # worst-case unserved rate
_RISK_W_SURGE_STRESS  = 15   # probability of gap under surge

# Histogram bin count for distributions
_HIST_BINS = 20

# ---------------------------------------------------------------------------
# Default perturbation parameters
# ---------------------------------------------------------------------------
DEFAULT_PARAMS: dict[str, Any] = {
    "delay_sigma_mins":  15.0,   # std-dev of per-flight delay draw
    "delay_max_mins":    30.0,   # hard cap: delay clipped to ±this value
    "delay_prob":        0.25,   # probability any given flight is delayed
    "absence_rate_min":  0.05,   # minimum run-level absence rate
    "absence_rate_max":  0.15,   # maximum run-level absence rate
    "surge_mean":        1.00,   # expected surge factor (log-normal centre)
    "surge_sigma":       0.10,   # log-normal sigma (≈ coefficient of variation)
    "seed":              None,   # int → reproducible; None → random
}


# ---------------------------------------------------------------------------
# Lightweight cached data structures (internal)
# ---------------------------------------------------------------------------

@dataclass(slots=True)
class _TaskRec:
    """Immutable snapshot of one task extracted from the base plan."""
    idx:              int
    task_id:          str
    label:            str
    skill:            str
    priority:         str
    priority_weight:  int
    start:            int          # minutes since midnight
    end:              int
    needed:           int
    assigned_ids:     frozenset    # staff IDs originally assigned
    flight_nos:       frozenset    # flight(s) this task covers
    originally_alert: bool         # True if base plan already under-staffed


@dataclass(slots=True)
class _StaffRec:
    """Immutable snapshot of one staff member from the base plan."""
    staff_id:    str
    shift_start: int
    shift_end:   int
    skills:      frozenset   # all skill slots (skill1-4), stripped


@dataclass
class _RunResult:
    """Results from a single simulation run."""
    run_id:          int
    absence_rate:    float
    surge_factor:    float
    absent_ids:      frozenset
    delay_map:       dict[str, int]   # flight_no → delay_delta_mins

    unserved_count:  int = 0
    total_tasks:     int = 0
    unserved_pct:    float = 0.0
    crit_unserved:   int = 0
    total_gap_mins:  int = 0          # sum of (gap × task_duration) mins
    util_values:     list[float] = field(default_factory=list)
    task_gaps:       dict[str, int] = field(default_factory=dict)  # task_id → gap count


# ---------------------------------------------------------------------------
# Internal helpers — pure-Python statistics (no numpy dependency)
# ---------------------------------------------------------------------------

def _box_muller() -> float:
    """Return one N(0,1) sample via Box-Muller transform."""
    u1 = max(random.random(), 1e-15)
    u2 = random.random()
    return math.sqrt(-2.0 * math.log(u1)) * math.cos(2.0 * math.pi * u2)


def _truncated_normal(sigma: float, cap: float) -> float:
    """Draw from N(0, sigma) clipped to [-cap, +cap]."""
    for _ in range(20):   # rejection sampling (almost always 1 draw)
        v = _box_muller() * sigma
        if abs(v) <= cap:
            return v
    return cap * (1 if random.random() > 0.5 else -1)


def _log_normal(mu_ln: float, sigma_ln: float) -> float:
    """Draw from LogNormal with given log-space mean and sigma."""
    return math.exp(mu_ln + sigma_ln * _box_muller())


def _percentile(sorted_data: list[float], p: float) -> float:
    """Return the p-th percentile of an already-sorted list."""
    n = len(sorted_data)
    if n == 0:
        return 0.0
    if n == 1:
        return sorted_data[0]
    k = (n - 1) * p / 100.0
    lo = int(k)
    hi = min(lo + 1, n - 1)
    return sorted_data[lo] + (sorted_data[hi] - sorted_data[lo]) * (k - lo)


def _mean(data: list[float]) -> float:
    return sum(data) / len(data) if data else 0.0


def _std(data: list[float], mean: float | None = None) -> float:
    n = len(data)
    if n < 2:
        return 0.0
    mu = mean if mean is not None else _mean(data)
    return math.sqrt(sum((x - mu) ** 2 for x in data) / n)


def _histogram(data: list[float], n_bins: int = _HIST_BINS) -> list[dict]:
    """Build a fixed-width histogram for chart rendering."""
    if not data:
        return []
    lo, hi = min(data), max(data)
    if hi == lo:
        return [{"x": round(lo, 4), "count": len(data)}]
    width = (hi - lo) / n_bins
    counts = [0] * n_bins
    for v in data:
        idx = min(int((v - lo) / width), n_bins - 1)
        counts[idx] += 1
    return [
        {"x": round(lo + (i + 0.5) * width, 4), "count": counts[i]}
        for i in range(n_bins)
        if counts[i] > 0
    ]


def _distribution_stats(data: list[float]) -> dict:
    """Return a full statistical summary of a numeric list."""
    if not data:
        return {"mean": 0, "std": 0, "min": 0,
                "p10": 0, "p25": 0, "p50": 0, "p75": 0, "p90": 0, "p99": 0, "max": 0}
    s = sorted(data)
    mu = _mean(s)
    return {
        "mean": round(mu, 4),
        "std":  round(_std(s, mu), 4),
        "min":  round(s[0], 4),
        "p10":  round(_percentile(s, 10), 4),
        "p25":  round(_percentile(s, 25), 4),
        "p50":  round(_percentile(s, 50), 4),
        "p75":  round(_percentile(s, 75), 4),
        "p90":  round(_percentile(s, 90), 4),
        "p99":  round(_percentile(s, 99), 4),
        "max":  round(s[-1], 4),
    }


# ---------------------------------------------------------------------------
# Phase 0 — Plan extraction
# ---------------------------------------------------------------------------

def _extract_records(plan: dict) -> tuple[list[_TaskRec], dict[str, _StaffRec], list[str]]:
    """Parse the optimize_day() output into fast lookup structures.

    Returns
    -------
    task_recs   — list of _TaskRec (one per unique task)
    staff_map   — {staff_id: _StaffRec}
    flight_nos  — list of all unique flight numbers in the plan
    """
    # ── Tasks ──────────────────────────────────────────────────────────────
    raw_tasks: list[dict] = plan.get("tasks", [])

    # De-duplicate tasks by id (shared tasks may appear in multiple flights)
    seen_task_ids: set[str] = set()
    task_recs: list[_TaskRec] = []

    for i, t in enumerate(raw_tasks):
        tid = t.get("id", f"task_{i}")
        if tid in seen_task_ids:
            continue
        seen_task_ids.add(tid)

        needed = int(t.get("staff_needed", 1))
        if needed <= 0:
            needed = 1

        flights_covered = t.get("flights_covered") or []
        if not flights_covered:
            fn = t.get("flight_no", "")
            flights_covered = [fn] if fn else []

        pw = _PRIORITY_ORDER.get(t.get("priority", "Medium"), _DEFAULT_PRIORITY_WEIGHT)

        task_recs.append(_TaskRec(
            idx              = len(task_recs),
            task_id          = tid,
            label            = t.get("task", tid),
            skill            = t.get("skill", ""),
            priority         = t.get("priority", "Medium"),
            priority_weight  = pw,
            start            = int(t.get("start_mins", 0)),
            end              = int(t.get("end_mins", 0)),
            needed           = needed,
            assigned_ids     = frozenset(t.get("assigned", [])),
            flight_nos       = frozenset(fn for fn in flights_covered if fn),
            originally_alert = bool(t.get("alert")),
        ))

    # ── Staff ──────────────────────────────────────────────────────────────
    staff_map: dict[str, _StaffRec] = {}
    for s in plan.get("staff", []):
        sid = s.get("id", "")
        if not sid:
            continue
        skills = frozenset(
            sk.strip()
            for sk in [s.get("skill1", ""), s.get("skill2", ""),
                       s.get("skill3", ""), s.get("skill4", "")]
            if sk and sk.strip()
        )
        staff_map[sid] = _StaffRec(
            staff_id    = sid,
            shift_start = int(s.get("shift_start", 0)),
            shift_end   = int(s.get("shift_end", 720)),
            skills      = skills,
        )

    # ── Flights ────────────────────────────────────────────────────────────
    flight_nos: list[str] = [
        f["flight_no"]
        for f in plan.get("flights", [])
        if f.get("flight_no")
    ]

    logger.info(
        "Plan extracted: %d tasks, %d staff, %d flights",
        len(task_recs), len(staff_map), len(flight_nos),
    )
    return task_recs, staff_map, flight_nos


# ---------------------------------------------------------------------------
# Phase 1 — Per-run perturbation
# ---------------------------------------------------------------------------

def _sample_absent_ids(
    all_staff_ids: list[str],
    absence_rate_min: float,
    absence_rate_max: float,
) -> frozenset[str]:
    """Draw a run-level absence rate then sample staff independently."""
    # Run-level rate: uniform between min and max
    rate = absence_rate_min + random.random() * (absence_rate_max - absence_rate_min)
    rate = max(0.0, min(rate, 0.99))
    return frozenset(sid for sid in all_staff_ids if random.random() < rate)


def _sample_delays(
    flight_nos: list[str],
    delay_prob: float,
    delay_sigma: float,
    delay_max: float,
) -> dict[str, int]:
    """Sample a delay delta for each flight. Most flights are on-time."""
    delay_map: dict[str, int] = {}
    for fn in flight_nos:
        if random.random() < delay_prob:
            delta = _truncated_normal(delay_sigma, delay_max)
            delay_map[fn] = int(round(delta))
    return delay_map


def _sample_surge(surge_mean: float, surge_sigma: float) -> float:
    """Draw a log-normal surge factor. Expected value ≈ surge_mean."""
    # Log-normal parameterisation so E[X] = surge_mean
    mu_ln = math.log(surge_mean) - 0.5 * surge_sigma ** 2
    return _log_normal(mu_ln, surge_sigma)


# ---------------------------------------------------------------------------
# Phase 2 — Coverage evaluation for one run
# ---------------------------------------------------------------------------

def _evaluate_run(
    task_recs:   list[_TaskRec],
    staff_map:   dict[str, _StaffRec],
    absent_ids:  frozenset[str],
    delay_map:   dict[str, int],
    surge:       float,
) -> tuple[dict[str, int], int, int, int]:
    """Evaluate plan coverage under one set of perturbations.

    Returns
    -------
    task_gaps   — {task_id: gap_headcount}  (only gap > 0)
    unserved    — count of tasks with gap > 0
    crit_unserved — count of Critical-priority tasks with gap > 0
    total_gap_mins — Σ gap × task_duration (staff-minutes of unmet demand)
    """
    task_gaps: dict[str, int] = {}
    unserved = 0
    crit_unserved = 0
    total_gap_mins = 0

    for tr in task_recs:
        # Compute task delay: worst delay across all flights it covers
        if tr.flight_nos:
            delay = max((delay_map.get(fn, 0) for fn in tr.flight_nos), default=0)
        else:
            delay = 0

        new_start = tr.start + delay
        new_end   = tr.end   + delay

        # Surge-adjusted headcount required
        new_needed = max(1, math.ceil(tr.needed * surge))

        # Count originally assigned staff who are still present and covering
        surviving = 0
        for sid in tr.assigned_ids:
            if sid in absent_ids:
                continue
            sr = staff_map.get(sid)
            if sr is None:
                continue
            # Shift must bracket the (possibly delayed) task window
            if sr.shift_start <= new_start and sr.shift_end >= new_end:
                surviving += 1

        gap = max(0, new_needed - surviving)
        if gap > 0:
            task_gaps[tr.task_id] = gap
            unserved += 1
            if tr.priority == "Critical":
                crit_unserved += 1
            total_gap_mins += gap * max(0, new_end - new_start)

    return task_gaps, unserved, crit_unserved, total_gap_mins


def _compute_staff_utilisation(
    task_recs:  list[_TaskRec],
    staff_map:  dict[str, _StaffRec],
    absent_ids: frozenset[str],
    delay_map:  dict[str, int],
) -> list[float]:
    """Return per-non-absent-staff utilisation fractions for one run.

    Utilisation = total assigned-and-covering minutes / shift length.
    This reflects how busy each staff member actually is given the delays.
    """
    staff_busy: dict[str, int] = defaultdict(int)

    for tr in task_recs:
        if tr.flight_nos:
            delay = max((delay_map.get(fn, 0) for fn in tr.flight_nos), default=0)
        else:
            delay = 0
        new_start = tr.start + delay
        new_end   = tr.end   + delay
        dur = max(0, new_end - new_start)

        for sid in tr.assigned_ids:
            if sid in absent_ids:
                continue
            sr = staff_map.get(sid)
            if sr is None:
                continue
            if sr.shift_start <= new_start and sr.shift_end >= new_end:
                staff_busy[sid] += dur

    utils: list[float] = []
    for sid, sr in staff_map.items():
        if sid in absent_ids:
            continue
        shift_dur = max(1, sr.shift_end - sr.shift_start)
        utils.append(min(staff_busy.get(sid, 0) / shift_dur, 1.0))

    return utils


# ---------------------------------------------------------------------------
# Phase 3 — Aggregation
# ---------------------------------------------------------------------------

def _build_bottlenecks(
    run_results:      list[_RunResult],
    task_recs:        list[_TaskRec],
    num_runs:         int,
) -> dict:
    """Rank tasks and skills by how often they were unserved."""
    # Per-task failure counts
    task_fail_count: dict[str, int] = defaultdict(int)
    task_gap_total:  dict[str, int] = defaultdict(int)

    for rr in run_results:
        for tid, gap in rr.task_gaps.items():
            task_fail_count[tid] += 1
            task_gap_total[tid] += gap

    # Per-skill failure counts
    skill_fail_count: dict[str, int] = defaultdict(int)
    skill_gap_total:  dict[str, int] = defaultdict(int)
    task_meta = {tr.task_id: tr for tr in task_recs}

    for tid, cnt in task_fail_count.items():
        tr = task_meta.get(tid)
        if tr:
            skill_fail_count[tr.skill] += cnt
            skill_gap_total[tr.skill]  += task_gap_total[tid]

    # Ranked task bottlenecks
    task_bottlenecks = sorted(
        [
            {
                "task_id":       tid,
                "label":         task_meta[tid].label if tid in task_meta else tid,
                "skill":         task_meta[tid].skill if tid in task_meta else "",
                "priority":      task_meta[tid].priority if tid in task_meta else "",
                "fail_count":    cnt,
                "fail_rate_pct": round(cnt / num_runs * 100, 1),
                "avg_gap":       round(task_gap_total[tid] / cnt, 2) if cnt else 0,
            }
            for tid, cnt in task_fail_count.items()
            if tid in task_meta
        ],
        key=lambda x: (-x["fail_count"], -x["avg_gap"]),
    )[:20]  # top 20

    # Ranked skill bottlenecks
    skill_bottlenecks = sorted(
        [
            {
                "skill":         sk,
                "fail_count":    cnt,
                "fail_rate_pct": round(cnt / (num_runs * max(1, len(task_recs))) * 100, 2),
                "total_gap_headcount": skill_gap_total[sk],
            }
            for sk, cnt in skill_fail_count.items()
        ],
        key=lambda x: -x["fail_count"],
    )

    return {
        "top_failing_tasks":  task_bottlenecks,
        "failing_skills":     skill_bottlenecks,
        "tasks_never_failed": sum(
            1 for tr in task_recs
            if task_fail_count.get(tr.task_id, 0) == 0
        ),
    }


def _compute_risk_score(
    unserved_pcts:   list[float],
    crit_fail_rates: list[float],
    gap_mins:        list[float],
) -> tuple[float, str]:
    """Compute a 0-100 composite risk index.

    Components
    ----------
    P90 unserved task rate × 35 pts
    Critical-task failure probability × 30 pts
    Worst-case unserved rate × 20 pts
    P90 of gap-mins (normalised to max 60 staff-min gap) × 15 pts
    """
    s_unserved  = sorted(unserved_pcts)
    p90_unserved = _percentile(s_unserved, 90)
    worst_unserved = s_unserved[-1] if s_unserved else 0.0

    prob_crit_fail = _mean(crit_fail_rates)   # fraction of runs with ≥1 critical failure

    p90_gap_hrs = _percentile(sorted(gap_mins), 90) / 60.0   # convert mins to hours
    surge_stress = min(p90_gap_hrs / 8.0, 1.0)               # 8-staff-hour gap → full score

    raw = (
        p90_unserved   * _RISK_W_P90_UNSERVED
        + prob_crit_fail * _RISK_W_CRIT_FAIL
        + worst_unserved * _RISK_W_WORST
        + surge_stress   * _RISK_W_SURGE_STRESS
    )
    score = round(max(0.0, min(100.0, raw * 100)), 1)

    level = (
        "Low"      if score < 20 else
        "Medium"   if score < 40 else
        "High"     if score < 65 else
        "Critical"
    )
    return score, level


# ---------------------------------------------------------------------------
# Baseline assessment (no perturbation)
# ---------------------------------------------------------------------------

def _baseline_coverage(task_recs: list[_TaskRec]) -> dict:
    """Report the base-plan coverage before any simulation."""
    total = len(task_recs)
    unserved = sum(1 for tr in task_recs if tr.originally_alert)
    crit_unserved = sum(1 for tr in task_recs if tr.originally_alert and tr.priority == "Critical")
    fully_unassigned = sum(1 for tr in task_recs if len(tr.assigned_ids) == 0)
    return {
        "total_tasks":         total,
        "unserved_tasks":      unserved,
        "unserved_pct":        round(unserved / total * 100, 1) if total else 0.0,
        "critical_unserved":   crit_unserved,
        "fully_unassigned":    fully_unassigned,
        "coverage_pct":        round((total - unserved) / total * 100, 1) if total else 100.0,
    }


# ---------------------------------------------------------------------------
# Main public function
# ---------------------------------------------------------------------------

def run_simulation(
    plan:     dict,
    num_runs: int = 100,
    params:   dict | None = None,
) -> dict:
    """Run a Monte Carlo stress-test on a staffing plan.

    Parameters
    ----------
    plan
        The dict returned by optimize_day() — must contain 'tasks' and 'staff'.
    num_runs
        Number of Monte Carlo iterations (100–500 recommended).
    params
        Override dict for perturbation parameters.  See DEFAULT_PARAMS.

    Returns
    -------
    dict with keys:
        summary, risk_score, risk_level, worst_case, bottlenecks,
        distributions, run_log, baseline, params_used, meta
    """
    t_start = time.perf_counter()

    # ── Merge parameters ────────────────────────────────────────────────────
    p = {**DEFAULT_PARAMS, **(params or {})}
    num_runs = max(10, min(int(num_runs), 1000))

    delay_sigma  = float(p["delay_sigma_mins"])
    delay_max    = float(p["delay_max_mins"])
    delay_prob   = float(p["delay_prob"])
    ab_min       = float(p["absence_rate_min"])
    ab_max       = float(p["absence_rate_max"])
    surge_mean   = float(p["surge_mean"])
    surge_sigma  = float(p["surge_sigma"])
    seed         = p.get("seed")

    if seed is not None:
        random.seed(int(seed))

    # ── Phase 0: extract plan ───────────────────────────────────────────────
    task_recs, staff_map, flight_nos = _extract_records(plan)
    all_staff_ids = list(staff_map.keys())

    if not task_recs:
        return {
            "error": "No tasks found in plan — ensure the plan was generated by optimize_day().",
            "params_used": p,
        }

    baseline = _baseline_coverage(task_recs)

    # ── Phase 1+2: simulation loop ──────────────────────────────────────────
    run_results: list[_RunResult] = []

    # Collect scalar time-series for aggregation
    unserved_pcts:   list[float] = []
    crit_fail_flags: list[float] = []   # 1.0 if any critical task failed, else 0.0
    gap_mins_series: list[float] = []
    util_means:      list[float] = []
    util_stds:       list[float] = []
    surge_values:    list[float] = []
    absence_values:  list[float] = []

    worst_rr: _RunResult | None = None
    worst_unserved_pct = -1.0

    for run_id in range(num_runs):
        # Perturbation draws
        absent_ids  = _sample_absent_ids(all_staff_ids, ab_min, ab_max)
        delay_map   = _sample_delays(flight_nos, delay_prob, delay_sigma, delay_max)
        surge       = _sample_surge(surge_mean, surge_sigma)

        absence_rate = len(absent_ids) / max(1, len(all_staff_ids))

        # Evaluate coverage
        task_gaps, unserved, crit_unserved, total_gap_mins = _evaluate_run(
            task_recs, staff_map, absent_ids, delay_map, surge
        )

        total_tasks = len(task_recs)
        unserved_pct = unserved / total_tasks if total_tasks else 0.0

        # Utilisation
        utils = _compute_staff_utilisation(task_recs, staff_map, absent_ids, delay_map)
        u_mean = _mean(utils)
        u_std  = _std(utils, u_mean)

        # Store run result
        rr = _RunResult(
            run_id       = run_id,
            absence_rate = absence_rate,
            surge_factor = surge,
            absent_ids   = absent_ids,
            delay_map    = delay_map,
            unserved_count = unserved,
            total_tasks    = total_tasks,
            unserved_pct   = unserved_pct,
            crit_unserved  = crit_unserved,
            total_gap_mins = total_gap_mins,
            util_values    = utils,
            task_gaps      = task_gaps,
        )
        run_results.append(rr)

        # Time-series accumulators
        unserved_pcts.append(unserved_pct)
        crit_fail_flags.append(1.0 if crit_unserved > 0 else 0.0)
        gap_mins_series.append(float(total_gap_mins))
        util_means.append(u_mean)
        util_stds.append(u_std)
        surge_values.append(surge)
        absence_values.append(absence_rate)

        # Track worst case
        if unserved_pct > worst_unserved_pct:
            worst_unserved_pct = unserved_pct
            worst_rr = rr

    # ── Phase 3: aggregation ────────────────────────────────────────────────
    summary = {
        "num_runs":            num_runs,
        "unserved_tasks":      _distribution_stats(unserved_pcts),
        "staff_utilisation":   _distribution_stats(util_means),
        "utilisation_variance": _distribution_stats(util_stds),
        "gap_staff_mins":      _distribution_stats(gap_mins_series),
        "critical_failure_probability": round(_mean(crit_fail_flags), 4),
        "prob_any_unserved":   round(
            sum(1 for x in unserved_pcts if x > 0) / num_runs, 4
        ),
        "prob_gt10pct_unserved": round(
            sum(1 for x in unserved_pcts if x > 0.10) / num_runs, 4
        ),
        "prob_gt25pct_unserved": round(
            sum(1 for x in unserved_pcts if x > 0.25) / num_runs, 4
        ),
        "avg_surge_factor":    round(_mean(surge_values), 4),
        "avg_absence_rate":    round(_mean(absence_values), 4),
    }

    risk_score, risk_level = _compute_risk_score(
        unserved_pcts, crit_fail_flags, gap_mins_series
    )

    bottlenecks = _build_bottlenecks(run_results, task_recs, num_runs)

    # Worst-case detail
    worst_case: dict = {}
    if worst_rr is not None:
        wc_task_details = []
        for tr in task_recs:
            gap = worst_rr.task_gaps.get(tr.task_id, 0)
            if gap > 0:
                flight_delay = max(
                    (worst_rr.delay_map.get(fn, 0) for fn in tr.flight_nos),
                    default=0,
                ) if tr.flight_nos else 0
                wc_task_details.append({
                    "task_id":      tr.task_id,
                    "label":        tr.label,
                    "skill":        tr.skill,
                    "priority":     tr.priority,
                    "start_mins":   tr.start,
                    "end_mins":     tr.end,
                    "original_needed":  tr.needed,
                    "surge_needed":     max(1, math.ceil(tr.needed * worst_rr.surge_factor)),
                    "gap":          gap,
                    "flight_delay": flight_delay,
                })
        wc_task_details.sort(
            key=lambda x: (-_PRIORITY_ORDER.get(x["priority"], 2), x["start_mins"])
        )

        worst_case = {
            "run_id":          worst_rr.run_id,
            "unserved_pct":    round(worst_rr.unserved_pct * 100, 1),
            "unserved_count":  worst_rr.unserved_count,
            "crit_unserved":   worst_rr.crit_unserved,
            "absence_rate_pct": round(worst_rr.absence_rate * 100, 1),
            "absent_count":    len(worst_rr.absent_ids),
            "absent_staff":    sorted(worst_rr.absent_ids),
            "surge_factor":    round(worst_rr.surge_factor, 3),
            "delayed_flights": {
                fn: delta
                for fn, delta in sorted(worst_rr.delay_map.items(), key=lambda x: -abs(x[1]))
            },
            "delayed_flight_count": len(worst_rr.delay_map),
            "failing_tasks":   wc_task_details,
            "total_gap_mins":  worst_rr.total_gap_mins,
        }

    # Distributions for chart rendering
    distributions = {
        "unserved_pct": _histogram(
            [x * 100 for x in unserved_pcts], _HIST_BINS
        ),
        "utilisation_mean": _histogram(
            [x * 100 for x in util_means], _HIST_BINS
        ),
        "utilisation_std": _histogram(
            [x * 100 for x in util_stds], _HIST_BINS
        ),
        "gap_staff_mins": _histogram(gap_mins_series, _HIST_BINS),
        "absence_rate":   _histogram(
            [x * 100 for x in absence_values], _HIST_BINS
        ),
        "surge_factor":   _histogram(surge_values, _HIST_BINS),
    }

    # Condensed run log (per-run summary, omit large fields)
    run_log = [
        {
            "run_id":         rr.run_id,
            "absent_count":   len(rr.absent_ids),
            "absence_rate":   round(rr.absence_rate * 100, 1),
            "delayed_flights": len(rr.delay_map),
            "surge_factor":   round(rr.surge_factor, 3),
            "unserved_count": rr.unserved_count,
            "unserved_pct":   round(rr.unserved_pct * 100, 1),
            "crit_unserved":  rr.crit_unserved,
            "gap_mins":       rr.total_gap_mins,
        }
        for rr in run_results
    ]

    elapsed = round(time.perf_counter() - t_start, 3)

    return {
        "summary":        summary,
        "risk_score":     risk_score,
        "risk_level":     risk_level,
        "worst_case":     worst_case,
        "bottlenecks":    bottlenecks,
        "distributions":  distributions,
        "run_log":        run_log,
        "baseline":       baseline,
        "params_used":    p,
        "meta": {
            "engine_version": _ENGINE_VERSION,
            "elapsed_seconds": elapsed,
            "num_runs":       num_runs,
            "num_tasks":      len(task_recs),
            "num_staff":      len(staff_map),
            "num_flights":    len(flight_nos),
            "runs_per_second": round(num_runs / max(elapsed, 0.001), 0),
        },
    }

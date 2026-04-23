from flask import Flask, jsonify, request, render_template
import csv
import json
import os
import re
from datetime import datetime, timedelta
from collections import defaultdict

# CP-SAT optimiser (optional — falls back to greedy if OR-Tools is absent)
try:
    from intraday_optimizer import (
        optimize_intraday_assignments as _cpsat_optimize,
        ORTOOLS_AVAILABLE as _CPSAT_AVAILABLE,
    )
except ImportError:  # pragma: no cover
    _CPSAT_AVAILABLE = False
    def _cpsat_optimize(*_a, **_kw):  # type: ignore[misc]
        return None

# Long-term MIP optimiser (optional — requires PuLP or scipy)
try:
    from long_term_mip import (
        optimize_weekly_staffing as _lt_mip_optimize,
        MIP_AVAILABLE as _LT_MIP_AVAILABLE,
    )
except ImportError:  # pragma: no cover
    _LT_MIP_AVAILABLE = False
    def _lt_mip_optimize(*_a, **_kw):  # type: ignore[misc]
        raise RuntimeError("long_term_mip module not found")

# Roster optimiser — two-phase shift-pattern generation + staff assignment
try:
    from roster_optimizer import (
        generate_roster       as _roster_generate,
        tasks_to_demand_windows as _roster_tasks_to_dw,
        format_as_on_duty     as _roster_fmt_on_duty,
        DemandWindow          as _RosterDemandWindow,
        SOLVER_AVAILABLE      as _ROSTER_SOLVER_AVAILABLE,
    )
    _ROSTER_AVAILABLE = True
except ImportError:  # pragma: no cover
    _ROSTER_AVAILABLE = False
    _ROSTER_SOLVER_AVAILABLE = False
    def _roster_generate(*_a, **_kw):  # type: ignore[misc]
        raise RuntimeError("roster_optimizer module not found")
    def _roster_tasks_to_dw(*_a, **_kw):  # type: ignore[misc]
        return []
    def _roster_fmt_on_duty(*_a, **_kw):  # type: ignore[misc]
        return []

# Simulation engine — Monte Carlo intraday stress-testing (validation layer only)
try:
    from simulation_engine import run_simulation as _sim_run_simulation
    _SIM_AVAILABLE = True
except ImportError:  # pragma: no cover
    _SIM_AVAILABLE = False
    def _sim_run_simulation(*_a, **_kw):  # type: ignore[misc]
        raise RuntimeError("simulation_engine module not found")

app = Flask(__name__)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

def read_csv(filename):
    path = os.path.join(BASE_DIR, 'data', filename)
    with open(path, encoding='utf-8-sig') as f:
        rows = list(csv.DictReader(f))
    return [r for r in rows if any(v.strip() for v in r.values())]

def parse_date(s, fmt='%d-%m-%y'):
    s = s.strip()
    for f in ('%d-%m-%y', '%d-%m-%Y', '%d-%b-%y', '%d-%b-%Y'):
        try:
            return datetime.strptime(s, f)
        except ValueError:
            pass
    return None

# ---------------------------------------------------------------------------
# Skill Normalization: Maps Staff_schedule names to Config.csv names
# ---------------------------------------------------------------------------
SKILL_MAP = {
    'GNIB':                 'GNIB / Immigration',
    'CBP Pre-clearance':    'CBP Pre-clearance',
    'Bussing':              'Bussing',
    'PBZ':                  'PBZ',
    'Mezz Operation':       'Mezz Operation',
    'Litter Picking':       'Litter Picking',
    'Ramp / Marshalling':   'Ramp / Marshalling',
    'Arr Customer Service': 'Arr Customer Service',
    'Check-in/Trolleys':    'Check-in/Trolleys',
    'Dep/Trolleys':         'Dep / Trolleys',
    'Dep / Trolleys':       'Dep / Trolleys',
    'T1/T2 Trolleys L/UL':  'Dep / Trolleys', # Proxy for T1 zone work
    'Transfer Corridor':   'Transfer Corridor'
}

def normalize_skill(sk):
    sk = sk.strip()
    return SKILL_MAP.get(sk, sk)

# ---------------------------------------------------------------------------
# Per-movement staff-minutes derived directly from Config.csv task rules.
# Key: (Flight_Category, Status)
#
# DEPARTURES apply: GNIB / Immigration + Ramp / Marshalling + Bussing (22% remote stands)
# ARRIVALS apply:   Arr Customer Service + Check-in/Trolleys + Bussing (22% remote stands)
# CBP hall is session-based (see FIXED_FTE below); per-movement only covers GNIB + Ramp.
#
# Derivations:
#   Short-Haul DEP : GNIB(2×60=120) + Ramp(1×30=30) + Bussing(0.22×1×30≈7)  = 157
#   Short-Haul ARR : ArrCS(1×55=55) + Trolleys(1×45=45) + Bussing(0.22×1×35≈8) = 108
#   Long-Haul  DEP : GNIB(3×80=240) + Ramp(2×50=100) + Bussing(0.10×1×30≈3)  = 343
#   Long-Haul  ARR : ArrCS(1×90=90) + Bussing(0.10×1×35≈4)                   =  94
#   CBP        DEP : GNIB(3×80=240) + Ramp(2×50=100) + Bussing(0.05×1×30≈2)  = 342
#   CBP        ARR : ArrCS(1×90=90) + Bussing(0.05×1×35≈2)                   =  92
#   Domestic   DEP : Ramp(1×30=30) + Bussing(0.20×1×30≈6)                    =  36
#   Domestic   ARR : ArrCS(1×45=45) + Bussing(0.20×1×35≈7)                   =  52
#   Cargo      DEP : Ramp(2×50=100)                                            = 100
#   Cargo      ARR : Ramp(2×40=80)                                             =  80
# ---------------------------------------------------------------------------
STAFF_MINS_PER_MOVEMENT = {
    ('International Short-Haul', 'Departure'): 157,
    ('International Short-Haul', 'Arrival'):   108,
    ('International Long-Haul',  'Departure'): 343,
    ('International Long-Haul',  'Arrival'):    94,
    ('Transatlantic CBP',        'Departure'): 342,
    ('Transatlantic CBP',        'Arrival'):    92,
    ('Domestic',                 'Departure'):  36,
    ('Domestic',                 'Arrival'):    52,
    ('Cargo',                    'Departure'): 100,
    ('Cargo',                    'Arrival'):    80,
}

# Skill share of each (category, status) task bundle — must sum to 1.0
SKILL_SPLIT = {
    ('International Short-Haul', 'Departure'): {'GNIB': 0.76, 'Ramp / Marshalling': 0.19, 'Bussing': 0.05},
    ('International Short-Haul', 'Arrival'):   {'Arr Customer Service': 0.51, 'Check-in/Trolleys': 0.42, 'Bussing': 0.07},
    ('International Long-Haul',  'Departure'): {'GNIB': 0.70, 'Ramp / Marshalling': 0.29, 'Bussing': 0.01},
    ('International Long-Haul',  'Arrival'):   {'Arr Customer Service': 0.96, 'Bussing': 0.04},
    ('Transatlantic CBP',        'Departure'): {'GNIB': 0.70, 'Ramp / Marshalling': 0.29, 'Bussing': 0.01},
    ('Transatlantic CBP',        'Arrival'):   {'Arr Customer Service': 0.96, 'Bussing': 0.04},
    ('Domestic',                 'Departure'): {'Ramp / Marshalling': 0.83, 'Bussing': 0.17},
    ('Domestic',                 'Arrival'):   {'Arr Customer Service': 0.87, 'Bussing': 0.13},
    ('Cargo',                    'Departure'): {'Ramp / Marshalling': 1.0},
    ('Cargo',                    'Arrival'):   {'Ramp / Marshalling': 1.0},
}

# Fixed posts from Config.csv — run regardless of flight volume.
# FTE = (staff_count × duration_mins × operating_days) / NET_WORKING_MINS_PER_WEEK
# NET_WORKING_MINS_PER_WEEK = 630 min/shift × 5 days = 3150
#
#  Mezz Operation  : 2 staff × 300 min × 5 days / 3150 = 0.95 FTE
#  Litter Picking  : 2 hrs at day shift, 2 hrs at night shift by 2 FTE = 480 mins/day × 7 days / 3150 = 1.07 FTE
#  CBP Hall        : 3 staff × 300 min/session × 5 days / 3150 = 1.43 FTE
#  PBZ (T2 pier)   : 4 roster slots (session-based, consistent) = ~1.27 FTE
FIXED_FTE = {
    'Mezz Operation':     0.95,
    'Litter Picking':     1.07,
    'CBP Pre-clearance':  1.43,   # hall session staffing on top of per-movement GNIB/Ramp
    'PBZ':                1.27,
}
FIXED_FTE_TOTAL = sum(FIXED_FTE.values())  # = 6.58 FTE

# Calibration constants
# Historical 2025 average weekly flight-driven staff-minutes (W24 + S25 + W25 data).
# Calculated from actual 2025 movements × STAFF_MINS_PER_MOVEMENT above.
# Represents the demand that the current 50-person workforce is calibrated against.
HISTORICAL_AVG_STAFF_MINS = 763_301.0
BASELINE_STAFF = 50
NET_WORKING_MINS_PER_WEEK = 630 * 5  # 3150 mins per FTE per week


def compute_week_start(d):
    """Return Monday of the week containing date d."""
    return d - timedelta(days=d.weekday())


def load_weekly_demand():
    rows = read_csv('Weekly_flight_demand.csv')
    return [r for r in rows if r.get('Season_Code')]


def load_staff():
    rows = read_csv('Staff_schedule.csv')
    # deduplicate: one record per employee (use first date seen)
    seen = {}
    for r in rows:
        emp = r.get('EMPLOYEE NUMBER', '').strip()
        if emp and emp not in seen:
            seen[emp] = r
    return list(seen.values())


def load_absences():
    rows = read_csv('Staff_absence_schedule.csv')
    return [r for r in rows if r.get('EMPLOYEE NUMBER', '').strip()]


def weekly_demand_2026():
    """Returns {week_key: {(category, status): movements}} for full year 2026.

    Uses S26/W26 Forecast for weeks W15-W53.
    Uses W25 Historical for weeks W01-W14 (Jan-Mar 2026, winter season).
    """
    rows = load_weekly_demand()
    by_week = defaultdict(lambda: defaultdict(float))

    for r in rows:
        sc    = r.get('Season_Code', '').strip()
        dtype = r.get('Data_type', '').strip()
        d     = parse_date(r.get('Week_Start', '').strip())
        if not d or d.year != 2026:
            continue

        include = sc in ('S26', 'W26') or \
                  (dtype == 'Historical' and sc == 'W25')
        if not include:
            continue

        week_key = d.strftime('%Y-W%V')
        key = (r.get('Flight_Category', '').strip(),
               r.get('Status', '').strip())
        try:
            mvmt = float(r.get('Weekly_Movements', 0) or 0)
        except:
            mvmt = 0
        by_week[week_key][key] += mvmt

    return dict(by_week)


def weekly_staff_required(demand_by_week):
    """Returns {week_key: fte_required} and {week_key: {skill: fte}}.

    This is the *baseline* demand-estimation method — it converts flight movements
    to FTE requirements using calibrated staff-minutes per movement.

    For an *optimised* allocation that minimises shortages, overtime, and cost
    given actual staff availability, use the MIP endpoint:
        GET/POST /api/long-term/optimised-staffing

    Methodology (Config.csv-derived):
    1. For each (category, status) pair, sum: movements × staff_mins_per_movement
       Staff-mins per movement = Σ(staff_count × duration_mins) for each applicable
       Config.csv task, using Status to determine which tasks fire:
         DEP tasks: GNIB/Immigration + Ramp/Marshalling + Bussing (22% remote)
         ARR tasks: Arr Customer Service + Check-in/Trolleys + Bussing (22% remote)
    2. Convert to FTE using the 2025 historical calibration:
         FTE = BASELINE_STAFF × (week_staff_mins / HISTORICAL_AVG_STAFF_MINS)
       This anchors the 50-person workforce to the 2025 average demand level and
       scales proportionally for any deviation in 2026.
    3. Add fixed-post FTE (Mezz, Litter, CBP hall, PBZ) from Config.csv durations.
    """
    total = {}
    by_skill = {}

    for wk, cat_status_mvmt in demand_by_week.items():
        # Step 1: total flight-driven staff-minutes for this week
        flight_staff_mins = 0.0
        skill_mins = defaultdict(float)

        for (cat, status), mvmt in cat_status_mvmt.items():
            spm = STAFF_MINS_PER_MOVEMENT.get((cat, status), 100)
            contrib = mvmt * spm
            flight_staff_mins += contrib
            for sk, ratio in SKILL_SPLIT.get((cat, status), {'GNIB': 1.0}).items():
                skill_mins[sk] += contrib * ratio

        # Step 2: calibrated FTE
        flight_fte = BASELINE_STAFF * (flight_staff_mins / HISTORICAL_AVG_STAFF_MINS)

        # Step 3: fixed-post FTE (Config.csv fixed duties)
        total_fte = flight_fte + FIXED_FTE_TOTAL

        # Skill FTE: scale flight skill-mins proportionally, then add fixed posts
        skill_fte = defaultdict(float)
        if flight_staff_mins > 0:
            for sk, mins in skill_mins.items():
                skill_fte[sk] = flight_fte * (mins / flight_staff_mins)
        for sk, fte in FIXED_FTE.items():
            skill_fte[sk] += fte

        total[wk] = round(total_fte, 1)
        by_skill[wk] = {k: round(v, 1) for k, v in skill_fte.items()}

    return total, by_skill


def weekly_staff_available():
    """Returns {week_key: net_staff} and {week_key: {skill: count}}."""
    staff = load_staff()
    absences = load_absences()
    total_staff = len(staff)

    # Build skill pool (all qualifications)
    skill_pool = defaultdict(int)
    for s in staff:
        for sk_col in ['Skill1', 'Skill2', 'Skill3', 'Skill4']:
            sk_name = s.get(sk_col, '').strip()
            if sk_name:
                skill_pool[sk_name] += 1

    # Build absence windows: {employee: [(from_date, to_date)]}
    absence_map = defaultdict(list)
    for a in absences:
        emp = a['EMPLOYEE NUMBER'].strip()
        d_from = parse_date(a.get('DATE FROM', ''))
        d_to = parse_date(a.get('DATE TO', ''))
        if d_from and d_to:
            absence_map[emp].append((d_from, d_to))

    # For each ISO week in 2026, count absent staff
    result = {}
    skill_result = {}

    # Generate all Monday dates for 2026
    start = datetime(2026, 1, 5)  # first Monday of 2026
    end = datetime(2026, 12, 28)
    d = start
    while d <= end:
        wk_key = d.strftime('%Y-W%V')
        week_end = d + timedelta(days=4)  # Friday
        absent_emps = set()
        for emp, windows in absence_map.items():
            for (f, t) in windows:
                if f <= week_end and t >= d:
                    absent_emps.add(emp)
                    break
        net = total_staff - len(absent_emps)
        result[wk_key] = net

        # Skill-level: subtract absent staff from their skill pool
        sk = dict(skill_pool)
        for emp_id in absent_emps:
            emp_data = next((s for s in staff if s['EMPLOYEE NUMBER'] == emp_id), None)
            if emp_data:
                for sk_col in ['Skill1', 'Skill2', 'Skill3', 'Skill4']:
                    sk_name = emp_data.get(sk_col, '').strip()
                    if sk_name:
                        sk[sk_name] = max(0, sk.get(sk_name, 0) - 1)
        skill_result[wk_key] = sk
        d += timedelta(weeks=1)

    return result, skill_result


# Pre-compute (cached at module load)
_demand = None
_staff_req = None
_skill_req = None
_staff_avail = None
_skill_avail = None

# Long-term MIP state
_lt_use_optimisation = False   # Toggle: False = baseline, True = MIP
_lt_mip_cache        = None    # Cached MIP result (invalidated on POST reset)


def get_data():
    global _demand, _staff_req, _skill_req, _staff_avail, _skill_avail
    if _demand is None:
        _demand = weekly_demand_2026()
        _staff_req, _skill_req = weekly_staff_required(_demand)
        _staff_avail, _skill_avail = weekly_staff_available()
    return _demand, _staff_req, _skill_req, _staff_avail, _skill_avail


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route('/')
def index():
    return render_template('index.html')


@app.route('/api/long-term/summary')
def lt_summary():
    demand, staff_req, skill_req, staff_avail, skill_avail = get_data()

    all_rows = load_weekly_demand()
    forecast_rows = [r for r in all_rows if r.get('Data_type', '').strip() == 'Forecast']

    # Annual flights 2026
    annual_flights = 0
    monthly_flights = defaultdict(float)
    for r in forecast_rows:
        d = parse_date(r.get('Week_Start', ''))
        if d and d.year == 2026:
            try:
                mv = float(r.get('Weekly_Movements', 0) or 0)
            except:
                mv = 0
            annual_flights += mv
            monthly_flights[d.month] += mv

    avg_weekly = annual_flights / 52 if annual_flights else 0

    peak_month_num = max(monthly_flights, key=monthly_flights.get) if monthly_flights else 7
    peak_month = datetime(2026, peak_month_num, 1).strftime('%B')

    # Peak week
    weekly_flights = defaultdict(float)
    for r in forecast_rows:
        d = parse_date(r.get('Week_Start', ''))
        if d and d.year == 2026:
            try:
                mv = float(r.get('Weekly_Movements', 0) or 0)
            except:
                mv = 0
            wk = d.strftime('%Y-W%V')
            weekly_flights[wk] += mv
    peak_wk = max(weekly_flights, key=weekly_flights.get) if weekly_flights else '2026-W28'

    # Staff utilisation: avg (staff_req / staff_avail) across 2026 weeks
    utils = []
    for wk in staff_req:
        avail = staff_avail.get(wk, 50)
        if avail > 0:
            utils.append(min(staff_req[wk] / avail * 100, 100))
    avg_util = round(sum(utils) / len(utils), 1) if utils else 0

    # Gate utilisation: contact stands can handle ~3 turns/day each
    # gate_util = (avg weekly flights / 2) / (contact_stands × 3 × 7) × 100
    # 142 contact stands from Stands.csv (Pier 1+2+3+4)
    CONTACT_STANDS = 142
    DAILY_TURNS    = 3
    weekly_gate_capacity = CONTACT_STANDS * DAILY_TURNS * 7  # 2,982 turns/week
    gate_util = round((avg_weekly / 2) / weekly_gate_capacity * 100, 1) if weekly_gate_capacity else 0

    return jsonify({
        'annual_flights': int(annual_flights),
        'avg_weekly_flights': round(avg_weekly, 0),
        'peak_month': peak_month,
        'peak_week': peak_wk,
        'staff_utilisation_pct': avg_util,
        'total_staff': len(load_staff()),
        'gate_utilisation_pct': gate_util,
    })


def _build_heatmap_row(wk_key, staff_req, skill_req, staff_avail, demand):
    """Build one heatmap row dict for a given week key."""
    try:
        year_str, w_str = wk_key.split('-W')
        d = datetime.strptime(f'{year_str}-W{int(w_str):02d}-1', '%G-W%V-%u')
    except:
        return None
    req   = staff_req.get(wk_key, 0)
    avail = staff_avail.get(wk_key, 50)
    gap   = round(avail - req, 1)
    util  = round(min(req / avail * 100, 150) if avail > 0 else 100, 1)

    # Per-skill FTE for the week
    skills = skill_req.get(wk_key, {})

    # Per-category flight volumes for the week (raw movements)
    cat_mvmt = {}
    for (cat, status), mvmt in demand.get(wk_key, {}).items():
        cat_mvmt[cat] = round(cat_mvmt.get(cat, 0) + mvmt, 0)

    return {
        'week':         wk_key,
        'week_start':   d.strftime('%d %b'),
        'week_end':     (d + timedelta(days=6)).strftime('%d %b %Y'),
        'month':        d.strftime('%b'),
        'month_num':    d.month,
        'week_in_month': (d.day - 1) // 7,
        'required':     req,
        'available':    avail,
        'gap':          gap,
        'utilisation':  util,
        'skills':       {k: round(v, 1) for k, v in skills.items()},
        'categories':   cat_mvmt,
    }


@app.route('/api/long-term/demand-heatmap')
def lt_demand_heatmap():
    demand, staff_req, skill_req, staff_avail, skill_avail = get_data()
    weeks_data = []
    for wk_key in sorted(staff_req.keys()):
        row = _build_heatmap_row(wk_key, staff_req, skill_req, staff_avail, demand)
        if row:
            weeks_data.append(row)
    return jsonify(weeks_data)


@app.route('/api/long-term/week/<week_key>')
def lt_week_detail(week_key):
    """Detailed data for a single week — drives the week-filter mode in the UI."""
    demand, staff_req, skill_req, staff_avail, skill_avail = get_data()
    row = _build_heatmap_row(week_key, staff_req, skill_req, staff_avail, demand)
    if not row:
        return jsonify({'error': 'Week not found'}), 404

    # Weekly flight movements by (category, status) for a mini breakdown chart
    cat_status = {}
    for (cat, status), mvmt in demand.get(week_key, {}).items():
        cat_status[f'{cat} ({status})'] = round(mvmt, 0)

    # Absent staff this week
    absences = load_absences()
    staff    = load_staff()
    absence_map = defaultdict(list)
    for a in absences:
        emp   = a['EMPLOYEE NUMBER'].strip()
        d_from = parse_date(a.get('DATE FROM', ''))
        d_to   = parse_date(a.get('DATE TO', ''))
        if d_from and d_to:
            absence_map[emp].append((d_from, d_to))
    try:
        year_str, w_str = week_key.split('-W')
        wk_start = datetime.strptime(f'{year_str}-W{int(w_str):02d}-1', '%G-W%V-%u')
    except:
        wk_start = None
    wk_end = wk_start + timedelta(days=4) if wk_start else None

    absent_emps = []
    if wk_start and wk_end:
        for emp, windows in absence_map.items():
            for (f, t) in windows:
                if f <= wk_end and t >= wk_start:
                    emp_data = next((s for s in staff if s['EMPLOYEE NUMBER'] == emp), None)
                    if emp_data:
                        absent_emps.append({
                            'id':    emp,
                            'skill': emp_data.get('Skill1', ''),
                            'leave': next((a['LEAVE TYPE'] for a in absences
                                           if a['EMPLOYEE NUMBER'].strip() == emp), ''),
                        })
                    break

    row['cat_status_breakdown'] = cat_status
    row['absent_staff']         = absent_emps
    row['absent_count']         = len(absent_emps)
    return jsonify(row)


@app.route('/api/long-term/staff-allocation')
def lt_staff_allocation():
    demand, staff_req, skill_req, staff_avail, skill_avail = get_data()

    # Monthly summary by skill
    monthly_skill = defaultdict(lambda: defaultdict(list))
    monthly_total_req = defaultdict(list)
    monthly_total_avail = defaultdict(list)

    req_skill_set = set()
    for wk_key, sk_req in skill_req.items():
        try:
            year_str, w_str = wk_key.split('-W')
            d = datetime.strptime(f'{year_str}-W{int(w_str):02d}-1', '%G-W%V-%u')
        except:
            continue
        month_key = d.strftime('%b %Y')
        for skill, fte in sk_req.items():
            monthly_skill[month_key][skill].append(fte)
            req_skill_set.add(skill)
        monthly_total_req[month_key].append(staff_req.get(wk_key, 0))
        monthly_total_avail[month_key].append(staff_avail.get(wk_key, 50))

    # Also include staff-availability counts for roles only in staff data (not in demand model)
    for wk_key, sk_av in skill_avail.items():
        try:
            year_str, w_str = wk_key.split('-W')
            d = datetime.strptime(f'{year_str}-W{int(w_str):02d}-1', '%G-W%V-%u')
        except:
            continue
        month_key = d.strftime('%b %Y')
        for skill, count in sk_av.items():
            if skill not in req_skill_set:
                monthly_skill[month_key][skill].append(count)

    # Collect all skills from both demand and staff availability data
    all_skill_set = set()
    for wk_sk in skill_req.values():
        all_skill_set.update(wk_sk.keys())
    for wk_sk in skill_avail.values():
        all_skill_set.update(wk_sk.keys())
    PREFERRED_ORDER = [
        'GNIB', 'CBP Pre-clearance', 'Arr Customer Service', 'Check-in/Trolleys',
        'Dep / Trolleys', 'T1/T2 Trolleys L/UL', 'Gate 335', 'Departures',
        'Transfer Corridor', 'Ramp / Marshalling', 'Bussing',
        'PBZ', 'Mezz Operation', 'Litter Picking',
    ]
    skills = [s for s in PREFERRED_ORDER if s in all_skill_set]
    skills += sorted(s for s in all_skill_set if s not in skills)
    months_ordered = []
    d = datetime(2026, 1, 5)
    seen_months = set()
    while d.year == 2026:
        mk = d.strftime('%b %Y')
        if mk not in seen_months:
            seen_months.add(mk)
            months_ordered.append({'key': mk, 'month_num': d.month})
        d += timedelta(weeks=1)

    def avg(lst): return sum(lst) / len(lst) if lst else 0

    # Gate headcount distribution
    # Contact piers handle GNIB, Ramp, Arr CS, Check-in, CBP, fixed posts
    # Remote Apron handles all Bussing FTE
    # Cargo Apron gets a small share of Ramp FTE (cargo movements)
    PIER_STANDS = {
        'Pier 1 (T1)':      41,
        'Pier 2 (T1)':      28,
        'Pier 3 (T1)':      28,
        'Pier 4 (T2)':      45,
    }
    CONTACT_TOTAL = 142
    GATE_ROWS = list(PIER_STANDS.keys()) + ['Remote Apron', 'Cargo Apron']

    result = []
    gate_monthly = {g: [] for g in GATE_ROWS}

    for mo in months_ordered:
        mk = mo['key']
        row = {'month': mk, 'month_num': mo['month_num']}
        for sk in skills:
            vals = monthly_skill[mk].get(sk, [])
            row[sk] = round(avg(vals), 1)
        row['total_required'] = round(avg(monthly_total_req.get(mk, [])), 1)
        row['total_available'] = round(avg(monthly_total_avail.get(mk, [])), 1)
        row['gap'] = round(row['total_available'] - row['total_required'], 1)
        result.append(row)

        # Gate headcount: split non-bussing FTE across contact piers by stand ratio
        bussing_fte  = row.get('Bussing', 0)
        cargo_fte    = row.get('Ramp / Marshalling', 0) * 0.07   # ~7% cargo ramp
        contact_fte  = row['total_required'] - bussing_fte - cargo_fte
        for pier, stands in PIER_STANDS.items():
            gate_monthly[pier].append(round(contact_fte * (stands / CONTACT_TOTAL), 1))
        gate_monthly['Remote Apron'].append(round(bussing_fte, 1))
        gate_monthly['Cargo Apron'].append(round(cargo_fte, 1))

    # Build by_gate: list of {gate, months: [fte per month]}
    by_gate = []
    for g in GATE_ROWS:
        by_gate.append({
            'gate':   g,
            'values': gate_monthly[g],
        })

    return jsonify({'months': result, 'skills': skills, 'by_gate': by_gate, 'gate_rows': GATE_ROWS})


@app.route('/api/long-term/daily-heatmap')
def lt_daily_heatmap():
    """Daily heatmap data for the entire 2026 planning year."""
    demand, staff_req, skill_req, staff_avail, skill_avail = get_data()
    
    skills = [
        'GNIB', 'CBP Pre-clearance', 'Arr Customer Service', 'Check-in/Trolleys',
        'Dep / Trolleys', 'T1/T2 Trolleys L/UL', 'Transfer Corridor',
        'Ramp / Marshalling', 'Bussing', 'PBZ', 'Mezz Operation', 'Litter Picking',
    ]

    # Generate all days for 2026
    start_date = datetime(2026, 1, 1)
    end_date = datetime(2026, 12, 31)
    
    today_str = datetime.now().strftime('%Y-%m-%d')
    days = []
    curr = start_date
    while curr <= end_date:
        # ISO week key
        wk_key = curr.strftime('%Y-W%V')
        iso_str = curr.strftime('%Y-%m-%d')
        
        day_data = {
            'date': iso_str,
            'label': curr.strftime('%d %b'),
            'is_today': iso_str == today_str,
            'values': {}
        }
        
        wk_sk_req = skill_req.get(wk_key, {})
        wk_sk_avail = skill_avail.get(wk_key, {})
        
        day_total_req = 0
        day_total_avail = 0
        
        for sk in skills:
            req = wk_sk_req.get(sk, 0)
            avail = wk_sk_avail.get(sk, 0)
            
            day_total_req += req
            day_total_avail += avail
            
            gap = avail - req
            
            # Status Logic
            if gap < -2.0:
                status = 'gap'
            elif gap < 0:
                status = 'warning'
            elif gap > 1.0:
                status = 'surplus'
            else:
                status = 'adequate'
                
            day_data['values'][sk] = {
                'req': round(req, 1),
                'avail': round(avail, 1),
                'status': status
            }
            
        day_data['totals'] = {
            'req': round(day_total_req, 1),
            'avail': round(day_total_avail, 1),
            'gap': round(day_total_avail - day_total_req, 1)
        }
        
        days.append(day_data)
        curr += timedelta(days=1)
        
    return jsonify({
        'skills': skills,
        'days': days
    })


@app.route('/api/long-term/imbalance')
def lt_imbalance():
    demand, staff_req, skill_req, staff_avail, skill_avail = get_data()

    result = []
    for wk_key in sorted(staff_req.keys()):
        try:
            year_str, w_str = wk_key.split('-W')
            d = datetime.strptime(f'{year_str}-W{int(w_str):02d}-1', '%G-W%V-%u')
        except:
            continue
        req = staff_req[wk_key]
        avail = staff_avail.get(wk_key, 50)
        gap = round(avail - req, 1)
        result.append({
            'week': wk_key,
            'date': d.strftime('%d %b %Y'),
            'month': d.strftime('%b'),
            'required': req,
            'available': avail,
            'gap': gap,
            'status': 'ok' if gap > 0 else ('warning' if gap == 0 else 'critical'),
        })

    return jsonify(result)


@app.route('/api/long-term/skill-breakdown')
def lt_skill_breakdown():
    staff = load_staff()
    absences = load_absences()
    absence_map = defaultdict(list)
    for a in absences:
        emp = a['EMPLOYEE NUMBER'].strip()
        d_from = parse_date(a.get('DATE FROM', ''))
        d_to = parse_date(a.get('DATE TO', ''))
        if d_from and d_to:
            absence_map[emp].append((d_from, d_to))

    # Total staff by all qualified skills
    total_by_skill = defaultdict(int)
    for s in staff:
        for sk_col in ['Skill1', 'Skill2', 'Skill3', 'Skill4']:
            sk_name = s.get(sk_col, '').strip()
            if sk_name:
                total_by_skill[sk_name] += 1

    # Monthly absent days per all qualified skills
    monthly_absent = defaultdict(lambda: defaultdict(int))
    for emp, windows in absence_map.items():
        emp_data = next((s for s in staff if s['EMPLOYEE NUMBER'] == emp), None)
        if not emp_data:
            continue
        
        # Collect all skills for this employee
        emp_skills = []
        for sk_col in ['Skill1', 'Skill2', 'Skill3', 'Skill4']:
            sk_val = emp_data.get(sk_col, '').strip()
            if sk_val:
                emp_skills.append(normalize_skill(sk_val))

        for (f, t) in windows:
            d = f
            while d <= t:
                if d.year == 2026:
                    for sk in emp_skills:
                        monthly_absent[d.strftime('%b %Y')][sk] += 1
                d += timedelta(days=1)

    skills = sorted(total_by_skill.keys())
    return jsonify({
        'total_by_skill': dict(total_by_skill),
        'monthly_absent': {k: dict(v) for k, v in monthly_absent.items()},
        'skills': skills,
    })


@app.route('/api/long-term/flight-trend')
def lt_flight_trend():
    rows = load_weekly_demand()

    # Monthly flights 2025 historical vs 2026 forecast
    monthly = defaultdict(lambda: {'historical': 0, 'forecast': 0})
    for r in rows:
        if not r.get('Season_Code'):
            continue
        d = parse_date(r.get('Week_Start', ''))
        if not d:
            continue
        try:
            mv = float(r.get('Weekly_Movements', 0) or 0)
        except:
            mv = 0
        dtype = r.get('Data_type', '').strip()
        if d.year == 2025 and dtype == 'Historical':
            mk = d.strftime('%b')
            monthly[mk]['historical'] += mv
        elif d.year == 2026 and (dtype == 'Forecast' or
             (dtype == 'Historical' and r.get('Season_Code', '') == 'W25')):
            mk = d.strftime('%b')
            monthly[mk]['forecast'] += mv

    months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
              'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    return jsonify([{
        'month': m,
        'historical': round(monthly[m]['historical'], 0),
        'forecast': round(monthly[m]['forecast'], 0),
    } for m in months])


@app.route('/api/long-term/gap-skill-data')
def lt_merged_gap_skill():
    demand, staff_req, skill_req, staff_avail, skill_avail = get_data()

    # Get all active skills from both req and avail
    all_skills = set()
    for wk in skill_req:
        all_skills.update(skill_req[wk].keys())
    for wk in skill_avail:
        all_skills.update(skill_avail[wk].keys())
    all_skills = sorted(list(all_skills))

    weekly_data = []
    for wk_key in sorted(staff_req.keys()):
        try:
            year_str, w_str = wk_key.split('-W')
            d = datetime.strptime(f'{year_str}-W{int(w_str):02d}-1', '%G-W%V-%u')
        except:
            continue
        
        req_total = staff_req[wk_key]
        avail_total = staff_avail.get(wk_key, 50)
        gap_total = round(avail_total - req_total, 1)

        sk_gaps = {}
        sk_reqs = {}
        sk_avails = {}
        for sk in all_skills:
            s_req = skill_req.get(wk_key, {}).get(sk, 0)
            s_avail = skill_avail.get(wk_key, {}).get(sk, 0)
            sk_gaps[sk] = round(s_avail - s_req, 1)
            sk_reqs[sk] = round(s_req, 1)
            sk_avails[sk] = round(s_avail, 1)

        weekly_data.append({
            'week': wk_key,
            'date': d.strftime('%d %b %Y'),
            'month': d.strftime('%b'),
            'required': req_total,
            'available': avail_total,
            'gap': gap_total,
            'skill_gaps': sk_gaps,
            'skill_reqs': sk_reqs,
            'skill_avails': sk_avails,
            'status': 'ok' if gap_total > 0 else ('warning' if gap_total == 0 else 'critical')
        })

    # Summary by skill (average across all weeks)
    skill_summary = []
    for sk in all_skills:
        gaps = [w['skill_gaps'].get(sk, 0) for w in weekly_data]
        reqs = [w['skill_reqs'].get(sk, 0) for w in weekly_data]
        avails = [w['skill_avails'].get(sk, 0) for w in weekly_data]
        
        avg_gap = round(sum(gaps) / len(gaps), 1) if gaps else 0
        peak_gap = round(max(gaps), 1) if gaps else 0
        min_gap = round(min(gaps), 1) if gaps else 0
        
        avg_req = round(sum(reqs) / len(reqs), 1) if reqs else 0
        avg_avail = round(sum(avails) / len(avails), 1) if avails else 0
        peak_req = round(max(reqs), 1) if reqs else 0
        peak_avail = round(max(avails), 1) if avails else 0

        skill_summary.append({
            'skill': sk,
            'avg_gap': avg_gap,
            'peak_gap': peak_gap,
            'min_gap': min_gap,
            'avg_req': avg_req,
            'avg_avail': avg_avail,
            'peak_req': peak_req,
            'peak_avail': peak_avail,
            'status': 'ok' if avg_gap > 0 else ('warning' if avg_gap == 0 else 'critical')
        })

    # Historical monthly absences (from original skills API)
    staff = load_staff()
    absences = load_absences()
    absence_map = defaultdict(list)
    for a in absences:
        emp = a['EMPLOYEE NUMBER'].strip()
        d_from = parse_date(a.get('DATE FROM', ''))
        d_to = parse_date(a.get('DATE TO', ''))
        if d_from and d_to:
            absence_map[emp].append((d_from, d_to))

    total_by_skill = defaultdict(int)
    for s in staff:
        total_by_skill[s.get('Skill1', '').strip()] += 1

    monthly_absent = defaultdict(lambda: defaultdict(int))
    for emp, windows in absence_map.items():
        emp_data = next((s for s in staff if s['EMPLOYEE NUMBER'] == emp), None)
        if not emp_data: continue
        sk = normalize_skill(emp_data.get('Skill1', '').strip())
        for (f, t) in windows:
            curr = f
            while curr <= t:
                if curr.year == 2026:
                    monthly_absent[curr.strftime('%b %Y')][sk] += 1
                curr += timedelta(days=1)

    return jsonify({
        'weekly': weekly_data,
        'skill_summary': skill_summary,
        'total_by_skill': dict(total_by_skill),
        'monthly_absent': {k: dict(v) for k, v in monthly_absent.items()},
        'skills': all_skills
    })


# ---------------------------------------------------------------------------
# Long-term MIP optimised staffing endpoint
# ---------------------------------------------------------------------------

@app.route('/api/long-term/optimised-staffing', methods=['GET', 'POST'])
def lt_optimised_staffing():
    """MIP-based weekly workforce optimisation.

    GET  — return current result (or prompt to enable).
    POST — toggle optimisation on/off; optionally pass constraints overrides.

    POST body (all optional):
        {
          "use_optimisation": true,        // enable / disable MIP
          "reset": true,                   // clear cached result and re-solve
          "constraints": {
            "surge_demand_factor":        1.0,
            "max_ot_hrs_per_person_per_week": 8,
            "regular_hrs_per_week":       40
          }
        }

    Response shape (when enabled and solved):
        {
          "use_optimisation": true,
          "status": "Optimal",
          "solver": "CBC via PuLP (MIP)",
          "objective_value": 12345.6,
          "summary": { ... aggregate stats ... },
          "weeks": {
            "2026-W01": {
              "total_demand_fte": 42.3,
              "total_available": 48,
              "total_assigned": 41,
              "total_shortage_fte": 1.3,
              "overtime_hrs": 0.0,
              "utilisation_pct": 85.4,
              "gap": 5.7,
              "status_flag": "minor",
              "skills": {
                "GNIB": {
                  "demand_fte": 12.5, "available": 18,
                  "assigned": 12, "shortage_fte": 0.5,
                  "excess_fte": 0.0, "coverage_pct": 96.0
                }, ...
              }
            }, ...
          }
        }
    """
    global _lt_use_optimisation, _lt_mip_cache

    if request.method == 'POST':
        body = request.get_json(force=True) or {}

        # Toggle
        if 'use_optimisation' in body:
            _lt_use_optimisation = bool(body['use_optimisation'])

        # Invalidate cache on reset or when constraints change
        if body.get('reset') or 'constraints' in body or 'use_optimisation' in body:
            _lt_mip_cache = None

        # Store per-request constraint overrides in the body for use below
        _lt_extra_constraints = body.get('constraints', {})
    else:
        _lt_extra_constraints = {}

    # --- Status: disabled ---
    if not _lt_use_optimisation:
        return jsonify({
            'use_optimisation': False,
            'mip_available':    _LT_MIP_AVAILABLE,
            'message': (
                'MIP optimisation is disabled. '
                'POST {"use_optimisation": true} to enable.'
            ),
            # Include the baseline demand/availability for comparison
            'baseline': _lt_baseline_summary(),
        })

    # --- Status: solver unavailable ---
    if not _LT_MIP_AVAILABLE:
        return jsonify({
            'use_optimisation': True,
            'mip_available':    False,
            'error': 'No MIP solver available.',
            'message': 'Install PuLP:  pip install pulp',
        }), 503

    # --- Solve (or return cached result) ---
    if _lt_mip_cache is None:
        demand, staff_req, skill_req, staff_avail, skill_avail = get_data()
        try:
            _lt_mip_cache = _lt_mip_optimize(
                skill_req, staff_req,
                skill_avail, staff_avail,
                _lt_extra_constraints or None,
            )
            print(
                f"[MIP] {_lt_mip_cache['status']}  "
                f"obj={_lt_mip_cache['objective_value']}  "
                f"shortage={_lt_mip_cache['summary'].get('total_shortage_fte', '?')} FTE"
            )
        except Exception as exc:
            return jsonify({'error': str(exc), 'use_optimisation': True}), 500

    return jsonify(_lt_mip_cache)


@app.route('/api/long-term/optimisation-status', methods=['GET'])
def lt_optimisation_status():
    """Quick status check: is MIP enabled, available, and what does it report."""
    return jsonify({
        'use_optimisation': _lt_use_optimisation,
        'mip_available':    _LT_MIP_AVAILABLE,
        'result_cached':    _lt_mip_cache is not None,
        'solver_status':    _lt_mip_cache.get('status')  if _lt_mip_cache else None,
        'objective_value':  _lt_mip_cache.get('objective_value') if _lt_mip_cache else None,
        'summary':          _lt_mip_cache.get('summary') if _lt_mip_cache else None,
    })


def _lt_baseline_summary():
    """Return a lightweight baseline summary for comparison in the disabled-state response."""
    try:
        _, staff_req, skill_req, staff_avail, _ = get_data()
        weeks = sorted(staff_req.keys())
        if not weeks:
            return {}
        total_short = sum(
            max(staff_req[w] - staff_avail.get(w, 0), 0) for w in weeks
        )
        weeks_short = sum(
            1 for w in weeks if staff_req[w] > staff_avail.get(w, 0)
        )
        return {
            'method':               'demand_estimation_baseline',
            'total_shortage_fte':   round(total_short, 1),
            'weeks_with_shortage':  weeks_short,
            'total_weeks':          len(weeks),
        }
    except Exception:
        return {}


# ---------------------------------------------------------------------------
# Route Map API
# ---------------------------------------------------------------------------

def _get_map_data_from_flights(flights_list):
    """Aggregates arrivals and departures by airport code."""
    res = {
        'arrivals': defaultdict(int),
        'departures': defaultdict(int)
    }
    for f in flights_list:
        code = f.get('origin_code', '').strip()
        status = f.get('Status', '').strip()
        if not code or code == 'DUB':
            continue
        if status == 'Arrival':
            res['arrivals'][code] += 1
        elif status == 'Departure':
            res['departures'][code] += 1
    
    # Convert to standard dict for jsonify
    return {
        'arrivals': dict(res['arrivals']),
        'departures': dict(res['departures'])
    }

@app.route('/api/map-data/long-term')
def map_data_long_term():
    """Returns aggregated route counts for the entire 4-day schedule as a representative network."""
    flights = read_csv_flights()
    return jsonify(_get_map_data_from_flights(flights))

@app.route('/api/map-data/short-term/<date_str>')
def map_data_short_term(date_str):
    """Returns route counts for a specific date."""
    # Convert date_str (YYYY-MM-DD or DD-MMM-YY) to DD-MMM-YY for CSV match
    d = None
    for fmt in ('%Y-%m-%d', '%d-%b-%y', '%d-%b-%Y', '%d-%m-%y'):
        try:
            d = datetime.strptime(date_str.strip(), fmt)
            break
        except ValueError:
            pass
    if not d:
        return jsonify({'error': 'Invalid date'}), 400
    
    target_date = d.strftime('%d-%b-%y')
    flights = [f for f in read_csv_flights() if f.get('date') == target_date]
    return jsonify(_get_map_data_from_flights(flights))

@app.route('/api/map-data/intraday')
def map_data_intraday():
    """Returns route counts for today (hardcoded to 13-Apr-26 in this project)."""
    target_date = '13-Apr-26'
    flights = [f for f in read_csv_flights() if f.get('date') == target_date]
    return jsonify(_get_map_data_from_flights(flights))


# ===========================================================================
# SHORT-TERM & INTRADAY OPTIMISATION
# ===========================================================================

TASK_SKILL = {
    # New Config.csv task names
    'GNIB':                  'GNIB',
    'Gate 335':              'GNIB',
    'Departures':            'GNIB',
    'Dep/Trolleys':          'Bussing',
    # Legacy / alternate spellings kept for backward compat
    'GNIB / Immigration':    'GNIB',
    'CBP Pre-clearance':     'CBP Pre-clearance',
    'Ramp / Marshalling':    'GNIB',
    'Bussing':               'Bussing',
    'Transfer Corridor':     'GNIB',
    'Check-in/Trolleys':     'GNIB',
    'Dep / Trolleys':        'Bussing',
    'Arr Customer Service':  'GNIB',
    'Mezz Operation':        'Mezz Operation',
    'Litter Picking':        'Litter Picking',
    'PBZ':                   'PBZ',
    'T1/T2 Trolleys L/UL':   'Bussing',
}

# ---------------------------------------------------------------------------
# Task sharing classification
#
# SHARED        — One pool of staff covers ALL flights that share the same
#                 terminal, pier, and 30-minute time-bucket.  These are
#                 area-based duties: the officer handles all passengers in the
#                 zone, regardless of which individual aircraft they arrived on.
#
# PARTIALLY_SHARED — Staff can be shared across concurrent flights but headcount
#                 scales with the combined passenger volume in the window.
#                 Thresholds are defined in PARTIAL_SHARE_PAX_THRESHOLDS.
#
# DEDICATED     — Every flight requires its own dedicated staff member(s).
#                 Ramp marshalling is aircraft-specific; bussing is bus-specific.
# ---------------------------------------------------------------------------

TASK_SHARED = frozenset({
    'GNIB / Immigration',
    'CBP Pre-clearance',    # session-level handled separately; included for completeness
    'Transfer Corridor',
    'Arr Customer Service',
    'Mezz Operation',
    'Litter Picking',
    'T1/T2 Trolleys L/UL',
})

TASK_PARTIALLY_SHARED = frozenset({
    'Check-in/Trolleys',
    'Dep / Trolleys',
    'PBZ',
})

TASK_DEDICATED = frozenset({
    'Ramp / Marshalling',
    'Bussing',
})

# Approximate seated-pax capacity by ICAO wake-turbulence category.
# Used to estimate passenger volume when the flights CSV has no pax column.
PAX_BY_ICAO = {
    'A': 50,    # light piston / turboprop
    'B': 150,   # narrow-body small  (A319, B737-700)
    'C': 180,   # narrow-body large  (A321, B757)
    'D': 280,   # wide-body medium   (B767, A330-200)
    'E': 350,   # wide-body large    (B777, A340)
    'F': 450,   # super-heavy        (B747, A380)
}
PAX_DEFAULT = 150   # fallback for unknown ICAO category

# Partially-shared staffing thresholds: (min_pax_inclusive, max_pax_exclusive, staff_count).
# staff_count is the number needed for the *whole group* in that time-window.
PARTIAL_SHARE_PAX_THRESHOLDS = [
    (0,   200, 1),
    (200, 400, 2),
    (400, float('inf'), 3),
]

# Width of the time-bucket (minutes) used to decide whether flights are
# "concurrent" for sharing purposes.  Configurable here; used throughout.
SHARING_WINDOW_MINS: int = 30

# Module-level state
_config_rules = None
_stands_map = None
_intraday_overrides = {}   # {flight_no: {delay_mins: int, cancelled: bool}}
_manual_assigns = {}       # {date_key: {task_id: [extra_staff_ids]}}
_intraday_custom_constraints = {
    'permitted_shifts': [
        (0, 720, 'Day'),
        (720, 1440, 'Night')
    ],
    'use_cpsat': False,   # Set True to engage the CP-SAT optimiser
}

_st_custom_constraints = {
    'permitted_shifts': [
        (0, 720, 'Day'),
        (720, 1440, 'Night')
    ]
}


# ---------------------------------------------------------------------------
# Helper functions
# ---------------------------------------------------------------------------

def read_csv_flights():
    """Read Flights_schedule_4days.csv with cp1252 encoding, strip \xa0 from all values."""
    path = os.path.join(BASE_DIR, 'data', 'Flights_schedule_4days.csv')
    with open(path, encoding='cp1252') as f:
        reader = csv.DictReader(f)
        rows = []
        for row in reader:
            clean = {k: v.replace('\xa0', '').strip() for k, v in row.items()}
            if any(clean.values()):
                rows.append(clean)
    return rows


def parse_time(s):
    """Convert 'H:MM' or 'HH:MM' to minutes since midnight. Return None if invalid."""
    if not s:
        return None
    s = s.strip().replace('\xa0', '')
    try:
        parts = s.split(':')
        if len(parts) != 2:
            return None
        h, m = int(parts[0]), int(parts[1])
        return h * 60 + m
    except (ValueError, AttributeError):
        return None


def mins_to_time(m):
    """Convert minutes to 'HH:MM' string, wrapping around midnight."""
    m = int(m) % 1440
    return f'{m // 60:02d}:{m % 60:02d}'


def icao_to_haul(icao_cat, cbp_flag):
    """Return haul type from ICAO category and CBP flag."""
    if str(cbp_flag).strip().upper() == 'TRUE':
        return 'US/Canada'
    cat = str(icao_cat).strip().upper()
    if cat in ('B', 'C'):
        return 'Short'
    if cat in ('D', 'E'):
        return 'Long'
    return 'Short'  # default


def load_config_rules():
    """Parse Config.csv (new multi-column format) and cache in _config_rules.

    Columns: Task, Terminal 1, Terminal 2, Pier 1-4, Priority,
             Short Haul, Long Haul, Arrival, Departure,
             Max Staff Count, Dependent on Flights/Terminal
    """
    global _config_rules
    if _config_rules is not None:
        return _config_rules
    path = os.path.join(BASE_DIR, 'data', 'Config.csv')
    with open(path, encoding='utf-8-sig') as f:
        rows = list(csv.DictReader(f))
    rules = []
    for r in rows:
        task = r.get('Task', '').strip()
        if not task:
            continue

        def _yes(col):
            return r.get(col, '').strip().lower() == 'yes'

        applicable_terminals = []
        if _yes('Terminal 1'): applicable_terminals.append('T1')
        if _yes('Terminal 2'): applicable_terminals.append('T2')

        applicable_piers = []
        if _yes('Pier 1'): applicable_piers.append('P1')
        if _yes('Pier 2'): applicable_piers.append('P2')
        if _yes('Pier 3'): applicable_piers.append('P3')
        if _yes('Pier 4'): applicable_piers.append('P4')

        count_raw = r.get('Max Staff Count', '1').strip()
        try:
            import math as _math
            max_staff_count = max(1, _math.ceil(float(count_raw)))
        except (ValueError, TypeError):
            max_staff_count = 1

        rules.append({
            'task':                   task,
            'applicable_terminals':   applicable_terminals,
            'applicable_piers':       applicable_piers,
            'priority':               r.get('Priority', 'Medium').strip(),
            'applies_to_short_haul':  _yes('Short Haul'),
            'applies_to_long_haul':   _yes('Long Haul'),
            'applies_to_arrivals':    _yes('Arrival'),
            'applies_to_departures':  _yes('Departure'),
            'max_staff_count':        max_staff_count,
            'scope':                  r.get('Dependent on Flights/Terminal', 'All Flights').strip(),
        })
    _config_rules = rules
    return _config_rules


def _infer_terminal(gate: str) -> str:
    """Best-effort terminal inference from a gate/stand identifier.

    Checks for explicit 'T2' token; everything else defaults to 'T1'.
    """
    g = gate.upper()
    if 'T2' in g:
        return 'T2'
    return 'T1'


def _infer_pier(gate: str) -> str:
    """Best-effort pier inference from a gate/stand identifier.

    Handles common naming conventions:
      • Explicit token  : 'P1-101', 'PIER2', 'T1-P3-22'
        → captures the single digit immediately after P/PIER
      • Three-digit gate: leading digit → pier  (e.g. '101' → P1, '204' → P2)
      • Single-letter   : 'A…' → P1, 'B…' → P2, 'C…' → P3, 'D…' → P4
    Defaults to 'P1' when no pattern matches.
    """
    g = gate.upper().replace(' ', '').replace('-', '')
    # Match 'P' or 'PIER' followed by a SINGLE digit (pier numbers are 1-9).
    # No lookahead needed — we only want the first digit after the P token.
    m = re.search(r'P(?:IER)?(\d)', g)
    if m:
        return f'P{m.group(1)}'
    # Three-or-more digit gate number: first digit is the pier
    m = re.match(r'[A-Z]*(\d)(\d{2,})', g)
    if m:
        return f'P{m.group(1)}'
    # Single letter prefix A-D maps to P1-P4
    m = re.match(r'([A-D])\d+', g)
    if m:
        return f'P{ord(m.group(1)) - ord("A") + 1}'
    return 'P1'


_PIER_NORM = {'1': 'P1', '2': 'P2', '3': 'P3', '4': 'P4'}

def _norm_pier_value(p: str) -> str:
    """Normalise Stands.csv pier values ('1'-'4') to 'P1'-'P4'.
    Non-numeric labels (North, Central …) are returned unchanged.
    """
    return _PIER_NORM.get(p, p)


def get_stands_map():
    """Return {stand_id: {'type': str, 'terminal': str, 'pier': str}}, cached.

    Reads Stands.csv.  Pier values are normalised: '1'→'P1', '2'→'P2', etc.
    so they match the 'P1'-'P4' format used in Config.csv rules.
    """
    global _stands_map
    if _stands_map is not None:
        return _stands_map
    path = os.path.join(BASE_DIR, 'data', 'Stands.csv')
    with open(path, encoding='utf-8-sig') as f:
        rows = list(csv.DictReader(f))
    _stands_map = {}
    for r in rows:
        sid   = r.get('stand_id', '').strip()
        stype = r.get('stand_type', '').strip() or 'Contact'
        term  = (r.get('terminal', '') or r.get('Terminal', '')).strip()
        pier  = (r.get('pier',     '') or r.get('Pier',     '')).strip()
        if sid:
            raw_pier = pier or _infer_pier(sid)
            _stands_map[sid] = {
                'type':     stype,
                'terminal': term or _infer_terminal(sid),
                'pier':     _norm_pier_value(raw_pier),
            }
    return _stands_map


def get_staff_for_date(date_str, custom_constraints=None, use_roster_optimiser=False,
                       demand_windows=None, prev_shift_ends=None):
    """Return (on_duty_list, absent_list) for the given date string.

    When use_roster_optimiser=True the two-phase roster engine is used to
    assign staff to optimal shift patterns instead of the density heuristic.
    The caller may supply pre-built demand_windows (list[DemandWindow]) and
    prev_shift_ends ({staff_id: shift_end_mins}) for the rest-rule check.
    Both default to empty / auto-derived when omitted.
    """
    if custom_constraints is None:
        custom_constraints = {}
    
    leave_types_excluded = custom_constraints.get('leave_types_excluded', ['Annual Leave', 'Paternity Leave', 'Jury Duty', 'Sick Leave', 'Training'])
    shift_duration_hrs = int(custom_constraints.get('shift_duration_hrs', 12))
    shift_duration_mins = shift_duration_hrs * 60
    # Parse date_str
    d = None
    for fmt in ('%Y-%m-%d', '%d-%b-%y', '%d-%m-%Y', '%d-%m-%y', '%d-%m-%Y'):
        try:
            d = datetime.strptime(date_str.strip(), fmt)
            break
        except ValueError:
            pass
    if d is None:
        return [], []

    # Staff CSV can use DD-MM-YYYY (4-digit) or DD-MM-YY (2-digit)
    staff_date_key_full = d.strftime('%d-%m-%Y') 
    staff_date_key_short = d.strftime('%d-%m-%y')

    # Load staff schedule
    path_staff = os.path.join(BASE_DIR, 'data', 'Staff_schedule.csv')
    with open(path_staff, encoding='utf-8-sig') as f:
        staff_rows = list(csv.DictReader(f))

    # Load absences
    path_abs = os.path.join(BASE_DIR, 'data', 'Staff_absence_schedule.csv')
    with open(path_abs, encoding='utf-8-sig') as f:
        abs_rows = list(csv.DictReader(f))

    # Build absent_set
    absent_set = {}
    for a in abs_rows:
        emp_id = a.get('EMPLOYEE NUMBER', '').strip()
        if not emp_id:
            continue
        d_from_raw = a.get('DATE FROM', '').strip()
        d_to_raw = a.get('DATE TO', '').strip()
        d_from = parse_date(d_from_raw)
        d_to = parse_date(d_to_raw)
        if d_from and d_to and d_from <= d <= d_to:
            leave_type = a.get('LEAVE TYPE', '').strip()
            if leave_type in leave_types_excluded:
                absent_set[emp_id] = leave_type

    # Filter staff for this date
    day_staff = [r for r in staff_rows
                 if (r.get('DATE', '').strip() == staff_date_key_full or r.get('DATE', '').strip() == staff_date_key_short)
                 and r.get('EMPLOYEE NUMBER', '').strip()]

    on_duty = []
    absent_staff = []

    # Shift duration in minutes
    shift_duration_hrs = int(custom_constraints.get('shift_duration_hrs', 12))
    shift_duration_mins = shift_duration_hrs * 60

    # Permitted shifts from constraints
    sh_options = custom_constraints.get('permitted_shifts')

    # ── Density-based shift allocation ──────────────────────────────────────
    # Only allocate shifts WHEN THERE ARE FLIGHTS.
    # Empty 1.5-hour windows are excluded from candidates entirely.
    # Busier windows attract proportionally more staff.
    density_shifts = None
    if not sh_options:
        try:
            flt_path     = os.path.join(BASE_DIR, 'data', 'Flights_schedule_4days.csv')
            flt_date_key = d.strftime('%d-%b-%y')
            flight_times = []
            with open(flt_path, encoding='cp1252') as ff:
                for row in csv.DictReader(ff):
                    clean = {k: v.replace('\xa0', '').strip() for k, v in row.items()}
                    if clean.get('date', '') == flt_date_key:
                        t = parse_time(clean.get('sta', ''))
                        if t is not None:
                            flight_times.append(t)

            # 1.5-hour blocks: 0..15
            # block_density now stores WEIGHTED demand (proxy for FTE)
            block_density = [0.0] * 16
            with open(flt_path, encoding='cp1252') as ff:
                for row in csv.DictReader(ff):
                    clean = {k: v.replace('\xa0', '').strip() for k, v in row.items()}
                    if clean.get('date', '') == flt_date_key:
                        t = parse_time(clean.get('sta', ''))
                        if t is not None:
                            # Proxy for task demand: higher weight for larger aircraft categories
                            # Cat C (~1.0), Cat E (~2.0), Cat F (~3.0)
                            cat = clean.get('icao_cat', 'C').upper()
                            weight = 1.0
                            if cat == 'D':   weight = 1.5
                            elif cat == 'E': weight = 2.0
                            elif cat == 'F': weight = 3.0
                            
                            block_density[min(15, int(t) // 90)] += weight

            # Find the span of active blocks
            active_blocks = [bi for bi, cnt in enumerate(block_density) if cnt > 0]

            if active_blocks:
                # Build candidates ONLY for requested start timings
                # Mandatory shift start timings: 00:00, 3:00, 7:00, 12:00
                requested_starts = [0, 180, 420, 720]
                candidates = []
                for s_start in requested_starts:
                    s_end = min(1440, s_start + shift_duration_mins)
                    
                    # Coverage = weighted flights in the duration of this shift
                    bi_start = s_start // 90
                    bi_end = (s_end - 1) // 90
                    coverage = sum(block_density[j] for j in range(bi_start, min(16, bi_end + 1)))
                    
                    if coverage == 0:
                        continue
                        
                    candidates.append({
                        'start':   s_start,
                        'end':     s_end,
                        'label':   f"{mins_to_time(s_start)}\u2013{mins_to_time(s_end)}",
                        'density': coverage,
                    })

                if candidates:
                    total_density = sum(c['density'] for c in candidates)
                    n_staff_count = len(day_staff)
                    density_shifts = []
                    # Proportionally allocate staff based on weighted demand
                    for cand in sorted(candidates, key=lambda x: -x['density']):
                        n_alloc = max(0, round(n_staff_count * cand['density'] / total_density))
                        for _ in range(n_alloc):
                            density_shifts.append((cand['start'], cand['end'], cand['label']))

                    # Pad/Trim to exactly n_staff_count (use busiest shift)
                    best = max(candidates, key=lambda x: x['density'])
                    while len(density_shifts) < n_staff_count:
                        density_shifts.append((best['start'], best['end'], best['label']))
                    density_shifts = density_shifts[:n_staff_count]
        except Exception:
            density_shifts = None


    # Current Day
    for i, r in enumerate(day_staff):
        emp_id = r.get('EMPLOYEE NUMBER', '').strip()
        skill1 = r.get('Skill1', '').strip()
        skill2 = r.get('Skill2', '').strip()
        skill3 = r.get('Skill3', '').strip()
        skill4 = r.get('Skill4', '').strip()
        employment = r.get('EMPLOYMENT TYPE', '').strip()

        if emp_id in absent_set:
            absent_staff.append({'id': emp_id, 'skill1': skill1, 'leave_type': absent_set[emp_id], 'absent': True})
            continue

        if sh_options and len(sh_options) > 0:
            sh_data = sh_options[i % len(sh_options)]
            st, en, lb = sh_data[0], sh_data[1], sh_data[2]
        elif density_shifts:
            # Use the density-optimised shift for this staff member's position
            idx = min(i, len(density_shifts) - 1)
            st, en, lb = density_shifts[idx]
        else:
            # Hard fallback: round-robin across the requested shift starts
            sys_defaults = [
                (0,   720,  '00:00'),
                (180, 900,  '03:00'),
                (420, 1140, '07:00'),
                (720, 1440, '12:00'),
            ]
            st, en, lb = sys_defaults[i % len(sys_defaults)]


        on_duty.append({
            'id': emp_id, 
            'skill1': skill1, 'skill2': skill2, 'skill3': skill3, 'skill4': skill4,
            'employment': employment, 'shift': lb.upper().replace(' SHIFT',''),
            'shift_start': st, 'shift_end': en,
            'shift_label': f"{lb} {mins_to_time(st)}–{mins_to_time(en)}",
            'assignments': [], 'breaks': [], 'utilisation_pct': 0
        })

    # ── Roster optimiser path ────────────────────────────────────────────────
    # Replace the density-heuristic shift labels with optimiser-assigned patterns.
    if use_roster_optimiser and _ROSTER_AVAILABLE and on_duty:
        try:
            dw_list  = demand_windows or []
            pe_map   = prev_shift_ends or {}
            use_mip  = custom_constraints.get('use_mip', True)

            roster_result = _roster_generate(
                demand_windows  = dw_list,
                staff_list      = [
                    {
                        'id':         s['id'],
                        'skill1':     s.get('skill1', ''),
                        'skill2':     s.get('skill2', ''),
                        'skill3':     s.get('skill3', ''),
                        'skill4':     s.get('skill4', ''),
                        'employment': s.get('employment', ''),
                    }
                    for s in on_duty
                ],
                constraints     = {
                    'b1_duration_mins': custom_constraints.get('b1_duration_mins', 30),
                    'b2_duration_mins': custom_constraints.get('b2_duration_mins', 60),
                    'max_shift_mins':   custom_constraints.get('shift_duration_hrs', 12) * 60,
                    'min_rest_mins':    custom_constraints.get('min_rest_mins', 660),
                    'permitted_starts': [0, 180, 420, 720],
                },
                prev_shift_ends = pe_map,
                use_mip         = use_mip,
            )

            # Merge optimiser assignments back onto the on_duty list
            optimised_lookup = {e['id']: e for e in roster_result.get('roster', [])}
            merged = []
            for s in on_duty:
                oe = optimised_lookup.get(s['id'])
                if oe and oe.get('pattern_id') != 'unassigned':
                    s = dict(s)
                    s['shift']          = oe['shift_label'].upper()[:12]
                    s['shift_start']    = oe['shift_start']
                    s['shift_end']      = oe['shift_end']
                    s['shift_label']    = oe['shift_label']
                    s['breaks']         = oe.get('breaks', [])
                    s['utilisation_pct'] = oe.get('utilisation_pct', 0)
                    s['pattern_id']     = oe.get('pattern_id', '')
                    s['skill_match']    = oe.get('skill_match', '')
                merged.append(s)
            on_duty = merged

            # Attach top-level roster metadata for callers that inspect it
            on_duty._roster_meta = roster_result  # type: ignore[attr-defined]
        except Exception as _exc:
            import logging
            logging.getLogger(__name__).warning(
                "Roster optimiser failed — falling back to density heuristic: %s", _exc
            )

    return on_duty, absent_staff


def schedule_breaks(staff, assigned_windows, custom_constraints=None):
    """Schedule mandatory rest breaks respecting these exact rules:

      1. A break MUST occur after every 3 hours (180 min) of continuous work.
      2. No break may start earlier than shift_start + 180 min (3 hours).
      3. The gap between the END of break-1 and the START of break-2 must
         be at least 3 hours (180 min).
      4. Maximum 2 breaks per shift.
      5. Break durations: Break-1 = b1_duration_mins (default 30),
                          Break-2 = b2_duration_mins (default 60).
      6. Breaks are placed in the first free gap at or after the mandatory
         trigger; last-resort fallback still respects the 3-hour minimum.
    """
    shift_start = staff['shift_start']
    shift_end   = staff['shift_end']

    if custom_constraints is None:
        custom_constraints = {}
    b1_dur          = int(custom_constraints.get('b1_duration_mins', 30))
    b2_dur          = int(custom_constraints.get('b2_duration_mins', 60))
    break_durations = [b1_dur, b2_dur]
    break_types     = ['Short Break', 'Meal Break']
    MAX_BREAKS      = 2
    WORK_LIMIT      = 180   # continuous work limit before break is mandatory
    BREAK_GAP       = 180   # minimum gap between end of one break and start of next

    # ─ Helper ───────────────────────────────────────────────────
    def find_free_slot(duration, search_start, search_end, busy_sorted):
        """Return start of first contiguous free window of `duration` mins, or None."""
        t       = max(search_start, shift_start)
        end_cap = min(search_end, shift_end - duration)
        while t + duration <= end_cap:
            conflict = False
            for (ws, we) in busy_sorted:
                if t < we and t + duration > ws:
                    conflict = True
                    t = max(t + 1, we)
                    break
            if not conflict:
                return t
        return None

    busy = sorted(assigned_windows)

    # ─ Step 1: Detect trigger points from continuous-work analysis ──────────
    # Walk the sorted busy windows; accumulate work time and record a trigger
    # each time we cross WORK_LIMIT minutes of uninterrupted work.
    trigger_points = []
    cum_work   = 0
    last_event = shift_start

    for (ws, we) in busy:
        ws = max(ws, shift_start)
        we = min(we, shift_end)
        if we <= ws:
            continue
        if ws > last_event:          # idle gap → reset continuous counter
            cum_work = 0
        cum_work  += we - ws
        if cum_work >= WORK_LIMIT:
            trigger_points.append(we)
            cum_work = 0
        last_event = we

    # Fallback: no triggers but shift is long → place one midshift trigger
    shift_dur = (shift_end - shift_start) % 1440 or 1440
    if not trigger_points and shift_dur >= WORK_LIMIT:
        trigger_points.append(shift_start + WORK_LIMIT)

    trigger_points = trigger_points[:MAX_BREAKS]

    # ─ Step 2: Place breaks, enforcing the 3-hour inter-break gap ──────────
    breaks       = []
    earliest_b2  = None   # will be set to break1_end + BREAK_GAP after B1

    for i, trigger in enumerate(trigger_points):
        if len(breaks) >= MAX_BREAKS:
            break

        dur   = break_durations[i] if i < len(break_durations) else b1_dur
        btype = break_types[i]     if i < len(break_types)     else 'Break'

        # Include previously placed breaks in busy list so we avoid overlap
        cur_busy = sorted(busy + [(b['start_mins'], b['end_mins']) for b in breaks])

        # For break-2 onwards, the search must not start before earliest_b2
        search_from = trigger
        if i > 0 and earliest_b2 is not None:
            search_from = max(trigger, earliest_b2)

        # Earliest the FIRST break may start: at least 3 hours into the shift.
        # All subsequent breaks already respect earliest_b2 (break_end + 180).
        earliest_b1 = shift_start + WORK_LIMIT
        search_from = max(search_from, earliest_b1) if i == 0 else search_from

        # Try right after trigger (within 90-min window), then anywhere in shift
        b_start = (
            find_free_slot(dur, search_from, search_from + 90, cur_busy)
            or find_free_slot(dur, search_from, shift_end - dur, cur_busy)
            or (find_free_slot(dur, earliest_b1, shift_end - dur, cur_busy) if i == 0 else None)
        )

        if b_start is not None:
            b_end = b_start + dur
            breaks.append({
                'start_mins': b_start,
                'end_mins':   b_end,
                'start':      mins_to_time(b_start),
                'end':        mins_to_time(b_end),
                'type':       btype,
            })
            # Next break may not start before break_end + BREAK_GAP
            earliest_b2 = b_end + BREAK_GAP

    return sorted(breaks, key=lambda b: b['start_mins'])



# ---------------------------------------------------------------------------
# Task-generation helper — applies sharing logic before greedy assignment
# ---------------------------------------------------------------------------

def _stand_info(gate: str, stands_map: dict) -> dict:
    """Return the stand info dict for a gate, with safe defaults."""
    info = stands_map.get(gate)
    if isinstance(info, dict):
        return info
    # Fallback: old-format string value or missing entry
    stype = info if isinstance(info, str) else 'Contact'
    return {
        'type':     stype,
        'terminal': _infer_terminal(gate),
        'pier':     _infer_pier(gate),
    }


def _pax_for_icao(icao_cat: str) -> int:
    """Estimate pax count from ICAO wake-turbulence category."""
    return PAX_BY_ICAO.get(icao_cat.strip().upper(), PAX_DEFAULT)


def _partial_staff_count(total_pax: int) -> int:
    """Return staff count for a partially-shared task given combined pax volume."""
    for pax_lo, pax_hi, count in PARTIAL_SHARE_PAX_THRESHOLDS:
        if pax_lo <= total_pax < pax_hi:
            return count
    return PARTIAL_SHARE_PAX_THRESHOLDS[-1][2]


def _generate_day_tasks(processed_flights: list, rules: list, stands_map: dict,
                        window_mins: int = SHARING_WINDOW_MINS) -> list:
    """Generate all per-day tasks driven by Config.csv rules.

    Each rule carries: task, applicable_terminals, applicable_piers, scope,
    applies_to_short_haul, applies_to_long_haul, applies_to_arrivals,
    applies_to_departures, max_staff_count, priority.

    Scope:
      'Terminal'    -> one pooled 1.5-hour block per (terminal, block_idx, direction)
      'All Flights' -> one pooled 1.5-hour block per (terminal, pier, block_idx, direction)
      'US Flights'  -> like 'All Flights' but haul must be 'US/Canada'
      'Fixed'       -> handled in optimize_day() -- skipped here
    """
    import math as _math

    # Pax-based staffing ratios: {task_name: (pax_per_staff, min_staff)}
    PAX_RATIOS = {
        "GNIB":                 (300, 2),
        "T1/T2 Trolleys L/UL":  (500, 1),
        "Dep/Trolleys":         (500, 1),
        "Dep / Trolleys":       (500, 1),
        "Check-in/Trolleys":    (400, 1),
        "Arr Customer Service": (400, 1),
        "Transfer Corridor":    (500, 1),
        "PBZ":                  (400, 1),
        "CBP Pre-clearance":    (300, 1),
    }

    # terminal_blocks key: (terminal, block_idx, direction, task_name)
    terminal_blocks = defaultdict(lambda: {"pax": 0, "flights": [], "rule": None})
    # flight_blocks key:  (terminal, pier, block_idx, direction, task_name)
    flight_blocks   = defaultdict(lambda: {"pax": 0, "flights": [], "rule": None})

    for flight in processed_flights:
        fn        = flight["flight_no"]
        t_mins    = flight["time_mins"]
        status    = flight["status"]
        haul      = flight["haul"]
        gate      = flight["gate"]
        icao_cat  = flight["icao_cat"]

        si        = _stand_info(gate, stands_map)
        terminal  = si["terminal"]
        pier      = si["pier"]

        block_idx = t_mins // 90
        direction = "ARR" if status == "Arrival" else "DEP"
        pax       = _pax_for_icao(icao_cat)

        is_short  = haul == "Short"
        is_long   = haul in ("Long", "US/Canada")
        is_us     = haul == "US/Canada"

        for rule in rules:
            scope = rule["scope"]
            if scope == "Fixed":
                continue

            if terminal not in rule["applicable_terminals"]:
                continue
            if pier not in rule["applicable_piers"]:
                continue

            if status == "Arrival"   and not rule["applies_to_arrivals"]:
                continue
            if status == "Departure" and not rule["applies_to_departures"]:
                continue

            haul_flagged = rule["applies_to_short_haul"] or rule["applies_to_long_haul"]
            if haul_flagged:
                if not ((rule["applies_to_short_haul"] and is_short) or
                        (rule["applies_to_long_haul"]  and is_long)):
                    continue

            if scope == "US Flights" and not is_us:
                continue

            task_name = rule["task"]

            if scope == "Terminal":
                key = (terminal, block_idx, direction, task_name)
                d = terminal_blocks[key]
                d["pax"] += pax
                if fn not in d["flights"]:
                    d["flights"].append(fn)
                d["rule"] = rule
            else:
                key = (terminal, pier, block_idx, direction, task_name)
                d = flight_blocks[key]
                d["pax"] += pax
                if fn not in d["flights"]:
                    d["flights"].append(fn)
                d["rule"] = rule

    all_tasks = []

    # Terminal-scope block tasks
    for (terminal, block_idx, direction, task_name), data in terminal_blocks.items():
        if not data["flights"]:
            continue
        rule      = data["rule"]
        total_pax = data["pax"]
        fns       = data["flights"]
        blk_start = block_idx * 90
        blk_end   = min(1440, blk_start + 90)
        skill     = TASK_SKILL.get(task_name, "GNIB")

        if task_name in PAX_RATIOS and total_pax > 0:
            ratio, min_s = PAX_RATIOS[task_name]
            needed = max(min_s, _math.ceil(total_pax / ratio))
        else:
            needed = max(1, _math.ceil(len(fns) / 1))
        needed = min(needed, rule["max_staff_count"])

        safe_name  = task_name[:8].replace(" ", "").replace("/", "")
        task_id    = f"TBLK_{terminal}_{block_idx}_{direction}_{safe_name}"
        task_label = f"{task_name} -- {terminal} {direction}"
        all_tasks.append({
            "id":              task_id,
            "flight_no":       fns[0],
            "task":            task_label,
            "skill":           skill,
            "priority":        rule["priority"],
            "start_mins":      blk_start,
            "end_mins":        blk_end,
            "start":           mins_to_time(blk_start),
            "end":             mins_to_time(blk_end),
            "staff_needed":    needed,
            "staff_capacity":  rule["max_staff_count"],
            "assigned":        [],
            "alert":           None,
            "time_mins":       blk_start,
            "flights_covered": fns,
            "terminal":        terminal,
            "pier":            "ALL",
            "sharing_mode":    "block_shared",
            "total_pax":       total_pax,
            "time_window":     f"{mins_to_time(blk_start)}-{mins_to_time(blk_end)}",
        })

    # All Flights / US Flights scope (pier-level block)
    for (terminal, pier, block_idx, direction, task_name), data in flight_blocks.items():
        if not data["flights"]:
            continue
        rule      = data["rule"]
        total_pax = data["pax"]
        fns       = data["flights"]
        blk_start = block_idx * 90
        blk_end   = min(1440, blk_start + 90)
        skill     = TASK_SKILL.get(task_name, "GNIB")

        if task_name in PAX_RATIOS and total_pax > 0:
            ratio, min_s = PAX_RATIOS[task_name]
            needed = max(min_s, _math.ceil(total_pax / ratio))
        else:
            needed = max(1, len(fns))
        needed = min(needed, rule["max_staff_count"])

        safe_name  = task_name[:8].replace(" ", "").replace("/", "")
        task_id    = f"FBLK_{terminal}_{pier}_{block_idx}_{direction}_{safe_name}"
        task_label = f"{task_name} -- {pier} {direction}"
        all_tasks.append({
            "id":              task_id,
            "flight_no":       fns[0],
            "task":            task_label,
            "skill":           skill,
            "priority":        rule["priority"],
            "start_mins":      blk_start,
            "end_mins":        blk_end,
            "start":           mins_to_time(blk_start),
            "end":             mins_to_time(blk_end),
            "staff_needed":    needed,
            "staff_capacity":  rule["max_staff_count"],
            "assigned":        [],
            "alert":           None,
            "time_mins":       blk_start,
            "flights_covered": fns,
            "terminal":        terminal,
            "pier":            pier,
            "sharing_mode":    "pier_block",
            "total_pax":       total_pax,
            "time_window":     f"{mins_to_time(blk_start)}-{mins_to_time(blk_end)}",
        })

    return all_tasks



# ---------------------------------------------------------------------------
# Main optimiser
# ---------------------------------------------------------------------------

def optimize_day(date_str, overrides=None, manual_assigns=None, current_time_mins=None, prefer_early=False, custom_constraints=None):
    """Run the greedy staff-assignment optimiser for a single day.

    Returns a rich dict with flights, tasks, staff, alerts and KPIs.
    """
    if overrides is None:
        overrides = {}
    if manual_assigns is None:
        manual_assigns = {}
    if custom_constraints is None:
        custom_constraints = {}
        
    tt_t1_t2 = int(custom_constraints.get('tt_t1_t2', 15))
    tt_skill_switch = int(custom_constraints.get('tt_skill_switch', 10))
    # Support both singular/plural naming from different JS files
    allow_overlap = custom_constraints.get('allow_overlap') or custom_constraints.get('allow_overlaps') or False
    use_primary_first = custom_constraints.get('use_primary_first', True)

    if current_time_mins is not None:
        current_time_mins = int(current_time_mins)

    # Parse date
    d = None
    for fmt in ('%Y-%m-%d', '%d-%b-%y', '%d-%m-%Y', '%d-%m-%y'):
        try:
            d = datetime.strptime(date_str.strip(), fmt)
            break
        except ValueError:
            pass
    if d is None:
        return {'error': f'Cannot parse date: {date_str}'}

    flight_date_key = d.strftime('%d-%b-%y')   # e.g. '11-Apr-26'
    iso_date_key    = d.strftime('%Y-%m-%d')    # e.g. '2026-04-11'
    date_label      = d.strftime('%A %d %b %Y')

    # Load flights for this date
    all_flights = read_csv_flights()
    # Case-insensitive date lookup
    flights_raw = [f for f in all_flights if (f.get('date') or f.get('DATE', '')).strip() == flight_date_key]

    # Apply overrides
    cancelled_set = set()
    delay_map = {}
    for fn, ov in overrides.items():
        if ov.get('cancelled'):
            cancelled_set.add(fn)
        if ov.get('delay_mins', 0):
            delay_map[fn] = int(ov['delay_mins'])

    # Load rules, stands, staff
    rules = load_config_rules()
    stands_map = get_stands_map()
    on_duty, absent_staff = get_staff_for_date(date_str, custom_constraints)
    print(f"[DEBUG] On-duty: {len(on_duty)}, Absent: {len(absent_staff)}")

    # Build skill lookup dicts using raw CSV skill names.
    # Staff CSV uses task-name labels ('Gate 335', 'Dep/Trolleys', etc.).
    # Pools are keyed by these raw names; task-to-staff matching uses SKILL_ALIASES below.
    staff_by_prim = defaultdict(list)   # raw_skill1 → [staff_dict]
    staff_by_any  = defaultdict(list)   # raw skill (any slot) → [staff_dict]
    for s in on_duty:
        raw1 = s.get('skill1', '').strip()
        if raw1:
            staff_by_prim[raw1].append(s)
            staff_by_any[raw1].append(s)

        seen_raw = {raw1}
        for raw_sk in [s.get('skill2',''), s.get('skill3',''), s.get('skill4','')]:
            rsk = raw_sk.strip()
            if rsk and rsk not in seen_raw:
                staff_by_any[rsk].append(s)
                seen_raw.add(rsk)

    # Reverse map: task_skill → set of raw CSV skill names that qualify.
    # e.g. 'GNIB' → {'GNIB', 'Gate 335', 'Departures', 'Check-in/Trolleys', ...}
    #      'Bussing' → {'Bussing', 'Dep/Trolleys', 'T1/T2 Trolleys L/UL', ...}
    _skill_aliases: dict = defaultdict(set)
    for raw_name, ts in TASK_SKILL.items():
        _skill_aliases[ts].add(raw_name)
    # Always include the task_skill itself in its own alias set
    for ts in set(TASK_SKILL.values()):
        _skill_aliases[ts].add(ts)

    def _skill_norm(raw_sk: str) -> str:
        """Map a raw staff skill name to its task-execution skill."""
        return TASK_SKILL.get(raw_sk.strip(), raw_sk.strip()) if raw_sk else ''

    def _candidate_pools(task_skill: str):
        """Return (prim_pool, any_pool) covering all raw skills for task_skill."""
        keys = _skill_aliases.get(task_skill, {task_skill})
        seen_ids: set = set()
        prim: list = []
        any_: list = []
        for k in keys:
            for s in staff_by_prim.get(k, []):
                if id(s) not in seen_ids:
                    seen_ids.add(id(s)); prim.append(s)
        seen_ids.clear()
        for k in keys:
            for s in staff_by_any.get(k, []):
                if id(s) not in seen_ids:
                    seen_ids.add(id(s)); any_.append(s)
        return prim, any_

    # busy_map: emp_id → [(start, end, terminal, skill)]
    busy_map = defaultdict(list)

    def available(s, task_start, task_end, task_terminal, task_skill):
        """Check if staff member s is available for window [task_start, task_end)."""

        # Shift window
        S, E = s['shift_start'], s['shift_end']
        D_shift = (E - S) % 1440
        if D_shift == 0 and E == S: D_shift = 1440
        
        # Task duration and relative start
        task_dur = (task_end - task_start) % 1440
        if task_dur == 0 and task_end != task_start: task_dur = 1440
        ts_rel = (task_start - S) % 1440
        
        # Is task within shift window?
        if ts_rel + task_dur > D_shift:
            return False
            
        if allow_overlap:
            return True
            
        # Check busy map for overlaps with buffer
        for (ws, we, term, sk) in busy_map[s['id']]:
            buffer_mins = 0
            if term != task_terminal and term != 'ALL' and task_terminal != 'ALL':
                buffer_mins = max(buffer_mins, tt_t1_t2)
            if sk != task_skill:
                buffer_mins = max(buffer_mins, tt_skill_switch)
            
            # Normalize busy window to shift-relative coordinates
            ws_rel = (ws - S) % 1440
            w_dur = (we - ws) % 1440
            if w_dur == 0 and we != ws: w_dur = 1440
            
            # Overlap check in relative space
            if ts_rel < (ws_rel + w_dur + buffer_mins) and (ts_rel + task_dur) > (ws_rel - buffer_mins):
                return False
        return True

    # ── Build processed-flight list (apply overrides once, reuse everywhere) ──
    # Each entry carries enough info for _generate_day_tasks and flights_map.
    processed_flights = []
    cbp_dep_times = []

    for flight in flights_raw:
        fn = flight.get('flight_no', '').strip()
        if fn in cancelled_set:
            continue
        sta_raw = flight.get('sta', '').strip()
        t_mins = parse_time(sta_raw)
        if t_mins is None:
            continue
        t_mins += delay_map.get(fn, 0)

        status   = flight.get('Status', '').strip()
        icao_cat = flight.get('icao_cat', '').strip()
        cbp_flag = flight.get('cbp_flag', '').strip()
        gate     = flight.get('gate', '').strip()
        haul     = icao_to_haul(icao_cat, cbp_flag)

        # Collect US/Canada DEP times for CBP hall session task
        if haul == 'US/Canada' and status == 'Departure':
            cbp_dep_times.append(t_mins)

        processed_flights.append({
            'flight_no': fn,
            'time_mins': t_mins,
            'status':    status,
            'haul':      haul,
            'gate':      gate,
            'icao_cat':  icao_cat,
            'cbp_flag':  cbp_flag,
            # Keep raw flight dict for flights_map construction below
            '_raw':      flight,
        })

    # ── Generate flight tasks from Config.csv rules ───────────────────────────
    all_tasks = _generate_day_tasks(processed_flights, rules, stands_map, SHARING_WINDOW_MINS)

    # ── CBP hall task — session-level, driven by US/Canada departures ────────
    # Find CBP rule from config for max-staff cap
    _cbp_rule = next((r for r in rules if r['task'] == 'CBP Pre-clearance'), None)
    if cbp_dep_times:
        cbp_start = max(0, min(cbp_dep_times) - 90)
        cbp_end   = max(cbp_dep_times) + 30
        if cbp_end <= cbp_start:
            cbp_end = cbp_start + 120
        cbp_flights = [pf['flight_no'] for pf in processed_flights
                       if pf['haul'] == 'US/Canada' and pf['status'] == 'Departure']
        _cbp_need = min(3, _cbp_rule['max_staff_count']) if _cbp_rule else 3
        _cbp_cap  = _cbp_rule['max_staff_count'] if _cbp_rule else 3
        _cbp_pri  = _cbp_rule['priority'] if _cbp_rule else 'Critical'
        all_tasks.append({
            'id':              f'CBP_HALL_{cbp_start}',
            'flight_no':       'CBP-HALL',
            'task':            'CBP Pre-clearance',
            'skill':           'CBP Pre-clearance',
            'priority':        _cbp_pri,
            'start_mins':      cbp_start,
            'end_mins':        cbp_end,
            'start':           mins_to_time(cbp_start),
            'end':             mins_to_time(cbp_end),
            'staff_needed':    _cbp_need,
            'staff_capacity':  _cbp_cap,
            'assigned':        [],
            'alert':           None,
            'time_mins':       cbp_start,
            'flights_covered': cbp_flights,
            'terminal':        'T2',
            'pier':            'P4',
            'sharing_mode':    'shared',
            'time_window':     f"{mins_to_time(cbp_start)}-{mins_to_time(cbp_end)}",
        })

    # ── Fixed duties — generated from Config.csv rows with scope='Fixed' ──────
    # Each Fixed rule runs two standard shifts (AM 04:00-12:00 / PM 12:00-20:00).
    _fixed_rules = [r for r in rules if r['scope'] == 'Fixed']
    fixed_duties = []
    for _fr in _fixed_rules:
        _task   = _fr['task']
        _skill  = TASK_SKILL.get(_task, _task)
        _pri    = _fr['priority']
        _needed = _fr['max_staff_count']
        
        if _task == 'Litter Picking':
            # 2 hrs daytime, 2 hrs nighttime at 2 FTE
            shifts_to_run = [(600, 720), (1320, 1440)]
        else:
            shifts_to_run = [(240, 720), (720, 1200)]
            
        for _shift_idx, (_s, _e) in enumerate(shifts_to_run):
            fixed_duties.append({
                'id':            f"FIXED_{_task[:6].replace(' ', '')}_{_shift_idx}",
                'task':          _task,
                'skill':         _skill,
                'priority':      _pri,
                'start_mins':    _s,
                'end_mins':      _e,
                'staff_needed':  _needed,
                'staff_capacity': _needed,
            })
    for fd in fixed_duties:
        fd.update({
            'flight_no':       'FIXED',
            'start':           mins_to_time(fd['start_mins']),
            'end':             mins_to_time(fd['end_mins']),
            'assigned':        [],
            'alert':           None,
            'time_mins':       fd['start_mins'],
            'flights_covered': [],
            'terminal':        'ALL',
            'pier':            'ALL',
            'sharing_mode':    'fixed',
            'time_window':     f"{mins_to_time(fd['start_mins'])}-{mins_to_time(fd['end_mins'])}",
        })
        all_tasks.append(fd)

    # Mark completed tasks in live intraday mode instead of deleting them.
    # This preserves them for the timeline and staff utilisation history.
    if current_time_mins is not None:
        for t in all_tasks:
            if t['end_mins'] <= current_time_mins:
                t['is_past'] = True

    # Apply manual assigns FIRST
    for task in all_tasks:
        tid = task['id']
        if tid in manual_assigns:
            for emp_id in manual_assigns[tid]:
                # Find staff member
                s = next((x for x in on_duty if x['id'] == emp_id), None)
                if s and emp_id not in task['assigned']:
                    task['assigned'].append(emp_id)
                    s['assignments'].append({
                        'task_id':    tid,
                        'task':       task['task'],
                        'skill':      task.get('skill', 'GNIB'),
                        'terminal':   task.get('terminal', 'ALL'),
                        'start':      task['start'],
                        'end':        task['end'],
                        'start_mins': task['start_mins'],
                        'end_mins':   task['end_mins'],
                    })
                    busy_map[emp_id].append((task['start_mins'], task['end_mins'], task.get('terminal', 'ALL'), task.get('skill', 'GNIB')))

    # Sort tasks for assignment.
    # Key objectives in order:
    #   1. Priority (Critical → High → Medium → Low) from Config.csv
    #   2. Coverage breadth: tasks covering more flights processed first so shared
    #      resources are allocated where they deliver the most coverage.
    #   3. Terminal/pier spread: tasks serving multiple terminals ahead of single-terminal
    #   4. Earliest start time (so deadlines are met in time order)
    #   5. Flight number as final tiebreaker for determinism
    # In live intraday mode (prefer_early=True) start_mins leads so past-due tasks
    # are never skipped in favour of future high-priority ones.
    priority_order = {'Critical': 0, 'High': 1, 'Medium': 2, 'Low': 3}
    if prefer_early:
        all_tasks.sort(key=lambda t: (
            t['start_mins'],
            priority_order.get(t['priority'], 2),
            -len(t.get('flights_covered', [])),
            t.get('flight_no', ''),
        ))
    else:
        all_tasks.sort(key=lambda t: (
            priority_order.get(t['priority'], 2),
            -len(t.get('flights_covered', [])),
            t['start_mins'],
            t.get('flight_no', ''),
        ))

    # ── CP-SAT optimisation (enabled via use_cpsat flag) ──────────────────────
    # Replaces the greedy loop when OR-Tools is installed and the flag is set.
    # On solver failure or if the flag is off, falls through to greedy below.
    _cpsat_applied = False
    if custom_constraints.get('use_cpsat', False) and _CPSAT_AVAILABLE:
        try:
            # Build the constraint dict expected by the optimizer module
            _cpsat_cons = {
                'tt_t1_t2':               tt_t1_t2,
                'tt_skill_switch':        tt_skill_switch,
                'b1_duration_mins':       int(custom_constraints.get('b1_duration_mins', 30)),
                'b2_duration_mins':       int(custom_constraints.get('b2_duration_mins', 60)),
                'max_overtime_per_day_hrs': 2,
            }
            # Only pass tasks that still need staff (manual assigns may have
            # already covered some or all slots for a task)
            _open_tasks = [
                t for t in all_tasks
                if len(t.get('assigned', [])) < t.get('staff_needed', 1)
                and not t.get('is_past')
            ]
            _cpsat_result = _cpsat_optimize(_open_tasks, on_duty, _cpsat_cons)

            if _cpsat_result and _cpsat_result.get('solver_status') in ('OPTIMAL', 'FEASIBLE'):
                _task_lookup = {t['id']: t for t in all_tasks}

                # Apply solver assignments to task and staff objects in-place
                for _asgn in _cpsat_result['assignments']:
                    _task = _task_lookup.get(_asgn['task_id'])
                    if not _task:
                        continue
                    for _emp_id in _asgn['staff_ids']:
                        if _emp_id in _task['assigned']:
                            continue
                        _s = next((w for w in on_duty if w['id'] == _emp_id), None)
                        if not _s:
                            continue
                        _task['assigned'].append(_emp_id)
                        _s['assignments'].append({
                            'task_id':    _task['id'],
                            'task':       _task['task'],
                            'skill':      _task.get('skill', 'GNIB'),
                            'terminal':   _task.get('terminal', 'ALL'),
                            'start':      _task['start'],
                            'end':        _task['end'],
                            'start_mins': _task['start_mins'],
                            'end_mins':   _task['end_mins'],
                        })
                        # Update busy_map so break-scheduling later is accurate
                        busy_map[_emp_id].append((
                            _task['start_mins'], _task['end_mins'],
                            _task.get('terminal', 'ALL'),
                            _task.get('skill', 'GNIB'),
                        ))

                # Set alerts on tasks that are still under-staffed after CP-SAT
                for _task in all_tasks:
                    _needed  = _task['staff_needed']
                    _covered = len(_task['assigned'])
                    if _covered < _needed and not _task.get('is_past'):
                        _task['alert'] = (
                            f'Under-staffed: need {_needed}, assigned {_covered}'
                            f' (gap {_needed - _covered})'
                        )

                _cpsat_applied = True
                print(
                    f"[CP-SAT] {_cpsat_result['solver_status']}  "
                    f"unassigned={len(_cpsat_result['unassigned_tasks'])}  "
                    f"gap={_cpsat_result['gap_pct']}%"
                )
        except Exception as _cpsat_exc:
            print(f"[CP-SAT] Error ({_cpsat_exc}); falling back to greedy.")

    # ── Greedy assignment (default path, or fallback when CP-SAT is off/fails) ─
    _greedy_tasks = [] if _cpsat_applied else all_tasks
    print(f"[DEBUG] Assigning {len(_greedy_tasks)} tasks (greedy)...")
    for task in _greedy_tasks:
        needed = task['staff_needed'] - len(task['assigned'])
        if needed <= 0:
            continue

        skill = task['skill']
        start = task['start_mins']
        end   = task['end_mins']

        # Optimization: Lazy evaluation of candidates.
        # Instead of pre-filtering all staff (which calls expensive available() for everyone),
        # we iterate and stop as soon as we meet the 'needed' headcount.
        assigned_count = 0

        _prim_pool, _any_pool = _candidate_pools(skill)
        candidate_pools = []
        if use_primary_first:
            candidate_pools = [_prim_pool, _any_pool]
        else:
            candidate_pools = [_any_pool]

        for pool_index, pool in enumerate(candidate_pools):
            if assigned_count >= needed:
                break
            for s in pool:
                if assigned_count >= needed:
                    break
                if s['id'] in task['assigned']:
                    continue
                if not available(s, start, end, task.get('terminal', 'ALL'), task.get('skill', 'GNIB')):
                    continue

                assignment = {
                    'task_id':   task['id'],
                    'task':      task['task'],
                    'skill':     task.get('skill', 'GNIB'),
                    'terminal':  task.get('terminal', 'ALL'),
                    'start':     task['start'],
                    'end':       task['end'],
                    'start_mins': start,
                    'end_mins':   end,
                }

                task['assigned'].append(s['id'])
                s['assignments'].append(assignment)
                busy_map[s['id']].append((start, end, task.get('terminal', 'ALL'), task.get('skill', 'GNIB')))
                assigned_count += 1

        if assigned_count < needed:
            gap = needed - assigned_count
            if not task.get('is_past'):
                task['alert'] = f'Under-staffed: need {needed}, assigned {assigned_count} (gap {gap})'

    # ── Pass 2: relax travel/skill-switch buffers for still-unassigned tasks ──
    # Retry with zero inter-task buffers so back-to-back tasks on the same staff
    # can be filled when minor buffer constraints prevented assignment above.
    def _available_no_buffer(s, task_start, task_end, extend_shift_mins=0):
        S, E = s['shift_start'], s['shift_end']
        D_shift = (E - S) % 1440
        if D_shift == 0 and E == S:
            D_shift = 1440
        task_dur = (task_end - task_start) % 1440
        if task_dur == 0 and task_end != task_start:
            task_dur = 1440
        ts_rel = (task_start - S) % 1440
        if ts_rel + task_dur > D_shift + extend_shift_mins:
            return False
        for (ws, we, _t, _sk) in busy_map[s['id']]:
            ws_rel = (ws - S) % 1440
            w_dur  = (we - ws) % 1440
            if w_dur == 0 and we != ws:
                w_dur = 1440
            if ts_rel < ws_rel + w_dur and ts_rel + task_dur > ws_rel:
                return False
        return True

    _pass2_tasks = [
        t for t in (_greedy_tasks if not _cpsat_applied else all_tasks)
        if len(t['assigned']) < t['staff_needed'] and not t.get('is_past')
    ]
    if _pass2_tasks:
        print(f"[DEBUG] Pass-2 (zero buffers): {len(_pass2_tasks)} tasks still need staff")
        for task in _pass2_tasks:
            needed = task['staff_needed'] - len(task['assigned'])
            if needed <= 0:
                continue
            skill = task['skill']
            start = task['start_mins']
            end   = task['end_mins']
            _p2_prim, _p2_any = _candidate_pools(skill)
            for pool in [_p2_prim, _p2_any]:
                if needed <= 0:
                    break
                for s in pool:
                    if needed <= 0:
                        break
                    if s['id'] in task['assigned']:
                        continue
                    if not _available_no_buffer(s, start, end):
                        continue
                    task['assigned'].append(s['id'])
                    s['assignments'].append({
                        'task_id':    task['id'],
                        'task':       task['task'],
                        'skill':      skill,
                        'terminal':   task.get('terminal', 'ALL'),
                        'start':      task['start'],
                        'end':        task['end'],
                        'start_mins': start,
                        'end_mins':   end,
                    })
                    busy_map[s['id']].append((start, end, task.get('terminal', 'ALL'), skill))
                    needed -= 1
            if len(task['assigned']) >= task['staff_needed']:
                task['alert'] = None

    # ── Pass 3: extend shift window (up to 90 min overtime) + any-skill fallback ─
    # Last-resort pass so no task is left completely unassigned. Staff with
    # zero skill overlap are marked with skill_mismatch=True.
    _pass3_tasks = [
        t for t in all_tasks
        if len(t['assigned']) < t['staff_needed'] and not t.get('is_past')
    ]
    if _pass3_tasks:
        print(f"[DEBUG] Pass-3 (extended shift + any skill): {len(_pass3_tasks)} tasks")
        _all_staff_sorted = sorted(on_duty, key=lambda s: len(busy_map[s['id']]))
        for task in _pass3_tasks:
            needed = task['staff_needed'] - len(task['assigned'])
            if needed <= 0:
                continue
            skill = task['skill']
            start = task['start_mins']
            end   = task['end_mins']
            if 'mismatch_assigned' not in task:
                task['mismatch_assigned'] = []
            _p3_prim, _p3_any = _candidate_pools(skill)
            skill_pools = list({id(s): s for s in (_p3_prim + _p3_any)}.values())
            for s in skill_pools:
                if needed <= 0:
                    break
                if s['id'] in task['assigned']:
                    continue
                if not _available_no_buffer(s, start, end, extend_shift_mins=90):
                    continue
                task['assigned'].append(s['id'])
                s['assignments'].append({
                    'task_id':        task['id'],
                    'task':           task['task'],
                    'skill':          skill,
                    'terminal':       task.get('terminal', 'ALL'),
                    'start':          task['start'],
                    'end':            task['end'],
                    'start_mins':     start,
                    'end_mins':       end,
                    'skill_mismatch': False,
                })
                busy_map[s['id']].append((start, end, task.get('terminal', 'ALL'), skill))
                needed -= 1
            if len(task['assigned']) >= task['staff_needed']:
                task['alert'] = None
            else:
                remaining = task['staff_needed'] - len(task['assigned'])
                task['alert'] = f'Under-staffed: need {task["staff_needed"]}, assigned {len(task["assigned"])} (gap {remaining})'

    # ── Pass 4: Full staff utilisation ────────────────────────────────────────
    # For every on-duty staff member, find 1.5-hour blocks within their shift where
    # they have no assignment, and assign them to the highest-priority task in
    # that block that matches one of their skills and has spare capacity.
    # This ensures all staff are productive every hour they are on duty.
    _p4_priority = {'Critical': 0, 'High': 1, 'Medium': 2, 'Low': 3}

    # Index tasks by 1.5-hour block index
    _blk_task_index: dict = defaultdict(list)
    for _t in all_tasks:
        if _t.get('is_past'):
            continue
        _blk = _t['start_mins'] // 90
        _blk_task_index[_blk].append(_t)
    # Sort each bucket: Critical first, then more-assigned tasks (fill existing slots)
    for _blk in _blk_task_index:
        _blk_task_index[_blk].sort(key=lambda t: (
            _p4_priority.get(t.get('priority', 'Medium'), 2),
            -len(t['assigned']),
        ))

    _p4_assigned = 0
    for s in on_duty:
        emp_id   = s['id']
        # Normalise via TASK_SKILL so 'Gate 335' → 'GNIB', 'Dep/Trolleys' → 'Bussing', etc.
        s_skills = {_skill_norm(sk) for sk in [s.get('skill1',''), s.get('skill2',''), s.get('skill3',''), s.get('skill4','')] if sk}
        sh_start = s['shift_start']
        sh_end   = s['shift_end']

        first_blk = sh_start // 90
        last_blk  = max(first_blk, (sh_end - 1) // 90)

        for blk in range(first_blk, last_blk + 1):
            blk_start = blk * 90
            blk_end   = min(1440, blk_start + 90)

            # Skip if staff already has an assignment overlapping this block
            already_busy = any(
                ws < blk_end and we > blk_start
                for (ws, we, _t, _sk) in busy_map[emp_id]
            )
            if already_busy:
                continue

            # Find best matching task in this block
            for _t in _blk_task_index.get(blk, []):
                t_skill = _t.get('skill', 'GNIB')
                if t_skill not in s_skills:
                    continue
                cap = _t.get('staff_capacity', _t['staff_needed'])
                if len(_t['assigned']) >= cap:
                    continue
                if emp_id in _t['assigned']:
                    continue
                if not _available_no_buffer(s, _t['start_mins'], _t['end_mins']):
                    continue

                _t['assigned'].append(emp_id)
                s['assignments'].append({
                    'task_id':    _t['id'],
                    'task':       _t['task'],
                    'skill':      t_skill,
                    'terminal':   _t.get('terminal', 'ALL'),
                    'start':      _t['start'],
                    'end':        _t['end'],
                    'start_mins': _t['start_mins'],
                    'end_mins':   _t['end_mins'],
                })
                busy_map[emp_id].append((_t['start_mins'], _t['end_mins'], _t.get('terminal', 'ALL'), t_skill))
                _p4_assigned += 1
                break  # one task per block per staff member

    print(f"[DEBUG] Pass-4 (full utilisation): {_p4_assigned} additional assignments")

    # Schedule breaks and compute utilisation
    print(f"[DEBUG] Scheduling breaks for staff...")
    for s in on_duty:
        windows = [(ws, we) for (ws, we, t, sk) in busy_map[s['id']]]
        s['breaks'] = schedule_breaks(s, windows, custom_constraints)
        total_busy = sum(e - st for (st, e) in windows)
        shift_len = s['shift_end'] - s['shift_start']
        s['utilisation_pct'] = round(min(total_busy / shift_len * 100, 100), 1) if shift_len > 0 else 0

    # ── Build flights_map from already-processed flight list ─────────────────
    # processed_flights already has overrides applied; no need to re-parse.
    flights_map = {}
    for pf in processed_flights:
        fn  = pf['flight_no']
        raw = pf['_raw']
        si  = _stand_info(pf['gate'], stands_map)
        flights_map[fn] = {
            'flight_no':    fn,
            'date':         raw.get('date', ''),
            'sta':          raw.get('sta', ''),
            'origin':       raw.get('origin', ''),
            'origin_code':  raw.get('origin_code', ''),
            'airline_name': raw.get('airline_name', ''),
            'aircraft_type':raw.get('aircraft_type', ''),
            'tail_reg':     raw.get('tail_reg', ''),
            'icao_cat':     pf['icao_cat'],
            'cbp_flag':     pf['cbp_flag'],
            'gate':         pf['gate'],
            'status':       pf['status'],
            'haul':         pf['haul'],
            'terminal':     si['terminal'],
            'pier':         si['pier'],
            'time_mins':    pf['time_mins'],
            'delayed':      fn in delay_map,
            'delay_mins':   delay_map.get(fn, 0),
            'tasks':        [],
        }

    # ── Attach tasks to flights ───────────────────────────────────────────────
    # Shared/partially-shared tasks cover multiple flights; they appear in the
    # task list of each flight they serve so the UI can show a full picture.
    # Dedicated and fixed tasks appear only on their primary flight.
    for task in all_tasks:
        task_summary = {
            'id':               task['id'],
            'task':             task['task'],
            'skill':            task['skill'],
            'priority':         task['priority'],
            'start':            task['start'],
            'end':              task['end'],
            'start_mins':       task['start_mins'],
            'end_mins':         task['end_mins'],
            'staff_needed':     task['staff_needed'],
            'assigned':         task['assigned'],
            'mismatch_assigned': task.get('mismatch_assigned', []),
            'alert':            task['alert'],
            'sharing_mode':     task.get('sharing_mode', 'dedicated'),
            'flights_covered':  task.get('flights_covered', []),
            'time_window':      task.get('time_window', ''),
            'terminal':         task.get('terminal', ''),
            'pier':             task.get('pier', ''),
        }
        for fn in task.get('flights_covered', [task.get('flight_no', '')]):
            if fn in flights_map:
                flights_map[fn]['tasks'].append(task_summary)

    # Mark flights as completed when all relevant tasks are in the past.
    if current_time_mins is not None:
        for flight in flights_map.values():
            if flight['tasks']:
                last_task_end = max(t['end_mins'] for t in flight['tasks'])
                if last_task_end <= current_time_mins:
                    flight['status'] = 'Completed'
            else:
                # No remaining tasks means the flight is complete for live intraday view.
                flight['status'] = 'Completed'

    flights_sorted = sorted(flights_map.values(), key=lambda x: x['time_mins'])

    # ── Build alerts list ────────────────────────────────────────────────────
    alerts = []
    for task in all_tasks:
        if task['alert']:
            needed         = task['staff_needed']
            assigned_count = len(task['assigned'])
            gap            = needed - assigned_count
            skill          = task['skill']
            start          = task['start_mins']
            end            = task['end_mins']
            rec_candidates = [s for s in staff_by_any.get(skill, [])
                               if s['id'] not in task['assigned'] and available(s, start, end, task.get('terminal', 'ALL'), task.get('skill', 'GNIB'))]
            rec_staff = [s['id'] for s in rec_candidates[:gap]]
            covered_flights = []
            for fn in task.get('flights_covered', []):
                flight = flights_map.get(fn)
                if not flight:
                    continue
                covered_flights.append({
                    'flight_no': flight.get('flight_no', ''),
                    'origin': flight.get('origin', ''),
                    'origin_code': flight.get('origin_code', ''),
                    'airline_name': flight.get('airline_name', ''),
                    'sta': flight.get('sta', ''),
                    'status': flight.get('status', ''),
                    'gate': flight.get('gate', ''),
                    'terminal': flight.get('terminal', ''),
                    'pier': flight.get('pier', ''),
                    'haul': flight.get('haul', ''),
                })
            alerts.append({
                'task_id':         task['id'],
                'flight_no':       task.get('flight_no', ''),
                'flights_covered': task.get('flights_covered', []),
                'covered_flights': covered_flights,
                'task':            task['task'],
                'skill':           skill,
                'priority':        task['priority'],
                'start':           task['start'],
                'end':             task['end'],
                'staff_needed':    needed,
                'assigned_count':  assigned_count,
                'assigned_staff':  task['assigned'],
                'gap':             gap,
                'message':         task['alert'],
                'rec_staff':       rec_staff,
                'sharing_mode':    task.get('sharing_mode', 'dedicated'),
                'terminal':        task.get('terminal', ''),
                'pier':            task.get('pier', ''),
                'time_window':     task.get('time_window', ''),
            })

    # Sort alerts: Critical first
    alerts.sort(key=lambda a: (priority_order.get(a['priority'], 2), a['start']))

    # ── KPIs ─────────────────────────────────────────────────────────────────
    tasks_covered = sum(1 for t in all_tasks if not t['alert'])
    tasks_total   = len(all_tasks)
    # gates_active derived from processed_flights (overrides already applied)
    gates_active  = len(set(pf['gate'] for pf in processed_flights if pf['gate']))

    return {
        'date':          iso_date_key,
        'date_label':    date_label,
        'kpis': {
            'total_flights':  len(flights_sorted),
            'staff_on_duty':  len(on_duty),
            'absent':         len(absent_staff),
            'gates_active':   gates_active,
            'tasks_total':    tasks_total,
            'tasks_covered':  tasks_covered,
            'coverage_pct':   round(tasks_covered / tasks_total * 100, 1) if tasks_total else 100.0,
        },
        'flights':       flights_sorted,
        'staff':         on_duty,
        'tasks':         all_tasks,
        'absent_staff':  absent_staff,
        'alerts':        alerts,
        'overrides':     overrides,
    }


# ---------------------------------------------------------------------------
# Short-term & Intraday Flask endpoints
# ---------------------------------------------------------------------------

@app.route('/api/short-term/dates')
def st_dates():
    """Return available D+1 to D+3 dates."""
    from datetime import date as date_type
    today = datetime.now()
    flight_dates = set(f['date'] for f in read_csv_flights())
    available_dates = []
    for i in [1, 2, 3]:
        d = today + timedelta(days=i)
        available_dates.append({
            'label':    d.strftime('%A %d %b'),
            'date':     d.strftime('%Y-%m-%d'),
            'has_data': d.strftime('%d-%b-%y') in flight_dates,
        })
    return jsonify(available_dates)


def _get_short_term_schedule(date_str, preserve_manual_assigns=True):
    """Return short-term schedule using the same optimizer mode as intraday.

    Short-term does not use live overrides or a simulation clock, but it should
    share the same early-first assignment ordering so shift/task allocation is
    optimized consistently with the intraday view.
    """
    man = _manual_assigns.get(date_str, {}) if preserve_manual_assigns else {}
    return optimize_day(
        date_str,
        manual_assigns=man,
        prefer_early=True,
        custom_constraints=_st_custom_constraints,
    )


@app.route('/api/short-term/<date_str>')
def st_day(date_str):
    """Return full optimised schedule for a short-term day (D+1 to D+3)."""
    result = _get_short_term_schedule(date_str)
    if 'error' in result:
        return jsonify(result), 404
    return jsonify(result)


@app.route('/api/short-term/roster-board')
def st_roster_board():
    """Returns combined roster data for all short-term dates (D+1 to D+3)."""
    today = datetime.now()
    flight_dates = set(f['date'] for f in read_csv_flights())
    
    dates = []
    days_data = []
    
    # We look for D+1, D+2, D+3
    for i in [1, 2, 3]:
        d = today + timedelta(days=i)
        date_iso = d.strftime('%Y-%m-%d')
        date_csv = d.strftime('%d-%b-%y')
        if date_csv in flight_dates:
            dates.append({
                'date': date_iso,
                'label': d.strftime('%a %d')
            })
            days_data.append(_get_short_term_schedule(date_iso))
            
    if not days_data:
        return jsonify({'error': 'No data available for short-term dates'}), 404
        
    # Aggregate by employee
    emp_map = {}
    for i, day in enumerate(days_data):
        date_key = dates[i]['date']
        # Regular staff
        for s in day.get('staff', []):
            eid = s['id']
            if eid not in emp_map:
                emp_map[eid] = {
                    'id': eid,
                    'name': eid, # Using ID as name for now as the image shows names/IDs
                    'skill': s.get('skill1', ''),
                    'shifts': {}
                }
            
            # Extract shift type (E, L, N) based on start time
            start = s.get('shift_start', 0)
            if 240 <= start < 600: # 4am to 10am
                stype = 'EARLY'
                code = 'E'
            elif 600 <= start < 1080: # 10am to 6pm
                stype = 'LATE'
                code = 'L'
            elif start >= 1080 or start < 240: # 6pm to 4am
                stype = 'NIGHT'
                code = 'N'
            else:
                stype = 'OTHER'
                code = 'O'
                
            timings = f"{mins_to_time(s['shift_start'])}-{mins_to_time(s['shift_end'])}"
            emp_map[eid]['shifts'][date_key] = {
                'label': f"{code} {timings}",
                'type': stype,
                'timings': timings,
                'is_absent': False
            }
            
        # Absent staff
        for s in day.get('absent_staff', []):
            eid = s['id']
            if eid not in emp_map:
                emp_map[eid] = {
                    'id': eid,
                    'name': eid,
                    'skill': s.get('skill1', ''),
                    'shifts': {}
                }
            emp_map[eid]['shifts'][date_key] = {
                'label': 'LEAVE',
                'type': 'LEAVE',
                'timings': s.get('leave_type', 'Absent'),
                'is_absent': True
            }
            
    # For employees who are "OFF" on some days, fill in the blanks
    for eid in emp_map:
        for d in dates:
            dk = d['date']
            if dk not in emp_map[eid]['shifts']:
                emp_map[eid]['shifts'][dk] = {
                    'label': 'OFF',
                    'type': 'OFF',
                    'timings': '',
                    'is_absent': False
                }
            
    # Convert to sorted list
    employees = sorted(emp_map.values(), key=lambda x: x['id'])
    
    return jsonify({
        'dates': dates,
        'employees': employees
    })


@app.route('/api/short-term/apply-rec', methods=['POST'])
def st_apply_rec():
    """Accept a recommendation: add staff_ids to task_id for a date, re-optimise."""
    body = request.get_json(force=True) or {}
    date  = body.get('date', '')
    task_id = body.get('task_id', '')
    staff_ids = body.get('staff_ids', [])
    if not date or not task_id:
        return jsonify({'error': 'date and task_id required'}), 400
    if date not in _manual_assigns:
        _manual_assigns[date] = {}
    existing = _manual_assigns[date].get(task_id, [])
    for sid in staff_ids:
        if sid not in existing:
            existing.append(sid)
    _manual_assigns[date][task_id] = existing
    result = _get_short_term_schedule(date)
    if 'error' in result:
        return jsonify(result), 404
    return jsonify(result)


@app.route('/api/short-term/constraints', methods=['GET', 'POST'])
def st_constraints():
    """Get or update short-term planning constraints."""
    global _st_custom_constraints

    if request.method == 'POST':
        body = request.get_json(force=True) or {}
        date = body.get('date') # can be specific date or global
        next_constraints = {k: v for k, v in body.items() if k != 'date'}
        _st_custom_constraints.update(next_constraints)
        if date:
            # Re-optimise from the current constraints, not from previously pinned
            # recommendation overrides, so "Update Schedule" performs a full reallocation.
            _manual_assigns.pop(date, None)
            result = _get_short_term_schedule(date, preserve_manual_assigns=False)
            if 'error' in result:
                return jsonify(result), 404
            return jsonify(result)
        return jsonify(_st_custom_constraints)

    res = {
        'tt_t1_t2': _st_custom_constraints.get('tt_t1_t2', 15),
        'tt_skill_switch': _st_custom_constraints.get('tt_skill_switch', 10),
        'allow_overlap': _st_custom_constraints.get('allow_overlap', False),
        'allow_overlaps': _st_custom_constraints.get('allow_overlaps', _st_custom_constraints.get('allow_overlap', False)),
        'use_primary_first': _st_custom_constraints.get('use_primary_first', True),
        'shift_duration_hrs': _st_custom_constraints.get('shift_duration_hrs', 12),
        'b1_duration_mins': _st_custom_constraints.get('b1_duration_mins', 30),
        'b2_duration_mins': _st_custom_constraints.get('b2_duration_mins', 60),
        'leave_types_excluded': _st_custom_constraints.get('leave_types_excluded', ["Annual Leave", "Paternity Leave", "Jury Duty", "Sick Leave", "Training"]),
        'permitted_shifts': _st_custom_constraints.get('permitted_shifts')
    }
    return jsonify(res)


@app.route('/api/intraday')
def intraday_get():
    """Return todays intraday-optimised schedule with any live overrides."""
    now = datetime.now()
    today_str = now.strftime('%Y-%m-%d')
    man = _manual_assigns.get(today_str, {})
    current_time_mins = now.hour * 60 + now.minute
    result = optimize_day(today_str, _intraday_overrides, man,
                          current_time_mins=current_time_mins,
                          prefer_early=True,
                          custom_constraints=_intraday_custom_constraints)
    if 'error' in result:
        return jsonify(result), 404
    return jsonify(result)


@app.route('/api/intraday/delay', methods=['POST'])
def intraday_delay():
    """Apply a delay or cancellation to a flight and re-optimise today."""
    body = request.get_json(force=True) or {}
    flight_no  = body.get('flight_no', '').strip()
    delay_mins = int(body.get('delay_mins', 0))
    cancelled  = bool(body.get('cancelled', False))
    if not flight_no:
        return jsonify({'error': 'flight_no required'}), 400
    _intraday_overrides[flight_no] = {'delay_mins': delay_mins, 'cancelled': cancelled}
    now = datetime.now()
    today_str = now.strftime('%Y-%m-%d')
    man = _manual_assigns.get(today_str, {})
    current_time_mins = now.hour * 60 + now.minute
    result = optimize_day(today_str, _intraday_overrides, man,
                          current_time_mins=current_time_mins,
                          prefer_early=True,
                          custom_constraints=_intraday_custom_constraints)
    if 'error' in result:
        return jsonify(result), 404
    return jsonify(result)


@app.route('/api/intraday/reset', methods=['POST'])
def intraday_reset():
    """Clear live intraday overrides and reload today's schedule."""
    _intraday_overrides.clear()
    today_str = datetime.now().strftime('%Y-%m-%d')
    if today_str in _manual_assigns:
        _manual_assigns.pop(today_str, None)
    return intraday_get()


@app.route('/api/intraday/assign', methods=['POST'])
def intraday_assign():
    """Manually assign or unassign a staff member to/from a task for today."""
    body    = request.get_json(force=True) or {}
    task_id = body.get('task_id', '').strip()
    staff_id = body.get('staff_id', '').strip()
    action  = body.get('action', 'assign')  # 'assign' or 'unassign'
    if not task_id or not staff_id:
        return jsonify({'error': 'task_id and staff_id required'}), 400
    now = datetime.now()
    today_str = now.strftime('%Y-%m-%d')
    if today_str not in _manual_assigns:
        _manual_assigns[today_str] = {}
    existing = _manual_assigns[today_str].get(task_id, [])
    if action == 'assign':
        if staff_id not in existing:
            existing.append(staff_id)
    elif action == 'unassign':
        existing = [x for x in existing if x != staff_id]
    _manual_assigns[today_str][task_id] = existing
    
    current_time_mins = now.hour * 60 + now.minute
    result = optimize_day(today_str, _intraday_overrides, _manual_assigns.get(today_str, {}),
                          current_time_mins=current_time_mins,
                          prefer_early=True,
                          custom_constraints=_intraday_custom_constraints)
    if 'error' in result:
        return jsonify(result), 404
    return jsonify(result)


@app.route('/api/intraday/constraints', methods=['GET', 'POST'])
def intraday_constraints():
    """Get or update intraday constraints."""
    global _intraday_custom_constraints
    
    path = os.path.join(BASE_DIR, 'Roster_constraints.json')
    try:
        with open(path, 'r', encoding='utf-8') as f:
            base_config = json.load(f)
    except:
        base_config = {}

    if request.method == 'POST':
        body = request.get_json(force=True) or {}
        _intraday_custom_constraints.update(body)
        # trigger an update by fetching
        return intraday_get()

    res = {
        'tt_t1_t2': _intraday_custom_constraints.get('tt_t1_t2', 15),
        'tt_skill_switch': _intraday_custom_constraints.get('tt_skill_switch', 10),
        'allow_overlap': _intraday_custom_constraints.get('allow_overlap', False),
        'use_primary_first': _intraday_custom_constraints.get('use_primary_first', True),
        'shift_duration_hrs': _intraday_custom_constraints.get('shift_duration_hrs', 12),
        'b1_duration_mins': _intraday_custom_constraints.get('b1_duration_mins', 30),
        'b2_duration_mins': _intraday_custom_constraints.get('b2_duration_mins', 60),
        'leave_types_excluded': _intraday_custom_constraints.get('leave_types_excluded', ["Annual Leave", "Paternity Leave", "Jury Duty", "Sick Leave", "Training"]),
        'permitted_shifts': _intraday_custom_constraints.get('permitted_shifts'),
        # CP-SAT optimiser controls
        'use_cpsat': _intraday_custom_constraints.get('use_cpsat', False),
        'cpsat_available': _CPSAT_AVAILABLE,
    }
    return jsonify(res)


# ===========================================================================
# UNIFIED INTRADAY OPTIMISE ENDPOINT
# ===========================================================================

@app.route('/api/intraday/optimise', methods=['POST'])
def intraday_optimise():
    """Apply all constraints + run roster optimiser → return full updated intraday schedule.

    Body:
      use_mip, min_rest_hrs,
      tt_t1_t2, tt_skill_switch, use_primary_first, allow_overlaps,
      shift_duration_hrs, b1_duration_mins, b2_duration_mins,
      leave_types_excluded, permitted_shifts
    """
    global _intraday_custom_constraints

    body = request.get_json(force=True) or {}

    use_mip = bool(body.get('use_mip', True))
    min_rest_hrs = float(body.get('min_rest_hrs', 11))

    # ── 1. Persist tactical constraints ──────────────────────────────
    tactical_keys = [
        'tt_t1_t2', 'tt_skill_switch', 'use_primary_first', 'allow_overlaps',
        'allow_overlap', 'shift_duration_hrs', 'b1_duration_mins', 'b2_duration_mins',
        'leave_types_excluded', 'permitted_shifts', 'use_cpsat',
    ]
    for k in tactical_keys:
        if k in body:
            _intraday_custom_constraints[k] = body[k]

    # ── 2. Re-run intraday schedule with updated constraints ──────────
    now = datetime.now()
    today_str = now.strftime('%Y-%m-%d')
    man = _manual_assigns.get(today_str, {})
    current_time_mins = now.hour * 60 + now.minute
    result = optimize_day(today_str, _intraday_overrides, man,
                          current_time_mins=current_time_mins,
                          prefer_early=True,
                          custom_constraints=_intraday_custom_constraints)
    if 'error' in result:
        return jsonify(result), 404

    roster_info = {'roster_available': False, 'solver_used': 'none'}

    # ── 3. Run roster optimiser and merge assignments ─────────────────
    if _ROSTER_AVAILABLE:
        try:
            on_duty = result.get('staff', [])
            flights = result.get('flights', [])

            all_tasks = [t for f in flights for t in f.get('tasks', [])]
            demand_windows = _roster_tasks_to_dw(all_tasks) if all_tasks else []

            if not demand_windows:
                anchor_skill = on_duty[0].get('skill1', 'GNIB') if on_duty else 'GNIB'
                demand_windows = [
                    _RosterDemandWindow(240,  960,  anchor_skill, 1, 'Standard'),
                    _RosterDemandWindow(960, 1440,  anchor_skill, 1, 'Standard'),
                ]

            staff_norm = [
                {
                    'id':               s.get('id', s.get('name', '')),
                    'skill1':           s.get('skill1', ''),
                    'skill2':           s.get('skill2', ''),
                    'shift_start_mins': s.get('shift_start_mins', 240),
                    'shift_end_mins':   s.get('shift_end_mins',   960),
                }
                for s in on_duty
            ]

            roster_constraints = {
                'shift_duration_hrs': _intraday_custom_constraints.get('shift_duration_hrs', 12),
                'min_rest_mins':      int(min_rest_hrs * 60),
                'b1_duration_mins':   _intraday_custom_constraints.get('b1_duration_mins', 30),
                'b2_duration_mins':   _intraday_custom_constraints.get('b2_duration_mins', 60),
            }

            rr = _roster_generate(
                demand_windows=demand_windows,
                staff_list=staff_norm,
                constraints=roster_constraints,
                use_mip=use_mip
            )

            roster_map = {e['id']: e for e in (rr.get('roster') or [])}
            for s in result['staff']:
                sid = s.get('id', s.get('name', ''))
                entry = roster_map.get(sid)
                if entry and entry.get('pattern_id') != 'unassigned':
                    s['shift_label']      = entry.get('shift_label', s.get('shift', ''))
                    s['pattern_id']       = entry.get('pattern_id', '')
                    s['skill_match']      = entry.get('skill_match', 'primary')
                    s['utilisation_pct']  = entry.get('utilisation_pct', 0)
                    if entry.get('shift_start_mins') is not None:
                        s['shift_start_mins'] = entry['shift_start_mins']
                    if entry.get('shift_end_mins') is not None:
                        s['shift_end_mins'] = entry['shift_end_mins']
                    if entry.get('breaks'):
                        s['breaks'] = entry['breaks']

            roster_info = {
                'roster_available': True,
                'solver_used':   rr.get('solver_used', 'greedy'),
                'mip_available': _ROSTER_SOLVER_AVAILABLE,
                'pattern_count': rr.get('pattern_count', 0),
                'patterns':      rr.get('patterns', []),
                'fairness':      rr.get('fairness', {}),
                'coverage':      rr.get('coverage', {}),
                'flags':         rr.get('flags', []),
                'utilisation':   rr.get('utilisation', {}),
            }
        except Exception as exc:
            roster_info = {'roster_available': False, 'error': str(exc)}

    result['roster'] = roster_info
    result['constraints_applied'] = {
        k: _intraday_custom_constraints.get(k) for k in tactical_keys
    }
    return jsonify(result)


# ===========================================================================
# SCENARIO PLANNING — MONTE CARLO SIMULATION ENGINE
# ===========================================================================

import math
import random
from datetime import datetime as _dt

# ── In-memory scenario store ─────────────────────────────────────────────────
_scenarios = {}          # {scenario_id: scenario_dict}
_scenario_seq = [0]      # auto-increment id counter

DEFAULT_CONSTRAINTS = {
    # ── Demand-side ─────────────────────────────────────────────────────────
    'surge_demand_factor':  1.0,    # Demand multiplier
    
    # ── Supply-side: staffing ────────────────────────────────────────────────
    'staff_utilisation':    0.80,   # target staff utilization
    'absence_rate':         0.06,   # mean fraction of staff absent
    'absence_cv':           0.02,   # CV of absence rate
    'cross_training_rate':  0.15,   # fraction of each skill pool cross-trained
    'new_hire_fraction':    0.00,   # fraction of workforce who are new hires
    'contractor_staff':     {'GNIB': 0, 'CBP Pre-clearance': 0, 'Arr Customer Service': 0,
                             'Check-in/Trolleys': 0, 'Dep / Trolleys': 0, 'T1/T2 Trolleys L/UL': 0,
                             'Transfer Corridor': 0, 'Ramp / Marshalling': 0, 'Bussing': 0,
                             'PBZ': 0, 'Mezz Operation': 0, 'Litter Picking': 0},
    'extra_staff':          {'GNIB': 0, 'CBP Pre-clearance': 0, 'Arr Customer Service': 0,
                             'Check-in/Trolleys': 0, 'Dep / Trolleys': 0, 'T1/T2 Trolleys L/UL': 0,
                             'Transfer Corridor': 0, 'Ramp / Marshalling': 0, 'Bussing': 0,
                             'PBZ': 0, 'Mezz Operation': 0, 'Litter Picking': 0},
    # ── Simulation ───────────────────────────────────────────────────────────
    'n_runs':               500,
}


def _box_muller():
    """Return one standard-normal sample using Box-Muller (no numpy needed)."""
    u1 = max(random.random(), 1e-12)
    u2 = random.random()
    return math.sqrt(-2 * math.log(u1)) * math.cos(2 * math.pi * u2)


def _rnorm(mean, std):
    return mean + std * _box_muller()


def _percentile(data, p):
    if not data:
        return 0.0
    s = sorted(data)
    k = (len(s) - 1) * p / 100.0
    lo, hi = int(k), min(int(k) + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (k - lo)


def _histogram(data, n_bins=20):
    """Return list of {x, count} bin dicts for a histogram."""
    if not data:
        return []
    lo, hi = min(data), max(data)
    if hi == lo:
        return [{'x': round(lo, 3), 'count': len(data)}]
    width = (hi - lo) / n_bins
    counts = [0] * n_bins
    for v in data:
        idx = min(int((v - lo) / width), n_bins - 1)
        counts[idx] += 1
    return [{'x': round(lo + (i + 0.5) * width, 3), 'count': counts[i]}
            for i in range(n_bins)]


def _extract_baseline(result):
    """Extract per-skill required & available staff-minutes from optimizer result."""
    skill_req   = defaultdict(float)   # total staff-mins required per skill
    skill_avail = defaultdict(float)   # total staff-mins available per skill

    for flight in result.get('flights', []):
        for task in flight.get('tasks', []):
            dur = max(task['end_mins'] - task['start_mins'], 1)
            skill_req[task['skill']] += task['staff_needed'] * dur

    for s in result.get('staff', []):
        shift_dur = s['shift_end'] - s['shift_start']
        skill_avail[s['skill1']] += shift_dur

    return dict(skill_req), dict(skill_avail)


def run_scenario_projection(start_date, end_date, constraints, n_runs=500):
    demand, staff_req, skill_req, staff_avail, skill_avail = get_data()
    
    # Filter weeks based on date range
    try:
        s_date = _dt.strptime(start_date, '%Y-%m-%d')
        e_date = _dt.strptime(end_date, '%Y-%m-%d')
    except Exception as e:
        return {'error': f'Invalid date format: {e}'}
    
    if s_date > e_date:
        return {'error': 'Invalid date range'}

    included_weeks = []
    # Identify weeks
    for wk_key in staff_req.keys():
        try:
            year_str, w_str = wk_key.split('-W')
            wk_d = _dt.strptime(f'{year_str}-W{int(w_str):02d}-1', '%G-W%V-%u')
        except:
            continue
        if s_date <= wk_d <= e_date:
            included_weeks.append(wk_key)

    included_weeks.sort() # Ensure chronological order for month map and charts

    if not included_weeks:
        return {'error': 'No data found for the selected date range'}

    surge_factor = float(constraints.get('surge_demand_factor', 1.0))
    target_util  = float(constraints.get('staff_utilisation', 0.80))
    absence_rate = float(constraints.get('absence_rate', 0.06))
    absence_cv   = float(constraints.get('absence_cv', 0.02))
    cross_rate   = float(constraints.get('cross_training_rate', 0.15))
    new_hire_frac= float(constraints.get('new_hire_fraction', 0.00))
    contractor_staff = constraints.get('contractor_staff', {})
    extra_staff      = constraints.get('extra_staff', {})
    total_extra_staff = sum(max(0.0, float(v or 0)) for v in extra_staff.values())
    total_contractor_staff = sum(max(0.0, float(v or 0)) for v in contractor_staff.values())

    new_hire_prod = 1.0 - max(0.0, min(1.0, new_hire_frac)) * 0.30

    skills = [
        'GNIB', 'CBP Pre-clearance', 'Arr Customer Service', 'Check-in/Trolleys',
        'Dep / Trolleys', 'T1/T2 Trolleys L/UL', 'Transfer Corridor',
        'Ramp / Marshalling', 'Bussing', 'PBZ', 'Mezz Operation', 'Litter Picking',
    ]

    # Group weeks by month
    month_map = defaultdict(list)
    for wk in included_weeks:
        year_str, w_str = wk.split('-W')
        wk_d = _dt.strptime(f'{year_str}-W{int(w_str):02d}-1', '%G-W%V-%u')
        mk = wk_d.strftime('%b %Y')
        month_map[mk].append(wk)
        
    monthly_risk = {}
    monthly_fte_breakdown = {}
    overall_coverage_runs = []
    overall_util_runs = []
    
    comparison_data = {
        'months': [],
        'demand_fte': [],
        'scenario_fte_req': [],
        'scenario_fte_avail': [],
        'current_fte': []
    }

    def stats(data):
        n = len(data)
        if n == 0: return {'mean': 0, 'p10': 0, 'p50': 0, 'p90': 0}
        s = sorted(data)
        return {
            'mean': sum(s)/n,
            'p10': _percentile(s, 10),
            'p50': _percentile(s, 50),
            'p90': _percentile(s, 90)
        }

    for month_label, weeks in month_map.items():
        month_cov_runs = []
        month_skill_cov = defaultdict(list)
        
        month_base_req = 0
        month_base_avail = 0
        month_scen_req = 0
        month_scen_avail = 0

        month_sk_exp_req = {sk: 0 for sk in skills}
        month_sk_exp_avail = {sk: 0 for sk in skills}
        month_sk_base_req = {sk: 0 for sk in skills}
        month_sk_base_avail = {sk: 0 for sk in skills}

        for wk in weeks:
            req_sk = skill_req.get(wk, {})
            avail_sk = skill_avail.get(wk, {})
            
            wk_base_req = float(staff_req.get(wk, 0))
            wk_base_avail = float(staff_avail.get(wk, 0))
            month_base_req += wk_base_req
            month_base_avail += wk_base_avail

            for _ in range(n_runs):
                absence_f = max(0.0, min(0.6, _rnorm(absence_rate, absence_cv)))
                contr_f = max(0.4, min(1.0, _rnorm(0.85, 0.10)))
                
                run_scen_req = wk_base_req * surge_factor
                
                sk_perm = {}
                for sk in skills:
                    base = avail_sk.get(sk, 0) + extra_staff.get(sk, 0)
                    sk_perm[sk] = base * (1.0 - absence_f) * new_hire_prod * target_util

                base_total_avail = (wk_base_avail + total_extra_staff) * (1.0 - absence_f) * new_hire_prod * target_util
                contractor_total_avail = total_contractor_staff * contr_f * target_util
                run_scen_avail = base_total_avail + contractor_total_avail
                
                total_perm = sum(sk_perm.values())
                flex_per_skill = (total_perm * cross_rate) / len(skills) if skills else 0.0

                for sk in skills:
                    r = req_sk.get(sk, 0) * surge_factor
                    c_avail = contractor_staff.get(sk, 0) * contr_f * target_util
                    a = sk_perm[sk] + c_avail + flex_per_skill

                    cov = min(a / r, 1.0) if r > 0 else 1.0
                    month_skill_cov[sk].append(cov)

                wk_cov = min(run_scen_avail / run_scen_req, 1.0) if run_scen_req > 0 else 1.0
                wk_util = min(run_scen_req / run_scen_avail, 1.0) if run_scen_avail > 0 else 1.0
                month_cov_runs.append(wk_cov)
                overall_coverage_runs.append(wk_cov)
                overall_util_runs.append(wk_util)

            wk_exp_req = 0
            wk_exp_avail = 0
            for sk in skills:
                wk_sk_base_req = req_sk.get(sk, 0)
                month_sk_base_req[sk] += wk_sk_base_req
                
                wk_sk_req = wk_sk_base_req * surge_factor
                wk_sk_avail = ((avail_sk.get(sk, 0) + extra_staff.get(sk, 0)) * (1.0 - absence_rate) * new_hire_prod * target_util) + (contractor_staff.get(sk, 0) * 0.85 * target_util)
                month_sk_exp_req[sk] += wk_sk_req
                month_sk_exp_avail[sk] += wk_sk_avail
                wk_sk_base_avail = avail_sk.get(sk, 0)
                month_sk_base_avail[sk] += wk_sk_base_avail

            wk_exp_req = wk_base_req * surge_factor
            wk_exp_avail = (
                (wk_base_avail + total_extra_staff) * (1.0 - absence_rate) * new_hire_prod * target_util
            ) + (total_contractor_staff * 0.85 * target_util)

            month_scen_req += wk_exp_req
            month_scen_avail += wk_exp_avail
            
        wn = len(weeks)
        if wn > 0:
            comparison_data['months'].append(month_label)
            comparison_data['demand_fte'].append(month_base_req / wn)
            comparison_data['scenario_fte_req'].append(month_scen_req / wn)
            comparison_data['scenario_fte_avail'].append(month_scen_avail / wn)
            comparison_data['current_fte'].append(month_base_avail / wn)

        monthly_risk[month_label] = {}
        for sk in skills:
            st = stats(month_skill_cov[sk])
            rs = max(0, min(100, ((1 - st['p50']) * 40 + (1 - st['p10']) * 40) * 100))
            rl = 'Low' if rs < 20 else 'Medium' if rs < 45 else 'High' if rs < 65 else 'Critical'
            monthly_risk[month_label][sk] = {
                'p50': st['p50'],
                'risk_score': rs,
                'risk_level': rl
            }
            
        monthly_fte_breakdown[month_label] = {
            'req': {sk: month_sk_exp_req[sk] / wn for sk in skills},
            'avail': {sk: month_sk_exp_avail[sk] / wn for sk in skills},
            'base_req': {sk: month_sk_base_req[sk] / wn for sk in skills},
            'base_avail': {sk: month_sk_base_avail[sk] / wn for sk in skills},
            'base_total_req': month_base_req / wn,
            'base_total_avail': month_base_avail / wn,
            'scenario_total_req': month_scen_req / wn,
            'scenario_total_avail': month_scen_avail / wn,
        }

    overall_cov_st = stats(overall_coverage_runs)
    avg_util = sum(overall_util_runs) / len(overall_util_runs) if overall_util_runs else 0
    
    prob_critical = sum(1 for c in overall_coverage_runs if c < 0.50) / len(overall_coverage_runs) if overall_coverage_runs else 0
    raw_risk = ((1 - overall_cov_st['p50']) * 40 + (1 - overall_cov_st['p10']) * 40 + prob_critical * 20)
    risk_score = round(max(0, min(100, raw_risk * 100)), 1)
    if risk_score < 20: risk_level = 'Low'
    elif risk_score < 45: risk_level = 'Medium'
    elif risk_score < 65: risk_level = 'High'
    else: risk_level = 'Critical'
    
    return {
        'n_runs': n_runs,
        'coverage': overall_cov_st,
        'average_utilisation': avg_util,
        'overall_coverage': overall_cov_st['mean'],
        'median_coverage': overall_cov_st['p50'],
        'risk_score': risk_score,
        'risk_level': risk_level,
        'monthly_risk': monthly_risk,
        'monthly_fte_breakdown': monthly_fte_breakdown,
        'comparison_data': comparison_data
    }


# ── Scenario endpoints ────────────────────────────────────────────────────────

@app.route('/api/scenarios', methods=['GET'])
def list_scenarios():
    out = []
    for sid, sc in sorted(_scenarios.items(), key=lambda x: x[1]['created_at']):
        r = sc.get('results', {})
        out.append({
            'id':          sid,
            'name':        sc['name'],
            'status':      sc['status'],
            'created_at':  sc['created_at'],
            'base_date':   sc['base_date'],
            'start_date':  sc.get('start_date', sc['base_date']),
            'end_date':    sc.get('end_date', sc['base_date']),
            'risk_score':  r.get('risk_score'),
            'risk_level':  r.get('risk_level'),
            'p50_coverage': r.get('median_coverage'),
            'average_utilisation': r.get('average_utilisation'),
            'n_runs':      r.get('n_runs'),
            'constraints': sc['constraints'],
        })
    return jsonify(out)


@app.route('/api/scenarios/run', methods=['POST'])
def run_scenario():
    body = request.get_json(force=True) or {}
    name       = body.get('name', f'Scenario {_scenario_seq[0]+1}').strip() or f'Scenario {_scenario_seq[0]+1}'
    start_date = body.get('start_date', _dt.now().strftime('%Y-%m-%d'))
    end_date   = body.get('end_date', _dt.now().strftime('%Y-%m-%d'))
    base_date  = _dt.now().strftime('%Y-%m-%d')
    constraints = {**DEFAULT_CONSTRAINTS, **body.get('constraints', {})}
    # Merge dict-valued constraints carefully so partial overrides work
    body_constraints = body.get('constraints', {})
    constraints['extra_staff'] = {
        **DEFAULT_CONSTRAINTS['extra_staff'],
        **body_constraints.get('extra_staff', {}),
    }
    constraints['contractor_staff'] = {
        **DEFAULT_CONSTRAINTS['contractor_staff'],
        **body_constraints.get('contractor_staff', {}),
    }
    n_runs = int(constraints.get('n_runs', 500))

    results = run_scenario_projection(start_date, end_date, constraints, n_runs)
    if 'error' in results:
        return jsonify(results), 400

    _scenario_seq[0] += 1
    sid = f'sc_{_scenario_seq[0]:03d}'
    _scenarios[sid] = {
        'id':          sid,
        'name':        name,
        'status':      'active',
        'created_at':  _dt.now().strftime('%Y-%m-%dT%H:%M:%S'),
        'base_date':   base_date,
        'start_date':  start_date,
        'end_date':    end_date,
        'constraints': constraints,
        'results':     results,
    }
    return jsonify({'id': sid, **_scenarios[sid]})


@app.route('/api/scenarios/<sid>', methods=['GET'])
def get_scenario(sid):
    sc = _scenarios.get(sid)
    if not sc:
        return jsonify({'error': 'Not found'}), 404
    return jsonify(sc)


@app.route('/api/scenarios/<sid>/finalise', methods=['POST'])
def finalise_scenario(sid):
    sc = _scenarios.get(sid)
    if not sc:
        return jsonify({'error': 'Not found'}), 404
    # Unfinalise all others
    for s in _scenarios.values():
        s['status'] = 'active'
    sc['status'] = 'finalised'
    return jsonify({'id': sid, 'status': 'finalised'})


@app.route('/api/scenarios/<sid>', methods=['DELETE'])
def delete_scenario(sid):
    if sid not in _scenarios:
        return jsonify({'error': 'Not found'}), 404
    del _scenarios[sid]
    return jsonify({'deleted': sid})


def update_csv_dates_to_current():
    """Auto-update CSV dates to start from today."""
    now = datetime.now()
    
    # 1. Update Flights_schedule_4days.csv
    flights_path = os.path.join(BASE_DIR, 'data', 'Flights_schedule_4days.csv')
    if os.path.exists(flights_path):
        with open(flights_path, encoding='cp1252') as f:
            reader = csv.DictReader(f)
            rows = list(reader)
            fieldnames = reader.fieldnames
        if rows:
            raw_dates = set(r.get('date', '').strip() for r in rows if r.get('date', '').strip())
            parsed = [(parse_date(d), d) for d in raw_dates if parse_date(d)]
            parsed.sort(key=lambda x: x[0])
            
            if parsed:
                date_map = {}
                for i, (d_obj, d_str) in enumerate(parsed):
                    date_map[d_str] = (now + timedelta(days=i)).strftime('%d-%b-%y')
                for r in rows:
                    if r.get('date', '').strip() in date_map:
                        r['date'] = date_map[r.get('date', '').strip()]
                with open(flights_path, 'w', encoding='cp1252', newline='') as f:
                    writer = csv.DictWriter(f, fieldnames=fieldnames)
                    writer.writeheader()
                    writer.writerows(rows)

    # 2. Update Staff_schedule.csv
    staff_path = os.path.join(BASE_DIR, 'data', 'Staff_schedule.csv')
    if os.path.exists(staff_path):
        with open(staff_path, encoding='utf-8-sig') as f:
            reader = csv.DictReader(f)
            rows = list(reader)
            fieldnames = reader.fieldnames
        if rows:
            raw_dates = set(r.get('DATE', '').strip() for r in rows if r.get('DATE', '').strip())
            parsed = [(parse_date(d), d) for d in raw_dates if parse_date(d)]
            parsed.sort(key=lambda x: x[0])
            
            if parsed:
                date_map = {}
                for i, (d_obj, d_str) in enumerate(parsed):
                    date_map[d_str] = (now + timedelta(days=i)).strftime('%d-%m-%Y')
                for r in rows:
                    if r.get('DATE', '').strip() in date_map:
                        r['DATE'] = date_map[r.get('DATE', '').strip()]
                with open(staff_path, 'w', encoding='utf-8-sig', newline='') as f:
                    writer = csv.DictWriter(f, fieldnames=fieldnames)
                    writer.writeheader()
                    writer.writerows(rows)

    # 3. Update Weekly_flight_demand.csv status (Historical vs Forecast)
    demand_path = os.path.join(BASE_DIR, 'data', 'Weekly_flight_demand.csv')
    if os.path.exists(demand_path):
        with open(demand_path, encoding='utf-8-sig') as f:
            reader = csv.DictReader(f)
            rows = list(reader)
            fieldnames = reader.fieldnames
        if rows:
            changed = False
            for r in rows:
                week_start_str = r.get('Week_Start', '').strip()
                if not week_start_str:
                    continue
                ws_date = parse_date(week_start_str)
                if ws_date:
                    # A week is considered completed if the current time is past its 7-day duration
                    if now >= ws_date + timedelta(days=7):
                        new_type = 'Historical'
                    else:
                        new_type = 'Forecast'
                    
                    if r.get('Data_type') != new_type:
                        r['Data_type'] = new_type
                        changed = True
            
            if changed:
                with open(demand_path, 'w', encoding='utf-8-sig', newline='') as f:
                    writer = csv.DictWriter(f, fieldnames=fieldnames)
                    writer.writeheader()
                    writer.writerows(rows)

# ===========================================================================
# UNIFIED SHORT-TERM OPTIMISE ENDPOINT
# ===========================================================================

@app.route('/api/short-term/optimise', methods=['POST'])
def st_optimise():
    """Apply all constraints + run roster optimiser → return full updated schedule.

    Body:
      date, use_mip, min_rest_hrs,
      tt_t1_t2, tt_skill_switch, use_primary_first, allow_overlaps,
      shift_duration_hrs, b1_duration_mins, b2_duration_mins,
      leave_types_excluded, permitted_shifts
    """
    global _st_custom_constraints

    body = request.get_json(force=True) or {}
    date = (body.get('date') or '').strip()
    if not date:
        return jsonify({'error': 'date required'}), 400

    use_mip = bool(body.get('use_mip', True))
    min_rest_hrs = float(body.get('min_rest_hrs', 11))

    # ── 1. Persist tactical constraints ──────────────────────────────
    tactical_keys = [
        'tt_t1_t2', 'tt_skill_switch', 'use_primary_first', 'allow_overlaps',
        'shift_duration_hrs', 'b1_duration_mins', 'b2_duration_mins',
        'leave_types_excluded', 'permitted_shifts',
    ]
    for k in tactical_keys:
        if k in body:
            _st_custom_constraints[k] = body[k]

    # ── 2. Re-run tactical schedule (clears manual overrides for fresh plan) ──
    _manual_assigns.pop(date, None)
    result = _get_short_term_schedule(date, preserve_manual_assigns=False)
    if 'error' in result:
        return jsonify(result), 404

    roster_info = {'roster_available': False, 'solver_used': 'none'}

    # ── 3. Run roster optimiser and merge assignments ─────────────────
    if _ROSTER_AVAILABLE:
        try:
            on_duty = result.get('staff', [])
            flights = result.get('flights', [])

            # Derive demand windows from today's tasks
            all_tasks = [t for f in flights for t in f.get('tasks', [])]
            demand_windows = _roster_tasks_to_dw(all_tasks) if all_tasks else []

            # Fallback: two synthetic anchor windows covering the day
            if not demand_windows:
                anchor_skill = on_duty[0].get('skill1', 'GNIB') if on_duty else 'GNIB'
                demand_windows = [
                    _RosterDemandWindow(240,  960,  anchor_skill, 1, 'Standard'),
                    _RosterDemandWindow(960, 1440,  anchor_skill, 1, 'Standard'),
                ]

            # Normalise staff list for the optimiser
            staff_norm = [
                {
                    'id':               s.get('id', s.get('name', '')),
                    'skill1':           s.get('skill1', ''),
                    'skill2':           s.get('skill2', ''),
                    'shift_start_mins': s.get('shift_start_mins', 240),
                    'shift_end_mins':   s.get('shift_end_mins',   960),
                }
                for s in on_duty
            ]

            roster_constraints = {
                'shift_duration_hrs': _st_custom_constraints.get('shift_duration_hrs', 12),
                'min_rest_mins':      int(min_rest_hrs * 60),
                'b1_duration_mins':   _st_custom_constraints.get('b1_duration_mins', 30),
                'b2_duration_mins':   _st_custom_constraints.get('b2_duration_mins', 60),
            }

            rr = _roster_generate(
                demand_windows=demand_windows,
                staff_list=staff_norm,
                constraints=roster_constraints,
                use_mip=use_mip
            )

            # Merge optimised shift/break assignments back into the staff list
            roster_map = {e['id']: e for e in (rr.get('roster') or [])}
            for s in result['staff']:
                sid = s.get('id', s.get('name', ''))
                entry = roster_map.get(sid)
                if entry and entry.get('pattern_id') != 'unassigned':
                    s['shift_label']      = entry.get('shift_label', s.get('shift', ''))
                    s['pattern_id']       = entry.get('pattern_id', '')
                    s['skill_match']      = entry.get('skill_match', 'primary')
                    s['utilisation_pct']  = entry.get('utilisation_pct', 0)
                    if entry.get('shift_start_mins') is not None:
                        s['shift_start_mins'] = entry['shift_start_mins']
                    if entry.get('shift_end_mins') is not None:
                        s['shift_end_mins'] = entry['shift_end_mins']
                    if entry.get('breaks'):
                        s['breaks'] = entry['breaks']

            roster_info = {
                'roster_available': True,
                'solver_used':   rr.get('solver_used', 'greedy'),
                'mip_available': _ROSTER_SOLVER_AVAILABLE,
                'pattern_count': rr.get('pattern_count', 0),
                'patterns':      rr.get('patterns', []),
                'fairness':      rr.get('fairness', {}),
                'coverage':      rr.get('coverage', {}),
                'flags':         rr.get('flags', []),
                'utilisation':   rr.get('utilisation', {}),
            }
        except Exception as exc:
            roster_info = {'roster_available': False, 'error': str(exc)}

    result['roster'] = roster_info
    result['constraints_applied'] = {
        k: _st_custom_constraints.get(k) for k in tactical_keys
    }
    return jsonify(result)


# ===========================================================================
# ROSTER OPTIMISATION ENDPOINT
# ===========================================================================

@app.route('/api/roster/optimised', methods=['GET', 'POST'])
def roster_optimised():
    """Two-phase roster optimisation: shift-pattern generation → staff assignment.

    GET  ?date=YYYY-MM-DD[&use_mip=true]
    POST { "date": "YYYY-MM-DD",
           "use_mip": true,
           "constraints": {
             "b1_duration_mins": 30,
             "b2_duration_mins": 60,
             "min_rest_mins": 660,
             "shift_duration_hrs": 12
           }
         }

    Phase 1 — Shift-Pattern Generation
      Generates all feasible patterns on a 60-minute grid up to 12 h.
      Scores each by weighted demand coverage; prunes to ≤18 candidates.
      Always retains DAY (00:00–12:00) and NIGHT (12:00–24:00) anchors.

    Phase 2a — Greedy Assignment  (always runs)
      Assigns staff to patterns respecting 11-hour rest, skill fit, and load balance.

    Phase 2b — MIP Refinement  (optional; requires PuLP)
      Minimises skill-mismatch cost + L1 workload deviation + demand coverage gaps.

    Response
    --------
    {
      "date":           "YYYY-MM-DD",
      "solver_used":    "CBC (PuLP MIP)" | "Greedy",
      "mip_status":     "Optimal" | "greedy_only" | …,
      "roster_available": true,
      "staff_count":    42,
      "pattern_count":  8,
      "patterns":       [ {id, label, start_mins, end_mins, net_mins,
                           coverage_score, demand_profile, staff_count} … ],
      "roster":         [ {id, skill1-4, employment, pattern_id, shift_label,
                           shift_start, shift_end, shift_duration_mins,
                           net_working_mins, utilisation_pct, skill_match,
                           breaks, assignments} … ],
      "utilisation":    { staff_id: {gross_mins, net_working_mins,
                                     utilisation_pct, pattern_id, skill_match} },
      "fairness":       { gini_coefficient, mean_utilisation_pct,
                          std_utilisation_pct, min_utilisation_pct,
                          max_utilisation_pct, interpretation },
      "coverage":       { skill: {needed, covered, coverage_pct} },
      "flags":          [ {flag_id, severity, staff_id, detail} … ],
      "absent_staff":   [ {id, skill1, leave_type} … ],
      "constraints_used": { … }
    }
    """
    if not _ROSTER_AVAILABLE:
        return jsonify({
            'error':   'roster_optimizer module not available',
            'message': 'Ensure roster_optimizer.py is present in the project root.',
        }), 503

    # ── Parse parameters ────────────────────────────────────────────────────
    if request.method == 'POST':
        body = request.get_json(force=True) or {}
    else:
        body = {}

    date_str = (
        body.get('date')
        or request.args.get('date', '')
        or datetime.now().strftime('%Y-%m-%d')
    ).strip()

    use_mip_param = body.get('use_mip', request.args.get('use_mip', 'true'))
    use_mip = str(use_mip_param).lower() not in ('false', '0', 'no')

    constraints_override = body.get('constraints', {})
    constraints = {
        'b1_duration_mins':  int(constraints_override.get('b1_duration_mins', 30)),
        'b2_duration_mins':  int(constraints_override.get('b2_duration_mins', 60)),
        'min_rest_mins':     int(constraints_override.get('min_rest_mins', 660)),
        'shift_duration_hrs': int(constraints_override.get('shift_duration_hrs', 12)),
    }
    constraints['max_shift_mins'] = constraints['shift_duration_hrs'] * 60

    # ── Validate date ───────────────────────────────────────────────────────
    parsed_date = None
    for fmt in ('%Y-%m-%d', '%d-%b-%y', '%d-%m-%Y', '%d-%m-%y'):
        try:
            parsed_date = datetime.strptime(date_str, fmt)
            break
        except ValueError:
            pass
    if parsed_date is None:
        return jsonify({'error': f'Invalid date: {date_str!r}'}), 400

    # ── Load staff & absences for the date ─────────────────────────────────
    # We call the existing path (without the optimiser branch) to get the raw
    # staff list and absent staff.  The optimiser branch is applied below after
    # we have built demand windows from the day's flights.
    on_duty_raw, absent_staff = get_staff_for_date(
        date_str,
        custom_constraints={
            'shift_duration_hrs':  constraints['shift_duration_hrs'],
            'b1_duration_mins':    constraints['b1_duration_mins'],
            'b2_duration_mins':    constraints['b2_duration_mins'],
            'leave_types_excluded': constraints_override.get(
                'leave_types_excluded',
                ['Annual Leave', 'Paternity Leave', 'Jury Duty', 'Sick Leave', 'Training'],
            ),
        },
        use_roster_optimiser=False,   # raw list first; optimiser applied below
    )

    if not on_duty_raw:
        return jsonify({
            'date':           date_str,
            'error':          'No staff scheduled for this date',
            'absent_staff':   absent_staff,
            'roster_available': False,
        }), 404

    # ── Build demand windows from the day's flights ─────────────────────────
    # Re-use optimize_day task generation machinery to derive demand windows.
    rules      = load_config_rules()
    stands_map = get_stands_map()

    # Read flights for this date
    all_flights  = read_csv_flights()
    date_csv_key = parsed_date.strftime('%d-%b-%y')
    day_flights  = [f for f in all_flights if f.get('date', '').strip() == date_csv_key]

    demand_windows: list = []
    if day_flights:
        # Build processed flights for task generation (same pre-processing as optimize_day)
        processed = []
        for f in day_flights:
            sta_m = parse_time(f.get('sta', ''))
            if sta_m is None:
                continue
            status  = f.get('Status', '').strip()
            icao    = f.get('icao_wake', '').strip().upper()
            cbp_flag = f.get('cbp', '')
            haul    = icao_to_haul(icao, cbp_flag)
            stand   = f.get('stand', '').strip()
            stand_info = stands_map.get(stand, {'type': 'Contact', 'terminal': 'T1', 'pier': 'P1'})
            is_remote  = stand_info.get('type', '').lower() in ('remote', 'apron')

            processed.append({
                'time_mins':   sta_m,
                'status':      status,
                'haul':        haul,
                'stand':       stand,
                'is_remote':   is_remote,
                'terminal':    stand_info.get('terminal', 'T1'),
                'pier':        stand_info.get('pier', 'P1'),
                'flight_no':   f.get('flight_no', ''),
                'icao':        icao,
            })

        day_tasks = _generate_day_tasks(processed, rules, stands_map, SHARING_WINDOW_MINS)
        demand_windows = _roster_tasks_to_dw(day_tasks)

    # If no flights data, synthesise two 12-hour demand blocks (DAY + NIGHT)
    # so the engine always has something to score patterns against.
    if not demand_windows:
        demand_windows = [
            _RosterDemandWindow(start=240,  end=960,  skill='GNIB', needed=3, priority='Medium'),
            _RosterDemandWindow(start=960,  end=1440, skill='GNIB', needed=2, priority='Medium'),
        ]

    # ── Normalise staff dicts for the optimiser ─────────────────────────────
    staff_list = [
        {
            'id':         s['id'],
            'skill1':     s.get('skill1', ''),
            'skill2':     s.get('skill2', ''),
            'skill3':     s.get('skill3', ''),
            'skill4':     s.get('skill4', ''),
            'employment': s.get('employment', ''),
        }
        for s in on_duty_raw
    ]

    # ── Run roster optimiser ────────────────────────────────────────────────
    roster_result = _roster_generate(
        demand_windows  = demand_windows,
        staff_list      = staff_list,
        constraints     = constraints,
        prev_shift_ends = {},   # no cross-day state at this endpoint for now
        use_mip         = use_mip,
    )

    # ── Build response ──────────────────────────────────────────────────────
    return jsonify({
        'date':              date_str,
        'roster_available':  True,
        'solver_used':       roster_result.get('solver_used', 'Greedy'),
        'mip_status':        roster_result.get('mip_status', 'greedy_only'),
        'mip_available':     _ROSTER_SOLVER_AVAILABLE,
        'staff_count':       roster_result.get('staff_count', len(staff_list)),
        'pattern_count':     roster_result.get('pattern_count', 0),
        'patterns':          roster_result.get('patterns', []),
        'roster':            roster_result.get('roster', []),
        'utilisation':       roster_result.get('utilisation', {}),
        'fairness':          roster_result.get('fairness', {}),
        'coverage':          roster_result.get('coverage', {}),
        'flags':             roster_result.get('flags', []),
        'absent_staff':      absent_staff,
        'demand_windows':    [
            {
                'start':    dw.start,
                'end':      dw.end,
                'skill':    dw.skill,
                'needed':   dw.needed,
                'priority': dw.priority,
                'task_id':  dw.task_id,
            }
            for dw in demand_windows
        ],
        'constraints_used':  constraints,
    })


# ===========================================================================
# MONTE CARLO SIMULATION ENDPOINT  (/api/simulation/run)
# ===========================================================================

@app.route('/api/simulation/run', methods=['POST'])
def simulation_run():
    """Intraday Monte Carlo stress-test for a staffing plan.

    This is a VALIDATION layer — it does not modify any optimisation logic.
    It perturbs the environment (delays, absences, surge) and measures how
    well the original plan survives across hundreds of random scenarios.

    POST body
    ---------
    {
      "date":     "YYYY-MM-DD",          // date to simulate (required)
      "num_runs": 200,                   // iterations 10-1000 (default 100)
      "params": {
        "delay_sigma_mins":  15,         // std-dev of per-flight delay draw
        "delay_max_mins":    30,         // hard cap on delay magnitude
        "delay_prob":        0.25,       // fraction of flights delayed per run
        "absence_rate_min":  0.05,       // minimum run-level absence fraction
        "absence_rate_max":  0.15,       // maximum run-level absence fraction
        "surge_mean":        1.0,        // expected passenger surge factor
        "surge_sigma":       0.10,       // log-normal sigma for surge draw
        "seed":              null        // int for reproducibility, null = random
      }
    }

    Response
    --------
    {
      "date":        "YYYY-MM-DD",
      "risk_score":  42.3,              // 0-100 composite risk index
      "risk_level":  "Medium",          // Low / Medium / High / Critical
      "summary": {
        "num_runs":             200,
        "unserved_tasks":       {mean, std, p10, p50, p90, p99, ...},
        "staff_utilisation":    {mean, std, p10, p50, p90, p99, ...},
        "critical_failure_probability": 0.12,
        "prob_any_unserved":    0.65,
        "prob_gt10pct_unserved": 0.18,
        ...
      },
      "worst_case": {
        "run_id": 47,
        "unserved_pct": 28.6,
        "absent_count": 9,
        "delayed_flights": {"EI123": 28, ...},
        "failing_tasks":  [{task_id, label, skill, priority, gap, ...}],
        ...
      },
      "bottlenecks": {
        "top_failing_tasks": [{task_id, label, skill, fail_rate_pct, avg_gap}],
        "failing_skills":    [{skill, fail_rate_pct, total_gap_headcount}],
        "tasks_never_failed": 18,
      },
      "distributions": {
        "unserved_pct":     [{x, count}, ...],
        "utilisation_mean": [{x, count}, ...],
        ...
      },
      "baseline": {
        "total_tasks": 35,
        "unserved_tasks": 2,
        "coverage_pct": 94.3,
        ...
      },
      "run_log": [{run_id, unserved_pct, absent_count, ...}],
      "params_used": {...},
      "meta": {elapsed_seconds, runs_per_second, ...}
    }
    """
    if not _SIM_AVAILABLE:
        return jsonify({
            "error":   "simulation_engine module not available",
            "message": "Ensure simulation_engine.py is in the project root.",
        }), 503

    body = request.get_json(force=True) or {}

    # ── Parse date ──────────────────────────────────────────────────────────
    date_str = body.get("date", "").strip()
    if not date_str:
        date_str = datetime.now().strftime("%Y-%m-%d")

    parsed_date = None
    for fmt in ("%Y-%m-%d", "%d-%b-%y", "%d-%m-%Y", "%d-%m-%y"):
        try:
            parsed_date = datetime.strptime(date_str, fmt)
            break
        except ValueError:
            pass
    if parsed_date is None:
        return jsonify({"error": f"Invalid date: {date_str!r}"}), 400

    # ── Parse simulation parameters ─────────────────────────────────────────
    num_runs = int(body.get("num_runs", 100))
    num_runs = max(10, min(num_runs, 1000))

    sim_params = body.get("params", {})

    # ── Build the base plan via optimize_day (read-only) ────────────────────
    # We call the standard day optimiser to get the current staffing plan.
    # The simulation layer then stress-tests this plan without touching it.
    plan = optimize_day(
        date_str,
        overrides={},
        manual_assigns={},
        custom_constraints=_st_custom_constraints,
    )

    if "error" in plan:
        return jsonify({
            "error": f"Could not build plan for {date_str}: {plan['error']}",
            "date":  date_str,
        }), 404

    if not plan.get("tasks"):
        return jsonify({
            "error": "Plan has no tasks — no flights scheduled for this date?",
            "date":  date_str,
            "kpis":  plan.get("kpis", {}),
        }), 404

    # ── Run Monte Carlo simulation ──────────────────────────────────────────
    try:
        sim_result = _sim_run_simulation(
            plan     = plan,
            num_runs = num_runs,
            params   = sim_params or None,
        )
    except Exception as exc:
        logger.exception("Simulation failed for date %s", date_str)
        return jsonify({"error": str(exc), "date": date_str}), 500

    # ── Attach plan-level context to the response ───────────────────────────
    sim_result["date"]         = date_str
    sim_result["date_label"]   = plan.get("date_label", date_str)
    sim_result["plan_kpis"]    = plan.get("kpis", {})
    sim_result["sim_available"] = True

    return jsonify(sim_result)


@app.route('/api/simulation/status', methods=['GET'])
def simulation_status():
    """Quick availability check for the simulation engine."""
    return jsonify({
        "sim_available": _SIM_AVAILABLE,
        "message": (
            "Monte Carlo simulation engine ready."
            if _SIM_AVAILABLE
            else "simulation_engine.py not found. Ensure it is in the project root."
        ),
    })


# Auto-update CSV dates on start-up (ensures compatibility with WSGI servers like Gunicorn/Render)
update_csv_dates_to_current()

if __name__ == '__main__':
    app.run(debug=True)

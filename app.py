from flask import Flask, jsonify, request, render_template
import csv
import json
import os
import re
from datetime import datetime, timedelta
from collections import defaultdict

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
    ('International Short-Haul', 'Arrival'):   {'Arr Customer Service': 0.51, 'Check-in / Trolleys': 0.42, 'Bussing': 0.07},
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
#  Litter Picking  : 3 shift slots (480+420+420 min) × 7 days / 3150 = 2.93 FTE
#  CBP Hall        : 3 staff × 300 min/session × 5 days / 3150 = 1.43 FTE
#  PBZ (T2 pier)   : 4 roster slots (session-based, consistent) = ~1.27 FTE
FIXED_FTE = {
    'Mezz Operation':     0.95,
    'Litter Picking':     2.93,
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

        include = (dtype == 'Forecast' and sc in ('S26', 'W26')) or \
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

    # Build skill pool
    skill_pool = defaultdict(int)
    for s in staff:
        skill_pool[s.get('Skill1', '').strip()] += 1

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
                sk_name = emp_data.get('Skill1', '').strip()
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
    gap   = round(req - avail, 1)
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

    for wk_key, sk_req in skill_req.items():
        try:
            year_str, w_str = wk_key.split('-W')
            d = datetime.strptime(f'{year_str}-W{int(w_str):02d}-1', '%G-W%V-%u')
        except:
            continue
        month_key = d.strftime('%b %Y')
        for skill, fte in sk_req.items():
            monthly_skill[month_key][skill].append(fte)
        monthly_total_req[month_key].append(staff_req.get(wk_key, 0))
        monthly_total_avail[month_key].append(staff_avail.get(wk_key, 50))

    skills = ['GNIB', 'CBP Pre-clearance', 'Bussing', 'PBZ', 'Mezz Operation', 'Litter Picking', 'Ramp / Marshalling']
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
        row['gap'] = round(row['total_required'] - row['total_available'], 1)
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
        gap = round(req - avail, 1)
        result.append({
            'week': wk_key,
            'date': d.strftime('%d %b %Y'),
            'month': d.strftime('%b'),
            'required': req,
            'available': avail,
            'gap': gap,
            'status': 'critical' if gap > 10 else ('warning' if gap > 0 else 'ok'),
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

    # Total staff by primary skill
    total_by_skill = defaultdict(int)
    for s in staff:
        total_by_skill[s.get('Skill1', '').strip()] += 1

    # Monthly absent days per skill
    monthly_absent = defaultdict(lambda: defaultdict(int))
    for emp, windows in absence_map.items():
        emp_data = next((s for s in staff if s['EMPLOYEE NUMBER'] == emp), None)
        if not emp_data:
            continue
        sk = emp_data.get('Skill1', '').strip()
        for (f, t) in windows:
            d = f
            while d <= t:
                if d.year == 2026:
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
        gap_total = round(req_total - avail_total, 1)

        sk_gaps = {}
        for sk in all_skills:
            s_req = skill_req.get(wk_key, {}).get(sk, 0)
            s_avail = skill_avail.get(wk_key, {}).get(sk, 0)
            sk_gaps[sk] = round(s_req - s_avail, 1)

        weekly_data.append({
            'week': wk_key,
            'date': d.strftime('%d %b %Y'),
            'month': d.strftime('%b'),
            'required': req_total,
            'available': avail_total,
            'gap': gap_total,
            'skill_gaps': sk_gaps,
            'status': 'critical' if gap_total > 10 else ('warning' if gap_total > 0 else 'ok')
        })

    # Summary by skill (average across all weeks)
    skill_summary = []
    for sk in all_skills:
        gaps = [w['skill_gaps'].get(sk, 0) for w in weekly_data]
        avg_gap = round(sum(gaps) / len(gaps), 1) if gaps else 0
        peak_gap = round(max(gaps), 1) if gaps else 0
        skill_summary.append({
            'skill': sk,
            'avg_gap': avg_gap,
            'peak_gap': peak_gap,
            'status': 'critical' if avg_gap > 5 else ('warning' if avg_gap > 0 else 'ok')
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
        sk = emp_data.get('Skill1', '').strip()
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
    'GNIB / Immigration':   'GNIB',
    'CBP Pre-clearance':    'CBP Pre-clearance',
    'Ramp / Marshalling':   'GNIB',
    'Bussing':              'Bussing',
    'Transfer Corridor':    'GNIB',
    'Check-in / Trolleys':  'GNIB',
    'Dep / Trolleys':       'Bussing',
    'Arr Customer Service': 'GNIB',
    'Mezz Operation':       'Mezz Operation',
    'Litter Picking':       'Litter Picking',
    'PBZ':                  'PBZ',
    'T1/T2 Trolleys L/UL':  'Bussing',
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
    'Check-in / Trolleys',
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
    """Parse Config.csv and cache in _config_rules."""
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
        try:
            start_offset = int(r.get('Start Offset (mins)', '0') or 0)
        except ValueError:
            start_offset = 0
        try:
            end_offset = int(r.get('End Offset (mins)', '0') or 0)
        except ValueError:
            end_offset = 0
        dur_raw = r.get('Duration (mins)', '').strip()
        if dur_raw == '' or dur_raw.lower() == 'variable' or dur_raw == '0':
            duration = None
        else:
            try:
                duration = int(dur_raw)
            except ValueError:
                duration = None
        sc_raw = r.get('Staff Count', '').strip()
        try:
            staff_count = int(sc_raw)
        except ValueError:
            staff_count = 1
        rules.append({
            'task':           task,
            'terminal':       r.get('Terminal', '').strip(),
            'priority':       r.get('Priority', 'Medium').strip(),
            'flight_type':    r.get('Flight Type', '').strip(),
            'haul_subtype':   r.get('Haul / Sub-Type', '').strip(),
            'window_start_ref': r.get('Window Start Ref', '').strip(),
            'start_offset':   start_offset,
            'window_end_ref': r.get('Window End Ref', '').strip(),
            'end_offset':     end_offset,
            'duration':       duration,
            'staff_count':    staff_count,
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


def get_stands_map():
    """Return {stand_id: {'type': str, 'terminal': str, 'pier': str}}, cached.

    Reads Stands.csv.  If the CSV contains 'terminal' and/or 'pier' columns
    those values are used directly; otherwise they are inferred from the
    stand_id string via _infer_terminal / _infer_pier.

    The richer dict replaces the old plain-string value so that the optimiser
    can group flights by terminal and pier for shared-task logic.
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
        # Accept either lowercase or title-case column names for terminal/pier
        term  = (r.get('terminal', '') or r.get('Terminal', '')).strip()
        pier  = (r.get('pier',     '') or r.get('Pier',     '')).strip()
        if sid:
            _stands_map[sid] = {
                'type':     stype,
                'terminal': term or _infer_terminal(sid),
                'pier':     pier or _infer_pier(sid),
            }
    return _stands_map


def get_applicable_task_rules(status, haul, rules):
    """Filter config rules for a given flight status and haul type."""
    applicable = []
    for rule in rules:
        ft = rule['flight_type']
        task = rule['task']
        hs = rule['haul_subtype']

        # Skip fixed duties and shift patrols (handled separately)
        if ft in ('Fixed duty', 'Shift patrol'):
            continue
        # Skip CBP (session-based)
        if task == 'CBP Pre-clearance':
            continue
        # Skip Bussing with Remote stand haul sub-type (handled separately)
        if task == 'Bussing' and hs == 'Remote stand':
            continue

        # Status match
        if status == 'Departure':
            if ft not in ('DEP', 'DEP/ARR'):
                continue
        elif status == 'Arrival':
            if ft not in ('ARR', 'DEP/ARR', 'ARR/DEP/ARR'):
                continue
        else:
            continue

        # Haul match
        if hs in ('Any', 'N/A', 'Surge', 'Morning', 'Afternoon', 'Evening/Night'):
            pass  # always applicable
        elif hs == 'Short':
            if haul != 'Short':
                continue
        elif hs == 'Long':
            if haul not in ('Long', 'US/Canada'):
                continue
        elif hs == 'US/Canada':
            if haul != 'US/Canada':
                continue
        elif hs == 'Long >300 pax':
            continue  # skip
        # else: unknown, skip
        else:
            continue

        applicable.append(rule)

    # If a task has both a specific movement rule and a DEP/ARR or ARR/DEP/ARR fallback,
    # keep the status-specific rule and drop the duplicate combined rule.
    preferred = {
        'DEP': 3,
        'ARR': 3,
        'DEP/ARR': 2,
        'ARR/DEP/ARR': 1,
    }
    deduped = {}
    for rule in applicable:
        key = (rule['task'], rule['haul_subtype'])
        existing = deduped.get(key)
        if existing is None or preferred.get(rule['flight_type'], 0) > preferred.get(existing['flight_type'], 0):
            deduped[key] = rule

    return list(deduped.values())


def compute_task_window(time_mins, rule):
    """Return (start, end) in minutes from midnight."""
    start = time_mins + rule['start_offset']
    if rule['duration'] is not None:
        end = start + rule['duration']
    else:
        end = time_mins + rule['end_offset']
    start = max(0, start)
    if end <= start:
        end = start + 30  # minimum 30 min window
    return start, end


def get_staff_for_date(date_str):
    """Return (on_duty_list, absent_list) for the given date string."""
    # Parse date_str
    d = None
    for fmt in ('%Y-%m-%d', '%d-%b-%y', '%d-%b-%Y', '%d-%m-%y', '%d-%m-%Y'):
        try:
            d = datetime.strptime(date_str.strip(), fmt)
            break
        except ValueError:
            pass
    if d is None:
        return [], []

    # Staff CSV uses DD-MM-YYYY format (4-digit year)
    staff_date_key = d.strftime('%d-%m-%Y')  # e.g. '11-04-2026'

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
            absent_set[emp_id] = leave_type

    # Filter staff for this date
    day_staff = [r for r in staff_rows
                 if r.get('DATE', '').strip() == staff_date_key
                 and r.get('EMPLOYEE NUMBER', '').strip()]

    on_duty = []
    absent_staff = []

    for r in day_staff:
        emp_id = r.get('EMPLOYEE NUMBER', '').strip()
        skill1 = r.get('Skill1', '').strip()
        skill2 = r.get('Skill2', '').strip()
        employment = r.get('EMPLOYMENT TYPE', '').strip()

        if emp_id in absent_set:
            absent_staff.append({
                'id': emp_id,
                'skill1': skill1,
                'leave_type': absent_set[emp_id],
                'absent': True,
            })
            continue

        # Determine shift: extract digits from emp_id
        digits = ''.join(c for c in emp_id if c.isdigit())
        if digits and int(digits) % 2 == 1:
            shift = 'DAY'
            shift_start = 240   # 04:00
            shift_end = 960     # 16:00
            shift_label = 'Day Shift 04:00–16:00'
        else:
            shift = 'NIGHT'
            shift_start = 960   # 16:00
            shift_end = 1680    # 04:00 next day
            shift_label = 'Night Shift 16:00–04:00'

        on_duty.append({
            'id': emp_id,
            'skill1': skill1,
            'skill2': skill2,
            'employment': employment,
            'shift': shift,
            'shift_start': shift_start,
            'shift_end': shift_end,
            'shift_label': shift_label,
            'assignments': [],
            'breaks': [],
            'utilisation_pct': 0,
        })

    return on_duty, absent_staff


def schedule_breaks(staff, assigned_windows):
    """Schedule two mandatory breaks for a staff member.

    Break 1 (Short Break, 30 min):
        Preferred window: [shift_start+120, shift_start+360]
        Fallback:         [shift_start+60,  shift_end-30]   (anywhere in shift)

    Break 2 (Meal Break, 60 min):
        Preferred window: [b1_end+120, shift_end-60]  (at least 2 hrs after B1)
        Fallback:         [shift_start+120, shift_end-60]   (anywhere after first hr)

    Breaks are inserted outside busy task windows; if no gap exists in preferred
    window we fall back to the widest possible window so every staff member
    always receives both breaks.
    """
    shift_start = staff['shift_start']
    shift_end   = staff['shift_end']
    breaks = []

    def find_free_slot(duration, search_start, search_end, busy):
        """Return start of first free slot of `duration` mins, or None."""
        t = max(search_start, shift_start)
        end_cap = min(search_end, shift_end - duration)
        while t + duration <= end_cap:
            conflict = False
            for (ws, we) in busy:
                if t < we and t + duration > ws:
                    conflict = True
                    t = we
                    break
            if not conflict:
                return t
        return None

    busy = sorted(assigned_windows)

    # ── Break 1: 30-min short break ──────────────────────────────
    b1_start = (
        find_free_slot(30, shift_start + 120, shift_start + 360, busy)
        or find_free_slot(30, shift_start + 60, shift_end - 30,  busy)
    )
    b1_end = None
    if b1_start is not None:
        b1_end = b1_start + 30
        breaks.append({
            'start_mins': b1_start,
            'end_mins':   b1_end,
            'start': mins_to_time(b1_start),
            'end':   mins_to_time(b1_end),
            'type':  'Short Break',
        })

    # ── Break 2: 60-min meal break ───────────────────────────────
    busy2 = sorted(busy + ([(b1_start, b1_end)] if b1_end else []))
    # Preferred: at least 2 hrs after short break (or 6 hrs into shift)
    b2_pref_start = max(b1_end + 120 if b1_end else 0, shift_start + 360)
    b2_start = (
        find_free_slot(60, b2_pref_start,        shift_end - 60, busy2)
        or find_free_slot(60, shift_start + 120, shift_end - 60, busy2)
    )
    if b2_start is not None:
        b2_end = b2_start + 60
        breaks.append({
            'start_mins': b2_start,
            'end_mins':   b2_end,
            'start': mins_to_time(b2_start),
            'end':   mins_to_time(b2_end),
            'type':  'Meal Break',
        })

    return breaks


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
    """Generate all per-day tasks applying the three-tier sharing model.

    Parameters
    ----------
    processed_flights : list of dicts, each containing:
        flight_no, time_mins, status, haul, gate, icao_cat
    rules             : loaded Config.csv rules (from load_config_rules)
    stands_map        : loaded Stands.csv map   (from get_stands_map)
    window_mins       : width of the time-bucket used to group concurrent flights

    Returns
    -------
    list of task dicts, each with a 'flights_covered' list and
    'terminal'/'pier'/'sharing_mode' fields in addition to the standard task keys.

    Sharing model
    -------------
    DEDICATED tasks (Ramp / Marshalling, Bussing):
        One task per flight, unchanged from the original logic.

    SHARED tasks (GNIB / Immigration, Arr Customer Service, etc.):
        Flights sharing the same (terminal, pier, time-bucket) get a SINGLE
        pooled task.  The task window spans the earliest start to latest end
        of all individual per-flight windows for that task type.
        Staff count comes from the Config.csv rule (the pool serves everyone).

    PARTIALLY SHARED tasks (Check-in / Trolleys, Dep / Trolleys, PBZ):
        Flights are grouped the same way, but the staff count scales with
        combined estimated passenger volume (PARTIAL_SHARE_PAX_THRESHOLDS).
    """
    dedicated_tasks = []

    # Accumulate shared/partially-shared entries before collapsing into tasks.
    # Key: (terminal, pier, time_bucket, task_name)
    # Value: list of {flight_no, start_mins, end_mins, pax, rule}
    shared_entries:  dict = defaultdict(list)
    partial_entries: dict = defaultdict(list)

    for flight in processed_flights:
        fn       = flight['flight_no']
        t_mins   = flight['time_mins']
        status   = flight['status']
        haul     = flight['haul']
        gate     = flight['gate']
        icao_cat = flight['icao_cat']

        si       = _stand_info(gate, stands_map)
        terminal = si['terminal']
        pier     = si['pier']
        stand_type = si['type']

        # Time-bucket: floor to nearest window_mins boundary
        bucket = (t_mins // window_mins) * window_mins

        pax = _pax_for_icao(icao_cat)

        applicable = get_applicable_task_rules(status, haul, rules)

        # Remote-stand bussing (handled as DEDICATED regardless of sharing class)
        if stand_type == 'Remote':
            for rule in rules:
                if rule['task'] == 'Bussing' and rule['haul_subtype'] == 'Remote stand':
                    if rule['flight_type'] in ('DEP', 'DEP/ARR') and status == 'Departure':
                        applicable.append(rule)
                    elif rule['flight_type'] in ('ARR', 'DEP/ARR', 'ARR/DEP/ARR') and status == 'Arrival':
                        applicable.append(rule)

        for rule in applicable:
            task_name = rule['task']
            start_mins, end_mins = compute_task_window(t_mins, rule)

            if task_name in TASK_DEDICATED:
                # ── DEDICATED: one task per flight ──────────────────────────
                skill   = TASK_SKILL.get(task_name, 'GNIB')
                task_id = f"{fn}_{task_name[:8].replace(' ', '')}_{start_mins}"
                dedicated_tasks.append({
                    'id':            task_id,
                    'flight_no':     fn,
                    'task':          task_name,
                    'skill':         skill,
                    'priority':      rule['priority'],
                    'start_mins':    start_mins,
                    'end_mins':      end_mins,
                    'start':         mins_to_time(start_mins),
                    'end':           mins_to_time(end_mins),
                    'staff_needed':  rule['staff_count'],
                    'assigned':      [],
                    'alert':         None,
                    'time_mins':     t_mins,
                    'flights_covered': [fn],
                    'terminal':      terminal,
                    'pier':          pier,
                    'sharing_mode':  'dedicated',
                })

            elif task_name in TASK_SHARED:
                # ── SHARED: accumulate for group collapse ────────────────────
                shared_entries[(terminal, pier, bucket, task_name)].append({
                    'flight_no':  fn,
                    'start_mins': start_mins,
                    'end_mins':   end_mins,
                    'rule':       rule,
                })

            elif task_name in TASK_PARTIALLY_SHARED:
                # ── PARTIALLY SHARED: accumulate with pax info ───────────────
                partial_entries[(terminal, pier, bucket, task_name)].append({
                    'flight_no':  fn,
                    'start_mins': start_mins,
                    'end_mins':   end_mins,
                    'pax':        pax,
                    'rule':       rule,
                })
            # Tasks that are neither DEDICATED, SHARED nor PARTIALLY_SHARED
            # are treated as dedicated to preserve correctness.
            else:
                skill   = TASK_SKILL.get(task_name, 'GNIB')
                task_id = f"{fn}_{task_name[:8].replace(' ', '')}_{start_mins}"
                dedicated_tasks.append({
                    'id':            task_id,
                    'flight_no':     fn,
                    'task':          task_name,
                    'skill':         skill,
                    'priority':      rule['priority'],
                    'start_mins':    start_mins,
                    'end_mins':      end_mins,
                    'start':         mins_to_time(start_mins),
                    'end':           mins_to_time(end_mins),
                    'staff_needed':  rule['staff_count'],
                    'assigned':      [],
                    'alert':         None,
                    'time_mins':     t_mins,
                    'flights_covered': [fn],
                    'terminal':      terminal,
                    'pier':          pier,
                    'sharing_mode':  'dedicated',
                })

    # ── Collapse shared groups into single pooled tasks ──────────────────────
    shared_tasks = []
    for (terminal, pier, bucket, task_name), entries in shared_entries.items():
        rule       = entries[0]['rule']          # use first rule for config fields
        start_mins = min(e['start_mins'] for e in entries)
        end_mins   = max(e['end_mins']   for e in entries)
        fns        = [e['flight_no'] for e in entries]
        skill      = TASK_SKILL.get(task_name, 'GNIB')
        # ID encodes the group so it is stable across re-runs
        safe_name  = task_name[:8].replace(' ', '').replace('/', '')
        task_id    = f"SHARED_{terminal}_{pier}_{bucket}_{safe_name}"
        shared_tasks.append({
            'id':            task_id,
            'flight_no':     fns[0],            # lead flight for backward compat
            'task':          task_name,
            'skill':         skill,
            'priority':      rule['priority'],
            'start_mins':    start_mins,
            'end_mins':      end_mins,
            'start':         mins_to_time(start_mins),
            'end':           mins_to_time(end_mins),
            'staff_needed':  rule['staff_count'],
            'assigned':      [],
            'alert':         None,
            'time_mins':     bucket,
            'flights_covered': fns,
            'terminal':      terminal,
            'pier':          pier,
            'sharing_mode':  'shared',
            # UI-friendly label showing which flights share this task
            'time_window':   f"{mins_to_time(bucket)}–{mins_to_time(bucket + window_mins)}",
        })

    # ── Collapse partially-shared groups with pax-scaled headcount ───────────
    partial_tasks = []
    for (terminal, pier, bucket, task_name), entries in partial_entries.items():
        rule       = entries[0]['rule']
        start_mins = min(e['start_mins'] for e in entries)
        end_mins   = max(e['end_mins']   for e in entries)
        total_pax  = sum(e['pax'] for e in entries)
        fns        = [e['flight_no'] for e in entries]
        skill      = TASK_SKILL.get(task_name, 'GNIB')
        safe_name  = task_name[:8].replace(' ', '').replace('/', '')
        task_id    = f"PSHARED_{terminal}_{pier}_{bucket}_{safe_name}"
        partial_tasks.append({
            'id':            task_id,
            'flight_no':     fns[0],
            'task':          task_name,
            'skill':         skill,
            'priority':      rule['priority'],
            'start_mins':    start_mins,
            'end_mins':      end_mins,
            'start':         mins_to_time(start_mins),
            'end':           mins_to_time(end_mins),
            'staff_needed':  _partial_staff_count(total_pax),
            'assigned':      [],
            'alert':         None,
            'time_mins':     bucket,
            'flights_covered': fns,
            'terminal':      terminal,
            'pier':          pier,
            'sharing_mode':  'partially_shared',
            'total_pax':     total_pax,
            'time_window':   f"{mins_to_time(bucket)}–{mins_to_time(bucket + window_mins)}",
        })

    return dedicated_tasks + shared_tasks + partial_tasks


# ---------------------------------------------------------------------------
# Main optimiser
# ---------------------------------------------------------------------------

def optimize_day(date_str, overrides=None, manual_assigns=None, current_time_mins=None, prefer_early=False):
    """Run the greedy staff-assignment optimiser for a single day.

    Returns a rich dict with flights, tasks, staff, alerts and KPIs.
    """
    if overrides is None:
        overrides = {}
    if manual_assigns is None:
        manual_assigns = {}
    if current_time_mins is not None:
        current_time_mins = int(current_time_mins)

    # Parse date
    d = None
    for fmt in ('%Y-%m-%d', '%d-%b-%y', '%d-%b-%Y', '%d-%m-%y'):
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
    flights_raw = [f for f in all_flights if f.get('date', '') == flight_date_key]

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
    on_duty, absent_staff = get_staff_for_date(date_str)

    # Build skill lookup dicts
    staff_by_prim = defaultdict(list)   # skill1 → [staff_dict]
    staff_by_any  = defaultdict(list)   # skill1 or skill2 → [staff_dict]
    for s in on_duty:
        staff_by_prim[s['skill1']].append(s)
        staff_by_any[s['skill1']].append(s)
        if s['skill2']:
            staff_by_any[s['skill2']].append(s)

    # busy_map: emp_id → [(start, end)]
    busy_map = defaultdict(list)

    def available(s, start, end):
        """Check if staff member s is available for window [start, end).

        Night shift covers 16:00-04:00 (wraps midnight).
        Early-morning tasks (start < 240) are treated as night-shift territory.
        Day shift covers 04:00-16:00 only.
        """
        if s['shift'] == 'DAY':
            # Day shift: task must fall within 04:00-16:00
            if start < s['shift_start'] or end > s['shift_end']:
                return False
        else:
            # Night shift: valid if task is in evening (>=960) OR early morning (<240)
            if 240 <= start < 960:
                return False  # mid-day tasks don't belong to night shift

        # Overlap check — normalise early-morning to 28:00 for night shift
        def norm(t):
            return t + 1440 if (s['shift'] == 'NIGHT' and t < 240) else t

        ns, ne = norm(start), norm(end)
        for (ws, we) in busy_map[s['id']]:
            nws, nwe = norm(ws), norm(we)
            if ns < nwe and ne > nws:
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

    # ── Generate flight tasks using three-tier sharing logic ──────────────────
    # DEDICATED  → one task per flight (Ramp / Marshalling, Bussing)
    # SHARED     → one pooled task per (terminal, pier, 30-min bucket)
    # PARTIALLY SHARED → pooled task with pax-scaled headcount
    all_tasks = _generate_day_tasks(processed_flights, rules, stands_map, SHARING_WINDOW_MINS)

    # ── CBP hall task (day-level session, not per-flight or per-window) ───────
    # Covers the entire departure window for all US/Canada flights.
    # Kept separate because the hall operates as a continuous session, not a
    # per-window pool — the same 3 officers handle all pre-clearance regardless
    # of how many 30-min buckets the departures span.
    if cbp_dep_times:
        cbp_start = min(cbp_dep_times) - 90
        cbp_end   = max(cbp_dep_times) + 30
        cbp_start = max(0, cbp_start)
        if cbp_end <= cbp_start:
            cbp_end = cbp_start + 120
        # Identify which flights are covered by this session
        cbp_flights = [pf['flight_no'] for pf in processed_flights
                       if pf['haul'] == 'US/Canada' and pf['status'] == 'Departure']
        all_tasks.append({
            'id':              f'CBP_HALL_{cbp_start}',
            'flight_no':       'CBP-HALL',
            'task':            'CBP Pre-clearance',
            'skill':           'CBP Pre-clearance',
            'priority':        'Critical',
            'start_mins':      cbp_start,
            'end_mins':        cbp_end,
            'start':           mins_to_time(cbp_start),
            'end':             mins_to_time(cbp_end),
            'staff_needed':    3,
            'assigned':        [],
            'alert':           None,
            'time_mins':       cbp_start,
            'flights_covered': cbp_flights,
            'terminal':        'T2',   # CBP pre-clearance hall is T2 by convention
            'pier':            'CBP',
            'sharing_mode':    'shared',
            'time_window':     f"{mins_to_time(cbp_start)}–{mins_to_time(cbp_end)}",
        })

    # ── Fixed duties (area-based, independent of flight schedule) ────────────
    # Mezz Operation, Litter Picking, and PBZ run every operating day.
    # They are included here as shared area tasks with no specific flight linkage.
    fixed_duties = [
        {'id': 'FIXED_MEZZ_240',  'task': 'Mezz Operation', 'skill': 'Mezz Operation', 'priority': 'High',   'start_mins': 240,  'end_mins': 540,  'staff_needed': 2},
        {'id': 'FIXED_LITTER_AM', 'task': 'Litter Picking', 'skill': 'Litter Picking', 'priority': 'Medium', 'start_mins': 240,  'end_mins': 720,  'staff_needed': 1},
        {'id': 'FIXED_LITTER_PM', 'task': 'Litter Picking', 'skill': 'Litter Picking', 'priority': 'Medium', 'start_mins': 720,  'end_mins': 1140, 'staff_needed': 1},
        {'id': 'FIXED_PBZ_240',   'task': 'PBZ',            'skill': 'PBZ',            'priority': 'High',   'start_mins': 240,  'end_mins': 960,  'staff_needed': 2},
    ]
    for fd in fixed_duties:
        fd.update({
            'flight_no':       'FIXED',
            'start':           mins_to_time(fd['start_mins']),
            'end':             mins_to_time(fd['end_mins']),
            'assigned':        [],
            'alert':           None,
            'time_mins':       fd['start_mins'],
            'flights_covered': [],          # fixed duties cover no specific flight
            'terminal':        'ALL',
            'pier':            'ALL',
            'sharing_mode':    'fixed',
            'time_window':     f"{mins_to_time(fd['start_mins'])}–{mins_to_time(fd['end_mins'])}",
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
                        'task_id': tid,
                        'task': task['task'],
                        'start': task['start'],
                        'end': task['end'],
                        'start_mins': task['start_mins'],
                        'end_mins': task['end_mins'],
                    })
                    busy_map[emp_id].append((task['start_mins'], task['end_mins']))

    # Sort: prefer early tasks first in intraday live mode, otherwise keep priority-first order.
    priority_order = {'Critical': 0, 'High': 1, 'Medium': 2, 'Low': 3}
    if prefer_early:
        all_tasks.sort(key=lambda t: (t['start_mins'], priority_order.get(t['priority'], 2), t['flight_no']))
    else:
        all_tasks.sort(key=lambda t: (priority_order.get(t['priority'], 2), t['start_mins'], t['flight_no']))

    # Greedy assignment
    for task in all_tasks:
        needed = task['staff_needed'] - len(task['assigned'])
        if needed <= 0:
            continue

        skill = task['skill']
        start = task['start_mins']
        end   = task['end_mins']

        # Try primary skill first
        candidates = [s for s in staff_by_prim.get(skill, [])
                      if s['id'] not in task['assigned'] and available(s, start, end)]
        assigned_count = 0
        for s in candidates:
            if assigned_count >= needed:
                break
            task['assigned'].append(s['id'])
            s['assignments'].append({
                'task_id': task['id'],
                'task': task['task'],
                'start': task['start'],
                'end': task['end'],
                'start_mins': start,
                'end_mins': end,
            })
            busy_map[s['id']].append((start, end))
            assigned_count += 1

        # Try secondary skill using the same task window.
        if assigned_count < needed:
            sec_candidates = [s for s in staff_by_any.get(skill, [])
                              if s['id'] not in task['assigned']
                              and s['skill1'] != skill  # secondary only
                              and available(s, start, end)]
            for s in sec_candidates:
                if assigned_count >= needed:
                    break
                task['assigned'].append(s['id'])
                s['assignments'].append({
                    'task_id': task['id'],
                    'task': task['task'],
                    'start': task['start'],
                    'end': task['end'],
                    'start_mins': start,
                    'end_mins': end,
                })
                busy_map[s['id']].append((start, end))
                assigned_count += 1

        if assigned_count < needed:
            gap = needed - assigned_count
            if not task.get('is_past'):
                task['alert'] = f'Under-staffed: need {needed}, assigned {assigned_count} (gap {gap})'

    # Schedule breaks and compute utilisation
    shift_lengths = {'DAY': 720, 'NIGHT': 720}  # 12-hour shifts = 720 mins
    for s in on_duty:
        windows = busy_map[s['id']]
        s['breaks'] = schedule_breaks(s, windows)
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
            'id':              task['id'],
            'task':            task['task'],
            'skill':           task['skill'],
            'priority':        task['priority'],
            'start':           task['start'],
            'end':             task['end'],
            'start_mins':      task['start_mins'],
            'end_mins':        task['end_mins'],
            'staff_needed':    task['staff_needed'],
            'assigned':        task['assigned'],
            'alert':           task['alert'],
            'sharing_mode':    task.get('sharing_mode', 'dedicated'),
            'flights_covered': task.get('flights_covered', []),
            'time_window':     task.get('time_window', ''),
            'terminal':        task.get('terminal', ''),
            'pier':            task.get('pier', ''),
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
                               if s['id'] not in task['assigned'] and available(s, start, end)]
            rec_staff = [s['id'] for s in rec_candidates[:gap]]
            alerts.append({
                'task_id':         task['id'],
                'flight_no':       task.get('flight_no', ''),
                'flights_covered': task.get('flights_covered', []),
                'task':            task['task'],
                'skill':           skill,
                'priority':        task['priority'],
                'start':           task['start'],
                'end':             task['end'],
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


@app.route('/api/short-term/<date_str>')
def st_day(date_str):
    """Return full optimised schedule for a short-term day (D+1 to D+3)."""
    man = _manual_assigns.get(date_str, {})
    result = optimize_day(date_str, manual_assigns=man)
    if 'error' in result:
        return jsonify(result), 404
    return jsonify(result)


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
    result = optimize_day(date, manual_assigns=_manual_assigns.get(date, {}))
    if 'error' in result:
        return jsonify(result), 404
    return jsonify(result)


@app.route('/api/intraday')
def intraday_get():
    """Return today's intraday-optimised schedule with any live overrides."""
    now = datetime.now()
    today_str = now.strftime('%Y-%m-%d')
    man = _manual_assigns.get(today_str, {})
    current_time_mins = now.hour * 60 + now.minute
    result = optimize_day(today_str, _intraday_overrides, man,
                          current_time_mins=current_time_mins,
                          prefer_early=True)
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
                          prefer_early=True)
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
                          prefer_early=True)
    if 'error' in result:
        return jsonify(result), 404
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
    'demand_cv':            0.08,   # CV of flight-demand multiplier ~ N(1, cv)
    'surge_probability':    0.05,   # P(surge event on this day) — match, bank holiday, etc.
    'surge_demand_factor':  1.35,   # demand multiplier applied during a surge event
    'airline_punctuality':  0.75,   # fraction of flights on time; lower → task bunching
                                    #   bunching_mult = 1 + (1 − punctuality) × 0.25
    # ── Supply-side: staffing ────────────────────────────────────────────────
    'absence_rate':         0.06,   # mean fraction of staff absent on any given day
    'absence_cv':           0.02,   # CV of absence rate
    'overtime_daily_hrs':   0,      # OT hours available per staff per day (capped by min_rest)
    'min_rest_hrs':         11,     # min rest between shifts (limits usable overtime)
    'cross_training_rate':  0.15,   # fraction of each skill pool cross-trained in ≥1 other skill
                                    #   creates a shared flex pool = cross_rate × total_avail
    'new_hire_fraction':    0.00,   # fraction of workforce who are new hires (70% productive)
    'fatigue_factor':       0.00,   # sustained fatigue penalty on capacity (0.0 – 0.20)
    'contractor_staff':     {'GNIB': 0, 'CBP Pre-clearance': 0, 'Bussing': 0,
                             'PBZ': 0, 'Mezz Operation': 0, 'Litter Picking': 0},
                                    # agency/contract staff per skill; attend at 85% ± 10% reliability
    'extra_staff':          {'GNIB': 0, 'CBP Pre-clearance': 0, 'Bussing': 0,
                             'PBZ': 0, 'Mezz Operation': 0, 'Litter Picking': 0},
                                    # permanent additional hires per skill (100% reliable)
    # ── Task-side ────────────────────────────────────────────────────────────
    'duration_cv':          0.10,   # CV of task-duration multiplier ~ N(1, cv)
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


def run_monte_carlo(base_date, constraints, n_runs=500):
    """
    Monte Carlo simulation for a given date and constraint set.

    Per-run stochastic model
    ────────────────────────
    demand_f   ~ N(1, demand_cv)                      flight demand multiplier
    absence_f  ~ N(absence_rate, absence_cv)          fraction of staff absent
    duration_f ~ N(1, duration_cv)                    task-duration multiplier
    surge      ~ Bernoulli(surge_probability)         if True: demand_f *= surge_demand_factor
    contractor_f ~ N(0.85, 0.10)                      contractor attendance rate

    For each skill pool:
      req_sk    = base_req × demand_f × duration_f × bunching_mult
      perm_sk   = (base_avail + extra × SHIFT + OT_mins) × (1 − absence_f)
                                                       × new_hire_productivity × (1 − fatigue)
      contr_sk  = contractor_staff × SHIFT × contractor_f × (1 − fatigue)
      flex_sk   = cross_training_rate × Σ(perm_other_sk) / n_skills  [shared flex pool]
      avail_sk  = perm_sk + contr_sk + flex_sk

    bunching_mult = 1 + (1 − airline_punctuality) × 0.25
    new_hire_productivity = 1 − new_hire_fraction × 0.30
    OT_mins = min(overtime_daily_hrs, 24 − 12 − min_rest_hrs) × 60 × n_staff_sk
    """
    SHIFT_MINS            = 720    # gross 12-hr shift minutes
    NEW_HIRE_PENALTY      = 0.30   # new hires deliver 70% of a seasoned staff member
    CONTRACTOR_RELIABILITY_MEAN = 0.85
    CONTRACTOR_RELIABILITY_STD  = 0.10
    BUNCHING_SENSITIVITY  = 0.25   # 1% drop in punctuality → +0.25% required staff-mins

    # ── Run baseline optimiser ───────────────────────────────────────────────
    result = optimize_day(base_date)
    if 'error' in result:
        return result

    skill_req_base, skill_avail_base = _extract_baseline(result)
    if not skill_req_base:
        return {'error': 'No task data found for this date'}

    skills = sorted(skill_req_base.keys())

    # ── Extract constraint parameters ────────────────────────────────────────
    extra_staff      = constraints.get('extra_staff', {})
    contractor_staff = constraints.get('contractor_staff', {})

    demand_cv       = float(constraints.get('demand_cv',           0.08))
    absence_rate    = float(constraints.get('absence_rate',        0.06))
    absence_cv      = float(constraints.get('absence_cv',          0.02))
    duration_cv     = float(constraints.get('duration_cv',         0.10))
    surge_prob      = float(constraints.get('surge_probability',   0.05))
    surge_factor    = float(constraints.get('surge_demand_factor', 1.35))
    punctuality     = float(constraints.get('airline_punctuality', 0.75))
    overtime_hrs    = float(constraints.get('overtime_daily_hrs',  0))
    min_rest        = float(constraints.get('min_rest_hrs',        11))
    cross_rate      = float(constraints.get('cross_training_rate', 0.15))
    new_hire_frac   = float(constraints.get('new_hire_fraction',   0.00))
    fatigue_f       = float(constraints.get('fatigue_factor',      0.00))

    # ── Derived constants (computed once, outside the loop) ──────────────────
    # Bunching multiplier: lower punctuality increases effective demand
    bunching_mult = 1.0 + (1.0 - max(0.0, min(1.0, punctuality))) * BUNCHING_SENSITIVITY

    # New-hire productivity multiplier
    new_hire_prod = 1.0 - max(0.0, min(1.0, new_hire_frac)) * NEW_HIRE_PENALTY

    # Fatigue cap
    fatigue_f = max(0.0, min(0.20, fatigue_f))

    # Overtime: cap by rest constraint so shift + OT + rest ≤ 24 hrs
    shift_hrs    = SHIFT_MINS / 60.0      # 12 hrs
    max_ot_hrs   = max(0.0, 24.0 - shift_hrs - min_rest)
    ot_hrs_used  = min(overtime_hrs, max_ot_hrs)
    ot_mins_each = ot_hrs_used * 60.0     # OT minutes per staff member

    # Staff count per skill (for overtime calculation)
    staff_count_by_skill = defaultdict(int)
    for s in result.get('staff', []):
        staff_count_by_skill[s['skill1']] += 1

    # Permanent available pool: base + extra staff + overtime capacity
    perm_base = {}
    for sk in skills:
        extra_mins = extra_staff.get(sk, 0) * SHIFT_MINS
        ot_pool    = staff_count_by_skill.get(sk, 0) * ot_mins_each
        perm_base[sk] = skill_avail_base.get(sk, 0) + extra_mins + ot_pool

    # Contractor pool (max capacity, attendance stochastic per run)
    contr_base = {}
    for sk in skills:
        contr_base[sk] = contractor_staff.get(sk, 0) * SHIFT_MINS

    # ── Simulation loop ──────────────────────────────────────────────────────
    coverage_runs  = []
    gap_fte_runs   = []
    skill_cov_runs = defaultdict(list)

    for _ in range(n_runs):
        # Stochastic draws
        demand_f   = max(0.5, _rnorm(1.0, demand_cv))
        absence_f  = max(0.0, min(0.6, _rnorm(absence_rate, absence_cv)))
        duration_f = max(0.5, _rnorm(1.0, duration_cv))
        contr_f    = max(0.4, min(1.0, _rnorm(CONTRACTOR_RELIABILITY_MEAN,
                                               CONTRACTOR_RELIABILITY_STD)))

        # Surge event (Bernoulli)
        if random.random() < surge_prob:
            demand_f = min(demand_f * surge_factor, 3.0)

        # Per-skill permanent available after absence, new-hire penalty, fatigue
        sk_perm = {}
        for sk in skills:
            sk_perm[sk] = (perm_base[sk]
                           * (1.0 - absence_f)
                           * new_hire_prod
                           * (1.0 - fatigue_f))

        # Cross-training flex pool: fraction of total permanent capacity that is
        # flexibly deployable across all skills (distributed equally)
        total_perm = sum(sk_perm.values())
        flex_per_skill = (total_perm * cross_rate) / len(skills) if skills else 0.0

        total_req   = 0.0
        total_avail = 0.0

        for sk in skills:
            # Required: base × demand × duration bunching
            req_sk = skill_req_base[sk] * demand_f * duration_f * bunching_mult

            # Available: permanent + contractor (stochastic) + flex cross-training
            contr_sk = contr_base[sk] * contr_f * (1.0 - fatigue_f)
            avail_sk = sk_perm[sk] + contr_sk + flex_per_skill

            total_req   += req_sk
            total_avail += avail_sk
            skill_cov_runs[sk].append(
                min(avail_sk / req_sk, 1.0) if req_sk > 0 else 1.0
            )

        cov = min(total_avail / total_req, 1.0) if total_req > 0 else 1.0
        gap_fte = max(0, (total_req - total_avail) / SHIFT_MINS)
        coverage_runs.append(cov)
        gap_fte_runs.append(gap_fte)

    # Statistics
    def stats(data):
        n = len(data)
        mean = sum(data) / n
        variance = sum((x - mean) ** 2 for x in data) / n
        return {
            'mean':  round(mean, 4),
            'std':   round(math.sqrt(variance), 4),
            'p10':   round(_percentile(data, 10), 4),
            'p25':   round(_percentile(data, 25), 4),
            'p50':   round(_percentile(data, 50), 4),
            'p75':   round(_percentile(data, 75), 4),
            'p90':   round(_percentile(data, 90), 4),
        }

    cov_stats = stats(coverage_runs)
    gap_stats = stats(gap_fte_runs)

    prob_adequate = sum(1 for c in coverage_runs if c >= 0.80) / n_runs
    prob_critical = sum(1 for c in coverage_runs if c < 0.50) / n_runs

    # Risk score 0–100 (higher = riskier)
    raw_risk = ((1 - cov_stats['p50']) * 40
                + (1 - cov_stats['p10']) * 40
                + prob_critical * 20)
    risk_score = round(max(0, min(100, raw_risk * 100)), 1)
    if   risk_score < 20: risk_level = 'Low'
    elif risk_score < 45: risk_level = 'Medium'
    elif risk_score < 65: risk_level = 'High'
    else:                  risk_level = 'Critical'

    # Per-skill breakdown
    skill_breakdown = {}
    for sk in skills:
        sc = stats(skill_cov_runs[sk])
        rs = round(max(0, min(100, ((1 - sc['p50']) * 40 + (1 - sc['p10']) * 40) * 100)), 1)
        rl = 'Low' if rs < 20 else 'Medium' if rs < 45 else 'High' if rs < 65 else 'Critical'
        skill_breakdown[sk] = {
            'p10': sc['p10'], 'p50': sc['p50'], 'p90': sc['p90'],
            'risk_score': rs, 'risk_level': rl,
            'base_required_mins': round(skill_req_base.get(sk, 0), 0),
            'base_available_mins': round(perm_base.get(sk, 0), 0),
        }

    return {
        'n_runs':          n_runs,
        'coverage':        cov_stats,
        'gap_fte':         gap_stats,
        'prob_adequate':   round(prob_adequate, 4),
        'prob_critical':   round(prob_critical, 4),
        'risk_score':      risk_score,
        'risk_level':      risk_level,
        'histogram':       _histogram(coverage_runs),
        'skill_breakdown': skill_breakdown,
        'baseline': {
            'staff_on_duty': result['kpis']['staff_on_duty'],
            'total_flights': result['kpis']['total_flights'],
            'base_coverage': round(result['kpis']['coverage_pct'] / 100, 4),
        },
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
            'risk_score':  r.get('risk_score'),
            'risk_level':  r.get('risk_level'),
            'p50_coverage': r.get('coverage', {}).get('p50'),
            'p10_coverage': r.get('coverage', {}).get('p10'),
            'prob_critical': r.get('prob_critical'),
            'n_runs':      r.get('n_runs'),
            'constraints': sc['constraints'],
        })
    return jsonify(out)


@app.route('/api/scenarios/run', methods=['POST'])
def run_scenario():
    body = request.get_json(force=True) or {}
    name       = body.get('name', f'Scenario {_scenario_seq[0]+1}').strip() or f'Scenario {_scenario_seq[0]+1}'
    base_date  = body.get('base_date', datetime.now().strftime('%Y-%m-%d'))
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

    results = run_monte_carlo(base_date, constraints, n_runs)
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

if __name__ == '__main__':
    update_csv_dates_to_current()
    app.run(debug=True)

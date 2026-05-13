import csv
import json
import os
from copy import deepcopy
from datetime import datetime, time


PULSE_FILE = 'intraday_pax_pulse.json'
FLIGHTS_FILE = 'intraday_pax_flights.csv'
TOUCHPOINTS = ('checkin', 'security', 'cbp', 'lounge', 'boarding', 'immigration', 'baggage')


def _data_path(base_dir, filename):
    return os.path.join(base_dir, 'data', filename)


def _load_json(base_dir, filename):
    with open(_data_path(base_dir, filename), encoding='utf-8') as f:
        return json.load(f)


def _numbers(values):
    out = []
    for value in values or []:
        try:
            out.append(float(value or 0))
        except (TypeError, ValueError):
            out.append(0.0)
    return out


def _peak_idx(values):
    return max(range(len(values)), key=lambda idx: values[idx]) if values else 0


def _active_avg(values):
    active = [v for v in values if v > 0]
    return round(sum(active) / len(active)) if active else 0


def _pct(part, total):
    return round((part / total) * 100) if total else None


def _peak_time(labels, values):
    idx = _peak_idx(values)
    return labels[idx] if idx < len(labels) else '--'


def _insight(series, labels, key, label, accent, secondary_label, secondary_value, metric_label='Peak Pax / min'):
    values = _numbers(series.get(key))
    return {
        'key': key,
        'label': label,
        'accent': accent,
        'peak': round(max(values) if values else 0),
        'metric_label': metric_label,
        'peak_time': _peak_time(labels, values),
        'secondary_label': secondary_label,
        'secondary_value': secondary_value,
    }


def _load_flights(base_dir):
    path = _data_path(base_dir, FLIGHTS_FILE)
    if not os.path.exists(path):
        return []

    flights = []
    with open(path, encoding='utf-8-sig', newline='') as f:
        for row in csv.DictReader(f):
            flight_no = str(row.get('Flight_No') or '').strip()
            if not flight_no:
                continue
            flights.append({
                'flight_no': flight_no,
                'type': str(row.get('Type') or '').strip(),
                'eta': str(row.get('ETA') or '').strip(),
                'etd': str(row.get('ETD') or '').strip(),
                'airline': str(row.get('Airline') or '').strip(),
                'terminal': str(row.get('Terminal') or '').strip(),
                'cbp_required': str(row.get('CBP_Required') or '').strip(),
            })
    return flights


def _terminal_for_flight(flight):
    terminal = str(flight.get('terminal') or '').strip().upper()
    return terminal if terminal in ('T1', 'T2') else None


def _terminal_weights(flights, touchpoint):
    counts = {'T1': 0.0, 'T2': 0.0}
    for flight in flights:
        terminal = _terminal_for_flight(flight)
        if not terminal:
            continue

        flow_type = str(flight.get('type') or '').strip().upper()
        is_departure_flow = flow_type in ('DEP', 'TURN')
        is_arrival_flow = flow_type in ('ARR', 'TURN')

        if touchpoint in ('immigration', 'baggage') and not is_arrival_flow:
            continue
        if touchpoint not in ('immigration', 'baggage') and not is_departure_flow:
            continue
        if touchpoint == 'cbp' and str(flight.get('cbp_required') or '').strip().lower() != 'true':
            continue

        counts[terminal] += 1.0

    total = counts['T1'] + counts['T2']
    if total <= 0:
        return {'T1': 0.5, 'T2': 0.5}
    return {'T1': counts['T1'] / total, 'T2': counts['T2'] / total}


def _aggregate_to_15_minutes(labels, values, touchpoint):
    buckets = {minute: [] for minute in range(0, 1440, 15)}
    for label, value in zip(labels or [], _numbers(values)):
        minute = _mins(label)
        bucket = (minute // 15) * 15
        if bucket in buckets:
            buckets[bucket].append(value)

    aggregated = {}
    for minute, bucket_values in buckets.items():
        if not bucket_values:
            aggregated[minute] = 0
        elif touchpoint == 'lounge':
            aggregated[minute] = round(sum(bucket_values) / len(bucket_values))
        else:
            aggregated[minute] = round(sum(bucket_values))
    return aggregated


def _simulation_export_date(base_dir):
    path = _data_path(base_dir, 'short term PAX.xlsx')
    if os.path.exists(path):
        try:
            import openpyxl
            wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
            ws = wb.active
            first_ts = ws.cell(2, 1).value
            if isinstance(first_ts, datetime):
                return first_ts.date()
        except Exception:
            pass
    return datetime.now().date()


def save_intraday_pax_simulation(base_dir, payload):
    """Write simulated intraday PAX demand in the short term PAX workbook shape."""
    try:
        import openpyxl
        from openpyxl.styles import Alignment, Font, PatternFill
    except ImportError:
        return {'saved': False, 'error': 'openpyxl is not installed'}

    series = payload.get('series') or {}
    labels = series.get('labels') or []
    if not labels:
        return {'saved': False, 'error': 'Simulation payload has no time labels'}

    headers = [
        'Timestamp',
        'T1_Checkin', 'T1_Security', 'T1_CBP', 'T1_Lounge', 'T1_Boarding', 'T1_Immigration', 'T1_Baggage',
        'T2_Checkin', 'T2_Security', 'T2_CBP', 'T2_Lounge', 'T2_Boarding', 'T2_Immigration', 'T2_Baggage',
    ]
    column_touchpoints = [
        ('T1', 'checkin'), ('T1', 'security'), ('T1', 'cbp'), ('T1', 'lounge'), ('T1', 'boarding'), ('T1', 'immigration'), ('T1', 'baggage'),
        ('T2', 'checkin'), ('T2', 'security'), ('T2', 'cbp'), ('T2', 'lounge'), ('T2', 'boarding'), ('T2', 'immigration'), ('T2', 'baggage'),
    ]

    simulation_meta = payload.get('simulation') or {}
    affected_terminal = simulation_meta.get('affected_terminal')  # e.g. 'T1', 'T2', or None

    flights = _load_flights(base_dir)
    weights = {touchpoint: _terminal_weights(flights, touchpoint) for touchpoint in TOUCHPOINTS}
    aggregated = {
        touchpoint: _aggregate_to_15_minutes(labels, series.get(touchpoint), touchpoint)
        for touchpoint in TOUCHPOINTS
    }

    # Load baseline (unshifted) aggregate so we can isolate changes to affected terminal only
    baseline_aggregated = None
    if affected_terminal in ('T1', 'T2'):
        try:
            pulse = _load_json(base_dir, PULSE_FILE)
            base_labels = pulse.get('labels', [])
            baseline_aggregated = {
                tp: _aggregate_to_15_minutes(base_labels, pulse.get(tp), tp)
                for tp in TOUCHPOINTS
            }
        except Exception:
            baseline_aggregated = None

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = 'Sheet1'
    ws.append(headers)

    header_fill = PatternFill(start_color='366092', end_color='366092', fill_type='solid')
    header_font = Font(bold=True, color='FFFFFF')
    for cell in ws[1]:
        cell.fill = header_fill
        cell.font = header_font
        cell.alignment = Alignment(horizontal='center')

    base_date = _simulation_export_date(base_dir)
    for interval_start in range(0, 1440, 15):
        ts = datetime.combine(base_date, time(hour=interval_start // 60, minute=interval_start % 60))
        row = [ts]
        for terminal, touchpoint in column_touchpoints:
            w = weights[touchpoint][terminal]
            sim_val = aggregated[touchpoint].get(interval_start, 0)

            if baseline_aggregated and affected_terminal:
                base_val = baseline_aggregated[touchpoint].get(interval_start, 0)
                delta = sim_val - base_val
                if terminal == affected_terminal:
                    # Apply full PAX delta to the affected terminal's column
                    value = max(0, round(base_val * w + delta))
                else:
                    # Unaffected terminal stays at its baseline proportion
                    value = max(0, round(base_val * w))
            else:
                value = max(0, round(sim_val * w))

            row.append(value)
        ws.append(row)

    for cell in ws['A'][1:]:
        cell.number_format = 'YYYY-MM-DD HH:MM:SS'
    ws.column_dimensions['A'].width = 20
    for col_idx in range(2, len(headers) + 1):
        ws.column_dimensions[openpyxl.utils.get_column_letter(col_idx)].width = 15

    output_path = _data_path(base_dir, 'simulated_intraday_PAX.xlsx')
    wb.save(output_path)
    return {'saved': True, 'filename': 'simulated_intraday_PAX.xlsx', 'path': output_path}


def _table_from_series(series):
    labels = series.get('labels', [])
    rows = []
    for start in range(30, len(labels), 15):
        row = {'time': labels[start]}
        end = min(start + 15, len(labels))
        for key in TOUCHPOINTS:
            vals = _numbers(series.get(key))[start:end]
            if key == 'lounge':
                row[key] = round(sum(vals) / len(vals)) if vals else 0
            else:
                row[key] = round(sum(vals))
        rows.append(row)
    return rows


def _build_insights(series):
    labels = series.get('labels', [])
    max_checkin = max(series['checkin'] or [0])
    max_security = max(series['security'] or [0])
    max_cbp = max(series['cbp'] or [0])
    max_lounge = max(series['lounge'] or [0])
    max_boarding = max(series['boarding'] or [0])
    max_immigration = max(series['immigration'] or [0])
    max_baggage = max(series['baggage'] or [0])
    avg_security = _active_avg(series['security'])

    return [
        _insight(series, labels, 'checkin', 'Check-In', 'teal', 'Avg (active)', f"{_active_avg(series['checkin']):,} pax"),
        _insight(series, labels, 'security', 'Security', 'purple', 'Pressure Index', f"{(max_security / avg_security):.1f}x avg" if avg_security else '--'),
        _insight(series, labels, 'cbp', 'CBP', 'crit', '% of Security', f"{_pct(max_cbp, max_security) or '--'}% of sec peak"),
        _insight(series, labels, 'lounge', 'Lounge', 'warn', 'Avg Occupancy', f"{_active_avg(series['lounge']):,} pax", 'Peak Concurrent'),
        _insight(series, labels, 'boarding', 'Boarding', 'info', 'Gate Pressure', f"{_pct(max_boarding, max_checkin) or '--'}% of check-in"),
        _insight(series, labels, 'immigration', 'Immigration', 'ok', 'Intl. Arrival Share', f"{_pct(max_immigration, max_baggage) or '--'}% of arrivals"),
    ]


def _base_payload(base_dir):
    pulse = _load_json(base_dir, PULSE_FILE)
    labels = pulse.get('labels', [])
    series = {'labels': labels}
    for key in TOUCHPOINTS:
        series[key] = _numbers(pulse.get(key))
    return pulse, series


def build_intraday_pax_pulse(base_dir):
    pulse, series = _base_payload(base_dir)

    table_rows = []
    table_labels = pulse.get('table_labels', [])
    table_data = pulse.get('table_data', {})
    if table_labels and table_data:
        for idx, label in enumerate(table_labels):
            table_rows.append({
                'time': label,
                **{key: round(_numbers(table_data.get(key))[idx]) if idx < len(_numbers(table_data.get(key))) else 0 for key in TOUCHPOINTS},
            })
    else:
        table_rows = _table_from_series(series)

    max_lounge = max(series['lounge'] or [0])
    return {
        'summary': {
            'title': 'Intra-Day Tactical Pulse',
            'subtitle': 'PAX flow aligned to flights between 7 AM to 8:30 AM based on touchpoint-wise probability distributions',
            'window': f"{series['labels'][0]}-{series['labels'][-1]}" if series.get('labels') else '',
            'lounge_peak': round(max_lounge),
        },
        'series': series,
        'table': {
            'columns': ['time', 'checkin', 'security', 'cbp', 'lounge', 'boarding', 'immigration', 'baggage'],
            'rows': table_rows,
        },
        'flights': _load_flights(base_dir),
        'insights': _build_insights(series),
    }


def _time_index(labels, hhmm):
    try:
        return labels.index(str(hhmm))
    except ValueError:
        return min(range(len(labels)), key=lambda idx: abs(_mins(labels[idx]) - _mins(hhmm))) if labels else 0


def _mins(hhmm):
    h, m = str(hhmm or '00:00').split(':')[:2]
    return int(h) * 60 + int(m)


def _mins_to_hhmm(total_mins):
    total_mins = max(0, int(total_mins))
    return f"{total_mins // 60:02d}:{total_mins % 60:02d}"


def _shift_range(arr, start_idx, end_idx, shift):
    out = arr[:]
    segment = out[start_idx:end_idx]
    for idx in range(start_idx, end_idx):
        out[idx] = 0.0
    for offset, val in enumerate(segment):
        dest = min(len(out) - 1, start_idx + shift + offset)
        out[dest] += val
    return out


def _cap_series(arr, start_idx, end_idx, reduction_pct):
    out = arr[:]
    window = out[start_idx:end_idx + 1]
    nominal = max(window) if window else max(out or [1])
    limit = nominal * max(0.05, 1 - reduction_pct / 100.0)
    queue = 0.0
    for idx, demand in enumerate(out):
        in_window = start_idx <= idx <= end_idx
        if in_window:
            allowed = min(demand + queue, limit)
            queue = (demand + queue) - allowed
            out[idx] = allowed
        elif queue > 0:
            spare = max(0.0, nominal - demand)
            drain = min(queue, spare)
            out[idx] = demand + drain
            queue -= drain
    return out


def simulate_intraday_pax(base_dir, scenario, params):
    base = build_intraday_pax_pulse(base_dir)
    series = deepcopy(base['series'])
    labels = series.get('labels', [])
    cascade = []

    if scenario == 'flight_delay':
        delay = int(float(params.get('delay_min') or 30))
        shift = max(0, delay)
        flight_no = params.get('flight_no') or 'selected flight'

        flights = _load_flights(base_dir)
        selected = next((f for f in flights if f['flight_no'] == flight_no), None)

        affected_terminal = None
        if selected and selected.get('etd'):
            etd = _mins(str(selected['etd']))
            cbp_req = str(selected.get('cbp_required') or '').strip().lower() == 'true'
            affected_terminal = _terminal_for_flight(selected)

            # Boarding window: 90 min lead up to departure
            board_start_idx = _time_index(labels, _mins_to_hhmm(max(0, etd - 90)))
            board_end_idx = _time_index(labels, _mins_to_hhmm(etd))

            # Lounge/CBP window: 180 min lead up to departure
            lc_start_idx = _time_index(labels, _mins_to_hhmm(max(0, etd - 180)))

            # Deduct passengers from the original flight window and add them to the shifted window
            series['boarding'] = _shift_range(series['boarding'], board_start_idx, board_end_idx, shift)
            series['lounge'] = _shift_range(series['lounge'], lc_start_idx, board_end_idx, shift)
            if cbp_req:
                series['cbp'] = _shift_range(series['cbp'], lc_start_idx, board_end_idx, shift)
        else:
            for key in ('boarding', 'lounge', 'cbp'):
                series[key] = _shift_range(series[key], 0, len(labels), shift)

        cascade = [
            f"{flight_no} delayed by {delay} minutes; boarding and lounge demand shift later.",
            "Gate pressure moves into the next departure wave.",
            "CBP demand is shifted where the selected flight requires preclearance.",
        ]

    elif scenario == 'ground_stop':
        start = params.get('start') or '07:30'
        duration = int(float(params.get('duration_min') or 45))
        start_idx = _time_index(labels, start)
        end_idx = min(len(labels) - 1, start_idx + duration)
        for key in TOUCHPOINTS:
            series[key] = _shift_range(series[key], start_idx, end_idx, duration)
        cascade = [
            f"Ground stop from {start} for {duration} minutes compresses affected demand into the recovery window.",
            "Arrivals and departures bunch after release, raising downstream queue risk.",
            "Lounge occupancy stays elevated while passengers wait airside.",
        ]

    elif scenario == 'security_reduction':
        reduction = float(params.get('reduction_pct') or 40)
        start = params.get('start') or '06:00'
        end = params.get('end') or '08:30'
        start_idx = _time_index(labels, start)
        end_idx = _time_index(labels, end)
        series['security'] = _cap_series(series['security'], start_idx, end_idx, reduction)
        series['boarding'] = _shift_range(series['boarding'], start_idx, end_idx, max(5, round(reduction / 2)))
        cascade = [
            f"Security throughput reduced by {reduction:.0f}% between {start} and {end}.",
            "Security queue pressure is capped during the restriction and drains afterward.",
            "Boarding demand shifts later as passengers clear security later.",
        ]

    elif scenario == 'checkin_reduction':
        reduction = float(params.get('reduction_pct') or 40)
        start = params.get('start') or '06:00'
        end = params.get('end') or '08:00'
        start_idx = _time_index(labels, start)
        end_idx = _time_index(labels, end)
        series['checkin'] = _cap_series(series['checkin'], start_idx, end_idx, reduction)
        series['security'] = _shift_range(series['security'], start_idx, end_idx, max(5, round(reduction / 2)))
        cascade = [
            f"Check-in desk capacity reduced by {reduction:.0f}% between {start} and {end}.",
            "Check-in backlog pushes later demand into security.",
            "Downstream resource pressure increases after the restriction window.",
        ]

    else:
        raise ValueError(f"Unsupported scenario: {scenario}")

    sim_meta = {
        'active': True,
        'scenario': scenario,
        'cascade': cascade,
    }
    if scenario == 'flight_delay' and affected_terminal:
        sim_meta['affected_terminal'] = affected_terminal

    return {
        **base,
        'series': series,
        'table': {
            'columns': base['table']['columns'],
            'rows': _table_from_series(series),
        },
        'insights': _build_insights(series),
        'simulation': sim_meta,
    }

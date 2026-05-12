import csv
import json
import os


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


def build_intraday_pax_pulse(base_dir):
    pulse = _load_json(base_dir, PULSE_FILE)
    labels = pulse.get('labels', [])
    series = {'labels': labels}
    for key in TOUCHPOINTS:
        series[key] = _numbers(pulse.get(key))

    max_checkin = max(series['checkin'] or [0])
    max_security = max(series['security'] or [0])
    max_cbp = max(series['cbp'] or [0])
    max_lounge = max(series['lounge'] or [0])
    max_boarding = max(series['boarding'] or [0])
    max_immigration = max(series['immigration'] or [0])
    max_baggage = max(series['baggage'] or [0])
    avg_security = _active_avg(series['security'])

    table_labels = pulse.get('table_labels', [])
    table_data = pulse.get('table_data', {})
    table_rows = []
    for idx, label in enumerate(table_labels):
        table_rows.append({
            'time': label,
            **{key: round(_numbers(table_data.get(key))[idx]) if idx < len(_numbers(table_data.get(key))) else 0 for key in TOUCHPOINTS},
        })

    insights = [
        _insight(series, labels, 'checkin', 'Check-In', 'teal', 'Avg (active)', f"{_active_avg(series['checkin']):,} pax"),
        _insight(series, labels, 'security', 'Security', 'purple', 'Pressure Index', f"{(max_security / avg_security):.1f}x avg" if avg_security else '--'),
        _insight(series, labels, 'cbp', 'CBP', 'crit', '% of Security', f"{_pct(max_cbp, max_security) or '--'}% of sec peak"),
        _insight(series, labels, 'lounge', 'Lounge', 'warn', 'Avg Occupancy', f"{_active_avg(series['lounge']):,} pax", 'Peak Concurrent'),
        _insight(series, labels, 'boarding', 'Boarding', 'info', 'Gate Pressure', f"{_pct(max_boarding, max_checkin) or '--'}% of check-in"),
        _insight(series, labels, 'immigration', 'Immigration', 'ok', 'Intl. Arrival Share', f"{_pct(max_immigration, max_baggage) or '--'}% of arrivals"),
    ]

    return {
        'summary': {
            'title': 'Intra-Day Tactical Pulse',
            'subtitle': 'PAX flow aligned to flights between 7 AM to 8:30 AM based on touchpoint-wise probability distributions',
            'window': f"{labels[0]}-{labels[-1]}" if labels else '',
            'lounge_peak': round(max_lounge),
        },
        'series': series,
        'table': {
            'columns': ['time', 'checkin', 'security', 'cbp', 'lounge', 'boarding', 'immigration', 'baggage'],
            'rows': table_rows,
        },
        'flights': _load_flights(base_dir),
        'insights': insights,
    }

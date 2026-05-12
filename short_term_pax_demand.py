import json
import os


PAX_3DAY_FILE = 'pax_3day_cache.json'
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
    if not values:
        return 0
    return max(range(len(values)), key=lambda idx: values[idx])


def _active_avg(values):
    active = [v for v in values if v > 0]
    return round(sum(active) / len(active)) if active else 0


def _pct(part, total):
    if not total:
        return None
    return round((part / total) * 100)


def _peak_time_label(data, values):
    idx = _peak_idx(values)
    time_label = (data.get('labels') or ['--'])[idx] if idx < len(data.get('labels') or []) else '--'
    day_label = (data.get('day_labels') or [''])[idx] if idx < len(data.get('day_labels') or []) else ''
    day_short = ' '.join(str(day_label).split(' ')[1:])
    return f"{day_short} · {time_label}" if day_short else time_label


def _insight(data, key, label, accent, secondary_label, secondary_value, metric_label='Peak Pax / 15-min'):
    values = _numbers(data.get(key))
    return {
        'key': key,
        'label': label,
        'accent': accent,
        'peak': round(max(values) if values else 0),
        'metric_label': metric_label,
        'peak_time': _peak_time_label(data, values),
        'secondary_label': secondary_label,
        'secondary_value': secondary_value,
    }


def build_short_term_pax_outlook(base_dir):
    source = _load_json(base_dir, PAX_3DAY_FILE)
    data = {
        'labels': source.get('labels', []),
        'day_labels': source.get('day_labels', []),
        'days_data': source.get('days_data', []),
    }
    for key in TOUCHPOINTS:
        data[key] = _numbers(source.get(key))

    max_checkin = max(data['checkin'] or [0])
    max_security = max(data['security'] or [0])
    max_cbp = max(data['cbp'] or [0])
    max_lounge = max(data['lounge'] or [0])
    max_boarding = max(data['boarding'] or [0])
    max_immigration = max(data['immigration'] or [0])
    max_baggage = max(data['baggage'] or [0])
    avg_security = _active_avg(data['security'])

    insights = [
        _insight(data, 'checkin', 'Check-In', 'teal', 'Avg (all day)', f"{_active_avg(data['checkin']):,} pax"),
        _insight(data, 'security', 'Security', 'purple', 'Pressure Index', f"{(max_security / avg_security):.1f}x avg" if avg_security else '--'),
        _insight(data, 'cbp', 'CBP Preclearance', 'crit', '% of Security', f"{_pct(max_cbp, max_security) or '--'}% of security peak"),
        _insight(data, 'lounge', 'Lounge / Retail', 'warn', 'Avg Occupancy', f"{_active_avg(data['lounge']):,} pax", 'Peak Concurrent Pax'),
        _insight(data, 'boarding', 'Boarding Gates', 'info', 'Gate Pressure', f"{_pct(max_boarding, max_checkin) or '--'}% of check-in"),
        _insight(data, 'immigration', 'Immigration', 'ok', 'Intl. Arrival Share', f"{_pct(max_immigration, max_baggage) or '--'}% of arrivals"),
    ]

    return {
        'summary': {
            'title': '3-Day Strategic Outlook',
            'subtitle': 'passenger numbers engineered based on actual next 3-day flight schedules',
            'interval': '15-min',
            'lounge_peak': round(max_lounge),
        },
        'series': data,
        'insights': insights,
    }

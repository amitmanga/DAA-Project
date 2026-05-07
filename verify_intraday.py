#!/usr/bin/env python3
import sys, os
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE_DIR)

try:
    import app
except Exception as e:
    print('IMPORT_FAILED', e)
    raise SystemExit(2)

date = '2026-05-07'
try:
    res = app.optimize_day(date, overrides={}, manual_assigns={}, current_time_mins=None, prefer_early=True, custom_constraints={})
    print('OK')
    print('HAS_PAX_SKILLS', 'pax_coverage_skills' in res)
    print('PAX_SKILLS', res.get('pax_coverage_skills'))
except Exception as e:
    import traceback
    traceback.print_exc()
    print('OPT_FAILED', e)
    raise SystemExit(3)

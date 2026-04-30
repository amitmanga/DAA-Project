import importlib.util
import pathlib
import sys

app_path = pathlib.Path(__file__).resolve().parents[1] / 'app.py'
spec = importlib.util.spec_from_file_location("app", str(app_path))
app = importlib.util.module_from_spec(spec)
spec.loader.exec_module(app)

# Choose a date that exists in data; use date from earlier tests
date_str = '02-05-2026'

res = app.optimize_day(date_str, manual_assigns={}, prefer_early=True, custom_constraints={})
staff_map = {s['id']: s for s in res.get('staff', [])}
violations = []
for t in res.get('tasks', []):
    need = t.get('skill', '')
    for sid in t.get('assigned', []):
        s = staff_map.get(sid)
        if not s:
            continue
        staff_skills = set()
        for k in ('skill1','skill2','skill3','skill4'):
            raw = s.get(k, '').strip()
            if raw:
                staff_skills.add(app.TASK_SKILL.get(raw, raw))
        if need and need not in staff_skills:
            violations.append((t['id'], need, sid, list(staff_skills)))

if not violations:
    print('No skill violations found after optimise.')
else:
    print('Found violations:')
    for v in violations[:50]:
        print(v)
    print('Total violations:', len(violations))

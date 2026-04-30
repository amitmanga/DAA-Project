import importlib.util
import pathlib

app_path = pathlib.Path(__file__).resolve().parents[1] / 'app.py'
spec = importlib.util.spec_from_file_location("app", str(app_path))
app = importlib.util.module_from_spec(spec)
spec.loader.exec_module(app)

# Choose date
date_str = '02-05-2026'
res = app.optimize_day(date_str, manual_assigns={}, prefer_early=True, custom_constraints={})
violations = []
staff_map = {s['id']: s for s in res.get('staff', [])}
for t in res.get('tasks', []):
    for sid in t.get('assigned', []):
        s = staff_map.get(sid)
        if not s:
            violations.append((t['id'], sid, 'STAFF_MISSING'))
            continue
        t_start = t.get('start_mins', 0)
        t_end = t.get('end_mins', 0)
        sh_start = s.get('shift_start', 0)
        sh_end = s.get('shift_end', 0)
        if t_start < sh_start or t_end > sh_end:
            violations.append((t['id'], sid, t_start, t_end, sh_start, sh_end))

if not violations:
    print('No shift-coverage violations found after optimise.')
else:
    print('Found violations:')
    for v in violations[:50]:
        print(v)
    print('Total violations:', len(violations))

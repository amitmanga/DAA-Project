import importlib.util
import pathlib

app_path = pathlib.Path(__file__).resolve().parents[1] / 'app.py'
spec = importlib.util.spec_from_file_location("app", str(app_path))
app_mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(app_mod)
flask_app = app_mod.app

with flask_app.test_client() as client:
    print('Posting to /api/intraday/optimise ...')
    r = client.post('/api/intraday/optimise', json={})
    print('Status code:', r.status_code)
    data = r.get_json()

    violations = []
    staff_map = {s['id']: s for s in data.get('staff', [])}
    for t in data.get('tasks', []):
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
        print('No violations after intraday optimise')
    else:
        print('Found violations:', len(violations))
        for v in violations[:60]:
            print(v)

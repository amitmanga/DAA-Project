import json
import importlib.util
import pathlib

# Load app.py as a module from the repository root (avoids import path issues)
app_path = pathlib.Path(__file__).resolve().parents[1] / 'app.py'
spec = importlib.util.spec_from_file_location("app", str(app_path))
app = importlib.util.module_from_spec(spec)
spec.loader.exec_module(app)

staff = app.load_staff()
mezz_only = []
for s in staff:
    emp = s.get('EMPLOYEE NUMBER', '').strip()
    skills = set()
    for c in ['Skill1', 'Skill2', 'Skill3', 'Skill4']:
        val = s.get(c, '').strip()
        if val:
            skills.add(app.normalize_skill(val))
    if skills == {'Mezz Operation'}:
        mezz_only.append(emp)

sa, sk = app.weekly_staff_available()
weeks = sorted(sk.keys())[:6]
print('Total staff:', len(staff))
print('Mezz-only employees (sample up to 10):', mezz_only[:10])
print('Mezz Operation availability (first 6 weeks):')
print(json.dumps({w: sk[w].get('Mezz Operation', 0) for w in weeks}, indent=2))

demand, staff_req, skill_req, staff_avail, skill_avail = app.get_data()
if skill_req:
    wk_sample = sorted(skill_req.keys())[0]
    print('Sample week:', wk_sample)
    print('Mezz Operation demand (fte):', skill_req[wk_sample].get('Mezz Operation', 0))
else:
    print('No skill_req data')

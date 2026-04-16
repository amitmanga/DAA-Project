import sys; sys.path.insert(0, '.')
from datetime import datetime
from app import optimize_day

result = optimize_day(datetime.now().strftime('%Y-%m-%d'), overrides={}, manual_assigns={},
    current_time_mins=600, prefer_early=True,
    custom_constraints={'tt_t1_t2':15,'tt_skill_switch':10,'allow_overlap':False,'shift_duration_hrs':12})

tasks = result.get('tasks', [])
ramp_tasks = [t for t in tasks if t['id'].startswith('RAMP_')]
print(f"Ramp pier block tasks: {len(ramp_tasks)}")
for t in ramp_tasks[:10]:
    print(f"  {t['id']} | {t['task']} | Flights:{t['flight_count']} | Staff:{t['staff_needed']}")

# check shift distribution
from collections import Counter
shifts = Counter(s['shift_label'].split(' ')[0] for s in result.get('staff', []))
print(f"\nShift distribution (density-based):")
for lbl, cnt in sorted(shifts.items()):
    print(f"  {lbl}: {cnt} staff")

# Check breaks
staff_breaks = [(s['id'], len(s.get('breaks',[]))) for s in result['staff'] if s.get('breaks')]
print(f"\nStaff with breaks: {len(staff_breaks)}/{len(result['staff'])}")
if staff_breaks:
    ex = next(s for s in result['staff'] if s.get('breaks'))
    for b in ex['breaks']:
        print(f"  {ex['id']}: {b['type']} {b['start']}-{b['end']}")

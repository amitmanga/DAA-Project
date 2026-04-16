import sys; sys.path.insert(0, '.')
from datetime import datetime
from app import optimize_day

result = optimize_day(datetime.now().strftime('%Y-%m-%d'), overrides={}, manual_assigns={},
    current_time_mins=600, prefer_early=True,
    custom_constraints={'tt_t1_t2':15,'tt_skill_switch':10,'allow_overlap':False,'shift_duration_hrs':12})

pier_blocks = [t for t in result.get('tasks',[]) if t['id'].startswith('PBLK_')]
print(f'Pier block tasks: {len(pier_blocks)}')
for t in pier_blocks[:10]:
    print(f"  {t['id']} | {t['task']} | Pax:{t.get('total_pax',0)} | Need:{t['staff_needed']}")

staff_with_breaks = [s for s in result.get('staff',[]) if s.get('breaks')]
print(f'\nStaff with breaks: {len(staff_with_breaks)}/{len(result["staff"])}')
if staff_with_breaks:
    ex = staff_with_breaks[0]
    print(f'  Example - {ex["id"]}: {[(b["type"],b["start"],b["end"]) for b in ex["breaks"]]}')

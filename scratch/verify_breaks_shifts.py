import sys; sys.path.insert(0, '.')
from datetime import datetime
from app import optimize_day

result = optimize_day(datetime.now().strftime('%Y-%m-%d'), overrides={}, manual_assigns={},
    current_time_mins=600, prefer_early=True,
    custom_constraints={'tt_t1_t2':15,'tt_skill_switch':10,'allow_overlap':False,'shift_duration_hrs':12})

# 1. Verify shift spans are flight-active only
from collections import Counter
shift_starts = Counter()
for s in result.get('staff', []):
    shift_starts[s['shift_start']] += 1
print("Shift start distribution (density-based, flight-only windows):")
for start, cnt in sorted(shift_starts.items()):
    h = start // 60
    m = start % 60
    print(f"  {h:02d}:{m:02d} shift start: {cnt} staff")

# 2. Verify break gaps
print("\nBreak gap check (all staff with 2 breaks):")
errors = 0
ok = 0
for s in result.get('staff', []):
    brks = sorted(s.get('breaks', []), key=lambda b: b['start_mins'])
    if len(brks) == 2:
        gap = brks[1]['start_mins'] - brks[0]['end_mins']
        if gap < 180:
            print(f"  FAIL {s['id']}: gap={gap}min < 180min  ({brks[0]['end']}->{brks[1]['start']})")
            errors += 1
        else:
            ok += 1
print(f"  {ok} staff with 2 breaks all have >=3h gap. {errors} violations.")

# 3. Total breaks overview
breaks_count = Counter(len(s.get('breaks',[])) for s in result.get('staff',[]))
print(f"\nBreaks per staff: {dict(breaks_count)}")

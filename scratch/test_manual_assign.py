import importlib.util
import pathlib
import json

app_path = pathlib.Path(__file__).resolve().parents[1] / 'app.py'
spec = importlib.util.spec_from_file_location("app", str(app_path))
app = importlib.util.module_from_spec(spec)
spec.loader.exec_module(app)

# Choose date '02-05-2026' (format dd-mm-YYYY)
date_str = '02-05-2026'

# Run a baseline optimise to get tasks
res = app.optimize_day(date_str, manual_assigns={}, prefer_early=True, custom_constraints={})
all_tasks = res.get('tasks', [])
arr_task = None
for t in all_tasks:
    if t.get('skill') == 'Arr Customer Service':
        arr_task = t
        break

if not arr_task:
    print('No Arr Customer Service task found for', date_str)
    exit(0)

print('Found task:', arr_task['id'], 'skill:', arr_task['skill'], 'needed:', arr_task['staff_needed'])

# Attempt manual assign of mezz-only employee DAA-4401
manual = {arr_task['id']: ['DAA-4401']}
res2 = app.optimize_day(date_str, manual_assigns=manual, prefer_early=True, custom_constraints={})
# Find task in new result
new_tasks = res2.get('tasks', [])
task_map = {t['id']: t for t in new_tasks}
new_t = task_map.get(arr_task['id'])
print('After manual assign attempt, assigned:', new_t.get('assigned'))

# Print warnings from app (printed to stdout) are visible above when running

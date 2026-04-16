
import os
import sys
import json
from datetime import datetime

# Mock the environment or import the actual app
# We need to be in the project root
sys.path.append(os.getcwd())

from app import optimize_day

def test_optimization():
    print("Testing Intraday Optimization...")
    today_str = datetime.now().strftime('%Y-%m-%d')
    # Use default constraints
    constraints = {
        'tt_t1_t2': 15,
        'tt_skill_switch': 10,
        'allow_overlap': False,
        'use_primary_first': True,
        'shift_duration_hrs': 12
    }
    
    start_time = datetime.now()
    try:
        result = optimize_day(today_str, overrides={}, manual_assigns={}, 
                              current_time_mins=600, prefer_early=True, 
                              custom_constraints=constraints)
        end_time = datetime.now()
        duration = (end_time - start_time).total_seconds()
        print(f"Optimization finished in {duration:.2f} seconds.")
        if 'error' in result:
            print(f"Error: {result['error']}")
        else:
            print(f"Successfully generated {len(result.get('tasks', []))} tasks.")
            print(f"Staff on duty: {len(result.get('staff', []))}")
            
            block_tasks = [t for t in result.get('tasks', []) if 'BLOCK' in t['id']]
            print(f"\n--- BLOCK TASKS ({len(block_tasks)}) ---")
            for bt in block_tasks:
                print(f"ID: {bt['id']} | Task: {bt['task']} | Pax: {bt.get('total_pax',0)} | Staff Needed: {bt['staff_needed']}")
    except Exception as e:
        print(f"Crash during optimization: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    test_optimization()

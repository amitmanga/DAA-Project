
import os

path = r'c:\Users\user\OneDrive\Coding\python_scripts\DAA-Project\app.py'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

# Pattern 1: Terminal block tasks
old1 = '"task":            task_label,\n            "skill":'
new1 = '"task":            task_label,\n            "role":            task_name,\n            "skill":'

if old1 in content:
    content = content.replace(old1, new1)
    print("Applied pattern 1")
else:
    # Try with \r\n
    old1_rn = old1.replace('\n', '\r\n')
    new1_rn = new1.replace('\n', '\r\n')
    if old1_rn in content:
        content = content.replace(old1_rn, new1_rn)
        print("Applied pattern 1 (CRLF)")
    else:
        print("Failed pattern 1")

# Pattern 2: Pier block tasks
# (Same logic but task_name is already correct)
if new1 not in content:
    print("Pattern 2 might be needed separately if distinct")

with open(path, 'w', encoding='utf-8') as f:
    f.write(content)

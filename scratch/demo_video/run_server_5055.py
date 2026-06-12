import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import app


if __name__ == "__main__":
    app.app.run(host="127.0.0.1", port=5055, debug=False, use_reloader=False)

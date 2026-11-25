"""Load the installed ADF package in isolated Python mode."""

from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from adf.__main__ import main

raise SystemExit(main())

"""Validate a folder using Harbor 0.22.0, independently of npm test."""
import argparse
from pathlib import Path
from harbor.utils.trajectory_validator import TrajectoryValidator

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("folder", type=Path)
args = parser.parse_args()
files = sorted(args.folder.glob("*.json"))
if not files:
    parser.error("folder contains no *.json files")
failed = False
for file in files:
    validator = TrajectoryValidator()
    try:
        valid = validator.validate(file)
        errors = validator.errors
    except Exception as error:
        valid, errors = False, [str(error)]
    print(f"{file}: {'VALID' if valid else 'INVALID'}")
    for error in errors:
        print(f"  {error}")
    failed |= not valid
raise SystemExit(1 if failed else 0)

#!/usr/bin/env python3
import os
import sys
from pathlib import Path
import unittest

# Ensure project root is in sys.path
PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

def run_suite():
    loader = unittest.TestLoader()
    start_dir = "tests"
    suite = loader.discover(start_dir, pattern="test_*.py")
    
    print("=" * 60)
    print(" 🧪 RUNNING UNIVERSAL PDF-TO-MARKDOWN TEST SUITE")
    print("=" * 60)
    
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    
    print("=" * 60)
    if result.wasSuccessful():
        print(f" ✅ ALL {result.testsRun} TESTS PASSED SUCCESSFULLY!")
        print("=" * 60)
        return 0
    else:
        print(f" ❌ {len(result.failures)} FAILURES, {len(result.errors)} ERRORS out of {result.testsRun} tests.")
        print("=" * 60)
        return 1

if __name__ == "__main__":
    sys.exit(run_suite())

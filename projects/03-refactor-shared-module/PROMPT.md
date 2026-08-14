`report_a.py` and `report_b.py` both define an identical `format_currency` function.
Remove that duplication.

1. Create a new file `formatting.py` containing the single shared `format_currency` function.
2. Edit `report_a.py` and `report_b.py` to import `format_currency` from `formatting`
   instead of each defining their own copy.
3. Do not change any behaviour and do not modify `test_reports.py`.
4. Run `python3 -m pytest -q` and confirm both tests still pass.

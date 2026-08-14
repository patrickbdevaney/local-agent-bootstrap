Write a script that summarises the event log in this directory.

`events.json` is a JSON array of objects, each with `level`, `service`, and `ms`.

1. Create `stats.py` that reads `events.json` and prints exactly this format:

   ```
   total: <number of events>
   level <name>: <count>          (one line per level, alphabetical by level)
   avg <service>: <average ms>    (one line per service, alphabetical by service,
                                   rounded to one decimal place)
   ```

2. Create `test_stats.py` with at least one pytest test covering the averaging logic.
   Put the averaging logic in a function in `stats.py` so it can be imported and tested.
3. Run `python3 -m pytest -q` and confirm it passes.
4. Run `python3 stats.py` and show me the output.

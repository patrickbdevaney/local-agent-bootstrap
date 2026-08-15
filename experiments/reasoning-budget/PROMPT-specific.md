Perform exactly these four steps in order. Do not plan at length before acting —
call a tool on your very first response, and keep any prose under two sentences.

Step 1. Use the edit tool on `mathutil.py`. Append exactly these three lines to the
end of the file (keeping the existing `add` function unchanged):

    def multiply(a, b):
        return a * b

Step 2. Use the edit tool on `test_mathutil.py`. Change the first line from
`from mathutil import add` to `from mathutil import add, multiply`.

Step 3. Use the edit tool on `test_mathutil.py` again. Append exactly these two
lines to the end of the file:

    def test_multiply():
        assert multiply(2, 3) == 6

Step 4. Run the bash command `python3 -m pytest -q`. It must report `2 passed`.

When step 4 reports 2 passed, reply with the single word DONE and stop.

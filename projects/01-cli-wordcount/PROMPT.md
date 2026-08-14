Create a word-frequency tool in this directory.

`sample.txt` already exists in this directory and is the input data.
Do NOT modify, overwrite, or recreate `sample.txt` — read it as-is.

1. Create `wordcount.py` containing:
   - A function `count_words(text)` that lowercases the text, splits it on whitespace,
     and returns a dict mapping each word to how many times it appears.
   - A `main()` using `argparse` that accepts a file path positional argument and an
     optional `--top N` (default 5). It reads the file and prints the N most common
     words, one per line, in the format `word count` (a single space between them),
     most common first.
   - A standard `if __name__ == "__main__": main()` block.
2. Create `test_wordcount.py` with pytest tests for `count_words`. Write the tests
   against inline strings, not against `sample.txt`.
3. Run `python3 -m pytest -q` and make sure it passes.
4. Run `python3 wordcount.py sample.txt --top 3` and show me the output.

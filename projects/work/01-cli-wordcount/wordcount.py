import argparse
from collections import Counter


def count_words(text):
    """Lowercase the text, split on whitespace, return dict mapping word to count."""
    words = text.lower().split()
    return Counter(words)


def main():
    parser = argparse.ArgumentParser(description="Count word frequencies in a file")
    parser.add_argument("file_path", help="Path to the input file")
    parser.add_argument("--top", type=int, default=5, help="Number of top words to show (default: 5)")
    args = parser.parse_args()

    with open(args.file_path, 'r') as f:
        text = f.read()

    word_counts = count_words(text)
    top_words = word_counts.most_common(args.top)

    for word, count in top_words:
        print(f"{word} {count}")


if __name__ == "__main__":
    main()

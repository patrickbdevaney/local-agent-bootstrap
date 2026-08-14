import pytest
from wordcount import count_words


def test_count_words_basic():
    text = "hello world hello"
    result = count_words(text)
    assert result == {"hello": 2, "world": 1}


def test_count_words_empty():
    text = ""
    result = count_words(text)
    assert result == {}


def test_count_words_single_word():
    text = "hello"
    result = count_words(text)
    assert result == {"hello": 1}


def test_count_words_multiple_words():
    text = "the quick brown fox"
    result = count_words(text)
    assert result == {"the": 1, "quick": 1, "brown": 1, "fox": 1}


def test_count_words_case_insensitive():
    text = "Hello world hello"
    result = count_words(text)
    assert result == {"hello": 2, "world": 1}


def test_count_words_with_whitespace():
    text = "hello   world\tworld"
    result = count_words(text)
    assert result == {"hello": 1, "world": 2}

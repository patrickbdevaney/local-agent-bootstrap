from search import binary_search


def test_finds_first():
    assert binary_search([1, 3, 5, 7, 9], 1) == 0


def test_finds_last():
    assert binary_search([1, 3, 5, 7, 9], 9) == 4


def test_finds_middle():
    assert binary_search([1, 3, 5, 7, 9], 5) == 2


def test_absent():
    assert binary_search([1, 3, 5, 7, 9], 4) == -1


def test_single_element():
    assert binary_search([42], 42) == 0


def test_empty():
    assert binary_search([], 1) == -1

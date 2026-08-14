import pytest
from stats import calculate_averages


def test_calculate_averages():
    events = [
        {"level": "info", "service": "api", "ms": 100},
        {"level": "info", "service": "api", "ms": 200},
        {"level": "error", "service": "api", "ms": 300},
        {"level": "info", "service": "db", "ms": 50},
        {"level": "warn", "service": "db", "ms": 150},
        {"level": "error", "service": "cache", "ms": 10},
    ]
    
    averages = calculate_averages(events)
    
    assert averages["api"] == 200.0
    assert averages["db"] == 100.0
    assert averages["cache"] == 10.0

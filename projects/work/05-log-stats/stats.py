import json
from collections import defaultdict


def calculate_averages(events):
    """Calculate average ms per service."""
    service_times = defaultdict(list)
    for event in events:
        service_times[event["service"]].append(event["ms"])
    
    averages = {}
    for service, times in service_times.items():
        averages[service] = sum(times) / len(times)
    return averages


def print_stats(events):
    """Print statistics in the required format."""
    total = len(events)
    
    # Count by level
    level_counts = defaultdict(int)
    for event in events:
        level_counts[event["level"]] += 1
    
    # Count by service and calculate averages
    service_times = defaultdict(list)
    for event in events:
        service_times[event["service"]].append(event["ms"])
    
    averages = {}
    for service, times in service_times.items():
        averages[service] = round(sum(times) / len(times), 1)
    
    # Print total
    print(f"total: {total}")
    
    # Print levels (alphabetical)
    for level in sorted(level_counts.keys()):
        print(f"level {level}: {level_counts[level]}")
    
    # Print averages (alphabetical by service)
    for service in sorted(averages.keys()):
        print(f"avg {service}: {averages[service]}")


def main():
    with open("events.json", "r") as f:
        events = json.load(f)
    
    print_stats(events)


if __name__ == "__main__":
    main()

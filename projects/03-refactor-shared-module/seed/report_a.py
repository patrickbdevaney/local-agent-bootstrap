def format_currency(amount):
    return "$%.2f" % amount


def sales_report(rows):
    return "\n".join("%s: %s" % (n, format_currency(v)) for n, v in rows)

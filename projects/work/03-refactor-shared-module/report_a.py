from formatting import format_currency


def sales_report(rows):
    return "\n".join("%s: %s" % (n, format_currency(v)) for n, v in rows)

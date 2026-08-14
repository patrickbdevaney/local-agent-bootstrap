from formatting import format_currency


def refund_report(rows):
    return "\n".join("REFUND %s: %s" % (n, format_currency(v)) for n, v in rows)

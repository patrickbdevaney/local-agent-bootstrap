from report_a import sales_report
from report_b import refund_report


def test_sales():
    assert sales_report([("widget", 3.5)]) == "widget: $3.50"


def test_refund():
    assert refund_report([("widget", 3.5)]) == "REFUND widget: $3.50"

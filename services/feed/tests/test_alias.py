from feed_service.alias import alias_of, edge_slug


def test_alias_differs_from_node_key_but_stays_readable():
    assert alias_of("STAMP_2") == "prs-02"
    assert alias_of("STAMP_10") == "prs-10"
    assert alias_of("KHO_A") == "wh-a"
    assert alias_of("FG_1") == "wh-fg-01"
    assert alias_of("QC") == "aoi"
    assert alias_of("TUG_B") == "tug-b"
    assert alias_of("SUPPLIER") == "dock-in"
    assert alias_of("WIDGET_3") == "widget-03"   # không có trong bảng → chữ thường + số 2 chữ số
    assert alias_of("odd key!") == "odd-key"


def test_edge_slug_is_unique_per_edge_and_has_no_mqtt_wildcards():
    a = edge_slug("KHO_A>STAMP_1")
    b = edge_slug("KHO_B>STAMP_2")
    c = edge_slug("KHO_B>STAMP_2#2")
    assert a == "wh-a~prs-01" and b == "wh-b~prs-02" and c == "wh-b~prs-02.2"
    for s in (a, b, c):
        assert "#" not in s and "+" not in s and "/" not in s

"""body_to_html: the markup the formatted editor writes must render as shown."""
from communication_center import body_to_html


def test_bold_italic_renders_as_both():
    html = body_to_html("***both*** and **bold** and *it*")
    assert "<strong><em>both</em></strong>" in html
    assert "<strong>bold</strong>" in html
    assert "<em>it</em>" in html


def test_touching_marks_split_by_zero_width_space():
    html = body_to_html("*a*​**b**")
    assert "<em>a</em>​<strong>b</strong>" in html


def test_zero_width_space_keeps_typed_marks_as_text():
    html = body_to_html("​- not a list\n\n​## not a heading")
    assert "<ul" not in html and "<li" not in html
    assert "not a heading" in html and "font-size:20px" not in html


def test_literal_star_never_pairs():
    html = body_to_html("2 ∗ 3 ∗ 4")
    assert "<em>" not in html


def test_sub_lists_nest_inside_their_item():
    html = body_to_html("- a\n  - b\n    1. c\n  - d\n- e")
    assert html.count("<ul") == 2 and html.count("<ol") == 1
    # b and d share the sub-list opened inside a; c's list sits inside b.
    assert "a<ul" in html and "b<ol" in html
    assert "circle" in html and "lower-roman" in html
    assert html.index("d</li></ul>") < html.index(">e")


def test_four_space_and_tab_indents_nest_the_same():
    two = body_to_html("- a\n  - b")
    assert body_to_html("- a\n    - b") == two
    assert body_to_html("- a\n\t- b") == two


def test_depth_caps_at_three_and_type_change_splits_level():
    html = body_to_html("- a\n  - b\n    - c\n      - d")
    assert html.count("<ul") == 3
    mixed = body_to_html("- a\n1. b")
    assert mixed.index("</ul>") < mixed.index("<ol")


def test_flat_list_unchanged():
    assert body_to_html("- a\n- b").count("<ul") == 1

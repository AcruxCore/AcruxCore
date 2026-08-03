"""Unit tests for the @acrux.tool decorator and its schema derivation.

Nothing here touches the network: the decorator is pure by design, so these tests
are the full contract for what it produces.
"""

from __future__ import annotations

import enum
from typing import Dict, List, Literal, Optional

import pytest

from acruxcore import ToolSchemaError, acrux, spec_of


# Module level, not inside the tests that use them. `from __future__ import annotations`
# turns every annotation into a string resolved against module globals, so a class
# defined inside a test function is unreachable — see the dedicated test at the bottom.
class Colour(enum.Enum):
    RED = "red"
    BLUE = "blue"


class Widget:
    """A type the converter has no JSON Schema for."""


def test_bare_decorator_derives_name_description_and_schema():
    @acrux.tool
    async def get_weather(city: str) -> dict:
        """Get the current weather for a city.

        Args:
            city: City name, e.g. 'Lahore'.
        """
        return {}

    spec = spec_of(get_weather)
    assert spec is not None
    assert spec.name == "get_weather"
    assert spec.description == "Get the current weather for a city."
    assert spec.parameters_schema == {
        "type": "object",
        "properties": {"city": {"type": "string", "description": "City name, e.g. 'Lahore'."}},
        "required": ["city"],
    }
    assert spec.executor == {"type": "client"}
    assert spec.alias == "production"
    assert spec.changelog is None


def test_decorated_function_is_still_callable():
    @acrux.tool
    def add(a: int, b: int) -> int:
        """Add two numbers."""
        return a + b

    assert add(2, 3) == 5
    assert add.__name__ == "add"


def test_multi_paragraph_docstring_uses_only_the_first_paragraph():
    @acrux.tool
    def f(x: str) -> str:
        """One line summary.

        A second paragraph the model does not need.

        Args:
            x: The x.
        """
        return x

    assert spec_of(f).description == "One line summary."


def test_multi_line_first_paragraph_is_joined():
    @acrux.tool
    def f(x: str) -> str:
        """A summary that wraps
        across two source lines.

        Args:
            x: The x.
        """
        return x

    assert spec_of(f).description == "A summary that wraps across two source lines."


def test_parameters_without_defaults_are_required_and_with_defaults_are_not():
    @acrux.tool
    def f(a: str, b: int = 3) -> str:
        """Do a thing."""
        return a

    schema = spec_of(f).parameters_schema
    assert schema["required"] == ["a"]
    assert schema["properties"]["b"] == {"type": "integer"}


def test_required_is_omitted_when_no_parameter_is_required():
    @acrux.tool
    def f(a: str = "x") -> str:
        """Do a thing."""
        return a

    assert "required" not in spec_of(f).parameters_schema


def test_no_parameters_gives_an_empty_properties_object():
    @acrux.tool
    def now() -> str:
        """Return the current time."""
        return "now"

    assert spec_of(now).parameters_schema == {"type": "object", "properties": {}}


def test_every_supported_hint():
    @acrux.tool
    def f(
        s: str,
        i: int,
        fl: float,
        b: bool,
        li: List[str],
        d: Dict[str, int],
        opt: Optional[str] = None,
        lit: Literal["a", "b"] = "a",
        col: Colour = Colour.RED,
    ) -> str:
        """Everything."""
        return s

    props = spec_of(f).parameters_schema["properties"]
    assert props["s"] == {"type": "string"}
    assert props["i"] == {"type": "integer"}
    assert props["fl"] == {"type": "number"}
    assert props["b"] == {"type": "boolean"}
    assert props["li"] == {"type": "array", "items": {"type": "string"}}
    assert props["d"] == {"type": "object"}
    # Optional[T] unwraps to T; optionality is carried by `required`, not by a null type.
    assert props["opt"] == {"type": "string"}
    assert props["lit"] == {"type": "string", "enum": ["a", "b"]}
    assert props["col"] == {"type": "string", "enum": ["red", "blue"]}


def test_unsupported_hint_raises_at_decoration_time_naming_the_parameter():
    with pytest.raises(ToolSchemaError) as exc:

        @acrux.tool
        def f(w: Widget) -> str:
            """Take a widget."""
            return "x"

    message = str(exc.value)
    assert "f" in message
    assert "w" in message
    assert "parameters=" in message  # points at the escape hatch


def test_missing_hint_raises_at_decoration_time():
    with pytest.raises(ToolSchemaError):

        @acrux.tool
        def f(x) -> str:
            """No hint on x."""
            return "y"


def test_var_args_raise():
    with pytest.raises(ToolSchemaError):

        @acrux.tool
        def f(*args: str) -> str:
            """Varargs."""
            return "y"


def test_bare_list_hint_raises_and_asks_for_an_item_type():
    with pytest.raises(ToolSchemaError) as exc:

        @acrux.tool
        def f(xs: list) -> str:
            """Bare list."""
            return "y"

    assert "list[str]" in str(exc.value)


def test_explicit_parameters_skip_derivation_entirely():
    hand_written = {"type": "object", "properties": {"w": {"type": "string"}}, "required": ["w"]}

    @acrux.tool(parameters=hand_written)
    def f(w: Widget) -> str:
        """Take a widget."""
        return "x"

    assert spec_of(f).parameters_schema == hand_written


def test_overrides():
    @acrux.tool(name="weather", description="Overridden.", alias="staging", changelog="v2")
    def get_weather(city: str) -> dict:
        """Ignored because description was overridden.

        Args:
            city: The city.
        """
        return {}

    spec = spec_of(get_weather)
    assert spec.name == "weather"
    assert spec.description == "Overridden."
    assert spec.alias == "staging"
    assert spec.changelog == "v2"
    # The Args: block still supplies the parameter description.
    assert spec.parameters_schema["properties"]["city"]["description"] == "The city."


def test_missing_docstring_gives_a_none_description_and_still_derives_the_schema():
    @acrux.tool
    def f(x: str) -> str:
        return x

    spec = spec_of(f)
    assert spec.description is None
    assert spec.parameters_schema["properties"]["x"] == {"type": "string"}


def test_spec_of_returns_none_for_an_undecorated_callable():
    def plain(x: str) -> str:
        return x

    assert spec_of(plain) is None
    assert spec_of("not even a function") is None


def test_args_block_continuation_lines_are_joined():
    @acrux.tool
    def f(city: str) -> str:
        """Look something up.

        Args:
            city: The city name, which may be
                spelled in any language.
        """
        return city

    described = spec_of(f).parameters_schema["properties"]["city"]["description"]
    assert described == "The city name, which may be spelled in any language."


def test_a_hint_defined_inside_another_function_names_the_parameter_and_the_cause():
    """The PEP 563 footgun: a locally-scoped class cannot be resolved at runtime."""

    class LocalOnly:
        pass

    with pytest.raises(ToolSchemaError) as exc:

        @acrux.tool
        def f(thing: LocalOnly) -> str:
            """Take a local type."""
            return "x"

    message = str(exc.value)
    assert "'thing'" in message
    assert "module level" in message
    assert "parameters=" in message


def test_a_section_after_args_does_not_leak_into_a_parameter_description():
    @acrux.tool
    def f(city: str) -> str:
        """Look something up.

        Args:
            city: The city name.

        Returns:
            A string nobody should see in the schema.
        """
        return city

    props = spec_of(f).parameters_schema["properties"]
    assert props["city"]["description"] == "The city name."
    assert "Returns" not in str(props)

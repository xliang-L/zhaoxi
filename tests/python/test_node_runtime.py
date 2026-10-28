"""Match the pinned OpenClaw runtime's minimum supported Node versions."""
import pytest
from zhaoxi.config import supported_node


@pytest.mark.parametrize(('version', 'expected'), [
    ('v22.22.0', False), ('v24.21.0', False), ('v24.22.0', False),
    ('v24.22.1', True), ('v24.23.0', True), ('v25.0.0', False),
    ('v26.12.0', False), ('v26.12.1', True), ('v27.0.0', True), ('garbage', False),
])
def test_node_minimum(version, expected):
    assert supported_node(version) is expected

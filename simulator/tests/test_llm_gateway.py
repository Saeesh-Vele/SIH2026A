"""The simulator's internal LLM gateway for the assistant (/api/llm/chat): input
validation, the router's own budget, and tool-call parsing. Groq is mocked."""

import pytest

import simulator as sim


@pytest.fixture
def gw(monkeypatch):
    monkeypatch.setattr(sim, "GROQ_API_KEY", "test-key-not-used")
    monkeypatch.setattr(sim, "_groq_calls", sim.collections.deque())
    monkeypatch.setattr(sim, "_router_calls", sim.collections.deque())
    return sim.control_app.test_client()


class FakeResp:
    def __init__(self, status, body):
        self.status_code = status
        self._body = body
        self.text = str(body)

    def json(self):
        return self._body


def _ok(content=None, tool_calls=None):
    return FakeResp(200, {"choices": [{"message": {"content": content, "tool_calls": tool_calls}}],
                          "usage": {"prompt_tokens": 100, "completion_tokens": 20}})


def test_router_call_returns_parsed_tool_calls(gw, monkeypatch):
    sent = {}

    def post(url, json=None, **kw):
        sent.update(json)
        return _ok(tool_calls=[{"function": {"name": "navigate", "arguments": '{"module": "energy"}'}},
                               {"function": {"name": "broken", "arguments": "{not json"}}])
    monkeypatch.setattr(sim.requests, "post", post)
    r = gw.post("/api/llm/chat", json={"kind": "router", "messages": [{"role": "user", "content": "power page"}],
                                       "tools": [{"type": "function"}]}).get_json()
    assert r["available"] is True
    assert r["toolCalls"] == [{"name": "navigate", "arguments": {"module": "energy"}}]
    assert sent["model"] == sim.app_config.GROQ_ROUTER_MODEL and sent["tool_choice"] == "auto"
    assert sent["reasoning_effort"] == "low"


def test_explain_call_uses_the_explanation_model_and_json_mode(gw, monkeypatch):
    sent = {}

    def post(url, json=None, **kw):
        sent.update(json)
        return _ok(content='{"spoken": "ok"}')
    monkeypatch.setattr(sim.requests, "post", post)
    r = gw.post("/api/llm/chat", json={"kind": "explain", "json": True,
                                       "messages": [{"role": "user", "content": "q"}]}).get_json()
    assert r["content"] == '{"spoken": "ok"}'
    assert sent["model"] == sim.GROQ_MODEL and sent["response_format"] == {"type": "json_object"}


def test_router_has_its_own_budget(gw, monkeypatch):
    monkeypatch.setattr(sim.app_config, "GROQ_ROUTER_MAX_CALLS_PER_HOUR", 1)
    monkeypatch.setattr(sim.requests, "post", lambda *a, **k: _ok(content="x"))
    body = {"kind": "router", "messages": [{"role": "user", "content": "x"}]}
    assert gw.post("/api/llm/chat", json=body).get_json()["available"] is True
    capped = gw.post("/api/llm/chat", json=body).get_json()
    assert capped["available"] is False and capped["capped"] is True
    assert sim.groq_budget_remaining() > 0          # the explanation budget is untouched


def test_upstream_errors_degrade(gw, monkeypatch):
    monkeypatch.setattr(sim.requests, "post", lambda *a, **k: FakeResp(429, {"error": "rate"}))
    r = gw.post("/api/llm/chat", json={"kind": "explain", "messages": [{"role": "user", "content": "x"}]}).get_json()
    assert r["available"] is False and r["reason"] == "upstream HTTP 429"


@pytest.mark.parametrize("body", [
    {"kind": "other", "messages": [{"role": "user", "content": "x"}]},
    {"kind": "router", "messages": []},
    {"kind": "router", "messages": [{"role": "tool", "content": "x"}]},
    {"kind": "router", "messages": [{"role": "user", "content": "x" * 20000}]},
    {"kind": "router", "messages": [{"role": "user", "content": "x"}], "tools": "all"},
])
def test_gateway_rejects_bad_input(gw, body):
    assert gw.post("/api/llm/chat", json=body).status_code == 400


def test_no_key_means_unavailable(gw, monkeypatch):
    monkeypatch.setattr(sim, "GROQ_API_KEY", "")
    r = gw.post("/api/llm/chat", json={"kind": "router", "messages": [{"role": "user", "content": "x"}]}).get_json()
    assert r["available"] is False and "GROQ_API_KEY" in r["reason"]
    st = gw.get("/api/llm/status").get_json()
    assert st["configured"] is False

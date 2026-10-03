"""Aurora assistant: playbooks, the action whitelist, deterministic understanding and
answers, the numeric grounding check, and the /api/assistant/* routes with the LLM
mocked (no network: conftest blocks it)."""

import copy

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

import assistant
import station_config

SNAPSHOT = {
    "stationId": "bharati", "timestamp": 1791042477485, "dataSource": "simulator",
    "provenance": {"equipment": "MODEL-DERIVED", "environment": "REANALYSIS", "storage": "MODEL-DERIVED",
                   "injectedSensors": ["generator.gen_power"], "activeScenario": "generator_failure",
                   "weatherSource": "ERA5 (ECMWF)"},
    "sensors": {
        "generator": {"gen_power": 25.4, "gen_fuel_rate": 14.66, "gen_rpm": 612.0, "gen_temp": 104.2},
        "heating": {"heat_a_flow": 1.4, "heat_a_temp": 50.2, "heat_a_pressure": 3.24},
        "heatingB": {"heat_b_flow": 0.93, "heat_b_temp": 69.11},
        "waterTank": {"water_level": 81.85, "water_temp": 11.77, "water_ph": 7.07},
        "commsMast": {"comms_signal": -38.71, "comms_bandwidth": 3.04, "comms_uptime": 99.52},
        "livingQuarters": {"lq_temp": 23.49, "lq_humidity": 44.1, "lq_co2": 420.63},
        "storage": {"store_fuel": 153.87, "store_food": 209.63, "store_spares": 380.0},
        "lab": {"env_temp": -15.6, "env_wind": 9.8, "env_pressure": 971.3, "env_humidity": 70.7},
    },
    "energy": {"loadPct": 29.4},
    "replay": {"local": "2026-09-05T19:03:22"},
    "alerts": {"generator": "critical", "heating": "warning", "heatingB": "normal", "waterTank": "normal",
               "commsMast": "normal", "livingQuarters": "normal", "storage": "normal", "lab": "normal"},
    "activeAlerts": [
        {"id": "a1", "buildingId": "generator", "buildingName": "Generator Shed", "level": "critical",
         "sensor": "gen_power", "value": 25.4, "unit": "kW", "threshold": 30, "direction": "low",
         "timestamp": 1791042400000, "acknowledged": False},
        {"id": "a2", "buildingId": "heating", "buildingName": "Heating Zone A", "level": "warning",
         "sensor": "heat_a_temp", "value": 50.2, "unit": "°C", "threshold": 55, "direction": "low",
         "timestamp": 1791042410000, "acknowledged": False},
    ],
    "dependencyAlerts": [
        {"sourceBuilding": "generator", "affectedBuilding": "heating", "severity": "critical",
         "chain": ["generator", "heating"]},
        {"sourceBuilding": "generator", "affectedBuilding": "livingQuarters", "severity": "warning",
         "chain": ["generator", "heating", "livingQuarters"]},
    ],
    "publicDemo": {"bharati": {"scenario": "generator_failure", "name": "Generator Failure", "remainingS": 80}},
}
ANOMALY = {
    "anomalyScore": 0.712, "threshold": 0.564, "isAnomaly": True, "detectorAvailable": True,
    "triggeredBy": ["isolation_forest", "residual_z"], "maxResidualSigma": 41.3, "residualAlarmSigma": 6.0,
    "evidence": [{"sensor": "gen_rpm", "value": 612.0, "expected": 1512.5, "deviation_sigma": -41.3,
                  "direction": "below"}],
    "candidateCauses": [{"cause": "generator_output_loss", "confidence": 1.0,
                         "matchingSensors": ["gen_power", "gen_rpm"],
                         "description": "Possible generator output loss (power and RPM below physics prediction)"}],
}
DECISION = {
    "event": {"type": "generator_output_loss", "description": "Possible generator output loss"},
    "risk": {"level": "high", "triggered_rules": [
        {"id": "R005", "name": "Anomaly without load change", "rationale": "Equipment anomaly under stable load."}]},
    "impact": ["Heating zones may lose electrical supply."],
    "recommendation": {"action": "Check generator output", "monitoring": "Every 5 min", "escalation": "Start backup",
                       "action_type": "operator_review", "confidence": "high"},
    "forecast": {"available": True, "temperature_change": -3.0, "load_change_pp": 1.2, "gen_temp_predicted_24h": 60.0},
    "auditTrail": [{"step": "current_state", "source": "telemetry", "provenance": "x", "data": {"big": 1}},
                   {"step": "risk_evaluation", "source": "decision_engine", "provenance": "y"}],
}


@pytest.fixture
def ctx():
    return assistant.build_context("bharati", copy.deepcopy(SNAPSHOT), ANOMALY, DECISION,
                                   link={"up": True, "bufferedReadings": 0})


# ── playbooks ─────────────────────────────────────────────────

def test_every_playbook_is_complete_and_marked_as_an_example():
    books = assistant.playbooks()
    assert books["disclaimer"] == "Example procedure, not an official NCPOR procedure."
    ids = [p["id"] for p in books["playbooks"]]
    for required in ("generator_failure", "heating_failure", "water_crisis", "co2_spike", "blizzard", "link_loss",
                     "low_fuel", "anomaly"):
        assert required in ids
    modules = set(assistant.catalogue()["modules"])
    buildings = set(station_config.building_names("maitri"))
    for p in books["playbooks"]:
        assert p["title"] and p["meaning"] and p["riskRationale"] and p["affectedHint"]
        assert p["typicalCauses"], p["id"]
        assert 4 <= len(p["steps"]) <= 6, p["id"]
        assert all(s["do"].endswith(".") and s["say"] and s["say"][0].islower() for s in p["steps"]), p["id"]
        assert p["page"] in modules
        assert p["baselineRisk"] in ("nominal", "low", "moderate", "high", "critical")
        assert p["focus"] is None or p["focus"] in buildings


def test_failure_playbooks_have_a_serious_risk_floor():
    rank = {"nominal": 0, "low": 1, "moderate": 2, "high": 3, "critical": 4}
    assert rank[assistant.playbook("generator_failure")["baselineRisk"]] >= rank["high"]
    for pid in ("heating_failure", "blizzard", "co2_spike"):
        assert rank[assistant.playbook(pid)["baselineRisk"]] >= rank["high"], pid
    for pid in ("water_crisis", "link_loss", "low_fuel"):
        assert rank[assistant.playbook(pid)["baselineRisk"]] >= rank["moderate"], pid


@pytest.mark.parametrize("scenario", assistant.catalogue()["demoScenarios"])
def test_every_public_demo_scenario_has_its_own_playbook(scenario):
    assert assistant.select_playbook(scenario=scenario)["id"] == scenario


def test_every_alert_sensor_maps_to_a_playbook():
    for sensor in station_config.sensors("maitri"):
        p = assistant.select_playbook(sensors=[sensor])
        assert p["id"] != "anomaly" or sensor in ("store_food", "store_spares", "env_humidity"), sensor


@pytest.mark.parametrize("kw, expected", [
    ({"sensors": ["gen_power", "gen_rpm"]}, "generator_failure"),
    ({"sensors": ["heat_a_temp"]}, "heating_failure"),
    ({"sensors": ["comms_signal"]}, "link_loss"),
    ({"sensors": ["env_wind", "comms_signal"]}, "blizzard"),
    ({"sensors": ["store_fuel"]}, "low_fuel"),
    ({"causes": ["ventilation_degradation"]}, "co2_spike"),
    ({"causes": ["something_new"]}, "anomaly"),
    ({"scenario": "co2_spike", "sensors": ["gen_power"]}, "co2_spike"),     # the running scenario wins
    ({}, "anomaly"),
])
def test_playbook_selection(kw, expected):
    assert assistant.select_playbook(**kw)["id"] == expected


# ── the action whitelist ──────────────────────────────────────

def test_catalogue_actions_are_the_spec_list():
    assert set(assistant.catalogue()["actions"]) == {
        "navigate", "switchStation", "openBuildingPanel", "highlightComponents", "showDependencyChain",
        "openAlertCentre", "runWhatIf", "startStory", "triggerDemoScenario", "openAiDiagnostics",
        "stopSpeaking", "mute"}
    changing = {k for k, v in assistant.catalogue()["actions"].items() if v["stateChanging"]}
    assert changing == {"startStory", "triggerDemoScenario"}


def test_validate_action_accepts_and_cleans():
    a = assistant.validate_action("navigate", {"module": "energy", "station": "Bharati"}, "maitri")
    assert a == {"type": "navigate", "args": {"module": "energy", "station": "bharati"}, "stateChanging": False}
    w = assistant.validate_action("runWhatIf", {"scenario": "blizzard", "intensity": 9}, "maitri")
    assert w["args"]["intensity"] == 2.0
    h = assistant.validate_action("highlightComponents", {"ids": ["generator", "heating", "generator"]}, "maitri")
    assert h["args"]["ids"] == ["generator", "heating"]
    assert assistant.validate_action("triggerDemoScenario", {"id": "co2_spike"}, "maitri")["stateChanging"] is True


@pytest.mark.parametrize("name, args", [
    ("eval", {"code": "alert(1)"}),
    ("navigate", {"module": "secret"}),
    ("navigate", {}),
    ("navigate", {"module": "energy", "url": "https://x"}),
    ("switchStation", {"station": "vostok"}),
    ("openBuildingPanel", {"id": "reactor"}),
    ("highlightComponents", {"ids": "generator"}),
    ("highlightComponents", {"ids": []}),
    ("runWhatIf", {"scenario": "meteor"}),
    ("runWhatIf", {"scenario": "blizzard", "intensity": "lots"}),
    ("triggerDemoScenario", {"id": "fuel_leak"}),
    ("startStory", {"id": "secret"}),
])
def test_validate_action_rejects(name, args):
    with pytest.raises(assistant.InvalidAction):
        assistant.validate_action(name, args, "maitri")


def test_tool_schemas_cover_every_action_and_answer_question():
    tools = {t["function"]["name"]: t["function"] for t in assistant.tool_schemas("maitri")}
    assert set(tools) == set(assistant.catalogue()["actions"]) | {"answer_question"}
    assert tools["navigate"]["parameters"]["required"] == ["module"]
    assert "generator" in tools["openBuildingPanel"]["parameters"]["properties"]["id"]["enum"]


# ── deterministic understanding (the spec's examples) ─────────

@pytest.mark.parametrize("text, topic, station, building", [
    ("Why is Heating Zone A in warning?", "why_building", "maitri", "heating"),
    ("What's the fuel situation at Maitri?", "fuel", "maitri", None),
    ("What's the fuel situation at Bharati?", "fuel", "bharati", None),
    ("Show me what depends on the generator", "depends", "maitri", "generator"),
    ("Explain the current anomaly", "anomaly", "maitri", None),
    ("What should I do next?", "action", "maitri", None),
    ("Any alerts?", "alerts", "maitri", None),
    ("What's the CO2 in the living quarters?", "sensor", "maitri", "livingQuarters"),
    ("why is heating zone b in warning", "why_building", "maitri", "heatingB"),
    ("how windy is it", "weather", "maitri", None),
    ("is it freezing outside at Bharati?", "weather", "bharati", None),
    ("sing me a song", "unknown", "maitri", None),
])
def test_understand(text, topic, station, building):
    q = assistant.understand(text, "maitri")
    assert q["topic"] == topic
    assert q["station"] == station
    assert q["building"] == building


def test_vocabulary_prefers_the_longest_phrase():
    assert assistant.match_vocab("open heating zone b", "buildings") == ["heatingB"]
    assert assistant.match_vocab("the generator shed and the comms tower", "buildings") == ["generator", "commsMast"]
    assert assistant.match_vocab("open the energy grid", "modules") == ["energy"]


# ── grounded answers from the context alone ───────────────────

def test_context_is_compact_and_labelled(ctx):
    assert ctx["station"] == {"id": "bharati", "name": "Bharati"}
    gp = next(r for r in ctx["telemetry"] if r["sensor"] == "gen_power")
    assert gp["provenance"] == "SIMULATED" and gp["unit"] == "kW"
    env = next(r for r in ctx["telemetry"] if r["sensor"] == "env_temp")
    assert env["provenance"] == "REANALYSIS"
    assert ctx["derived"]["fuelAutonomyDays"]["value"] == round(153.87 * 1000 / (14.66 * 24))
    assert ctx["anomaly"]["candidateCauses"][0]["label"] == assistant.HEURISTIC_CAUSE_LABEL
    assert ctx["anomaly"]["scoreNote"].endswith("not a probability")
    assert ctx["decision"]["auditTrail"][0] == {"step": "current_state", "source": "telemetry", "provenance": "x"}
    assert ctx["cascades"][1]["chain"] == ["Generator Shed", "Heating Zone A", "Living Quarters"]
    assert ctx["replayTime"] == "2026-09-05T19:03:22"


def test_fuel_answer_quotes_the_data_with_units(ctx):
    a = assistant.local_answer({"topic": "fuel"}, ctx)
    assert "153.9 kL" in a["spoken"] and "14.7 L/hr" in a["spoken"]
    assert f"{ctx['derived']['fuelAutonomyDays']['value']} days" in a["spoken"]
    assert "MODEL-DERIVED" in a["detail"][0]


def test_why_building_names_the_rule_value_and_threshold(ctx):
    a = assistant.local_answer({"topic": "why_building", "building": "heating"}, ctx)
    assert a["spoken"].startswith("Heating Zone A is in warning because")
    assert "50.2 °C" in a["spoken"] and "55.0 °C" in a["spoken"]
    assert a["actions"] == [{"type": "highlightComponents", "args": {"ids": ["heating"]}}]


def test_why_building_without_alert_explains_the_cascade(ctx):
    a = assistant.local_answer({"topic": "why_building", "building": "livingQuarters"}, ctx)
    assert "depends on Generator Shed" in a["spoken"]


def test_depends_answer_walks_the_graph(ctx):
    a = assistant.local_answer({"topic": "depends", "building": "generator"}, ctx)
    for name in ("Heating Zone A", "Water Treatment", "Comms Tower", "Living Quarters"):
        assert name in a["spoken"]
    assert a["actions"] == [{"type": "showDependencyChain", "args": {"id": "generator"}}]


def test_anomaly_answer_labels_the_heuristic(ctx):
    a = assistant.local_answer({"topic": "anomaly"}, ctx)
    assert "0.712" in a["spoken"] and "0.564" in a["spoken"]
    assert "rule-based match" in a["spoken"]
    assert any("not a probability" in line for line in a["detail"])


def test_unknown_question_says_the_data_does_not_contain_it(ctx):
    a = assistant.local_answer({"topic": "unknown"}, ctx)
    assert a["spoken"].startswith(assistant.NOT_IN_DATA)


def test_missing_decision_is_said_plainly():
    c = assistant.build_context("maitri", copy.deepcopy(SNAPSHOT), None, None, decision_error="simulator offline")
    a = assistant.local_answer({"topic": "status"}, c)
    assert "no assessment" in a["spoken"] and "simulator offline" in a["spoken"]


# ── numeric grounding check ───────────────────────────────────

def test_numbers_grounded(ctx):
    src = assistant.compact_for_llm(ctx)
    assert assistant.numbers_grounded("The store holds 153.9 kL (about 154 kL).", src)[0]
    assert assistant.numbers_grounded("Two alerts; step 3 next.", src)[0]
    ok, bad = assistant.numbers_grounded("You have 10,470 hours of fuel.", src)
    assert not ok and bad == ["10,470"]
    assert assistant.numbers_grounded("Outside it is −15.6 °C.", src)[0]


def test_parse_explanation():
    parsed = assistant.parse_explanation('{"spoken": "Hi.", "detail": ["a", "b"]}')
    assert parsed == {"spoken": "Hi.", "detail": ["a", "b"]}
    assert assistant.parse_explanation('noise {"spoken": "Hi."} tail')["spoken"] == "Hi."
    assert assistant.parse_explanation("not json") is None
    assert assistant.parse_explanation('{"spoken": ""}') is None


# ── routes (LLM mocked) ───────────────────────────────────────

@pytest.fixture
def client(temp_db, monkeypatch):
    import unified_backend as ub
    monkeypatch.setattr(ub, "published_snapshot", lambda sid: {**copy.deepcopy(SNAPSHOT), "stationId": sid})
    ub._explain_cache.clear()
    with TestClient(ub.app) as c:
        yield c, ub


def fake_sim(router=None, explain=None, calls=None):
    """A stand-in for _sim_request: anomaly/decision data and scripted LLM replies."""
    def _req(method, path, **kw):
        if calls is not None:
            calls.append((path, (kw.get("json_body") or {}).get("kind")))
        if path == "/api/anomaly":
            return copy.deepcopy(ANOMALY)
        if path == "/api/decision":
            return copy.deepcopy(DECISION)
        if path == "/api/llm/chat":
            kind = kw["json_body"]["kind"]
            res = router if kind == "router" else explain
            if res is None:
                raise HTTPException(status_code=503, detail="Simulator offline")
            return res
        if path == "/api/llm/status":
            return {"configured": True, "explainRemaining": 5, "routerRemaining": 5}
        raise AssertionError(path)
    return _req


def _chat(c, text, station="bharati", **kw):
    r = c.post("/api/assistant/chat", json={"stationId": station, "text": text, **kw})
    assert r.status_code == 200, r.text
    return r.json()


def test_chat_works_with_the_simulator_down(client):
    c, _ = client
    out = _chat(c, "What's the fuel situation at Maitri?")
    assert out["station"] == "maitri" and out["topic"] == "fuel" and out["mode"] == "local"
    assert "153.9 kL" in out["spoken"]
    out = _chat(c, "Why is Heating Zone A in warning?")
    assert out["notice"] == "Answering from station data only"
    assert out["actions"] == [{"type": "highlightComponents", "args": {"ids": ["heating"]}, "stateChanging": False}]


def test_lookups_never_call_the_llm(client, monkeypatch):
    c, ub = client
    calls = []
    monkeypatch.setattr(ub, "_sim_request", fake_sim(calls=calls))
    out = _chat(c, "Show me what depends on the generator")
    assert out["topic"] == "depends" and out["notice"] is None
    assert not [p for p in calls if p[0] == "/api/llm/chat"]


def test_explanation_uses_the_llm_when_grounded(client, monkeypatch):
    c, ub = client
    calls = []
    reply = {"available": True,
             "content": '{"spoken": "The anomaly detector flags Bharati: score 0.712 against 0.564.",'
                        ' "detail": ["Likely cause, based on a rule-based match: output loss."]}'}
    monkeypatch.setattr(ub, "_sim_request", fake_sim(explain=reply, calls=calls))
    out = _chat(c, "Explain the current anomaly")
    assert out["mode"] == "llm" and out["grounding"]["ok"] is True
    assert out["spoken"].startswith("The anomaly detector flags Bharati")
    assert ("/api/llm/chat", "explain") in calls and ("/api/llm/chat", "router") not in calls
    again = _chat(c, "Explain the current anomaly")
    assert again["cached"] is True


def test_llm_reply_with_invented_numbers_falls_back_to_the_data(client, monkeypatch):
    c, ub = client
    reply = {"available": True, "content": '{"spoken": "Risk is high; fuel lasts 10,470 hours.", "detail": []}'}
    monkeypatch.setattr(ub, "_sim_request", fake_sim(explain=reply))
    out = _chat(c, "Why is the risk high?")
    assert out["mode"] == "local" and out["grounding"] == {"ok": False, "ungrounded": ["10,470"]}
    assert "10,470" not in out["spoken"]


def test_capped_llm_says_so(client, monkeypatch):
    c, ub = client
    monkeypatch.setattr(ub, "_sim_request", fake_sim(explain={"available": False, "capped": True,
                                                              "reason": "budget used up"}))
    out = _chat(c, "Explain the current anomaly")
    assert out["mode"] == "local" and out["notice"] == "Answering from station data only"
    assert "0.712" in out["spoken"]


def test_router_tool_calls_are_validated(client, monkeypatch):
    c, ub = client
    router = {"available": True, "toolCalls": [
        {"name": "navigate", "arguments": {"module": "energy"}},
        {"name": "runShell", "arguments": {"cmd": "rm -rf /"}},
        {"name": "openBuildingPanel", "arguments": {"id": "reactor"}},
    ]}
    monkeypatch.setattr(ub, "_sim_request", fake_sim(router=router))
    out = _chat(c, "take me where the power stuff lives")
    assert out["topic"] == "unknown"
    assert out["actions"] == [{"type": "navigate", "args": {"module": "energy"}, "stateChanging": False}]
    assert len(out["rejectedActions"]) == 2


def test_router_answer_question_routes_to_a_topic(client, monkeypatch):
    c, ub = client
    router = {"available": True, "toolCalls": [{"name": "answer_question", "arguments": {"topic": "fuel"}}]}
    monkeypatch.setattr(ub, "_sim_request", fake_sim(router=router))
    out = _chat(c, "how long until we run dry")
    assert out["topic"] == "fuel" and "kL" in out["spoken"]


def test_chat_validates_input(client):
    c, _ = client
    assert c.post("/api/assistant/chat", json={"stationId": "bharati", "text": ""}).status_code == 422
    assert c.post("/api/assistant/chat", json={"stationId": "bharati", "text": "x" * 501}).status_code == 422
    assert c.post("/api/assistant/chat", json={"stationId": "vostok", "text": "hi"}).status_code in (404, 422)
    assert c.post("/api/assistant/chat", json={"stationId": "bharati", "text": "hi", "x": 1}).status_code == 422


def test_context_playbooks_and_status_routes(client, monkeypatch):
    c, ub = client
    r = c.get("/api/assistant/context?stationId=bharati").json()
    assert r["anomaly"] == {"available": False, "reason": "simulator offline"}
    assert r["alerts"][0]["sensor"] == "gen_power"
    assert c.get("/api/assistant/playbooks").json()["disclaimer"].startswith("Example procedure")
    assert c.get("/api/assistant/status").json()["notice"] == "Answering from station data only"
    monkeypatch.setattr(ub, "_sim_request", fake_sim())
    assert c.get("/api/assistant/status").json()["llmAvailable"] is True


def test_assistant_routes_need_no_token_and_change_nothing(client, monkeypatch):
    c, ub = client
    monkeypatch.setattr(ub.app_config, "ADMIN_TOKEN", "secret")
    assert c.post("/api/assistant/chat", json={"stationId": "maitri", "text": "fuel?"}).status_code == 200
    assert c.get("/api/assistant/context?stationId=maitri").status_code == 200


def test_evaluate_route_asks_the_simulator_and_degrades(client, monkeypatch):
    c, ub = client
    assert c.post("/api/assistant/evaluate?stationId=bharati").json()["queued"] is False   # simulator down
    seen = []
    monkeypatch.setattr(ub, "_sim_request", lambda m, p, **k: seen.append((m, p, k.get("params"))) or {"queued": True})
    assert c.post("/api/assistant/evaluate?stationId=bharati").json() == {"queued": True}
    assert seen == [("POST", "/api/decision/evaluate", {"station": "bharati"})]
    assert c.post("/api/assistant/evaluate?stationId=vostok").status_code == 404

"""Decision-engine timing: event-driven re-evaluation, debounce, periodic fallback,
and the "recently resolved" hold (so a 30 s demo injection is visible)."""

import pytest

from decision_scheduler import DecisionScheduler, is_non_normal

TICK = 2.0
NORMAL = {"event": {"type": "normal"}, "risk": {"level": "nominal"}}
ALERT = {"event": {"type": "generator_output_loss"}, "risk": {"level": "high"}}


def _sched():
    return DecisionScheduler(TICK, periodic_s=60, debounce_s=2, resolved_hold_s=60)


# ── pure scheduler ────────────────────────────────────────────

def test_first_call_evaluates():
    s = _sched()
    ok, reasons = s.should_evaluate(1, False, [], "low")
    assert ok and reasons == ["initial"]


def test_no_change_no_evaluation_until_periodic():
    s = _sched()
    s.record(1, NORMAL, *s.should_evaluate(1, False, [], "low")[1:])
    for t in range(2, 31):
        assert s.should_evaluate(t, False, [], "low") == (False, [])
    ok, reasons = s.should_evaluate(31, False, [], "low")          # 30 ticks = 60 s
    assert ok and reasons == ["periodic"]


def test_request_evaluates_on_the_next_tick():
    s = _sched()
    s.record(1, NORMAL, *s.should_evaluate(1, False, [], "low")[1:])
    s.request("assistant_incident")
    ok, reasons = s.should_evaluate(2, False, [], "low")
    assert ok and reasons == ["assistant_incident"]
    assert s.should_evaluate(3, False, [], "low") == (False, [])        # once only


@pytest.mark.parametrize("change,reason", [
    (dict(anomaly=True), "anomaly_flip"),
    (dict(inj=["generator.gen_rpm"]), "injection_started"),
    (dict(risk="high"), "input_risk_changed"),
])
def test_events_trigger_immediately(change, reason):
    s = _sched()
    s.record(1, NORMAL, s.should_evaluate(1, False, [], "low")[1])
    ok, reasons = s.should_evaluate(2, change.get("anomaly", False), change.get("inj", []), change.get("risk", "low"))
    assert ok and reason in reasons


def test_injection_end_triggers():
    s = _sched()
    s.record(1, ALERT, s.should_evaluate(1, True, ["a.b"], "low")[1])
    ok, reasons = s.should_evaluate(5, True, [], "low")
    assert ok and "injection_ended" in reasons


def test_debounce_defers_but_does_not_drop():
    s = DecisionScheduler(TICK, debounce_s=6)                      # 3 ticks
    s.record(1, NORMAL, s.should_evaluate(1, False, [], "low")[1])
    assert s.should_evaluate(2, True, [], "low") == (False, [])     # within debounce
    ok, reasons = s.should_evaluate(4, True, [], "low")              # allowed now, reason carried over
    assert ok and "anomaly_flip" in reasons


def test_recently_resolved_hold():
    s = _sched()
    s.record(1, ALERT, ["anomaly_flip"])
    pub = s.record(10, NORMAL, ["anomaly_flip"])
    assert not is_non_normal(pub)
    assert pub["recentlyResolved"]["event"]["type"] == "generator_output_loss"
    assert pub["recentlyResolved"]["resolvedTicksAgo"] == 0
    still = s.publishable(40, s.last_evaluated)                      # 30 ticks = 60 s later
    assert "recentlyResolved" in still
    gone = s.publishable(41, s.last_evaluated)
    assert "recentlyResolved" not in gone
    assert "recentlyResolved" not in s.publishable(42, s.last_evaluated)   # stays gone


# ── integration: real simulator station ───────────────────────

@pytest.fixture(scope="module")
def simulator_module():
    import simulator  # builds the default stations (network is blocked → forecast unavailable)
    return simulator


def test_injection_gives_non_normal_decision_within_2_ticks_then_recently_resolved(simulator_module):
    sm = simulator_module
    sim = sm.StationSimulator("bharati", mode="reanalysis", date=sm.DEFAULT_DATE, speed_factor=120)
    for _ in range(5):
        sim.tick()
    assert sim._last_decision is not None and not is_non_normal(sim._last_decision)

    sim.inject_scenario("generator_failure")
    seen = None
    for k in range(1, 3):                                            # within 2 ticks
        sim.tick()
        if is_non_normal(sim._last_decision):
            seen = k
            break
    assert seen is not None, sim._last_decision
    assert sim._last_decision["event"]["type"] != "normal"
    assert {"injection_started", "anomaly_flip"} & set(sim._last_decision["evaluation"]["reasons"])

    # run until the 30 s (15-tick) injection has expired and the decision cleared
    for _ in range(25):
        sim.tick()
        if not sim.active_injections and not is_non_normal(sim._last_decision):
            break
    d = sim._last_decision
    assert not is_non_normal(d)
    assert d["recentlyResolved"]["event"]["type"] != "normal"         # still visible after the injection ended
    assert d["recentlyResolved"]["visibleForSeconds"] > 0

    other = sm.StationSimulator("maitri", mode="reanalysis", date=sm.DEFAULT_DATE, speed_factor=120)
    for _ in range(5):
        other.tick()
    assert not is_non_normal(other._last_decision)                   # other station unaffected

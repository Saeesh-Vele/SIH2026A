"""
Aurora — event-driven decision scheduling (fixes the decision-timing issue).

Previously the decision engine ran every 30 ticks (60 s) while a Demo Control
injection lasts 15 ticks (30 s), so whether a decision ever saw an injection
was down to luck. Now a station's decision is re-evaluated:

  • immediately when the anomaly state flips (normal ↔ anomalous),
  • immediately when an injection starts or ends (active injection keys change),
  • immediately when the forecast's input risk level changes,
  • on request (request(), e.g. the assistant opening an incident),
  • periodically as a fallback (every PERIODIC_S),
  • but never more than once per DEBOUNCE_S (debounce).

After a non-normal decision clears, it stays visible as `recentlyResolved` for
RESOLVED_HOLD_S of simulator run time, so a 30 s demo injection is still visible
in the UI after it ends.

Pure and tick-based (no wall clock) so it is deterministic and testable.
"""

import math

PERIODIC_S = 60.0       # fallback re-evaluation interval
DEBOUNCE_S = 2.0        # at most one evaluation per 2 s per station
RESOLVED_HOLD_S = 60.0  # keep the last non-normal decision visible after it clears


def is_non_normal(decision: dict) -> bool:
    return bool(decision) and (decision.get("event") or {}).get("type", "normal") != "normal"


class DecisionScheduler:
    def __init__(self, tick_interval_s: float, periodic_s: float = PERIODIC_S,
                 debounce_s: float = DEBOUNCE_S, resolved_hold_s: float = RESOLVED_HOLD_S):
        self.tick_s = tick_interval_s
        self.periodic_ticks = max(1, math.ceil(periodic_s / tick_interval_s))
        self.debounce_ticks = max(1, math.ceil(debounce_s / tick_interval_s))
        self.hold_ticks = max(1, math.ceil(resolved_hold_s / tick_interval_s))
        self._last_eval_tick = None
        self._last_inputs = None
        self._pending = []              # triggers seen while debounced
        self._last_non_normal = None    # (decision, tick)
        self._resolved = None           # {"decision", "resolvedAtTick"}
        self.last_evaluated = None      # last evaluated decision (no recentlyResolved)

    # ── when to evaluate ──────────────────────────────────────
    def should_evaluate(self, tick: int, anomaly_active: bool, injection_keys, forecast_risk_level):
        """Return (evaluate: bool, reasons: list[str])."""
        inputs = (bool(anomaly_active), frozenset(injection_keys or ()), forecast_risk_level)
        reasons = list(self._pending)
        if self._last_inputs is None:
            reasons.append("initial")
        else:
            prev_anom, prev_inj, prev_risk = self._last_inputs
            if inputs[0] != prev_anom:
                reasons.append("anomaly_flip")
            if inputs[1] != prev_inj:
                reasons.append("injection_started" if len(inputs[1]) > len(prev_inj) else "injection_ended")
            if inputs[2] != prev_risk:
                reasons.append("input_risk_changed")
        if self._last_eval_tick is not None and tick - self._last_eval_tick >= self.periodic_ticks:
            reasons.append("periodic")
        self._last_inputs = inputs

        if not reasons:
            return False, []
        if self._last_eval_tick is not None and tick - self._last_eval_tick < self.debounce_ticks:
            self._pending = sorted(set(r for r in reasons if r != "periodic"))   # carry over, evaluate when allowed
            return False, []
        self._pending = []
        return True, sorted(set(reasons))

    def request(self, reason: str) -> None:
        """Ask for an evaluation on the next tick (still subject to the debounce), e.g. when
        the assistant opens an incident and needs the engine's view of it now."""
        if reason not in self._pending:
            self._pending.append(reason)

    # ── what to publish ───────────────────────────────────────
    def record(self, tick: int, decision: dict, reasons) -> dict:
        """Store a freshly evaluated decision; returns the decision to publish."""
        self._last_eval_tick = tick
        decision = {k: v for k, v in decision.items() if k != "recentlyResolved"}
        decision["evaluation"] = {"tick": tick, "reasons": list(reasons)}
        self.last_evaluated = decision
        if is_non_normal(decision):
            self._last_non_normal = (decision, tick)
            self._resolved = None
        elif self._last_non_normal is not None:
            self._resolved = {"decision": self._last_non_normal[0], "resolvedAtTick": tick}
            self._last_non_normal = None
        return self.publishable(tick, decision)

    def publishable(self, tick: int, decision: dict) -> dict:
        """Decision plus `recentlyResolved` while within the hold window."""
        if decision is None:
            return None
        out = {k: v for k, v in decision.items() if k != "recentlyResolved"}
        if self._resolved is not None:
            age = tick - self._resolved["resolvedAtTick"]
            if age <= self.hold_ticks:
                prev = self._resolved["decision"]
                out["recentlyResolved"] = {
                    "event": prev.get("event"),
                    "risk": prev.get("risk", {}).get("level"),
                    "recommendation": prev.get("recommendation"),
                    "resolvedTicksAgo": age,
                    "resolvedSecondsAgo": round(age * self.tick_s, 1),
                    "visibleForSeconds": round((self.hold_ticks - age) * self.tick_s, 1),
                }
            else:
                self._resolved = None
        return out

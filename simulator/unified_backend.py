"""
Aurora & NCPOR Antarctic Digital Twin — Unified Mission Control Backend
THE single public backend (see CLAUDE.md). Runs FastAPI + Uvicorn + WebSockets
on API_PORT (default 8080). All settings come from config.py (root .env).

Telemetry pipeline (PROJECT_CONTEXT.md B1/B2 fix):
- simulator.py (:8001, internal) POSTs /api/sensors/batch every tick.
- A background tick (the ONLY code that advances physics state) runs every
  TICK_INTERVAL_S: it advances the physics-fallback model per station, then
  publishes either the fresh simulator batch (dataSource="simulator") or the
  physics fallback (dataSource="physics-fallback") and broadcasts it on the WS.
- Every GET / WS read returns the last *published* snapshot — reads never
  mutate twin state.

Also serves NCPOR data APIs, analytics (ISF/SVM, ARIMA), risk engine, twin
inspector, what-if, logistics, remote commands and admin config.
"""

import asyncio
import json
import logging
import re
import secrets
import sys
import threading
import time
import uuid
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Literal

import requests
from fastapi import (
    Depends,
    FastAPI,
    Header,
    HTTPException,
    Query,
    Request,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator

# Import digital twin engines
sys.path.insert(0, str(Path(__file__).parent))
import judge_mode
from judge_mode import DEMO, LINK_SCENARIO, LINK_SCENARIO_NAME, SANDBOX
from link_buffer import LinkBuffer
from ncpor_sync import NcporSync
from visits import VISITS

import alert_engine
import assistant
import config as app_config
import db
import station_config
from alert_engine import AlertEngine, AlertNotFound
from analytics_ai_engine import (
    assess_blizzard_and_polar_risks,
    query_observations,
    run_anomaly_detection,
    run_correlation_matrix,
    run_time_series_forecast,
)
from cascade import analyze_dependency_cascade
from ncpor_ingestor import init_db
from offline_explain import offline_explanation
from physics_model import StationPhysicsModel, energy_summary
from station_store import StationStore
from twin_inspector import build_twin_inspector
from units import kmh_to_ms, ms_to_kmh
from validation import Identifier, OperatorName, StationIdStr

log = logging.getLogger("aurora.backend")

STATIONS = station_config.station_ids()          # from station_config.json

# Physics-fallback models. ONLY advance_fallback() (called by the tick) may
# call .compute() on these — compute() mutates fuel/temps/water state.
PHYSICS = {sid: StationPhysicsModel(sid) for sid in STATIONS}

store = StationStore(STATIONS, history_max_points=app_config.HISTORY_MAX_POINTS)
# Persistent threshold alerts for every sensor (station_config defaults + admin overrides).
ALERTS = AlertEngine(STATIONS, resolve_ticks=app_config.ALERT_RESOLVE_TICKS)
# Simulated satellite link per station, with the station-side store-and-forward buffer.
LINK = LinkBuffer(STATIONS)
# Scheduled NCPOR live-page sync (every NCPOR_SYNC_INTERVAL_MIN, with back-off).
NCPOR = NcporSync(STATIONS)
_background: set[asyncio.Task] = set()


# ═══════════════════════════════════════════════════════════════
#  Station validation (shared by every route)
# ═══════════════════════════════════════════════════════════════

def require_station(raw) -> str:
    """Normalise a station id; unknown → 404 with a clear message."""
    sid = str(raw).strip().lower() if raw is not None else ""
    if sid not in STATIONS:
        raise HTTPException(
            status_code=404,
            detail=f"Unknown station '{raw}'. Valid stations: {', '.join(STATIONS)}",
        )
    return sid


def station_param(stationId: str | None = Query(None), station: str | None = Query(None)) -> str:
    """Query-string station dependency. Missing → 'maitri' (backward compatible)."""
    raw = stationId if stationId is not None else station
    return require_station("maitri" if raw is None else raw)


def optional_station_param(stationId: str | None = Query(None), station: str | None = Query(None)) -> str | None:
    """Like station_param, but missing means 'all stations' (None)."""
    raw = stationId if stationId is not None else station
    return None if raw is None else require_station(raw)


# ═══════════════════════════════════════════════════════════════
#  Write protection
# ═══════════════════════════════════════════════════════════════
# Every state-changing route depends on require_admin. Reads and /ws/station stay public,
# so a demo deployment is fully viewable while nobody can change thresholds, the
# inventory ledger, the simulator or the alert state.
#
# The two POSTs that change nothing are deliberately NOT protected, because they are
# reads that happen to need a request body: /api/simulation/whatif (explicitly read-only
# against the published snapshot) and the explain routes. Those are rate-limited instead.
#
# With ADMIN_TOKEN unset there is no protection at all: convenient locally, refused by
# config.check_production_config() when APP_ENV=production.

def require_admin(x_admin_token: str | None = Header(None, alias="X-Admin-Token")) -> None:
    """401 unless the caller presents the configured ADMIN_TOKEN."""
    expected = app_config.ADMIN_TOKEN
    if not expected:
        return
    if not x_admin_token or not secrets.compare_digest(x_admin_token, expected):
        # Deliberately identical for a missing and a wrong token, and never echoed back.
        log.warning("401 on a write route: %s token", "missing" if not x_admin_token else "invalid")
        raise HTTPException(
            status_code=401,
            detail="Operator login required: send the X-Admin-Token header.",
            headers={"WWW-Authenticate": 'X-Admin-Token realm="aurora"'},
        )


def client_ip(request: Request) -> str:
    """The visitor's address. nginx sets X-Real-IP (its real_ip module trusts only the
    internal proxy hop), so this is the client, not Caddy or the Docker gateway."""
    return ((request.headers.get("x-real-ip") or (request.client.host if request.client else "")) or "unknown")[:64]


def write_scope(x_admin_token: str | None = Header(None, alias="X-Admin-Token")) -> str:
    """Where a write goes. 'shared': the real shared state (a valid ADMIN_TOKEN, or no
    protection configured). 'sandbox': an anonymous visitor in judge mode
    (VISITOR_SANDBOX), whose write is validated like a real one and kept private.
    A presented but wrong token is always 401."""
    if x_admin_token:
        require_admin(x_admin_token)
        return "shared"
    if app_config.VISITOR_SANDBOX:
        return "sandbox"
    require_admin(None)
    return "shared"


def demo_actor(x_admin_token: str | None = Header(None, alias="X-Admin-Token")) -> str:
    """'team' (token, or an unprotected local stack) or 'visitor' (PUBLIC_DEMO rules)."""
    if x_admin_token:
        require_admin(x_admin_token)
        return "team"
    if app_config.PUBLIC_DEMO:
        return "visitor"
    require_admin(None)
    return "team"


def sandbox_session(request: Request) -> str | None:
    """This visitor's live sandbox session id (from the httpOnly cookie), or None."""
    if not app_config.VISITOR_SANDBOX:
        return None
    return SANDBOX.valid(request.cookies.get(judge_mode.COOKIE_NAME))


def sandbox_for_write(request: Request, response: Response) -> str:
    """The session a sandbox write goes to: the visitor's, or a new one (cookie set on
    this response). 503 when the sandbox is full, 429 past the per-session write rate."""
    sid = sandbox_session(request)
    if sid is None:
        try:
            sid, _expires = SANDBOX.create()
        except judge_mode.SandboxFull as exc:
            raise HTTPException(status_code=503, detail=(
                "The visitor sandbox is full right now; please try again in a few minutes.")) from exc
        response.set_cookie(judge_mode.COOKIE_NAME, sid, max_age=app_config.SANDBOX_TTL_S, httponly=True,
                            samesite="lax", secure=app_config.APP_ENV == "production", path="/")
        response.headers["X-Sandbox-Created"] = "1"
    try:
        SANDBOX.check_rate(sid)
    except judge_mode.SandboxRateLimited as exc:
        raise HTTPException(status_code=429, detail=(
            f"Too many sandbox changes in a minute; try again in {exc.retry_after_s} s."),
            headers={"Retry-After": str(exc.retry_after_s)}) from exc
    return sid


# ── Sandbox overlays: the visitor's private changes on top of the shared state ──

def overlay_alerts(alerts: list[dict], acks: dict) -> list[dict]:
    """Open alerts with this visitor's sandbox acknowledgements applied (copies)."""
    if not acks:
        return alerts
    out = []
    for a in alerts:
        ack = acks.get(str(a.get("id")))
        if ack and not a.get("acknowledged"):
            a = {**a, "status": "acknowledged", "acknowledged": True, "acknowledgedBy": ack["by"],
                 "acknowledgedAt": ack["at"], "sandbox": True}
        out.append(a)
    return out


def sandbox_alert_view(snap: dict, session: str, overrides: list[dict]) -> dict:
    """The snapshot as a visitor with their own thresholds sees it (a new dict; `snap` is
    never changed). Every sensor the visitor re-set is checked against their thresholds on
    the same shared readings: the shared alert for it is replaced by the visitor's own
    (or by none). Building states, the dependency cascade and the overall health are then
    recomputed from that list. Read-only and private: the shared alerts, the database and
    every other visitor are untouched, and nothing is persisted but a start time per
    alert in memory (bounded by the sandbox session cap)."""
    sid = snap["stationId"]
    mine = {o["sensor"] for o in overrides}
    th = sandbox_thresholds(session, sid)
    catalog = station_config.sensors(sid)
    names = station_config.building_names(sid)
    ts = snap.get("timestamp") or judge_mode.now_ms()
    active = [a for a in snap.get("activeAlerts") or [] if a.get("sensor") not in mine]
    for sensor in sorted(mine):
        meta = catalog.get(sensor)
        value = (snap.get("sensors") or {}).get(meta["building"], {}).get(sensor) if meta else None
        if value is None or sensor not in th:
            continue
        level, direction, threshold = alert_engine.classify(float(value), th[sensor])
        since = SANDBOX.alert_since(session, sid, sensor, None if level == "normal" else level, ts)
        if since is None:
            continue
        message = alert_engine.alert_message(meta, level, direction, threshold, value) + " (your sandbox threshold)"
        active.append({
            "id": f"SBX-{sid}-{sensor}-{since}", "buildingId": meta["building"],
            "buildingName": names.get(meta["building"], meta["building"]), "level": level, "peakLevel": level,
            "sensor": sensor, "value": value, "unit": meta["unit"], "threshold": threshold, "direction": direction,
            "message": message, "timestamp": since, "status": "active", "acknowledged": False,
            "acknowledgedBy": None, "acknowledgedAt": None, "clearing": False,
            "triggeredSensors": [{"name": sensor, "value": value, "unit": meta["unit"]}],
            "sandbox": True, "sandboxThreshold": True,
        })
    rank = alert_engine.LEVEL_RANK
    active.sort(key=lambda a: (-rank.get(a.get("level"), 0), a.get("timestamp") or 0))
    levels = {b: "normal" for b in names}
    for a in active:
        b = a.get("buildingId")
        if rank.get(a.get("level"), 0) > rank[levels.get(b, "normal")]:
            levels[b] = a["level"]
    dependency = analyze_dependency_cascade(levels, sid)
    if any(a["level"] == "critical" for a in active) or any(d["severity"] == "critical" for d in dependency):
        health = "critical"
    elif active or dependency:
        health = "warning"
    else:
        health = "healthy"
    return {**snap, "activeAlerts": active, "alerts": levels, "dependencyAlerts": dependency,
            "aiHealth": health, "sandboxThresholds": sorted(mine)}


def overlay_snapshot(snap: dict, session: str | None) -> dict:
    """The snapshot with this visitor's sandbox applied: their own thresholds re-evaluated
    (sandbox_alert_view), then their acknowledgements. No sandbox → `snap` itself."""
    if not session:
        return snap
    overrides = sandbox_threshold_overrides(session, snap.get("stationId"))
    if overrides:
        snap = sandbox_alert_view(snap, session, overrides)
    acks = SANDBOX.get(session, "ack")
    if not acks:
        return snap
    return {**snap, "activeAlerts": overlay_alerts(snap.get("activeAlerts") or [], acks)}


def sandbox_threshold_overrides(session: str | None, sid: str) -> list[dict]:
    """The session's threshold overrides that apply to `sid`, in the shared override format."""
    out = []
    for key, v in SANDBOX.get(session, "threshold").items():
        scope, sensor, direction, level = key.split("|")
        if scope in ("*", sid):
            out.append({"stationId": scope, "sensor": sensor, "direction": direction, "level": level,
                        "value": v["value"], "updatedAt": v["at"], "updatedBy": v["by"], "sandbox": True})
    return out


def sandbox_thresholds(session: str | None, sid: str) -> dict:
    """Shared effective thresholds, then this visitor's sandbox overrides ('*' then station)."""
    th = alert_engine.effective_thresholds(sid)
    ov = sandbox_threshold_overrides(session, sid)
    for scope in ("*", sid):
        for o in ov:
            if o["stationId"] == scope and o["sensor"] in th and o["direction"] in th[o["sensor"]]:
                th[o["sensor"]][o["direction"]][o["level"]] = o["value"]
    return th


# ═══════════════════════════════════════════════════════════════
#  WebSocket Connection Manager (per-station subscriptions)
# ═══════════════════════════════════════════════════════════════

class ConnectionManager:
    """All methods run on the event loop, so the dict needs no lock."""

    def __init__(self):
        # websocket → (station filter, sandbox session id or None)
        self._conns: dict[WebSocket, tuple[str | None, str | None]] = {}

    async def connect(self, websocket: WebSocket, station_filter: str | None, session: str | None = None):
        await websocket.accept()
        self._conns[websocket] = (station_filter, session)

    def disconnect(self, websocket: WebSocket):
        self._conns.pop(websocket, None)

    async def broadcast(self, sid: str, message: dict):
        for ws, (station_filter, session) in list(self._conns.items()):
            if station_filter is not None and station_filter != sid:
                continue
            try:
                # A visitor with a sandbox sees their own acknowledgements; everyone else
                # gets the shared snapshot unchanged.
                msg = overlay_snapshot(message, SANDBOX.valid(session)) if session else message
                await ws.send_json(msg)
            except Exception as exc:
                log.info("WS send failed (%s); dropping client", exc)
                self.disconnect(ws)

manager = ConnectionManager()


# ═══════════════════════════════════════════════════════════════
#  Weather input (read-only DB access)
# ═══════════════════════════════════════════════════════════════

def get_latest_weather_for_station(station_id: str):
    with db.connect() as conn:
        rows = conn.execute("""
            SELECT parameter, value, timestamp, source, dataset
            FROM observations
            WHERE station_id = ? AND quality != 'suspect'
            ORDER BY timestamp DESC LIMIT 30
        """, (station_id,)).fetchall()

    res = {"temp": -15.0, "wind": 12.0, "pressure": 985.0, "humidity": 65.0,
           "source": "built-in default (no observations in DB)", "dataset": None}
    for param, val, ts, src, ds in rows:
        if param == "temperature" and "temp_read" not in res:
            res["temp"] = val
            res["temp_read"] = True
            res["observedAt"] = ts
            res["source"] = src
            res["dataset"] = ds
        elif param == "wind_speed" and "wind_read" not in res:
            res["wind"] = val
            res["wind_read"] = True
        elif param == "air_pressure" and "pres_read" not in res:
            res["pressure"] = val
            res["pres_read"] = True
        elif param == "relative_humidity" and "hum_read" not in res:
            res["humidity"] = val
            res["hum_read"] = True
    return res


def _weather_provenance(weather: dict) -> str:
    ds = weather.get("dataset")
    if ds == "NCPOR-AWS-Live":
        return "REAL"
    if ds is None:
        return "HARDCODED-DEMO"
    return "REANALYSIS"


# ═══════════════════════════════════════════════════════════════
#  ADVANCE STATE (mutating) — called only by the background tick
# ═══════════════════════════════════════════════════════════════

def _val(readings: dict, bld: str, sensor: str, default: float) -> float:
    return float(readings.get(bld, {}).get(sensor, {}).get("value", default))


def advance_fallback(sid: str) -> dict:
    """Advance the physics-fallback model by one tick from the latest DB weather.
    This is the ONLY place pm.compute() is called. Returns raw physics output."""
    weather = get_latest_weather_for_station(sid)
    weather_input = {
        "env_temp": weather["temp"],
        "env_wind": ms_to_kmh(weather["wind"]),  # DB stores m/s; physics model takes km/h
        "env_pressure": weather["pressure"],
        "env_humidity": weather["humidity"],
    }
    readings = PHYSICS[sid].compute(weather_input, dt_seconds=app_config.TICK_INTERVAL_S)
    meta = readings.pop("_meta", {})

    sensors = {
        "generator": {
            "gen_power": round(float(meta.get("power_breakdown", {}).get(
                "total_demand_kW", _val(readings, "generator", "gen_power", 160))), 1),
            "gen_fuel_rate": round(_val(readings, "generator", "gen_fuel_rate", 28), 1),
            "gen_rpm": round(_val(readings, "generator", "gen_rpm", 1500), 0),
            "gen_temp": round(_val(readings, "generator", "gen_temp", 82), 1),
        },
        "heating": {
            "heat_a_flow": round(_val(readings, "heating", "heat_a_flow", 35), 1),
            "heat_a_temp": round(_val(readings, "heating", "heat_a_temp", 72), 1),
            "heat_a_pressure": round(_val(readings, "heating", "heat_a_pressure", 3.2), 2),
        },
        "heatingB": {
            "heat_b_flow": round(_val(readings, "heatingB", "heat_b_flow", 28), 1),
            "heat_b_temp": round(_val(readings, "heatingB", "heat_b_temp", 68), 1),
        },
        "waterTank": {
            "water_level": round(_val(readings, "waterTank", "water_level", 82.5), 1),
            "water_temp": round(_val(readings, "waterTank", "water_temp", 14.2), 1),
            "water_ph": round(_val(readings, "waterTank", "water_ph", 7.2), 2),
        },
        "commsMast": {
            "comms_signal": round(_val(readings, "commsMast", "comms_signal", -45.0), 1),
            "comms_bandwidth": round(_val(readings, "commsMast", "comms_bandwidth", 2.4), 1),
            "comms_uptime": round(_val(readings, "commsMast", "comms_uptime", 99.8), 1),
        },
        "livingQuarters": {
            "lq_temp": round(_val(readings, "livingQuarters", "lq_temp", 20.8), 1),
            "lq_humidity": round(_val(readings, "livingQuarters", "lq_humidity", 42.0), 1),
            "lq_co2": round(_val(readings, "livingQuarters", "lq_co2", 520.0), 1),
        },
        # Storage from the physics model's running state. Unit convention
        # (CLAUDE.md): store_fuel kL, store_food days, store_spares items.
        "storage": {
            "store_fuel": round(_val(readings, "storage", "store_fuel", 0.0), 2),
            "store_food": round(_val(readings, "storage", "store_food", 0.0), 1),
            "store_spares": round(_val(readings, "storage", "store_spares", 0.0), 0),
        },
        "lab": {
            "env_temp": weather["temp"],
            "env_wind": round(ms_to_kmh(weather["wind"]), 1),   # km/h
            "env_pressure": weather["pressure"],
            "env_humidity": weather["humidity"],
        },
    }
    return {
        "sensors": sensors,
        "meta": meta,
        "readings": readings,
        "weather": weather,
        "computedAt": int(time.time() * 1000),
    }


# ═══════════════════════════════════════════════════════════════
#  COMPUTE SNAPSHOT (pure) — no IO, no mutation
# ═══════════════════════════════════════════════════════════════

def build_snapshot(sid: str, sensors: dict, *, source: str, provenance: dict, ts_ms: int,
                   last_batch_age, connected: bool, event_timeline=None, active_patterns=None,
                   energy=None, replay=None) -> dict:
    """sensors → persistent threshold alerts (ALERTS.evaluate) → cascade → health → snapshot.
    Only the tick calls this (via select_snapshot), so alert state advances once per tick."""
    alerts, active_alerts = ALERTS.evaluate(sid, sensors, ts_ms)
    dependency_alerts = analyze_dependency_cascade(alerts, sid)
    if (any(a["level"] == "critical" for a in active_alerts)
            or any(d["severity"] == "critical" for d in dependency_alerts)):
        health = "critical"
    elif active_alerts or dependency_alerts:
        health = "warning"
    else:
        health = "healthy"
    return {
        "stationId": sid,
        "timestamp": ts_ms,
        "dataSource": source,
        "provenance": provenance,
        "lastBatchAgeSec": None if last_batch_age is None else round(last_batch_age, 1),
        "sensors": sensors,
        # Physics energy breakdown of the same tick as `sensors` (None in random-walk mode).
        "energy": energy,
        # ERA5 replay clock of the same tick (None: physics fallback runs on the wall clock).
        "replay": replay,
        "alerts": alerts,
        "activeAlerts": active_alerts,
        "dependencyAlerts": dependency_alerts,
        "aiHealth": health,
        "eventTimeline": list(event_timeline or []),
        "activePatterns": list(active_patterns or []),
        "connected": connected,
    }


def _coords(sid: str) -> str:
    c = station_config.coords(sid)
    return f"Lat {c['lat']}, Lon {c['lon']}"


def reading_from_fallback(sid: str, fallback: dict, last_batch_age) -> dict:
    """One tick's reading from the physics fallback: the inputs of build_snapshot."""
    weather = fallback["weather"]
    provenance = {
        "equipment": "MODEL-DERIVED",
        "environment": _weather_provenance(weather),
        "storage": "MODEL-DERIVED",
        "injectedSensors": [],
        "activeScenario": None,
        "weatherSource": weather.get("source"),
        "equipmentModel": "Aurora causal energy & thermal model (physics fallback in backend)",
        "stationCoordinates": _coords(sid),
    }
    return {"sid": sid, "sensors": fallback["sensors"], "source": "physics-fallback", "provenance": provenance,
            "ts_ms": fallback["computedAt"], "last_batch_age": last_batch_age,
            "energy": energy_summary(fallback["meta"])}


def snapshot_from_fallback(sid: str, fallback: dict, last_batch_age) -> dict:
    return build_snapshot(**reading_from_fallback(sid, fallback, last_batch_age), connected=LINK.status(sid)["up"])


def reading_from_batch(sid: str, batch: dict, last_batch_age) -> dict:
    """One tick's reading from the simulator's latest batch: the inputs of build_snapshot."""
    sensors = {
        bld: {sensor: reading["value"] for sensor, reading in readings.items()}
        for bld, readings in batch["readings"].items()
    }
    injected = list(batch.get("injectedSensors") or [])
    mode = batch.get("mode") or "reanalysis"
    simulated_mode = mode == "simulation"
    equipment_injected = any(not k.startswith("lab.") for k in injected)
    env_injected = any(k.startswith("lab.") for k in injected)
    provenance = {
        "equipment": "SIMULATED" if (simulated_mode or equipment_injected) else "MODEL-DERIVED",
        "environment": "SIMULATED" if (simulated_mode or env_injected) else "REANALYSIS",
        "storage": "SIMULATED" if simulated_mode else "MODEL-DERIVED",
        "injectedSensors": injected,
        "activeScenario": batch.get("activeScenario"),
        "weatherSource": batch.get("weatherSource"),
        "equipmentModel": ("random-walk simulation (simulator.py)" if simulated_mode
                           else "Aurora physics model (simulator.py)"),
        "stationCoordinates": _coords(sid),
    }
    return {"sid": sid, "sensors": sensors, "source": "simulator", "provenance": provenance,
            "ts_ms": batch.get("timestamp") or int(time.time() * 1000), "last_batch_age": last_batch_age,
            "event_timeline": batch.get("eventTimeline"), "active_patterns": batch.get("activePatterns"),
            "energy": batch.get("energy"), "replay": batch.get("replay")}


def select_reading(sid: str) -> dict:
    """This tick's reading: the simulator batch if fresh (≤ SIM_BATCH_FRESH_S), else the physics fallback."""
    age = store.batch_age(sid)
    batch = store.latest_batch(sid)
    if batch is not None and age is not None and age <= app_config.SIM_BATCH_FRESH_S:
        return reading_from_batch(sid, batch, age)
    return reading_from_fallback(sid, store.get_fallback(sid), age)


def select_snapshot(sid: str) -> dict:
    return build_snapshot(**select_reading(sid), connected=LINK.status(sid)["up"])


def published_snapshot(sid: str) -> dict:
    snap = store.get_published(sid)
    if snap is None:
        raise HTTPException(status_code=503, detail="Telemetry not ready yet; retry shortly")
    return snap


# ═══════════════════════════════════════════════════════════════
#  Background tick (the only writer of physics state)
# ═══════════════════════════════════════════════════════════════

def _decorate(sid: str, snap: dict) -> dict:
    """What every published snapshot carries besides the reading: the link state and its
    events, and every running demo scenario (the banner, whichever station is viewed)."""
    link = LINK.status(sid)
    events = LINK.events(sid)
    if events:
        timeline = sorted((snap.get("eventTimeline") or []) + events, key=lambda e: e.get("timestamp") or 0)
        snap["eventTimeline"] = timeline[-50:]
    snap["link"] = link
    snap["connected"] = link["up"]
    snap["publicDemo"] = DEMO.status()
    return snap


def sync_link(sid: str) -> dict:
    """The link is back: evaluate and publish every buffered reading in order (alerts at
    their real timestamps, history backfilled), then record the sync summary."""
    readings, meta = LINK.take(sid)
    for r in readings:
        store.publish(sid, build_snapshot(**r, connected=True))
    raised = 0
    if readings:
        with db.connect() as conn:
            raised = conn.execute(
                "SELECT COUNT(*) FROM station_alerts WHERE station_id = ? AND timestamp BETWEEN ? AND ?",
                (sid, readings[0]["ts_ms"], readings[-1]["ts_ms"])).fetchone()[0]
    kb = meta["bytes"] / 1000
    parts = [f"{len(readings)} reading{'s' if len(readings) != 1 else ''} ({kb:.1f} KB) synced",
             f"{raised} alert{'s' if raised != 1 else ''} raised during the outage"]
    if meta["dropped"]:
        parts.append(f"{meta['dropped']} oldest reading(s) dropped: the station buffer was full")
    summary = {"at": judge_mode.now_ms(), "readings": len(readings), "bytes": meta["bytes"], "alertsRaised": raised,
               "dropped": meta["dropped"], "downSince": meta["since"], "lastContact": meta["lastContact"],
               "outageS": round((judge_mode.now_ms() - (meta["since"] or judge_mode.now_ms())) / 1000),
               "startedBy": meta["startedBy"], "message": "Link restored: " + ", ".join(parts) + "."}
    LINK.record_sync(sid, summary)
    log.info("[%s] %s", sid, summary["message"])
    return summary


def tick_station(sid: str) -> dict:
    """One station tick (blocking: physics + alert DB writes). Runs in a worker thread."""
    fallback = advance_fallback(sid)
    store.set_fallback(sid, fallback)
    reading = select_reading(sid)
    # A scenario the simulator no longer runs (expired, or reset elsewhere) is not "running".
    # (Link loss is not a simulator scenario: it ends when the link is restored.)
    rec = DEMO.get(sid)
    if (rec and rec["scenario"] != LINK_SCENARIO and reading["source"] == "simulator"
            and not reading["provenance"].get("activeScenario") and judge_mode.now_ms() - rec["startedAt"] > 8000):
        DEMO.clear(sid)
    prev = store.get_published(sid)
    if LINK.is_down(sid) and prev is not None:
        # Store-and-forward: the station keeps recording; the dashboard keeps the last
        # data received (same timestamp, so nothing is appended to the history).
        LINK.hold(sid, reading)
        snap = _decorate(sid, {**prev})
        store.publish(sid, snap)
        return snap
    if LINK.restore_due(sid):
        sync_link(sid)
    snap = _decorate(sid, build_snapshot(**reading, connected=True))
    store.publish(sid, snap)          # also appends to the rolling history served by /api/history
    return snap


_ticks = 0


async def run_tick():
    for sid in STATIONS:
        try:
            snap = await asyncio.to_thread(tick_station, sid)
            await manager.broadcast(sid, snap)
        except Exception:
            log.exception("Tick failed for station %s", sid)
    for sid in DEMO.due():
        if (DEMO.get(sid) or {}).get("scenario") == LINK_SCENARIO:
            await asyncio.to_thread(_end_link_demo, sid, "public-demo-auto")
            DEMO.clear(sid)
            log.info("Public demo link loss on %s ended automatically: link restoring", sid)
            continue
        try:
            await asyncio.to_thread(_sim_request, "POST", "/reset",
                                    params={"station": sid, "source": "public-demo-auto"})
            log.info("Public demo on %s ended automatically", sid)
        except Exception:
            log.exception("Public demo auto-reset failed for %s; will retry", sid)
            continue
        DEMO.clear(sid)
    for sid in NCPOR.due():
        # Network + SQLite, up to ~12 s: off the tick, one task per station.
        task = asyncio.create_task(asyncio.to_thread(NCPOR.run, sid, "scheduled"))
        _background.add(task)
        task.add_done_callback(_background.discard)
    global _ticks
    _ticks += 1
    if app_config.VISITOR_SANDBOX and _ticks % 30 == 0:
        try:
            await asyncio.to_thread(SANDBOX.cleanup)
        except Exception:
            log.exception("Sandbox cleanup failed")
    try:
        promoted = await asyncio.to_thread(promote_remote_commands)
        if promoted:
            log.info("Simulated remote commands acknowledged: %d", promoted)
    except Exception:
        log.exception("Remote-command lifecycle step failed")


async def tick_loop():
    while True:
        await asyncio.sleep(app_config.TICK_INTERVAL_S)
        await run_tick()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Refuses to start on a development-grade config when APP_ENV=production; otherwise
    # logs the same problems as warnings.
    app_config.check_production_config()
    if not app_config.ADMIN_TOKEN:
        log.warning(
            "ADMIN_TOKEN is not set: every write endpoint (thresholds, logistics, "
            "acknowledge, remote dispatch, simulator control) is unauthenticated. "
            "Fine locally; set it before exposing this host."
        )
    init_db()
    ALERTS.load_open()   # open/acknowledged alerts survive restarts
    if NCPOR.enabled:
        NCPOR.start()
        log.info("NCPOR live sync every %.0f min (first in %d s)", NCPOR.interval_s / 60, 20)
    await run_tick()   # prime: every station has a published snapshot before serving
    task = asyncio.create_task(tick_loop())
    log.info("Unified backend ready (v%s, tick %.1fs, batch freshness %.0fs)",
             app_config.APP_VERSION, app_config.TICK_INTERVAL_S, app_config.SIM_BATCH_FRESH_S)
    try:
        yield
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            log.debug("Tick loop stopped on shutdown")


app = FastAPI(title="Aurora Antarctic Digital Twin Platform", version=app_config.APP_VERSION, lifespan=lifespan)

@app.exception_handler(RequestValidationError)
async def _validation_error_handler(request: Request, exc: RequestValidationError):
    """422 with JSON-safe details. FastAPI's default echoes the raw input, which
    crashes (500) when a body contains NaN/Infinity."""
    errors = []
    for e in exc.errors():
        item = {k: v for k, v in e.items() if k not in ("input", "ctx", "url")}
        if "ctx" in e:
            item["ctx"] = {k: str(v) for k, v in e["ctx"].items()}
        errors.append(item)
    log.info("422 on %s %s: %s", request.method, request.url.path, [x.get("msg") for x in errors][:5])
    return JSONResponse(status_code=422, content={"detail": errors})


app.add_middleware(
    CORSMiddleware,
    allow_origins=app_config.ALLOWED_ORIGINS,
    # The visitor-sandbox session is a cookie (judge mode). Origins are an explicit
    # allow-list (never '*'), which credentialed CORS requires.
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    # X-Admin-Token is needed for the operator login. In Docker everything is same-origin
    # behind nginx so no preflight happens, but local dev is Vite:5173 -> backend:8080,
    # and a custom header there triggers one.
    allow_headers=["Content-Type", "X-Admin-Token"],
)


# ═══════════════════════════════════════════════════════════════
#  WebSocket Route
# ═══════════════════════════════════════════════════════════════

@app.websocket("/ws/station")
async def websocket_endpoint(websocket: WebSocket):
    # CORSMiddleware does not cover WebSockets: enforce the origin allow-list here.
    # Non-browser clients (no Origin header) are allowed.
    origin = websocket.headers.get("origin")
    if origin is not None and origin.rstrip("/") not in app_config.ALLOWED_ORIGINS:
        log.warning("WS rejected: disallowed origin %s", origin)
        await websocket.close(code=1008)
        return
    raw = websocket.query_params.get("stationId")
    station_filter = None
    if raw is not None:
        station_filter = raw.strip().lower()
        if station_filter not in STATIONS:
            log.warning("WS rejected: unknown stationId %r", raw)
            await websocket.close(code=1008)
            return
    session = None
    if app_config.VISITOR_SANDBOX:
        session = SANDBOX.valid(websocket.cookies.get(judge_mode.COOKIE_NAME))
    await manager.connect(websocket, station_filter, session)
    try:
        # Initial snapshot(s) from the published cache — no computation.
        for sid in ([station_filter] if station_filter else STATIONS):
            snap = store.get_published(sid)
            if snap is not None:
                await websocket.send_json(overlay_snapshot(snap, session))
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        log.debug("WS client disconnected (filter=%s)", station_filter)
    except Exception:
        log.warning("WS connection error", exc_info=True)
    finally:
        manager.disconnect(websocket)


# ═══════════════════════════════════════════════════════════════
#  Station & Telemetry REST APIs
# ═══════════════════════════════════════════════════════════════

@app.get("/api/stations")
def get_stations():
    """Station list (plain values) derived from station_config.json."""
    out = []
    for sid in STATIONS:
        m = station_config.metadata_values(sid)
        out.append({
            "id": sid,
            "name": m["fullName"],
            "shortName": m["name"],
            "latitude": m["latitude"],
            "longitude": m["longitude"],
            "elevation_m": m["elevation_m"],
            "region": m["region"],
            "established": m["commissionedYear"],
            "personnelWinter": m.get("personnelWinter"),
            "dataSources": ["ERA5 reanalysis (Open-Meteo)", "NCPOR AWS live page (synced automatically)"],
        })
    return out


@app.get("/api/config/stations")
def get_station_config():
    """The full station configuration (metadata with source/confidence notes,
    buildings, dependency graph, default thresholds, remote-command catalogue)."""
    return station_config.load()


@app.get("/api/sensors/latest")
def get_latest_sensors(sid: str = Depends(station_param)):
    return published_snapshot(sid)


@app.get("/api/station/{station_id}/state")
def get_station_state(station_id: str, request: Request):
    return overlay_snapshot(published_snapshot(require_station(station_id)), sandbox_session(request))


_SERIES_KEY = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,39}\.[A-Za-z][A-Za-z0-9_]{0,39}$")


@app.get("/api/history")
def get_history(sid: str = Depends(station_param),
                keys: str = Query(..., max_length=400,
                                  description="Comma-separated 'building.sensor' keys (max 8)"),
                minutes: int = Query(30, ge=1, le=60)):
    """Rolling history of published telemetry (the values clients saw, one point per
    published snapshot), oldest first, as [timestampMs, value] pairs. The window is
    capped by HISTORY_MAX_POINTS × TICK_INTERVAL_S; unknown keys return an empty list."""
    wanted = [k.strip() for k in keys.split(",") if k.strip()]
    if not wanted or len(wanted) > 8 or not all(_SERIES_KEY.match(k) for k in wanted):
        raise HTTPException(status_code=422, detail="keys: 1-8 comma-separated 'building.sensor' ids")
    since = int(time.time() * 1000) - minutes * 60_000
    return {
        "stationId": sid,
        "minutes": minutes,
        "tickIntervalSec": app_config.TICK_INTERVAL_S,
        "maxWindowMinutes": round(app_config.HISTORY_MAX_POINTS * app_config.TICK_INTERVAL_S / 60, 1),
        "series": {k: [[t, v] for t, v in store.series(sid, k) if t >= since] for k in wanted},
    }


# ── Simulator ingest ──────────────────────────────────────────

class SensorValue(BaseModel):
    value: float = Field(allow_inf_nan=False)
    unit: str = Field("", max_length=16)
    sourceType: str | None = Field(None, max_length=32)


class EnergySummary(BaseModel):
    """physics_model.energy_summary() of the tick the readings come from."""
    model_config = ConfigDict(extra="forbid")
    totalDemand_kW: float | None = Field(None, allow_inf_nan=False)
    baseElectrical_kW: float | None = Field(None, allow_inf_nan=False)
    heatingElectrical_kW: float | None = Field(None, allow_inf_nan=False)
    ventilation_kW: float | None = Field(None, allow_inf_nan=False)
    waterTreatment_kW: float | None = Field(None, allow_inf_nan=False)
    comms_kW: float | None = Field(None, allow_inf_nan=False)
    heatLoss_kW: float | None = Field(None, allow_inf_nan=False)
    heatingDemand_kW: float | None = Field(None, allow_inf_nan=False)
    loadPct: float | None = Field(None, allow_inf_nan=False)


class ReplayClock(BaseModel):
    """The ERA5 replay instant a simulator tick describes (reanalysis mode)."""
    model_config = ConfigDict(extra="forbid")
    timeMs: int | None = None                       # epoch ms (UTC); None if the offset is unknown
    local: str | None = Field(None, max_length=32)  # the cache's own (station-local) timestamp
    speedFactor: float | None = Field(None, allow_inf_nan=False, gt=0)
    loop: int | None = None
    utcOffsetSource: str | None = Field(None, max_length=40)
    # ERA5 10 m wind direction at this instant (meteorological: degrees the wind blows FROM).
    # REANALYSIS; the 3D overview points its blowing snow along it.
    windFromDeg: float | None = Field(None, ge=0, le=360, allow_inf_nan=False)


class SensorBatch(BaseModel):
    """Superset of the legacy Java SensorBatchDTO (new fields are optional)."""
    stationId: str = Field(max_length=32)
    timestamp: int | None = None
    readings: dict[str, dict[str, SensorValue]]
    eventTimeline: list[dict[str, Any]] | None = None
    activePatterns: list[str] | None = None
    mode: str | None = Field(None, max_length=32)
    activeScenario: str | None = Field(None, max_length=64)
    injectedSensors: list[str] | None = None
    weatherSource: str | None = Field(None, max_length=200)
    energy: EnergySummary | None = None
    replay: ReplayClock | None = None

    @field_validator("readings")
    @classmethod
    def _bounded_readings(cls, v):
        if len(v) > 20 or any(len(s) > 20 for s in v.values()):
            raise ValueError("too many buildings/sensors (max 20 x 20)")
        if any(len(b) > 40 or any(len(k) > 40 for k in s) for b, s in v.items()):
            raise ValueError("building/sensor ids must be <= 40 chars")
        return v

    @field_validator("eventTimeline")
    @classmethod
    def _bounded_timeline(cls, v):
        if v is None:
            return v
        out = []
        for ev in v[-50:]:
            out.append({k: (str(val)[:200] if isinstance(val, str) else val)
                        for k, val in ev.items() if k in ("type", "message", "timestamp", "tick")})
        return out

    @field_validator("activePatterns", "injectedSensors")
    @classmethod
    def _bounded_str_list(cls, v):
        return None if v is None else [str(x)[:80] for x in v[:50]]


@app.post("/api/sensors/batch", dependencies=[Depends(require_admin)])
async def ingest_sensor_batch(batch: SensorBatch):
    sid = require_station(batch.stationId)
    points = store.record_batch(sid, batch.model_dump())
    return {"status": "accepted", "stationId": sid,
            "receivedAt": int(time.time() * 1000), "historyPoints": points}


# ── Health ───────────────────────────────────────────────────

_sim_probe_lock = threading.Lock()
_sim_probe_cache = {"at": 0.0, "value": None}


def _check_db() -> dict:
    try:
        with db.connect() as conn:
            conn.execute("SELECT 1 FROM observations LIMIT 1").fetchall()
        return {"ok": True, "path": str(db.DB_PATH), "error": None}
    except Exception as exc:
        log.warning("Health: DB check failed: %s", exc)
        return {"ok": False, "path": str(db.DB_PATH), "error": str(exc)}


def _probe_simulator() -> dict:
    """GET simulator /health + /api/chronos-status (1 s timeout, cached 5 s)."""
    with _sim_probe_lock:
        if _sim_probe_cache["value"] is not None and time.monotonic() - _sim_probe_cache["at"] < 5:
            return _sim_probe_cache["value"]
    base = app_config.SIMULATOR_URL
    result = {
        "simulator": {"reachable": False, "url": base, "error": None},
        "chronos": {"available": "unknown", "modelLoaded": "unknown", "source": "simulator"},
    }
    try:
        requests.get(f"{base}/health", timeout=1).raise_for_status()
        result["simulator"]["reachable"] = True
        cs = requests.get(f"{base}/api/chronos-status", timeout=1).json()
        result["chronos"] = {"available": bool(cs.get("chronos_available")),
                             "modelLoaded": bool(cs.get("model_loaded")), "source": "simulator"}
    except Exception as exc:
        log.info("Health: simulator probe failed: %s", exc)
        result["simulator"]["error"] = str(exc)[:200]
    with _sim_probe_lock:
        _sim_probe_cache.update(at=time.monotonic(), value=result)
    return result


@app.head("/api/health", include_in_schema=False)
async def health_head():
    """Liveness probe. HEAD answers 200 with no body, so `curl -I`, load balancers and
    uptime checks work; FastAPI's @app.get does not register HEAD on its own (it would
    be a 405). The detailed report is on GET."""
    return Response(status_code=200)


@app.get("/api/health")
async def health():
    db = await asyncio.to_thread(_check_db)
    probe = await asyncio.to_thread(_probe_simulator)
    stations = {}
    for sid in STATIONS:
        snap = store.get_published(sid)
        age = store.batch_age(sid)
        stations[sid] = {
            "dataSource": snap["dataSource"] if snap else None,
            "lastBatchAgeSec": None if age is None else round(age, 1),
            "historyPoints": store.history_len(sid),
        }
    return {
        "status": "ok" if db["ok"] else "degraded",
        "version": app_config.APP_VERSION,
        "db": db,
        "simulator": probe["simulator"],
        "chronos": probe["chronos"],
        "stations": stations,
    }


@app.get("/api/ai/analysis")
def get_ai_analysis(sid: str = Depends(station_param)):
    risk = assess_blizzard_and_polar_risks(sid)
    snap = published_snapshot(sid)
    return {
        "stationId": sid,
        "overallHealth": risk["overall_health"],
        "riskScore": risk["risk_score"],
        "windChill": risk["wind_chill_c"],
        "currentWeather": risk["current_weather"],
        # Cascade alerts (shape expected by DependencyGraph.jsx) — ported from legacy ai-service
        "dependencyAlerts": snap["dependencyAlerts"],
        "telemetryHealth": snap["aiHealth"],
        "dataSource": snap["dataSource"],
        # Weather/blizzard rule hits (previously mislabelled as dependencyAlerts)
        "riskAlerts": risk["identified_risks"],
        "provenance": risk["provenance"]
    }

# NOTE: the old GET /api/predictions (value × 0.98 "predictions") was removed —
# real model outputs are served by /api/ai/anomaly, /api/ai/forecast, /api/ai/chronos.

@app.get("/api/ncpor/live")
def get_ncpor_live(sid: str = Depends(station_param)):
    weather = get_latest_weather_for_station(sid)
    return {
        "status": "success",
        "stationId": sid,
        "stationName": station_config.meta_value(sid, "fullName"),
        "weather": {
            "temperature_c": weather["temp"],
            "wind_speed_ms": weather["wind"],
            "wind_speed_kmh": round(ms_to_kmh(weather["wind"]), 1),
            "air_pressure_hpa": weather["pressure"],
            "relative_humidity_pct": weather["humidity"],
            "source": weather["source"],
            # The actual dataset of the latest DB row (was always labelled "NCPOR Live AWS")
            "dataset": weather.get("dataset"),
            "observedAt": weather.get("observedAt"),     # epoch ms of the temperature row; None = defaults
            "provenance": _weather_provenance(weather),
            "latitude": station_config.meta_value(sid, "latitude"),
            "longitude": station_config.meta_value(sid, "longitude")
        }
    }

@app.post("/api/ncpor/ingest", dependencies=[Depends(require_admin)])
def trigger_ncpor_ingestion(sid: str | None = Depends(optional_station_param)):
    """Team: "Sync now". Same path as the scheduled sync (checks, back-off reset on success)."""
    results = {s: NCPOR.run(s, "manual") for s in ([sid] if sid else STATIONS)}
    return {"status": "success", "results": results}


@app.get("/api/ncpor/status")
def get_ncpor_status():
    """Freshness of the NCPOR live data per station: last sync, readings, next sync,
    errors since when, suspect values. Public (reads only)."""
    return NCPOR.status()

@app.get("/api/ncpor/observations")
def get_ncpor_observations(
    sid: str = Depends(station_param),
    parameter: str = "temperature",
    limit: int = 200
):
    df = query_observations(sid, parameter, limit=limit)
    if df.empty:
        return {"status": "empty", "records": []}
    return {
        "status": "success",
        "stationId": sid,
        "parameter": parameter,
        "count": len(df),
        "window": df.attrs.get("window"),
        "records": df.to_dict(orient="records")
    }

# ═══════════════════════════════════════════════════════════════
#  Analytics, Anomaly Detection & Forecasting
# ═══════════════════════════════════════════════════════════════

@app.get("/api/anomaly")
def get_anomaly_results(
    sid: str = Depends(station_param),
    parameter: str = "temperature",
    algorithm: str = "isf"
):
    return run_anomaly_detection(sid, parameter, algorithm)

@app.get("/api/forecast")
def get_forecast_results(
    sid: str = Depends(station_param),
    parameter: str = "temperature",
    model: str = "arima",
    horizon: int = 24
):
    return run_time_series_forecast(sid, parameter, model, horizon)

@app.get("/api/correlation")
def get_correlation_matrix(sid: str = Depends(station_param)):
    return run_correlation_matrix(sid)

@app.get("/api/risk")
def get_station_risk(sid: str = Depends(station_param)):
    return assess_blizzard_and_polar_risks(sid)

# ═══════════════════════════════════════════════════════════════
#  Digital Twin Inspector Causal Chain
# ═══════════════════════════════════════════════════════════════

@app.get("/api/twin-inspector")
def get_twin_inspector(sid: str = Depends(station_param)):
    """ONE schema (twin_inspector.build_twin_inspector) for both sources (B13).
    Simulator live → its causal chain (proxied); otherwise the backend's physics
    fallback (read-only — never calls pm.compute())."""
    snap = published_snapshot(sid)
    if snap["dataSource"] == "simulator":
        try:
            data = _sim_request("GET", "/api/twin-inspector", params={"station": sid})
            data["telemetrySource"] = "simulator"
            return data
        except HTTPException as exc:
            log.info("Twin inspector: simulator unavailable (%s); using physics fallback", exc.detail)
    fallback = store.get_fallback(sid)
    if fallback is None:
        raise HTTPException(status_code=503, detail="Telemetry not ready yet; retry shortly")
    weather = fallback["weather"]
    env_type = _weather_provenance(weather).lower()
    return build_twin_inspector(
        station_id=sid,
        mode="physics-fallback",
        tick_count=None,
        values=fallback["sensors"],
        meta=fallback["meta"],
        params=PHYSICS[sid].params,
        environment_source=f"{weather.get('source')} ({weather.get('dataset') or 'no dataset'})",
        environment_source_type=env_type,
        simulated_time=None,
        data_source={"mode": "physics-fallback", "sourceType": env_type,
                     "label": "Backend physics fallback driven by the latest DB weather row",
                     "weatherDataset": weather.get("dataset")},
        telemetry_source="physics-fallback",
    )

# ═══════════════════════════════════════════════════════════════
#  What-If Scenario Simulation Engine
# ═══════════════════════════════════════════════════════════════

WHATIF_SCENARIOS = ("extreme_cold", "blizzard", "gen_failure", "battery_failure", "fuel_leak",
                    "comms_outage", "resupply_delay")


class WhatIfRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    stationId: StationIdStr
    scenarioId: Literal[WHATIF_SCENARIOS]
    intensity: float = Field(1.0, ge=0.5, le=2.0, allow_inf_nan=False)   # multiplier

def _ledger_items(sid: str, session: str | None = None) -> dict:
    """The operator-entered logistics ledger for one station, by item id, as this visitor
    sees it (their sandbox ledger edits applied, judge mode)."""
    with db.connect() as conn:
        rows = conn.execute("SELECT * FROM logistics_inventory WHERE station_id = ?", (sid,)).fetchall()
    ledger = SANDBOX.get(session, "ledger")
    return {r["id"]: _inventory_item(_sandbox_ledger_row(r, ledger)[0]) for r in rows}


@app.post("/api/simulation/whatif")
def run_what_if_simulation(req: WhatIfRequest, request: Request):
    """Rule-based what-if: FIXED scenario deltas applied to the published snapshot.
    This is not the physics model: the coefficients below are assumptions, returned in
    `assumptions`, and every consequence line states only what is computed here (or read
    from the logistics ledger). Read-only: nothing in the twin changes."""
    station_id = require_station(req.stationId)
    base = published_snapshot(station_id)   # read-only baseline (no physics advance)
    weather = base["sensors"]["lab"]
    gen = base["sensors"]["generator"]
    heat = base["sensors"]["heating"]
    comms = base["sensors"]["commsMast"]
    k = req.intensity

    sim_weather = dict(weather)
    sim_gen = dict(gen)
    sim_heat = dict(heat)
    sim_comms = dict(comms)
    impacts: list[str] = []
    assumptions: list[str] = []
    affected_subsystems: list[str] = []

    if req.scenarioId == "extreme_cold":
        temp_drop = 20.0 * k
        heat_kw_per_c = 1.8
        l_per_kwh = 0.18
        sim_weather["env_temp"] -= temp_drop
        power_spike = temp_drop * heat_kw_per_c
        sim_gen["gen_power"] += power_spike
        sim_gen["gen_fuel_rate"] += power_spike * l_per_kwh
        sim_gen["gen_temp"] += 6.5
        sim_heat["heat_a_flow"] += 12.0 * k
        sim_heat["heat_a_temp"] = max(55.0, sim_heat["heat_a_temp"] - 6.0)
        assumptions += [f"{temp_drop:.0f} °C drop (20 °C × intensity)",
                        f"heating load {heat_kw_per_c} kW per °C", f"{l_per_kwh} L of diesel per extra kWh",
                        "coolant +6.5 °C; zone A flow +12 L/min × intensity"]
        impacts.append(f"Outside temperature {sim_weather['env_temp']:.1f} °C "
                       f"({temp_drop:.1f} °C below the current snapshot).")
        share = power_spike / max(1, gen["gen_power"]) * 100
        impacts.append(f"Generator load +{power_spike:.1f} kW "
                       f"(+{share:.0f} % of the current {gen['gen_power']:.0f} kW).")
        impacts.append(f"Fuel burn +{power_spike * l_per_kwh:.1f} L/h (≈ +{power_spike * l_per_kwh * 24:.0f} L/day).")
        affected_subsystems = ["Heating", "Power generation", "Fuel"]
        risk_score = min(95, int(65 + 15 * k))
        risk_level = "critical" if risk_score > 75 else "warning"
        action = "Prepare additional heating capacity and check the standby generator before the cold arrives."

    elif req.scenarioId == "blizzard":
        wind_spike = 45.0 * k
        sim_weather["env_wind"] += wind_spike
        sim_weather["env_temp"] -= 8.0 * k
        sim_comms["comms_signal"] = -92.0
        sim_comms["comms_bandwidth"] = 0.4
        assumptions += [f"wind +{wind_spike:.0f} km/h (45 × intensity)",
                        f"temperature −{8.0 * k:.1f} °C (8 × intensity)",
                        "satellite link degraded to −92 dBm / 0.4 Mbps (fixed)"]
        impacts.append(f"Sustained wind {sim_weather['env_wind']:.0f} km/h "
                       f"({kmh_to_ms(sim_weather['env_wind']):.1f} m/s).")
        impacts.append(f"Outside temperature {sim_weather['env_temp']:.1f} °C.")
        impacts.append("Satellite link assumed degraded: signal −92 dBm, bandwidth 0.4 Mbps.")
        impacts.append("Generator load is not recomputed: this rule-based scenario does not run the thermal model.")
        affected_subsystems = ["Communications", "Outdoor operations"]
        risk_score = min(98, int(72 + 16 * k))
        risk_level = "critical"
        action = "Restrict outdoor movement, secure external equipment and plan for reduced satellite bandwidth."

    elif req.scenarioId == "gen_failure":
        sim_gen["gen_power"] = 0.0
        sim_gen["gen_rpm"] = 0.0
        sim_gen["gen_fuel_rate"] = 0.0
        sim_gen["gen_temp"] = 32.0
        assumptions += ["generator power, rpm and fuel set to 0; coolant to 32 °C"]
        impacts.append(f"Generator output 0 kW (from {gen['gen_power']:.0f} kW): every electrical load loses supply.")
        impacts.append("The twin models one generator and no battery or UPS, so no backup autonomy is computed.")
        affected_subsystems = ["Power generation", "Heating", "Water treatment", "Communications"]
        risk_score = 95
        risk_level = "critical"
        action = "Shed non-essential loads and start the backup gen-set (the second gen-set is not modelled)."

    elif req.scenarioId == "battery_failure":
        sim_gen["gen_power"] = gen["gen_power"] * 1.15
        sim_gen["gen_fuel_rate"] = gen["gen_fuel_rate"] * 1.18
        assumptions += ["illustrative penalty: generator load +15 %, fuel burn +18 %",
                        "the twin does not model a battery bank or UPS"]
        impacts.append(f"Assumed generator load {sim_gen['gen_power']:.1f} kW (+15 %) and fuel "
                       f"{sim_gen['gen_fuel_rate']:.1f} L/h (+18 %).")
        impacts.append("No battery or UPS is modelled: the loss of buffering itself is not simulated.")
        affected_subsystems = ["Power generation", "Fuel"]
        risk_score = 82
        risk_level = "critical"
        action = "Keep the backup gen-set on hot standby until the storage fault is cleared."

    elif req.scenarioId == "fuel_leak":
        extra_burn = 16.0 * k
        sim_gen["gen_fuel_rate"] += extra_burn
        assumptions += [f"unmetered loss {extra_burn:.1f} L/h (16 × intensity)"]
        impacts.append(f"Fuel loss +{extra_burn:.1f} L/h on top of the generator's {gen['gen_fuel_rate']:.1f} L/h.")
        fuel = _ledger_items(station_id, sandbox_session(request)).get(f"{station_id}-fuel")
        if fuel and fuel["unit"] == "L" and gen["gen_fuel_rate"] > 0:
            before = fuel["current"] / (gen["gen_fuel_rate"] * 24)
            after = fuel["current"] / ((gen["gen_fuel_rate"] + extra_burn) * 24)
            impacts.append(f"Fuel autonomy {before:.0f} → {after:.0f} days at the current burn "
                           f"({fuel['current']:,.0f} L in the operator-entered ledger).")
        else:
            impacts.append("Fuel autonomy not computed: no fuel stock in litres in the ledger.")
        affected_subsystems = ["Fuel", "Power generation"]
        risk_score = min(92, int(70 + 15 * k))
        risk_level = "critical"
        action = "Locate and isolate the leaking section of the fuel line; switch the generator to an intact supply."

    elif req.scenarioId == "comms_outage":
        sim_comms["comms_signal"] = -120.0
        sim_comms["comms_bandwidth"] = 0.0
        sim_comms["comms_uptime"] = 0.0
        assumptions += ["satellite link down: signal −120 dBm, bandwidth 0, uptime 0 (fixed)"]
        impacts.append("Satellite link down: no telemetry reaches mission control.")
        impacts.append("Station systems are unaffected in the model; "
                       "see Link cut (simulated) for the twin's behaviour.")
        affected_subsystems = ["Communications"]
        risk_score = 70
        risk_level = "warning"
        action = "Switch to any backup link available and confirm local monitoring until the link returns."

    elif req.scenarioId == "resupply_delay":
        days_delay = int(60 * k)
        assumptions += [f"resupply delayed {days_delay} days (60 × intensity)",
                        "consumption stays at the ledger's daily use"]
        items = _ledger_items(station_id, sandbox_session(request)).values()
        short = [i for i in items if i["daysRemaining"] is not None and i["daysRemaining"] < days_delay]
        impacts.append(f"Resupply delayed by {days_delay} days.")
        if short:
            impacts.append("Would run out before a delayed resupply (operator-entered ledger): "
                           + "; ".join(f"{i['name']} ({i['daysRemaining']:.0f} days)" for i in short) + ".")
        else:
            impacts.append(f"Every ledger item covers the {days_delay}-day delay at its current daily use.")
        affected_subsystems = ["Logistics"] + [i["name"] for i in short]
        risk_score = 65 if not short else min(95, 65 + 10 * len(short))
        risk_level = "warning" if risk_score < 76 else "critical"
        action = ("Reduce consumption of the items listed above and re-plan the resupply."
                  if short else "Keep current consumption; review the ledger weekly.")

    else:
        impacts.append("Baseline nominal operating envelope.")
        affected_subsystems = ["All systems"]
        risk_score = 15
        risk_level = "healthy"
        action = "Routine station monitoring."

    deltas = {
        "temperature_delta": round(sim_weather["env_temp"] - weather["env_temp"], 1),
        "wind_delta": round(sim_weather["env_wind"] - weather["env_wind"], 1),
        "power_delta": round(sim_gen["gen_power"] - gen["gen_power"], 1),
        "fuel_rate_delta": round(sim_gen["gen_fuel_rate"] - gen["gen_fuel_rate"], 1),
    }

    return {
        "stationId": station_id,
        "scenarioId": req.scenarioId,
        "intensity": req.intensity,
        "dataSource": base["dataSource"],
        "baselineTimestamp": base["timestamp"],
        "engine": "rule-based",
        "baseline": base["sensors"],
        "simulated": {
            "lab": sim_weather,
            "generator": sim_gen,
            "heating": sim_heat,
            "commsMast": sim_comms
        },
        "deltas": deltas,
        "affectedSubsystems": affected_subsystems,
        "consequences": impacts,
        "assumptions": assumptions,
        "calculatedRisk": {
            "score": risk_score,
            "level": risk_level,
            "recommendedAction": action
        },
        "provenance": (f"Rule-based what-if: fixed scenario deltas applied to the {base['dataSource']} snapshot of "
                       f"{station_id} (environment: {base['provenance'].get('environment', 'unknown')}). "
                       "Coefficients are assumptions, not the physics model. Severity score is rule-based (0-100).")
    }

# ═══════════════════════════════════════════════════════════════
#  Satellite Link & Connection Management APIs
# ═══════════════════════════════════════════════════════════════

def _cut_link(sid: str, started_by: str) -> bool:
    last = (store.get_published(sid) or {}).get("timestamp")
    return LINK.cut(sid, started_by, last)


# The link-loss demo also starts a short CO₂ rise on the simulator while the link is down,
# so visitors see an alert happen on site, wait in the buffer and arrive with its real time.
LINK_DEMO_FAULT = "co2_spike"


def _start_link_demo(sid: str, started_by: str) -> bool:
    if not _cut_link(sid, started_by):
        return False
    try:
        _sim_request("POST", f"/inject/{LINK_DEMO_FAULT}",
                     params={"station": sid, "duration": app_config.PUBLIC_DEMO_DURATION_S, "source": "public-demo"})
    except HTTPException as exc:
        log.warning("[%s] link-loss demo: on-site fault not started (%s); the link loss runs without it",
                    sid, exc.detail)
    return True


def _end_link_demo(sid: str, source: str) -> dict:
    LINK.request_restore(sid)
    try:
        _sim_request("POST", "/reset", params={"station": sid, "source": source})
    except HTTPException as exc:
        log.warning("[%s] link-loss demo: simulator reset failed (%s)", sid, exc.detail)
    return {"status": "reset", "station": sid, "scenario": LINK_SCENARIO,
            "message": "Link restoring: the buffered readings sync on the next tick."}


@app.post("/api/connection/toggle", dependencies=[Depends(require_admin)])
def toggle_station_connection(sid: str = Depends(station_param)):
    """Team: take the station's simulated satellite link down (its readings are buffered
    on site) or bring it back (the next tick syncs the buffer). Visitors use the public
    demo scenario 'link_loss' instead, which restores itself."""
    link = LINK.status(sid)
    if link["up"]:
        _cut_link(sid, "team")
        rec = DEMO.get(sid)
        if not rec:
            DEMO.start(sid, LINK_SCENARIO, LINK_SCENARIO_NAME, started_by="team", duration_s=24 * 3600)
        connected = False
    else:
        LINK.request_restore(sid)
        rec = DEMO.get(sid)
        if rec and rec["scenario"] == LINK_SCENARIO:
            DEMO.clear(sid)
        connected = True
    return {"status": "success", "stationId": sid, "connected": connected, "link": LINK.status(sid)}

@app.get("/api/connection/status")
def get_station_connection_status(sid: str = Depends(station_param)):
    link = LINK.status(sid)
    return {"status": "success", "stationId": sid, "connected": link["up"] or link["syncing"], "link": link}

class AcknowledgeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    acknowledgedBy: OperatorName


@app.post("/api/alerts/{alert_id}/acknowledge")
def acknowledge_alert(alert_id: str, req: AcknowledgeRequest, request: Request, response: Response,
                      scope: str = Depends(write_scope)):
    if len(alert_id) > 120:
        raise HTTPException(status_code=422, detail=["alert id too long"])
    if scope == "sandbox":
        with db.connect() as conn:
            row = conn.execute("SELECT * FROM station_alerts WHERE id = ?", (alert_id,)).fetchone()
        if row is None:
            # One of this visitor's own-threshold alerts, if it is open in their view now.
            row = _open_sandbox_alert(alert_id, sandbox_session(request))
        if row is None:
            raise HTTPException(status_code=404, detail=f"Unknown alert '{alert_id}'")
        session = sandbox_for_write(request, response)
        already = row["acknowledged_at"] is not None or alert_id in SANDBOX.get(session, "ack")
        if not already:
            SANDBOX.put(session, "ack", alert_id, {"by": req.acknowledgedBy, "at": judge_mode.now_ms()})
        ack = SANDBOX.get(session, "ack").get(alert_id) or {}
        return {"status": "success", "alertId": alert_id, "acknowledged": True, "sandbox": True,
                "acknowledgedBy": row["acknowledged_by"] or ack.get("by"),
                "acknowledgedAt": row["acknowledged_at"] or ack.get("at"),
                "alertStatus": "acknowledged", "alreadyAcknowledged": already}
    try:
        row = ALERTS.acknowledge(alert_id, req.acknowledgedBy)
    except AlertNotFound as exc:
        raise HTTPException(status_code=404, detail=f"Unknown alert '{alert_id}'") from exc
    return {"status": "success", "alertId": alert_id, "acknowledged": True,
            "acknowledgedBy": row["acknowledged_by"], "acknowledgedAt": row["acknowledged_at"],
            "alertStatus": row["status"], "alreadyAcknowledged": row["alreadyAcknowledged"]}


def _sandbox_view_alerts(sid: str, session: str | None) -> list[dict]:
    """This visitor's own-threshold alerts open at `sid` now (none without a sandbox)."""
    if not session:
        return []
    return [a for a in overlay_snapshot(published_snapshot(sid), session)["activeAlerts"] if a.get("sandboxThreshold")]


def _open_sandbox_alert(alert_id: str, session: str | None) -> dict | None:
    """An open own-threshold alert of this visitor, as an acknowledgeable row, or None."""
    if not session or not alert_id.startswith("SBX-"):
        return None
    for sid in STATIONS:
        if alert_id.startswith(f"SBX-{sid}-"):
            for a in _sandbox_view_alerts(sid, session):
                if a["id"] == alert_id:
                    return {"acknowledged_by": None, "acknowledged_at": None}
    return None


@app.get("/api/alerts/history")
def get_alert_history(request: Request, sid: str = Depends(station_param), limit: int = Query(100, ge=1, le=500)):
    session = sandbox_session(request)
    # The visitor's own-threshold alerts (open now) come first, in the history row shape.
    rows = [{"id": a["id"], "parameter": a["sensor"], "subsystem": a["buildingId"], "severity": a["level"],
             "peak_severity": a["peakLevel"], "direction": a["direction"], "threshold_value": a["threshold"],
             "unit": a["unit"], "observed_value": a["value"], "reason": a["message"], "status": "active",
             "timestamp": a["timestamp"], "resolved_at": None, "acknowledged_by": None, "acknowledged_at": None,
             "_sandbox": True} for a in _sandbox_view_alerts(sid, session)]
    rows = (rows + ALERTS.history(sid, limit))[:limit]
    acks = SANDBOX.get(session, "ack")
    if acks:
        rows = [{**r, "acknowledged_by": acks[r["id"]]["by"], "acknowledged_at": acks[r["id"]]["at"],
                 "status": "acknowledged" if r["status"] == "active" else r["status"], "_sandbox": True}
                if r["id"] in acks and r["acknowledged_at"] is None else r for r in rows]
    names = station_config.building_names(sid)
    return {"stationId": sid, "alerts": [{
        "id": r["id"], "sensor": r["parameter"], "buildingId": r["subsystem"],
        "buildingName": names.get(r["subsystem"], r["subsystem"]), "level": r["severity"],
        "peakLevel": r["peak_severity"] or r["severity"], "direction": r["direction"],
        "threshold": r["threshold_value"], "unit": r["unit"], "value": r["observed_value"],
        "message": r["reason"], "status": r["status"], "raisedAt": r["timestamp"],
        "resolvedAt": r["resolved_at"], "acknowledgedBy": r["acknowledged_by"],
        "acknowledgedAt": r["acknowledged_at"], "sandbox": bool(r.get("_sandbox"))} for r in rows]}

# ═══════════════════════════════════════════════════════════════
#  Logistics & Operational Inventory APIs
# ═══════════════════════════════════════════════════════════════

def _inventory_item(r) -> dict:
    current = r["current"]
    daily = r["daily_consumption"]
    return {
        "id": r["id"],
        "name": r["name"],
        "category": r["category"],
        "current": current,
        "max": r["max_capacity"],
        "unit": r["unit"],
        "dailyUse": daily,
        "reorderAt": r["reorder_threshold"],
        "daysRemaining": round(current / daily, 1) if daily > 0 else None,
        "isLow": current <= r["reorder_threshold"],
        "lastUpdated": r["last_updated"],
        "updatedBy": r["updated_by"],
        "provenance": r["provenance"],
    }


def _sandbox_ledger_row(row, ledger: dict):
    """The inventory row as this visitor's sandbox sees it (dict), or the row itself."""
    v = ledger.get(f"{row['station_id']}|{row['id']}")
    if not v:
        return row, False
    return {**dict(row), "current": v["current"], "daily_consumption": v["dailyConsumption"],
            "last_updated": v["at"], "updated_by": v["by"]}, True


@app.get("/api/logistics")
def get_logistics(request: Request, sid: str = Depends(station_param)):
    with db.connect() as conn:
        rows = conn.execute("SELECT * FROM logistics_inventory WHERE station_id = ? ORDER BY id", (sid,)).fetchall()
    ledger = SANDBOX.get(sandbox_session(request), "ledger")
    items = []
    for r in rows:
        row, sandboxed = _sandbox_ledger_row(r, ledger)
        items.append({**_inventory_item(row), "sandbox": sandboxed})
    return {"stationId": sid, "items": items}


class InventoryUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    stationId: StationIdStr
    itemId: Identifier
    current: float = Field(ge=0, le=1e9, allow_inf_nan=False)
    dailyConsumption: float | None = Field(None, ge=0, le=1e7, allow_inf_nan=False)
    updatedBy: OperatorName


@app.post("/api/logistics/update")
def update_inventory_item(req: InventoryUpdateRequest, request: Request, response: Response,
                          scope: str = Depends(write_scope)):
    sid = require_station(req.stationId)
    now_ts = int(time.time() * 1000)
    if scope == "sandbox":
        with db.connect() as conn:
            shared = conn.execute("SELECT * FROM logistics_inventory WHERE id = ? AND station_id = ?",
                                  (req.itemId, sid)).fetchone()
        if shared is None:
            raise HTTPException(status_code=404, detail=f"Unknown inventory item '{req.itemId}' for station '{sid}'")
        if req.current > shared["max_capacity"]:
            raise HTTPException(status_code=422, detail=[
                f"current ({req.current}) exceeds max capacity "
                f"({shared['max_capacity']} {shared['unit']}) of {req.itemId}"])
        session = sandbox_for_write(request, response)
        row, _ = _sandbox_ledger_row(shared, SANDBOX.get(session, "ledger"))
        daily = req.dailyConsumption if req.dailyConsumption is not None else row["daily_consumption"]
        changes = [("current", row["current"], req.current)]
        if req.dailyConsumption is not None:
            changes.append(("daily_consumption", row["daily_consumption"], req.dailyConsumption))
        changes = [(f, old, new) for f, old, new in changes if float(old) != float(new)]
        SANDBOX.put(session, "ledger", f"{sid}|{req.itemId}",
                    {"current": req.current, "dailyConsumption": daily, "at": now_ts, "by": req.updatedBy})
        for i, (f, old, new) in enumerate(changes):
            SANDBOX.put(session, "ledger_audit", f"{sid}|{now_ts}|{uuid.uuid4().hex[:8]}{i}",
                        {"itemId": req.itemId, "field": f, "old": str(old), "new": str(new),
                         "by": req.updatedBy, "at": now_ts})
        updated, _ = _sandbox_ledger_row(shared, SANDBOX.get(session, "ledger"))
        return {"status": "success", "sandbox": True, "item": {**_inventory_item(updated), "sandbox": True},
                "changes": len(changes)}
    with db.connect() as conn:
        row = conn.execute("SELECT * FROM logistics_inventory WHERE id = ? AND station_id = ?",
                           (req.itemId, sid)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail=f"Unknown inventory item '{req.itemId}' for station '{sid}'")
        if req.current > row["max_capacity"]:
            raise HTTPException(status_code=422, detail=[
                f"current ({req.current}) exceeds max capacity ({row['max_capacity']} {row['unit']}) of {req.itemId}"])
        changes = [("current", row["current"], req.current)]
        if req.dailyConsumption is not None:
            changes.append(("daily_consumption", row["daily_consumption"], req.dailyConsumption))
        changes = [(f, old, new) for f, old, new in changes if float(old) != float(new)]
        conn.execute(
            "UPDATE logistics_inventory SET current = ?, daily_consumption = ?, last_updated = ?, updated_by = ? "
            "WHERE id = ? AND station_id = ?",
            (req.current, req.dailyConsumption if req.dailyConsumption is not None else row["daily_consumption"],
             now_ts, req.updatedBy, req.itemId, sid))
        conn.executemany(
            "INSERT INTO logistics_audit (station_id, item_id, field, old_value, new_value, updated_by, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            [(sid, req.itemId, f, str(old), str(new), req.updatedBy, now_ts) for f, old, new in changes])
        updated = conn.execute("SELECT * FROM logistics_inventory WHERE id = ?", (req.itemId,)).fetchone()
    log.info("Inventory %s/%s updated by %s: %s", sid, req.itemId, req.updatedBy,
             ", ".join(f"{f} {old}→{new}" for f, old, new in changes) or "no change")
    return {"status": "success", "item": _inventory_item(updated), "changes": len(changes)}


@app.get("/api/logistics/history")
def get_logistics_history(request: Request, sid: str = Depends(station_param),
                          itemId: str | None = Query(None, max_length=64),
                          limit: int = Query(100, ge=1, le=500)):
    with db.connect() as conn:
        if itemId:
            rows = conn.execute(
                "SELECT * FROM logistics_audit WHERE station_id = ? AND item_id = ? "
                "ORDER BY updated_at DESC, id DESC LIMIT ?",
                (sid, itemId, limit)).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM logistics_audit WHERE station_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?",
                (sid, limit)).fetchall()
    history = [
        {"id": r["id"], "itemId": r["item_id"], "field": r["field"], "oldValue": r["old_value"],
         "newValue": r["new_value"], "updatedBy": r["updated_by"], "updatedAt": r["updated_at"], "sandbox": False}
        for r in rows]
    mine = [{"id": f"sandbox-{k}", "itemId": v["itemId"], "field": v["field"], "oldValue": v["old"],
             "newValue": v["new"], "updatedBy": v["by"], "updatedAt": v["at"], "sandbox": True}
            for k, v in SANDBOX.get(sandbox_session(request), "ledger_audit").items()
            if k.startswith(f"{sid}|") and (not itemId or v["itemId"] == itemId)]
    if mine:
        history = sorted(mine + history, key=lambda h: h["updatedAt"], reverse=True)[:limit]
    return {"stationId": sid, "history": history}

# ═══════════════════════════════════════════════════════════════
#  Remote Command & Control APIs (SIMULATED dispatch — no station link)
# ═══════════════════════════════════════════════════════════════

CMD_QUEUED = "queued (simulated)"
CMD_ACKNOWLEDGED = "acknowledged (simulated)"


class DispatchCommandRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    stationId: StationIdStr
    subsystem: str = Field(min_length=1, max_length=40)
    command: Identifier
    parameters: dict[str, str | float | int | bool] | None = Field(None, max_length=10)
    issuedBy: OperatorName


@app.post("/api/remote/dispatch")
def dispatch_remote_command(req: DispatchCommandRequest, request: Request, response: Response,
                            scope: str = Depends(write_scope)):
    sid = require_station(req.stationId)
    catalog = station_config.remote_command_catalog()
    if req.subsystem not in catalog:
        raise HTTPException(status_code=422, detail=[
            f"unknown subsystem '{req.subsystem}'. Known: {', '.join(catalog)}"])
    if req.command not in catalog[req.subsystem]:
        raise HTTPException(status_code=422, detail=[
            f"unknown command '{req.command}' for {req.subsystem}. Known: {', '.join(catalog[req.subsystem])}"])
    now_ts = int(time.time() * 1000)
    cmd_id = f"CMD-{now_ts}-{sid[:3].upper()}-{uuid.uuid4().hex[:6]}"
    if scope == "sandbox":
        session = sandbox_for_write(request, response)
        SANDBOX.put(session, "command", cmd_id, {
            "station_id": sid, "subsystem": req.subsystem, "command": req.command,
            "parameters": req.parameters or {}, "created_at": now_ts, "issued_by": req.issuedBy})
        return {"status": CMD_QUEUED, "simulated": True, "sandbox": True, "commandId": cmd_id,
                "message": (f"Simulated dispatch in your sandbox: '{req.command}' for {sid} {req.subsystem} "
                            "was recorded privately. No real actuation link exists.")}
    with db.connect() as conn:
        conn.execute("""
            INSERT INTO remote_commands
            (id, station_id, subsystem, command, parameters, status, created_at, dispatched_at, issued_by, response_log)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (cmd_id, sid, req.subsystem, req.command, json.dumps(req.parameters or {}), CMD_QUEUED, now_ts,
              None, req.issuedBy,
              "SIMULATED dispatch: recorded only. No station actuation link exists; nothing will be executed."))
    return {
        "status": CMD_QUEUED,
        "simulated": True,
        "commandId": cmd_id,
        "message": (f"Simulated dispatch: '{req.command}' for {sid} {req.subsystem} was recorded. "
                    "No real actuation link exists."),
    }


def promote_remote_commands(now_ms: int | None = None) -> int:
    """Lifecycle step run by the tick: queued (simulated) → acknowledged (simulated)
    after REMOTE_ACK_DELAY_S. Never 'executed' — there is no station link."""
    now_ms = now_ms or int(time.time() * 1000)
    cutoff = now_ms - int(app_config.REMOTE_ACK_DELAY_S * 1000)
    with db.connect() as conn:
        cur = conn.execute(
            "UPDATE remote_commands SET status = ?, acknowledged_at = ?, "
            "response_log = response_log || ' | Simulated acknowledgement (no station link; not executed).' "
            "WHERE status = ? AND created_at <= ?",
            (CMD_ACKNOWLEDGED, now_ms, CMD_QUEUED, cutoff))
    return cur.rowcount


def _command_out(r) -> dict:
    d = dict(r)
    lifecycle = [{"state": CMD_QUEUED, "at": r["created_at"]}]
    if r["acknowledged_at"]:
        lifecycle.append({"state": CMD_ACKNOWLEDGED, "at": r["acknowledged_at"]})
    d["lifecycle"] = lifecycle
    d["simulated"] = True
    return d


def _sandbox_command_out(cmd_id: str, v: dict) -> dict:
    """A sandbox command in the shared row shape, its lifecycle derived from the clock."""
    acked_at = v["created_at"] + int(app_config.REMOTE_ACK_DELAY_S * 1000)
    acked = judge_mode.now_ms() >= acked_at
    lifecycle = [{"state": CMD_QUEUED, "at": v["created_at"]}]
    if acked:
        lifecycle.append({"state": CMD_ACKNOWLEDGED, "at": acked_at})
    return {"id": cmd_id, "station_id": v["station_id"], "subsystem": v["subsystem"], "command": v["command"],
            "parameters": json.dumps(v["parameters"]), "status": CMD_ACKNOWLEDGED if acked else CMD_QUEUED,
            "created_at": v["created_at"], "dispatched_at": None, "acknowledged_at": acked_at if acked else None,
            "issued_by": v["issued_by"],
            "response_log": "SIMULATED dispatch in a visitor sandbox: recorded privately, nothing executed.",
            "lifecycle": lifecycle, "simulated": True, "sandbox": True}


@app.get("/api/remote/commands")
def get_remote_commands(request: Request, sid: str = Depends(station_param), limit: int = Query(50, ge=1, le=200)):
    with db.connect() as conn:
        rows = conn.execute("SELECT * FROM remote_commands WHERE station_id = ? ORDER BY created_at DESC LIMIT ?",
                            (sid, limit)).fetchall()
    commands = [{**_command_out(r), "sandbox": False} for r in rows]
    mine = [_sandbox_command_out(k, v) for k, v in SANDBOX.get(sandbox_session(request), "command").items()
            if v["station_id"] == sid]
    if mine:
        commands = sorted(mine + commands, key=lambda c: c["created_at"], reverse=True)[:limit]
    return {"stationId": sid, "commands": commands, "catalog": station_config.remote_command_catalog()}

# ═══════════════════════════════════════════════════════════════
#  Alert Management APIs
# ═══════════════════════════════════════════════════════════════

@app.get("/api/alerts")
def get_alerts(request: Request, sid: str = Depends(station_param)):
    snap = overlay_snapshot(published_snapshot(sid), sandbox_session(request))   # read-only
    return {
        "stationId": sid,
        "activeAlerts": snap["activeAlerts"],
        "alerts": snap["alerts"],
        "dependencyAlerts": snap["dependencyAlerts"],
        "dataSource": snap["dataSource"],
    }

# ═══════════════════════════════════════════════════════════════
#  Admin & Configuration APIs
# ═══════════════════════════════════════════════════════════════

@app.get("/api/admin/session")
def admin_session(x_admin_token: str | None = Header(None, alias="X-Admin-Token")) -> dict:
    """Whether writes need a token, and whether the one presented works.

    Public on purpose, and it leaks nothing: it reports only that protection is on, never
    the token. The UI needs both answers — `writeProtected` to decide whether to disable
    the write controls at all (with ADMIN_TOKEN unset, local development must keep
    working), and `authenticated` to verify a token at login instead of discovering it was
    wrong on the operator's first real write.
    """
    expected = app_config.ADMIN_TOKEN
    judge = {"sandbox": app_config.VISITOR_SANDBOX, "publicDemo": app_config.PUBLIC_DEMO,
             "sandboxTtlS": app_config.SANDBOX_TTL_S, "publicDemoDurationS": app_config.PUBLIC_DEMO_DURATION_S}
    if not expected:
        return {"writeProtected": False, "authenticated": True, **judge}
    ok = bool(x_admin_token) and secrets.compare_digest(x_admin_token, expected)
    return {"writeProtected": True, "authenticated": ok, **judge}


class VisitRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    entry: str = Field("main", max_length=64)


@app.post("/api/visit")
def record_visit(req: VisitRequest, request: Request,
                 x_admin_token: str | None = Header(None, alias="X-Admin-Token")):
    """Count a page open (visits.py: aggregate counts, no cookie, nothing personal stored).
    Public by nature, like the explain routes: it changes only a counter, and nginx's
    /api rate limit applies. The team (a valid token) is not counted."""
    if x_admin_token and app_config.ADMIN_TOKEN and secrets.compare_digest(x_admin_token, app_config.ADMIN_TOKEN):
        return {"counted": False}
    out = VISITS.record(client_ip(request), request.headers.get("user-agent", "")[:300], req.entry)
    return {"counted": out["counted"]}


@app.get("/api/admin/visits", dependencies=[Depends(require_admin)])
def get_visits(days: int = Query(14, ge=1, le=90)):
    """Visit counts for the team (Administration → Visits)."""
    return VISITS.summary(days)


@app.get("/api/sandbox")
def sandbox_status(request: Request):
    """This visitor's sandbox: whether it exists, when it expires, what it holds. Never creates one."""
    session = sandbox_session(request)
    return {"enabled": app_config.VISITOR_SANDBOX, "active": session is not None,
            "expiresAt": SANDBOX.expires_at(session) if session else None,
            "ttlS": app_config.SANDBOX_TTL_S, "changes": SANDBOX.counts(session)}


@app.post("/api/sandbox/reset")
def sandbox_reset(request: Request, response: Response):
    """Forget this visitor's sandbox (only theirs: the id comes from their own cookie)."""
    session = sandbox_session(request)
    removed = SANDBOX.reset(session) if session else 0
    response.delete_cookie(judge_mode.COOKIE_NAME, path="/")
    return {"status": "reset", "removed": removed}


@app.get("/api/admin/config")
def get_admin_config(request: Request, sid: str = Depends(station_param)):
    sensors = station_config.sensors(sid)
    overrides = alert_engine.load_overrides(sid)
    session = sandbox_session(request)
    sandbox_ov = sandbox_threshold_overrides(session, sid)
    return {
        "system": {
            "name": "AURORA Antarctic Digital Twin Platform",
            "version": app_config.APP_VERSION,
            "activeStations": [station_config.meta_value(s_id, "name") for s_id in STATIONS],
            "ingestionSource": "Open-Meteo ERA5 reanalysis cache + NCPOR AWS live pages (synced automatically)",
        },
        # HARDCODED-DEMO: example roles only — there is no authentication or RBAC yet (P1-8).
        "usersProvenance": "HARDCODED-DEMO (no authentication / RBAC implemented)",
        "users": [
            {"id": "usr-01", "name": "Station Commander", "role": "Commander",
             "station": "All", "access": "Full Control"},
            {"id": "usr-02", "name": "Chief Electrical Engineer", "role": "Engineer",
             "station": "Maitri", "access": "C&C Dispatch"},
            {"id": "usr-03", "name": "Scientific Observer", "role": "Observer",
             "station": "Bharati", "access": "Read-Only Analytics"},
            {"id": "usr-04", "name": "Logistics Officer", "role": "Logistics",
             "station": "All", "access": "Inventory Management"}
        ],
        "stationId": sid,
        # Effective thresholds used by the alert engine for this station.
        "thresholds": (sandbox_thresholds(session, sid) if sandbox_ov
                       else alert_engine.effective_thresholds(sid, overrides)),
        "thresholdDefaults": station_config.default_thresholds(sid),
        "thresholdOverrides": overrides + sandbox_ov,
        # This visitor's private overrides (judge mode): their own alert view uses them
        # (sandbox_alert_view); the shared alerts and every other visitor keep the shared ones.
        "sandboxOverrides": sandbox_ov,
        "thresholdRules": {k: {"name": v["name"], "building": v["building"], "unit": v["unit"],
                               "min": v["thresholdRange"][0], "max": v["thresholdRange"][1], "basis": v["basis"]}
                           for k, v in sensors.items()},
        "alertResolveTicks": ALERTS.resolve_ticks,
        "thresholdsUsedByAlerts": True,
    }


class ThresholdLevels(BaseModel):
    model_config = ConfigDict(extra="forbid")
    warning: float | None = Field(None, allow_inf_nan=False)
    critical: float | None = Field(None, allow_inf_nan=False)


class SensorThresholdUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    low: ThresholdLevels | None = None
    high: ThresholdLevels | None = None


class ConfigUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    stationId: StationIdStr                      # a station id, or "*" for every station
    thresholds: dict[str, SensorThresholdUpdate] = Field(min_length=1, max_length=40)
    updatedBy: OperatorName


def _scope(raw: str) -> str:
    return "*" if raw.strip() == "*" else require_station(raw)


@app.post("/api/admin/config")
def update_admin_config(req: ConfigUpdateRequest, request: Request, response: Response,
                        scope_kind: str = Depends(write_scope)):
    scope = _scope(req.stationId)
    updates = {
        sensor: {d: {lvl: v for lvl, v in levels.model_dump().items() if v is not None}
                 for d, levels in (("low", u.low), ("high", u.high)) if levels is not None}
        for sensor, u in req.thresholds.items()
    }
    updates = {k: {d: lv for d, lv in v.items() if lv} for k, v in updates.items()}
    updates = {k: v for k, v in updates.items() if v}
    if not updates:
        raise HTTPException(status_code=422, detail=["no threshold values given"])
    if scope_kind == "sandbox":
        session = sandbox_session(request)
        errors = alert_engine.validate_threshold_update(scope, updates, base=lambda s: sandbox_thresholds(session, s))
        if errors:
            raise HTTPException(status_code=422, detail=errors)
        session = sandbox_for_write(request, response)
        ts = judge_mode.now_ms()
        n = 0
        for sensor, dirs in updates.items():
            for direction, levels in dirs.items():
                for level, value in levels.items():
                    SANDBOX.put(session, "threshold", f"{scope}|{sensor}|{direction}|{level}",
                                {"value": float(value), "by": req.updatedBy, "at": ts})
                    n += 1
        shown = STATIONS[0] if scope == "*" else scope
        return {"status": "saved", "sandbox": True, "stationId": scope, "valuesSaved": n, "updatedAt": ts,
                "thresholds": sandbox_thresholds(session, shown), "thresholdsUsedByAlerts": True,
                "alertsScope": "sandbox"}
    errors = alert_engine.validate_threshold_update(scope, updates)
    if errors:
        raise HTTPException(status_code=422, detail=errors)
    n = alert_engine.save_overrides(scope, updates, req.updatedBy)
    log.info("Alert thresholds updated by %s for %s: %s", req.updatedBy, scope, updates)
    shown = STATIONS[0] if scope == "*" else scope
    return {"status": "saved", "stationId": scope, "valuesSaved": n, "updatedAt": int(time.time() * 1000),
            "thresholds": alert_engine.effective_thresholds(shown), "thresholdsUsedByAlerts": True}


class ThresholdResetRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    stationId: StationIdStr
    sensor: Identifier | None = None
    updatedBy: OperatorName


@app.post("/api/admin/config/reset")
def reset_admin_thresholds(req: ThresholdResetRequest, request: Request, response: Response,
                           scope_kind: str = Depends(write_scope)):
    scope = _scope(req.stationId)
    if req.sensor is not None and req.sensor not in station_config.sensors(STATIONS[0] if scope == "*" else scope):
        raise HTTPException(status_code=404, detail=f"Unknown sensor '{req.sensor}'")
    if scope_kind == "sandbox":
        session = sandbox_for_write(request, response)
        removed = SANDBOX.delete(session, "threshold", f"{scope}|{req.sensor}|" if req.sensor else f"{scope}|")
        SANDBOX.forget_alerts(session, None if scope == "*" else scope)
        return {"status": "reset", "sandbox": True, "stationId": scope, "sensor": req.sensor, "removed": removed}
    removed = alert_engine.reset_overrides(scope, req.sensor)
    log.info("Alert threshold overrides reset by %s for %s/%s: %d removed", req.updatedBy, scope, req.sensor, removed)
    return {"status": "reset", "stationId": scope, "sensor": req.sensor, "removed": removed}

# ═══════════════════════════════════════════════════════════════
#  Real AI pipeline (proxied from the internal simulator, :SIM_PORT)
# ═══════════════════════════════════════════════════════════════

SIM_TIMEOUT_S = 3.0
EXPLAIN_TIMEOUT_S = 20.0
MODE_TIMEOUT_S = 30.0   # /mode rebuilds simulators (may load weather caches)


def _sim_request(method: str, path: str, *, params=None, json_body=None, timeout=SIM_TIMEOUT_S):
    """Call the internal simulator. Down/timeout/5xx → HTTP 503 with a clear reason."""
    url = f"{app_config.SIMULATOR_URL}{path}"
    try:
        r = requests.request(method, url, params=params, json=json_body, timeout=timeout)
    except requests.Timeout as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Simulator offline: no response from {app_config.SIMULATOR_URL} within {timeout:g} s",
        ) from exc
    except requests.RequestException as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Simulator offline: cannot reach {app_config.SIMULATOR_URL} ({type(exc).__name__})",
        ) from exc
    if r.status_code >= 500:
        raise HTTPException(status_code=503, detail=f"Simulator error: HTTP {r.status_code} from {path}")
    try:
        data = r.json()
    except ValueError as exc:
        raise HTTPException(status_code=502, detail=f"Simulator returned invalid JSON from {path}") from exc
    if r.status_code >= 400:
        raise HTTPException(status_code=r.status_code, detail=data)
    return data


@app.get("/api/ai/anomaly")
def ai_anomaly(sid: str = Depends(station_param)):
    return {**_sim_request("GET", "/api/anomaly", params={"station": sid}), "source": "simulator"}


@app.get("/api/ai/decision")
def ai_decision(sid: str = Depends(station_param)):
    return {**_sim_request("GET", "/api/decision", params={"station": sid}), "source": "simulator"}


@app.get("/api/ai/forecast")
def ai_forecast(sid: str = Depends(station_param)):
    return {**_sim_request("GET", "/api/forecast", params={"station": sid}), "source": "simulator"}


@app.get("/api/ai/chronos")
def ai_chronos(sid: str = Depends(station_param)):
    return {**_sim_request("GET", "/api/chronos-forecast", params={"station": sid}), "source": "simulator"}


# ── Demo Control / replay controls (so the browser never calls :SIM_PORT) ──

@app.get("/api/sim/scenarios")
def sim_scenarios(sid: str = Depends(station_param)):
    """The simulator's scenarios, plus the backend's own satellite link loss."""
    res = _sim_request("GET", "/scenarios", params={"station": sid})
    res.setdefault("scenarios", {})[LINK_SCENARIO] = {
        "name": LINK_SCENARIO_NAME, "kind": "link", "targets": None,
        "duration": app_config.PUBLIC_DEMO_DURATION_S,
        "description": ("Cuts the station's satellite link. The dashboard freezes on the last data received while "
                        "the station keeps recording, and a CO₂ rise in the living quarters (simulated) happens "
                        "on site. When the link returns, everything recorded is sent in order: no gap in the charts, "
                        "and the alert keeps its real time."),
    }
    if not LINK.status(sid)["up"]:
        res["activeScenario"] = LINK_SCENARIO
    return res


def _demo_error(status: int, exc: judge_mode.DemoBusy):
    return HTTPException(status_code=status, detail={"message": exc.message, "retryAfterS": exc.retry_after_s},
                         headers={"Retry-After": str(exc.retry_after_s)})


@app.post("/api/sim/inject/{scenario_id}")
def sim_inject(scenario_id: str, request: Request, sid: str = Depends(station_param),
               actor: str = Depends(demo_actor)):
    """Team: any scenario, any time. Visitor (PUBLIC_DEMO): only the predefined demo
    scenarios, one per station at a time, PUBLIC_DEMO_DURATION_S long, then auto-reset,
    and one start per PUBLIC_DEMO_COOLDOWN_S per IP."""
    if not re.fullmatch(r"[a-z0-9_]{1,40}", scenario_id):
        raise HTTPException(status_code=422, detail=["invalid scenario id"])
    if actor == "visitor":
        if scenario_id not in judge_mode.PUBLIC_SCENARIOS:
            raise HTTPException(status_code=403, detail="Only the predefined demo scenarios can be started publicly.")
        name = scenario_id.replace("_", " ")
        ip = client_ip(request)
        duration = app_config.PUBLIC_DEMO_DURATION_S
        try:
            DEMO.start(sid, scenario_id, name, started_by="visitor", duration_s=duration, ip=ip,
                       station_name=station_config.meta_value(sid, "name"))
        except judge_mode.DemoCooldown as exc:
            raise _demo_error(429, exc) from exc
        except judge_mode.DemoBusy as exc:
            raise _demo_error(409, exc) from exc
        if scenario_id == LINK_SCENARIO:
            if not _start_link_demo(sid, "visitor"):
                DEMO.forget_start(sid, ip)
                raise HTTPException(status_code=409, detail={"message": "The link is already down at this station.",
                                                             "retryAfterS": 30})
            rec = DEMO.set_name(sid, LINK_SCENARIO_NAME)
            log.info("Public demo link_loss started on %s by a visitor", sid)
            return {"scenario": LINK_SCENARIO, "name": LINK_SCENARIO_NAME, "station": sid, "duration": duration,
                    "source": "public-demo", "publicDemo": rec}
        try:
            res = _sim_request("POST", f"/inject/{scenario_id}",
                               params={"station": sid, "duration": duration, "source": "public-demo"})
        except HTTPException:
            DEMO.forget_start(sid, ip)
            raise
        rec = DEMO.set_name(sid, res.get("name", name))
        log.info("Public demo %s started on %s by a visitor", scenario_id, sid)
        return {**res, "publicDemo": rec}
    if scenario_id == LINK_SCENARIO:
        _start_link_demo(sid, "team")
        rec = DEMO.start(sid, LINK_SCENARIO, LINK_SCENARIO_NAME, started_by="team",
                         duration_s=app_config.PUBLIC_DEMO_DURATION_S)
        return {"scenario": LINK_SCENARIO, "name": LINK_SCENARIO_NAME, "station": sid, "publicDemo": rec}
    res = _sim_request("POST", f"/inject/{scenario_id}", params={"station": sid})
    rec = DEMO.start(sid, scenario_id, res.get("name", scenario_id), started_by="team",
                     duration_s=float(res.get("duration") or 30))
    return {**res, "publicDemo": rec}


@app.post("/api/sim/reset")
def sim_reset(sid: str = Depends(station_param), actor: str = Depends(demo_actor)):
    """Team: always. Visitor: only a running public demo scenario."""
    if actor == "visitor":
        rec = DEMO.get(sid)
        if not rec:
            return {"status": "idle", "station": sid, "message": "No demo scenario is running."}
        if rec["startedBy"] != "visitor":
            raise HTTPException(status_code=403,
                                detail="This scenario was started by the Aurora team; it ends by itself.")
        if rec["scenario"] == LINK_SCENARIO:
            res = _end_link_demo(sid, "public-demo")
        else:
            res = _sim_request("POST", "/reset", params={"station": sid, "source": "public-demo"})
    elif (DEMO.get(sid) or {}).get("scenario") == LINK_SCENARIO or not LINK.status(sid)["up"]:
        res = _end_link_demo(sid, "team")
    else:
        res = _sim_request("POST", "/reset", params={"station": sid})
    DEMO.clear(sid)
    return res



class ModeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: Literal["reanalysis", "simulation"] = "reanalysis"
    date: str | None = Field(None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    speed: float = Field(120.0, ge=1.0, le=3600.0, allow_inf_nan=False)

    @field_validator("date")
    @classmethod
    def _real_date(cls, v):
        if v is not None:
            datetime.strptime(v, "%Y-%m-%d")      # ValueError → 422 (e.g. 2024-02-31)
        return v


@app.post("/api/sim/mode", dependencies=[Depends(require_admin)])
def sim_mode(req: ModeRequest):
    return _sim_request("POST", "/mode", json_body=req.model_dump(), timeout=MODE_TIMEOUT_S)


# ═══════════════════════════════════════════════════════════════
#  Explanation: LLM via simulator (Groq) or honest offline summary
# ═══════════════════════════════════════════════════════════════

class ExplainRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    station: StationIdStr | None = None
    stationId: StationIdStr | None = None
    question: str = Field("status", min_length=1, max_length=32, pattern=r"^[A-Za-z_]+$")
    freeText: str = Field("", max_length=2000)


_LLM_FAILURE_PREFIXES = ("LLM explanation", "Decision engine has not")

# Several judges asking the same thing at the same moment get one LLM answer: the cache
# key is the request plus the station's alert state, so a changed situation is re-asked.
_explain_cache: dict[tuple, tuple[float, dict]] = {}
_explain_lock = threading.Lock()


def _explain_key(sid: str, req: "ExplainRequest") -> tuple:
    snap = store.get_published(sid) or {}
    alerts = tuple(sorted((str(a.get("id")), a.get("level")) for a in snap.get("activeAlerts") or []))
    scenario = (snap.get("provenance") or {}).get("activeScenario")
    return (sid, req.question, " ".join(req.freeText.lower().split()), alerts, scenario)


@app.post("/api/aurora-explain")
@app.post("/api/explain")
@app.post("/api/ai/explain")
def get_ai_explanation(req: ExplainRequest):
    """Forward question + freeText to the simulator's Groq layer. With no key,
    Groq/simulator unreachable or an upstream error, return a deterministic
    summary of the current decision JSON labelled 'offline summary'."""
    sid = require_station(req.stationId or req.station or "maitri")
    reason = None
    key = _explain_key(sid, req)
    now = time.time()
    with _explain_lock:
        for k in [k for k, (t, _) in _explain_cache.items() if now - t > app_config.EXPLAIN_CACHE_S]:
            _explain_cache.pop(k, None)
        hit = _explain_cache.get(key)
    if hit:
        return {**hit[1], "cached": True, "cachedAgeS": round(now - hit[0])}
    try:
        res = _sim_request("POST", "/api/aurora-explain", timeout=EXPLAIN_TIMEOUT_S,
                           json_body={"station": sid, "question": req.question, "freeText": req.freeText})
        text = str(res.get("explanation", ""))
        if res.get("llmAvailable") and not text.startswith(_LLM_FAILURE_PREFIXES):
            out = {**res, "station": sid, "mode": "llm", "llmAvailable": True}
            with _explain_lock:
                _explain_cache[key] = (time.time(), out)
            return out
        reason = text or "LLM unavailable"
    except HTTPException as exc:
        reason = str(exc.detail)
        log.info("Explain: LLM path unavailable (%s); using offline summary", reason)

    try:
        decision = _sim_request("GET", "/api/decision", params={"station": sid})
        if (decision.get("risk") or {}).get("level") == "unknown":
            decision = None     # simulator up but no decision computed yet
    except HTTPException as exc:
        log.info("Explain: decision unavailable (%s)", exc.detail)
        decision = None
    out = offline_explanation(decision, req.question, req.freeText, sid, store.get_published(sid))
    out.update({"station": sid, "reason": reason,
                "sources": ["decision_engine"] if decision else ["telemetry_snapshot"]})
    return out

# ═══════════════════════════════════════════════════════════════
#  Aurora assistant (grounded Q&A + whitelisted UI actions)
# ═══════════════════════════════════════════════════════════════
# The browser's assistant panel parses common commands itself; questions and anything it
# does not recognise come here. Answers use ONLY assistant.build_context() for the station.
# Like the explain routes, /api/assistant/chat changes nothing (it may *return* actions,
# which the browser validates again, confirms if they change state, and runs through the
# normal, protected routes), so it is public and rate-limited by nginx instead.

ASSISTANT_NOTICE_OFFLINE = "Answering from station data only"
# Topics where the deterministic answer is already the whole answer (a lookup): no LLM call.
_ASSISTANT_LOOKUPS = {"fuel", "sensor", "weather", "generator", "alerts", "depends"}


def _assistant_context(sid: str, request: Request | None) -> dict:
    snap = overlay_snapshot(published_snapshot(sid), sandbox_session(request) if request else None)
    anomaly = decision = None
    anomaly_err = decision_err = None
    try:
        anomaly = _sim_request("GET", "/api/anomaly", params={"station": sid})
    except HTTPException as exc:
        anomaly_err = "simulator offline" if exc.status_code == 503 else f"HTTP {exc.status_code}"
    try:
        decision = _sim_request("GET", "/api/decision", params={"station": sid})
    except HTTPException as exc:
        decision_err = "simulator offline" if exc.status_code == 503 else f"HTTP {exc.status_code}"
    return assistant.build_context(sid, snap, anomaly, decision, link=LINK.status(sid),
                                   anomaly_error=anomaly_err, decision_error=decision_err)


@app.get("/api/assistant/context")
def assistant_context(request: Request, sid: str = Depends(station_param)):
    """The compact, current context Aurora answers from (also used for incident briefings)."""
    return _assistant_context(sid, request)


@app.get("/api/assistant/status")
def assistant_status():
    """Whether answers can use the LLM now, or come from station data only."""
    try:
        st = _sim_request("GET", "/api/llm/status")
    except HTTPException as exc:
        return {"llmAvailable": False, "notice": ASSISTANT_NOTICE_OFFLINE, "reason": str(exc.detail)}
    ok = bool(st.get("configured")) and st.get("explainRemaining", 0) > 0
    reason = None if ok else ("no Groq key on the server" if not st.get("configured")
                              else "the hourly or daily Groq budget is used up")
    return {"llmAvailable": ok, "routerAvailable": bool(st.get("configured")) and st.get("routerRemaining", 0) > 0,
            "notice": None if ok else ASSISTANT_NOTICE_OFFLINE, "reason": reason,
            "models": {"router": st.get("routerModel"), "explain": st.get("explainModel")}}


@app.post("/api/assistant/evaluate")
def assistant_evaluate(sid: str = Depends(station_param)):
    """Ask the decision engine to re-evaluate this station on its next tick (debounced to one
    evaluation per 2 s). Changes no shared state: it only refreshes a computed assessment,
    so like the explain routes it needs no token."""
    try:
        return _sim_request("POST", "/api/decision/evaluate", params={"station": sid})
    except HTTPException as exc:
        return {"queued": False, "station": sid, "reason": str(exc.detail)}


@app.get("/api/assistant/playbooks")
def assistant_playbooks():
    """Incident playbooks: example procedures, not official NCPOR procedures."""
    return assistant.playbooks()


class AssistantTurn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    role: Literal["user", "assistant"]
    text: str = Field(..., max_length=600)


class AssistantChatRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    stationId: StationIdStr
    text: str = Field(..., min_length=1, max_length=assistant.TEXT_MAX)
    page: str | None = Field(None, max_length=32, pattern=r"^[a-z]+$")
    lang: Literal["en", "hi"] = "en"
    history: list[AssistantTurn] = Field(default_factory=list, max_length=4)


def _llm(kind: str, messages: list, **extra) -> dict:
    """One call through the simulator's Groq gateway; {"available": False, "reason"} on any failure."""
    try:
        return _sim_request("POST", "/api/llm/chat", timeout=EXPLAIN_TIMEOUT_S,
                            json_body={"kind": kind, "messages": messages, **extra})
    except HTTPException as exc:
        return {"available": False, "reason": str(exc.detail)}


@app.post("/api/assistant/chat")
def assistant_chat(req: AssistantChatRequest, request: Request):
    default_sid = require_station(req.stationId)
    q = assistant.understand(req.text, default_sid)
    sid = q["station"]
    key = ("assistant", sid, " ".join(req.text.lower().split()), req.lang, *_explain_key(sid, ExplainRequest())[3:])
    now = time.time()
    with _explain_lock:
        hit = _explain_cache.get(key)
    if hit and now - hit[0] <= app_config.EXPLAIN_CACHE_S:
        return {**hit[1], "cached": True}

    ctx = _assistant_context(sid, request)
    llm = {"router": None, "explain": None}
    reason = None
    actions: list[dict] = []
    rejected: list[str] = []

    # 1. Unrecognised request: a small model maps it onto the whitelisted actions.
    if q["topic"] == "unknown":
        res = _llm("router", assistant.router_messages(req.text, ctx["station"]["name"], req.page),
                   tools=assistant.tool_schemas(sid), maxTokens=300)
        llm["router"] = bool(res.get("available"))
        if not res.get("available"):
            reason = res.get("reason")
        for call in res.get("toolCalls") or []:
            if call.get("name") == "answer_question":
                a = call.get("arguments") or {}
                if a.get("topic") in assistant.TOPICS:
                    q = {**q, "topic": a["topic"], "building": a.get("building") or q["building"],
                         "sensor": a.get("sensor") or q["sensor"]}
                    if a.get("station") in STATIONS and a["station"] != sid:
                        sid = a["station"]
                        q["station"] = sid
                        ctx = _assistant_context(sid, request)
                continue
            try:
                actions.append(assistant.validate_action(call.get("name"), call.get("arguments"), sid))
            except assistant.InvalidAction as exc:
                log.info("Assistant: rejected tool call: %s", exc)
                rejected.append(str(exc))
        if q["topic"] in ("depends", "why_building") and not q.get("building"):
            q = {**q, "topic": "unknown"}

    draft = assistant.local_answer(q, ctx)
    answer = {"spoken": draft["spoken"], "detail": draft["detail"]}
    mode = "local"

    # 2. Explanations (not plain lookups) are phrased by the explanation model, then checked.
    explain = (q["topic"] not in _ASSISTANT_LOOKUPS or req.lang == "hi") and not (q["topic"] == "unknown" and actions)
    grounding = None
    if explain and q["topic"] != "unknown":
        res = _llm("explain", assistant.explain_messages(ctx, req.text, draft, req.lang), maxTokens=700, json=True)
        llm["explain"] = bool(res.get("available"))
        if res.get("available"):
            parsed = assistant.parse_explanation(res.get("content", ""))
            if parsed:
                ok, bad = assistant.numbers_grounded(parsed["spoken"] + " " + " ".join(parsed["detail"]),
                                                     assistant.compact_for_llm(ctx), draft)
                grounding = {"ok": ok, "ungrounded": bad}
                refused = parsed["spoken"].startswith(assistant.NOT_IN_DATA) and not draft["spoken"].startswith(
                    assistant.NOT_IN_DATA)
                if ok and not refused:
                    answer, mode = parsed, "llm"
                elif refused:
                    log.info("Assistant: LLM said the data has no answer, but the data answer exists; using it")
                else:
                    log.info("Assistant: LLM reply quoted numbers not in the context %s; using the data answer", bad)
            else:
                log.info("Assistant: explanation model returned no usable JSON; using the data answer")
        else:
            reason = reason or res.get("reason")

    if not actions:
        actions = [assistant.validate_action(a["type"], a["args"], sid) for a in draft["actions"]]
    elif q["topic"] == "unknown":
        answer = {"spoken": "", "detail": []}      # the browser announces the actions it runs
    llm_used = any(v for v in llm.values())
    llm_failed = any(v is False for v in llm.values())
    out = {
        "station": sid, "topic": q["topic"], "spoken": answer["spoken"], "detail": answer["detail"],
        "actions": actions, "mode": mode, "sources": draft["sources"],
        "llm": llm, "grounding": grounding, "rejectedActions": rejected,
        "notice": None if (llm_used and not llm_failed) or not (explain or q["topic"] == "unknown")
        else ASSISTANT_NOTICE_OFFLINE,
        "reason": reason if llm_failed else None,
        "replayTime": ctx.get("replayTime"),
    }
    if mode == "llm" or not llm_failed:
        with _explain_lock:
            _explain_cache[key] = (time.time(), out)
    return out


if __name__ == "__main__":
    import uvicorn

    # Checked here as well as in the lifespan, so the CLI path prints just the problem and
    # exits instead of burying it in a startup traceback. The lifespan check stays as the
    # backstop for anything that imports `app` directly (gunicorn, uvicorn --factory, …).
    _errors = app_config.production_config_errors()
    if _errors and app_config.APP_ENV == "production":
        print("Refusing to start with APP_ENV=production:", file=sys.stderr)
        for _e in _errors:
            print(f"  - {_e}", file=sys.stderr)
        print("\nSee docs/DEPLOYMENT.md for the required variables.", file=sys.stderr)
        raise SystemExit(1)

    # log_config=None: uvicorn's loggers propagate to the root handler configured in config.py,
    # so every service line has the same format and honours LOG_LEVEL.
    uvicorn.run(app, host=app_config.HOST, port=app_config.API_PORT, log_config=None,
                log_level=app_config.LOG_LEVEL.lower())

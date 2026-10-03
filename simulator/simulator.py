"""
Aurora v3 — Sensor Simulator (Dual Station, Physics-Based)
Feeds BOTH Maitri and Bharati to the unified FastAPI backend (POST /api/sensors/batch).

MODES:
  🟢 REANALYSIS — ERA5 weather → physics thermal/power model → model-derived equipment state
  🔵 SIMULATION — Random walk with organic weather patterns (Developer/Test Mode)

Each station runs independently. Manual injection works in both modes.
Internal Flask control API on SIM_PORT (default 8001); the browser never calls it.
"""

import collections
import json
import logging
import math
import os
import random
import threading
import time
from datetime import datetime

import requests
from flask import Flask, jsonify
from flask import request as flask_request
from flask_cors import CORS

import config as app_config  # aliased: 'config' is a loop variable in this module
import station_config
from config import ALLOWED_ORIGINS, HOST
from decision_scheduler import DecisionScheduler
from physics_model import StationPhysicsModel, energy_summary
from twin_inspector import build_twin_inspector

# Import new Phase 1/2 modules
from weather_data import WeatherDataLayer, sim_hours_per_real_minute

log = logging.getLogger("aurora.simulator")

# Phase 3: Anomaly detection
try:
    from anomaly_engine import AnomalyDetector, extract_features
    ANOMALY_AVAILABLE = True
except ImportError:
    ANOMALY_AVAILABLE = False
    logging.getLogger("aurora.simulator").warning("Anomaly engine unavailable (import failed)", exc_info=True)

# Phase 4: Forecast engine
try:
    from forecast_engine import ForecastEngine
    FORECAST_AVAILABLE = True
except ImportError:
    FORECAST_AVAILABLE = False
    logging.getLogger("aurora.simulator").warning("Forecast engine unavailable (import failed)", exc_info=True)

# Phase 5: Decision engine
try:
    from decision_engine import DecisionEngine
    DECISION_AVAILABLE = True
except ImportError:
    DECISION_AVAILABLE = False
    logging.getLogger("aurora.simulator").warning("Decision engine unavailable (import failed)", exc_info=True)

# Phase 6: Genuine Chronos forecaster (optional — requires torch + chronos-forecasting).
# Only "available" if torch AND chronos actually import (B11).
try:
    from chronos_forecaster import GenuineChronosForecaster, chronos_available
    CHRONOS_AVAILABLE = chronos_available()
except ImportError:
    CHRONOS_AVAILABLE = False
    logging.getLogger("aurora.simulator").info(
        "Chronos forecaster module not importable; Chronos disabled", exc_info=True)
if CHRONOS_AVAILABLE:
    log.info("Chronos available (torch + chronos-forecasting installed)")
else:
    log.info("Chronos unavailable (optional ML extras not installed: pip install -r simulator/requirements-ml.txt)")

# ── Backend endpoint & ports (from config.py / root .env) ─────
BACKEND_URL = f"{app_config.BACKEND_URL}/api/sensors/batch"
# /api/sensors/batch is write-protected like every other state-changing route, so the
# simulator authenticates with the same ADMIN_TOKEN from the shared root .env. Unset
# means no protection, and the header is simply omitted.
BATCH_HEADERS = {"Content-Type": "application/json"}
if app_config.ADMIN_TOKEN:
    BATCH_HEADERS["X-Admin-Token"] = app_config.ADMIN_TOKEN
TICK_INTERVAL = 2.0  # seconds
CONTROL_PORT = app_config.SIM_PORT

# ── Default mode and replay settings (config.py) ─────────────
# AURORA_DATE defaults to the latest date present in weather_cache/,
# so startup does not need the network. /mode can override at runtime.
DEFAULT_MODE = app_config.AURORA_MODE    # "reanalysis" or "simulation"
DEFAULT_DATE = app_config.AURORA_DATE    # YYYY-MM-DD for replay
DEFAULT_SPEED = app_config.AURORA_SPEED  # 120x = 2 simulated hours per real minute


# ═══════════════════════════════════════════════════════════════
#  Station-Specific Sensor Profiles (for SIMULATION mode only)
# ═══════════════════════════════════════════════════════════════

STATION_PROFILES = {
    "maitri": {
        "name": station_config.meta_value("maitri", "name"),
        "sensors": {
            "generator": {
                "gen_power":     {"nominal": 160, "step": 2.0,   "min": 0,    "max": 200,  "unit": "kW"},
                "gen_fuel_rate": {"nominal": 28,  "step": 0.5,   "min": 0,    "max": 50,   "unit": "L/hr"},
                "gen_rpm":       {"nominal": 1500,"step": 10.0,  "min": 0,    "max": 2000, "unit": "rpm"},
                "gen_temp":      {"nominal": 82,  "step": 0.5,   "min": 0,    "max": 120,  "unit": "°C"},
            },
            "heating": {
                "heat_a_flow":     {"nominal": 35,  "step": 0.3, "min": 0,  "max": 50,  "unit": "L/min"},
                "heat_a_temp":     {"nominal": 72,  "step": 0.4, "min": 0,  "max": 90,  "unit": "°C"},
                "heat_a_pressure": {"nominal": 3.2, "step": 0.05,"min": 0,  "max": 6,   "unit": "bar"},
            },
            "heatingB": {
                "heat_b_flow": {"nominal": 28, "step": 0.3, "min": 0, "max": 40, "unit": "L/min"},
                "heat_b_temp": {"nominal": 68, "step": 0.4, "min": 0, "max": 90, "unit": "°C"},
            },
            "waterTank": {
                "water_level": {"nominal": 78,  "step": 0.2,  "min": 0, "max": 100, "unit": "%"},
                "water_temp":  {"nominal": 12,  "step": 0.2,  "min": 0, "max": 30,  "unit": "°C"},
                "water_ph":    {"nominal": 7.1, "step": 0.02, "min": 5, "max": 9,   "unit": "pH"},
            },
            "commsMast": {
                "comms_signal":    {"nominal": -42, "step": 1.0,  "min": -120, "max": 0,   "unit": "dBm"},
                "comms_bandwidth": {"nominal": 2.4, "step": 0.1,  "min": 0,    "max": 10,  "unit": "Mbps"},
                "comms_uptime":    {"nominal": 99.2,"step": 0.05, "min": 0,    "max": 100, "unit": "%"},
            },
            "livingQuarters": {
                "lq_temp":     {"nominal": 21,  "step": 0.2, "min": 10, "max": 30,   "unit": "°C"},
                "lq_humidity": {"nominal": 42,  "step": 0.5, "min": 10, "max": 80,   "unit": "%"},
                "lq_co2":      {"nominal": 620, "step": 5.0, "min": 300,"max": 2000, "unit": "ppm"},
            },
            "storage": {
                "store_fuel":   {"nominal": 142, "step": 0.1,  "min": 0, "max": 200, "unit": "kL"},
                "store_food":   {"nominal": 186, "step": 0.08, "min": 0, "max": 365, "unit": "days"},
                "store_spares": {"nominal": 312, "step": 0.05, "min": 0, "max": 500, "unit": "items"},
            },
            "lab": {
                "env_temp":     {"nominal": -33, "step": 0.3, "min": -60, "max": 5,    "unit": "°C"},
                "env_wind":     {"nominal": 35,  "step": 1.5, "min": 0,   "max": 200,  "unit": "km/h"},
                "env_pressure": {"nominal": 986, "step": 0.3, "min": 940, "max": 1040, "unit": "hPa"},
                "env_humidity": {"nominal": 55,  "step": 0.5, "min": 10,  "max": 100,  "unit": "%"},
            },
        },
    },
    "bharati": {
        "name": station_config.meta_value("bharati", "name"),
        "sensors": {
            "generator": {
                "gen_power":     {"nominal": 172, "step": 2.0,   "min": 0,    "max": 220,  "unit": "kW"},
                "gen_fuel_rate": {"nominal": 32,  "step": 0.5,   "min": 0,    "max": 55,   "unit": "L/hr"},
                "gen_rpm":       {"nominal": 1520,"step": 10.0,  "min": 0,    "max": 2000, "unit": "rpm"},
                "gen_temp":      {"nominal": 78,  "step": 0.5,   "min": 0,    "max": 120,  "unit": "°C"},
            },
            "heating": {
                "heat_a_flow":     {"nominal": 38,  "step": 0.3, "min": 0,  "max": 55,  "unit": "L/min"},
                "heat_a_temp":     {"nominal": 74,  "step": 0.4, "min": 0,  "max": 90,  "unit": "°C"},
                "heat_a_pressure": {"nominal": 3.4, "step": 0.05,"min": 0,  "max": 6,   "unit": "bar"},
            },
            "heatingB": {
                "heat_b_flow": {"nominal": 30, "step": 0.3, "min": 0, "max": 45, "unit": "L/min"},
                "heat_b_temp": {"nominal": 70, "step": 0.4, "min": 0, "max": 90, "unit": "°C"},
            },
            "waterTank": {
                "water_level": {"nominal": 82,  "step": 0.2,  "min": 0, "max": 100, "unit": "%"},
                "water_temp":  {"nominal": 14,  "step": 0.2,  "min": 0, "max": 30,  "unit": "°C"},
                "water_ph":    {"nominal": 7.0, "step": 0.02, "min": 5, "max": 9,   "unit": "pH"},
            },
            "commsMast": {
                "comms_signal":    {"nominal": -38, "step": 1.0,  "min": -120, "max": 0,   "unit": "dBm"},
                "comms_bandwidth": {"nominal": 3.1, "step": 0.1,  "min": 0,    "max": 10,  "unit": "Mbps"},
                "comms_uptime":    {"nominal": 99.5,"step": 0.05, "min": 0,    "max": 100, "unit": "%"},
            },
            "livingQuarters": {
                "lq_temp":     {"nominal": 22,  "step": 0.2, "min": 10, "max": 30,   "unit": "°C"},
                "lq_humidity": {"nominal": 40,  "step": 0.5, "min": 10, "max": 80,   "unit": "%"},
                "lq_co2":      {"nominal": 580, "step": 5.0, "min": 300,"max": 2000, "unit": "ppm"},
            },
            "storage": {
                "store_fuel":   {"nominal": 154, "step": 0.1,  "min": 0, "max": 220, "unit": "kL"},
                "store_food":   {"nominal": 210, "step": 0.08, "min": 0, "max": 365, "unit": "days"},
                "store_spares": {"nominal": 380, "step": 0.05, "min": 0, "max": 550, "unit": "items"},
            },
            "lab": {
                "env_temp":     {"nominal": -25, "step": 0.3, "min": -55, "max": 5,    "unit": "°C"},
                "env_wind":     {"nominal": 28,  "step": 1.5, "min": 0,   "max": 180,  "unit": "km/h"},
                "env_pressure": {"nominal": 998, "step": 0.3, "min": 940, "max": 1040, "unit": "hPa"},
                "env_humidity": {"nominal": 48,  "step": 0.5, "min": 10,  "max": 100,  "unit": "%"},
            },
        },
    },
}

# ── Pre-defined anomaly scenarios ────────────────────────────
SCENARIOS = {
    "generator_failure": {
        "name": "Generator Failure",
        "description": ("Overrides generator power, speed and coolant toward fault values. Downstream "
                        "buildings are flagged as cascade risks by the alert rules; their readings are "
                        "not changed."),
        "duration": 30,
        "injections": {
            "generator.gen_power": 25.0,
            "generator.gen_rpm": 600.0,
            "generator.gen_temp": 108.0,
        },
    },
    "heating_failure": {
        "name": "Heating System Failure",
        "description": ("Overrides Heating Zone A supply temperature and flow, and the living-quarters "
                        "temperature, toward fault values."),
        "duration": 25,
        "injections": {
            "heating.heat_a_temp": 32.0,
            "heating.heat_a_flow": 8.0,
            "livingQuarters.lq_temp": 13.0,
        },
    },
    "blizzard": {
        "name": "Blizzard Event",
        "description": ("Overrides outside wind and temperature and the comms signal toward storm values. "
                        "The physics model does not see injected weather, so heating demand is not "
                        "recomputed."),
        "duration": 40,
        "injections": {
            "lab.env_wind": 145.0,
            "lab.env_temp": -48.0,
            "commsMast.comms_signal": -95.0,
        },
    },
    "water_crisis": {
        "name": "Water System Alert",
        "description": "Overrides the water-tank level and pH toward fault values.",
        "duration": 20,
        "injections": {
            "waterTank.water_level": 8.0,
            "waterTank.water_ph": 5.4,
        },
    },
    "co2_spike": {
        "name": "CO2 Spike",
        "description": "Overrides living-quarters CO2 and humidity toward a ventilation-failure level.",
        "duration": 20,
        "injections": {
            "livingQuarters.lq_co2": 1600.0,
            "livingQuarters.lq_humidity": 72.0,
        },
    },
}

# ── Organic weather patterns (SIMULATION mode only) ──────────
WEATHER_PATTERNS = {
    "cold_snap": {
        "name": "Cold Snap", "probability": 0.003,
        "duration_range": (30, 60),
        "effects": {
            "lab.env_temp": {"drift": -0.8, "volatility": 1.5},
            "lab.env_wind": {"drift": 0.5, "volatility": 2},
            "lab.env_pressure": {"drift": -0.4, "volatility": 0.5},
        },
    },
    "storm": {
        "name": "Blizzard", "probability": 0.002,
        "duration_range": (40, 80),
        "effects": {
            "lab.env_wind": {"drift": 2.0, "volatility": 4},
            "lab.env_temp": {"drift": -0.5, "volatility": 1},
            "commsMast.comms_signal": {"drift": -2, "volatility": 3},
        },
    },
    "warm_spell": {
        "name": "Warm Front", "probability": 0.002,
        "duration_range": (20, 50),
        "effects": {
            "lab.env_temp": {"drift": 0.6, "volatility": 1},
            "lab.env_pressure": {"drift": 0.3, "volatility": 0.4},
        },
    },
    "signal_interference": {
        "name": "Signal Interference", "probability": 0.0015,
        "duration_range": (20, 40),
        "effects": {
            "commsMast.comms_signal": {"drift": -3, "volatility": 5},
            "commsMast.comms_bandwidth": {"drift": -0.15, "volatility": 0.2},
        },
    },
    "equipment_stress": {
        "name": "Equipment Stress", "probability": 0.001,
        "duration_range": (50, 100),
        "effects": {
            "generator.gen_temp": {"drift": 0.3, "volatility": 0.8},
            "generator.gen_rpm": {"drift": -3, "volatility": 5},
        },
    },
}

# ── Cascade Rules (SIMULATION mode only) ─────────────────────
CASCADE_RULES = [
    {"trigger": "lab.env_temp", "threshold_below": -40,
     "nudges": [("heating.heat_a_flow", 0.3), ("heatingB.heat_b_flow", 0.2),
                ("generator.gen_power", 0.5), ("generator.gen_fuel_rate", 0.15),
                ("generator.gen_temp", 0.1)]},
    {"trigger": "lab.env_temp", "threshold_below": -35,
     "nudges": [("heating.heat_a_flow", 0.15), ("generator.gen_power", 0.3)]},
    {"trigger": "generator.gen_power", "threshold_below": 80,
     "nudges": [("heating.heat_a_temp", -0.5), ("heatingB.heat_b_temp", -0.4),
                ("livingQuarters.lq_temp", -0.3), ("commsMast.comms_signal", -1)]},
    {"trigger": "generator.gen_temp", "threshold_above": 95,
     "nudges": [("generator.gen_rpm", -5), ("generator.gen_power", -1)]},
    {"trigger": "lab.env_wind", "threshold_above": 80,
     "nudges": [("commsMast.comms_signal", -1.5), ("commsMast.comms_bandwidth", -0.05)]},
]


# ═══════════════════════════════════════════════════════════════
#  StationSimulator — Unified for both modes
# ═══════════════════════════════════════════════════════════════

class StationSimulator:
    """
    Independent simulation state for a single station.
    Supports two modes:
      - 'reanalysis': ERA5 weather + physics model
      - 'simulation': Random walk + organic patterns (legacy)
    """

    def __init__(self, station_id: str, mode: str = "reanalysis",
                 date: str = None, speed_factor: float = 120):
        self.station_id = station_id
        self.mode = mode
        self.profile = STATION_PROFILES[station_id]
        self.sensors = self.profile["sensors"]
        self.values = {}  # Current sensor values (flat)
        self.tick_count = 0
        self.active_injections = {}
        self.active_scenario = None
        self.active_patterns = []
        self.event_log = []

        # ── Phase 1/2 modules (reanalysis mode) ──────────────
        self.weather_layer = None
        self.physics_model = None
        self.weather_available = False
        self.anomaly_detector = None
        self._last_anomaly = {"anomaly_score": 0, "is_anomaly": False, "evidence": []}

        if mode == "reanalysis":
            try:
                self.weather_layer = WeatherDataLayer(
                    station_id, date=date, speed_factor=speed_factor
                )
                self.weather_available = self.weather_layer.fetch_and_cache()
                if self.weather_available:
                    self.physics_model = StationPhysicsModel(station_id)
                    self.log_event("mode", "ERA5 reanalysis mode — physics digital twin active")
                else:
                    log.warning(f"[{station_id}] Weather data unavailable, falling back to simulation")
                    self.mode = "simulation"
            except Exception as e:
                log.warning(f"[{station_id}] Weather init failed: {e}, falling back to simulation")
                self.mode = "simulation"

        # ── Phase 3: Load trained anomaly model ──────────────
        if ANOMALY_AVAILABLE:
            model_path = str(app_config.anomaly_model_path(station_id))
            if os.path.exists(model_path):
                try:
                    self.anomaly_detector = AnomalyDetector(station_id)
                    self.anomaly_detector.load(model_path)
                    log.info(f"[{station_id}] Anomaly detector loaded")
                except Exception as e:
                    log.warning(f"[{station_id}] Anomaly model load failed: {e}")

        # ── Phase 4: Forecast engine ─────────────────────────
        self.forecast_engine = None
        self._last_forecast = None
        self._forecast_tick = 0  # only update forecast every N ticks
        if FORECAST_AVAILABLE:
            try:
                # Reanalysis mode replays a PAST date → live forecast is not time-aligned
                self.forecast_engine = ForecastEngine(station_id, replay_mode=(self.mode == "reanalysis"))
                if self.forecast_engine.initialize():
                    log.info(f"[{station_id}] Forecast engine initialized")
                else:
                    log.warning(f"[{station_id}] Forecast weather unavailable")
            except Exception as e:
                log.warning(f"[{station_id}] Forecast init failed: {e}")

        # ── Phase 5: Decision engine ─────────────────────────
        self.decision_engine = None
        self._last_decision = None      # published decision (+ recentlyResolved)
        self._base_decision = None      # last evaluated decision
        self._decision_scheduler = DecisionScheduler(TICK_INTERVAL)
        if DECISION_AVAILABLE:
            try:
                self.decision_engine = DecisionEngine(station_id)
                log.info(f"[{station_id}] Decision engine initialized")
            except Exception as e:
                log.warning(f"[{station_id}] Decision engine init failed: {e}")

        # ── Phase 6: Genuine Chronos forecaster (shared instance) ─
        self._chronos_forecaster = None
        if CHRONOS_AVAILABLE:
            try:
                # Shared singleton: one model in memory, per-station buffers + locks
                if not hasattr(StationSimulator, '_shared_chronos'):
                    StationSimulator._shared_chronos = GenuineChronosForecaster()
                self._chronos_forecaster = StationSimulator._shared_chronos
                log.info(f"[{station_id}] Genuine Chronos forecaster attached")
            except Exception as e:
                log.warning("[%s] Chronos init failed: %s", station_id, e)

        # Initialize values for simulation mode
        for building_id, sensors in self.sensors.items():
            self.values[building_id] = {}
            for sensor_id, config in sensors.items():
                jitter = (random.random() - 0.5) * config["step"] * 4
                initial = max(config["min"], min(config["max"],
                              config["nominal"] + jitter))
                self.values[building_id][sensor_id] = initial

    def _log_stage_error(self, stage: str):
        """Log a tick-stage failure with traceback, once per stage per station
        (subsequent repeats are counted, not re-logged, to avoid log floods)."""
        counts = self.__dict__.setdefault("_stage_errors", {})
        counts[stage] = counts.get(stage, 0) + 1
        if counts[stage] == 1:
            log.exception("[%s] %s stage failed (further repeats suppressed)", self.station_id, stage)

    def log_event(self, event_type: str, message: str):
        self.event_log.append({
            "type": event_type,
            "message": message,
            "timestamp": int(time.time() * 1000),
            "tick": self.tick_count,
        })
        if len(self.event_log) > 100:
            self.event_log.pop(0)

    def tick(self) -> dict:
        """Execute one simulation tick. Returns readings for the backend."""
        self.tick_count += 1
        self._last_energy = None   # set only by a tick that ran the physics model
        self._last_replay = None   # replay clock of this tick (reanalysis mode only)

        if self.mode == "reanalysis" and self.weather_available:
            return self._tick_reanalysis()
        else:
            return self._tick_simulation()

    def _tick_reanalysis(self) -> dict:
        """
        REANALYSIS MODE:
        Weather from cached ERA5 → physics model → model-derived equipment.
        Injections override specific values.
        """
        # 1. Get interpolated weather from cached ERA5 data
        weather = self.weather_layer.get_current_weather()
        if weather is None:
            return self._tick_simulation()  # Fallback

        # 2. Run physics model
        physics_readings = self.physics_model.compute(weather, dt_seconds=TICK_INTERVAL)

        # 3. Clean expired injections
        expired = [k for k, v in self.active_injections.items() if self.tick_count > v[1]]
        for k in expired:
            del self.active_injections[k]
        if expired and not self.active_injections:
            self.active_scenario = None

        # 4. Convert physics output to backend format + apply injections
        readings = {}
        meta = physics_readings.pop("_meta", {})

        for building_id, sensors in physics_readings.items():
            readings[building_id] = {}
            for sensor_id, sensor_data in sensors.items():
                key = f"{building_id}.{sensor_id}"
                value = sensor_data["value"]

                # Apply injection override
                if key in self.active_injections:
                    target, _ = self.active_injections[key]
                    current = self.values.get(building_id, {}).get(sensor_id, value)
                    value = current + (target - current) * 0.3
                    sensor_data = {**sensor_data, "sourceType": "synthetic"}

                # Store current value
                if building_id not in self.values:
                    self.values[building_id] = {}
                self.values[building_id][sensor_id] = value

                readings[building_id][sensor_id] = {
                    "value": round(value, 2),
                    "unit": sensor_data["unit"],
                }

        # 5. Store metadata for logging
        self._last_meta = meta
        self._last_energy = energy_summary(meta)
        self._last_replay = {
            "timeMs": weather.get("simulated_time_ms"),
            "local": weather.get("simulated_time"),
            "speedFactor": self.weather_layer.speed_factor,
            "loop": weather.get("replay_loop"),
            "utcOffsetSource": weather.get("utc_offset_source"),
            "windFromDeg": weather.get("wind_direction"),   # ERA5 10 m, degrees FROM (reanalysis)
        }
        self._last_weather = weather

        # 6. Phase 3: Anomaly detection (scored every tick)
        if self.anomaly_detector and ANOMALY_AVAILABLE:
            try:
                # Observed (post-injection) vs the physics prediction for this tick
                features = extract_features(weather, self.values, meta, station_id=self.station_id,
                                            predicted=physics_readings)
                self._last_anomaly = self.anomaly_detector.score(features)
            except Exception:
                self._log_stage_error("anomaly")  # never break the main loop

        # 7. Phase 4: Update forecast every 30 ticks (~1 minute)
        if (self.forecast_engine and self.physics_model
                and self.tick_count % 30 == 0):
            try:
                self._last_forecast = self.forecast_engine.predict(
                    self.physics_model, weather, self._last_anomaly
                )
            except Exception:
                self._log_stage_error("forecast")

        # 8. Phase 5: Decision engine — event-driven (decision_scheduler.py):
        #    anomaly flip / injection start-end / input risk change, 2 s debounce,
        #    60 s periodic fallback, "recently resolved" hold after it clears.
        if self.decision_engine:
            forecast_risk = ((self._last_forecast or {}).get("risk") or {}).get("level")
            evaluate, reasons = self._decision_scheduler.should_evaluate(
                self.tick_count, bool(self._last_anomaly.get("is_anomaly")),
                self.active_injections.keys(), forecast_risk)
            if evaluate:
                try:
                    current_state = {
                        "weather": weather,
                        "generator": self.values.get("generator", {}),
                        "meta": meta,
                    }
                    self._base_decision = self.decision_engine.evaluate(
                        current_state, self._last_anomaly, self._last_forecast
                    )
                    self._last_decision = self._decision_scheduler.record(
                        self.tick_count, self._base_decision, reasons)
                except Exception:
                    self._log_stage_error("decision")
            elif self._base_decision is not None:
                self._last_decision = self._decision_scheduler.publishable(
                    self.tick_count, self._decision_scheduler.last_evaluated)

        # 9. Phase 6: Genuine Chronos — append telemetry every tick,
        #    run forecast async every 150 ticks (~5 minutes)
        if self._chronos_forecaster is not None:
            try:
                self._chronos_forecaster.append_telemetry(
                    self.station_id, self.values, meta
                )
                if self.tick_count % 150 == 0:
                    self._chronos_forecaster.run_forecast_async(self.station_id)
            except Exception:
                self._log_stage_error("chronos")  # never break the main loop

        return readings

    def _tick_simulation(self) -> dict:
        """
        SIMULATION MODE (legacy):
        Random walk + organic weather patterns + cascade rules.
        """
        readings = {}

        # 1. Organic weather patterns
        for pattern_id, pattern in WEATHER_PATTERNS.items():
            if any(p["id"] == pattern_id for p in self.active_patterns):
                continue
            if random.random() < pattern["probability"]:
                lo, hi = pattern["duration_range"]
                duration = lo + random.random() * (hi - lo)
                self.active_patterns.append({
                    "id": pattern_id, "name": pattern["name"],
                    "effects": pattern["effects"],
                    "ticks_remaining": int(duration),
                })
                self.log_event("pattern_start", f"{pattern['name']} developing")
                log.info(f"[{self.station_id}] Weather: {pattern['name']} starting ({int(duration)} ticks)")

        # 2. Clean expired injections
        expired = [k for k, v in self.active_injections.items() if self.tick_count > v[1]]
        for k in expired:
            del self.active_injections[k]
        if expired and not self.active_injections:
            self.active_scenario = None

        # 3. Tick all sensors
        for building_id, sensors in self.sensors.items():
            readings[building_id] = {}
            for sensor_id, config in sensors.items():
                current = self.values[building_id][sensor_id]
                key = f"{building_id}.{sensor_id}"

                if key in self.active_injections:
                    target, _ = self.active_injections[key]
                    next_val = current + (target - current) * 0.3
                else:
                    mean_reversion = (config["nominal"] - current) * 0.02
                    noise = (random.random() - 0.5) * 2 * config["step"]
                    trend = 0
                    if sensor_id.startswith("env_"):
                        cycle = math.sin(self.tick_count * 0.05)
                        trend = cycle * config["step"] * 0.5
                    if sensor_id.startswith("store_"):
                        trend = -config["step"] * 0.1

                    for pattern in self.active_patterns:
                        effect = pattern["effects"].get(key)
                        if effect:
                            trend += effect["drift"] + (random.random() - 0.5) * effect["volatility"]

                    next_val = current + mean_reversion + noise + trend

                next_val = max(config["min"], min(config["max"], next_val))
                next_val = round(next_val, 2)
                self.values[building_id][sensor_id] = next_val
                readings[building_id][sensor_id] = {"value": next_val, "unit": config["unit"]}

        # 4. Cascade rules
        for rule in CASCADE_RULES:
            b_id, s_id = rule["trigger"].split(".")
            if b_id in self.values and s_id in self.values[b_id]:
                val = self.values[b_id][s_id]
                triggered = False
                if "threshold_below" in rule and val < rule["threshold_below"]:
                    triggered = True
                if "threshold_above" in rule and val > rule["threshold_above"]:
                    triggered = True
                if triggered:
                    for target_key, nudge in rule["nudges"]:
                        tb, ts = target_key.split(".")
                        if tb in self.values and ts in self.values[tb]:
                            cfg = self.sensors.get(tb, {}).get(ts, {})
                            v = self.values[tb][ts] + nudge
                            v = max(cfg.get("min", v), min(cfg.get("max", v), v))
                            self.values[tb][ts] = round(v, 2)

        # 5. Expire weather patterns
        for i in range(len(self.active_patterns) - 1, -1, -1):
            self.active_patterns[i]["ticks_remaining"] -= 1
            if self.active_patterns[i]["ticks_remaining"] <= 0:
                name = self.active_patterns[i]["name"]
                self.log_event("pattern_end", f"{name} subsiding")
                log.info(f"[{self.station_id}] Weather: {name} ended")
                self.active_patterns.pop(i)

        return readings

    def inject_scenario(self, scenario_id: str, duration_s: float | None = None, source: str = "team") -> dict:
        scenario = SCENARIOS.get(scenario_id)
        if not scenario:
            return {"error": f"Unknown scenario: {scenario_id}"}

        duration = scenario["duration"] if duration_s is None else duration_s
        duration_ticks = int(duration / TICK_INTERVAL)
        expiry = self.tick_count + duration_ticks
        self.active_scenario = scenario_id

        for key, target in scenario["injections"].items():
            self.active_injections[key] = (target, expiry)

        by = " (public demo, started by a visitor)" if source == "public-demo" else ""
        self.log_event("injection", f"Scenario: {scenario['name']}{by}, {int(duration)} s")
        log.info(f"[{self.station_id}] SCENARIO: {scenario['name']} ({duration:g}s){by}")
        return {
            "scenario": scenario_id, "name": scenario["name"],
            "station": self.station_id, "duration": duration, "source": source,
        }

    def inject_single(self, building_id, sensor_id, target, duration=20):
        key = f"{building_id}.{sensor_id}"
        if building_id in self.values and sensor_id in self.values[building_id]:
            expiry = self.tick_count + int(duration / TICK_INTERVAL)
            self.active_injections[key] = (target, expiry)
            return {"injected": key, "target": target, "station": self.station_id}
        return {"error": f"Sensor not found: {key}"}

    def reset(self, reason: str | None = None):
        self.active_injections.clear()
        self.active_scenario = None
        self.active_patterns.clear()
        for building_id, sensors in self.sensors.items():
            for sensor_id, config in sensors.items():
                self.values[building_id][sensor_id] = config["nominal"]
        if self.physics_model:
            self.physics_model = StationPhysicsModel(self.station_id)
        self.log_event("reset", f"All sensors reset to nominal{f' ({reason})' if reason else ''}")
        return {"status": "reset", "station": self.station_id}

    def get_data_source_info(self) -> dict:
        """Return metadata about the current data source for UI display."""
        if self.mode == "reanalysis" and self.weather_available:
            progress = self.weather_layer.get_replay_progress()
            weather = getattr(self, '_last_weather', None)
            return {
                "mode": "reanalysis",
                "label": "ERA5 Reanalysis + Physics Model",
                "sourceType": "reanalysis",
                "dataset": "ERA5 (ECMWF)",
                "replay": progress,
                "simulatedTime": weather.get("simulated_time") if weather else None,
            }
        else:
            return {
                "mode": "simulation",
                "label": "Developer/Test Mode (Synthetic)",
                "sourceType": "synthetic",
            }


# ── Global station simulators ────────────────────────────────
# `stations_lock` is shared by the tick loop and every endpoint that mutates or
# replaces simulators (/inject, /inject-single, /reset, /mode). The tick holds it
# while ticking (not while POSTing), so a /mode rebuild or an injection can never
# interleave with a tick (item 10: /mode race).
stations_lock = threading.RLock()
stations = {
    "maitri": StationSimulator("maitri", mode=DEFAULT_MODE,
                                date=DEFAULT_DATE, speed_factor=DEFAULT_SPEED),
    "bharati": StationSimulator("bharati", mode=DEFAULT_MODE,
                                 date=DEFAULT_DATE, speed_factor=DEFAULT_SPEED),
}


# ── Flask Control API ────────────────────────────────────────
control_app = Flask(__name__)
CORS(control_app, origins=ALLOWED_ORIGINS, supports_credentials=False)


class RequestError(Exception):
    """Client error from a control route → JSON {error, detail} with the given status."""

    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


@control_app.errorhandler(RequestError)
def _request_error(e: RequestError):
    return jsonify({"error": "bad request" if e.status != 404 else "not found", "detail": e.detail}), e.status


def _get_station(raw):
    """Unknown station → 404 (never silently fall back to Maitri)."""
    sid = str(raw if raw is not None else "maitri").strip().lower()
    sim = stations.get(sid)
    if sim is None:
        raise RequestError(404, f"Unknown station '{raw}'. Valid stations: {', '.join(stations)}")
    return sim


@control_app.route("/scenarios", methods=["GET"])
def list_scenarios():
    result = {}
    for sid, s in SCENARIOS.items():
        result[sid] = {
            "name": s["name"], "description": s["description"],
            "duration": s["duration"],
            "affectedSensors": list(s["injections"].keys()),
            # Target of each override; a value moves 30 % of the way there per tick.
            "targets": dict(s["injections"]),
        }
    station_id = flask_request.args.get("station", "maitri")
    sim = _get_station(station_id)
    return jsonify({
        "scenarios": result,
        "activeScenario": sim.active_scenario,
        "activeInjections": len(sim.active_injections),
        "activePatterns": [p["name"] for p in sim.active_patterns],
        "tickCount": sim.tick_count,
        "station": station_id,
        "dataSource": sim.get_data_source_info(),
    })


@control_app.route("/inject/<scenario_id>", methods=["POST"])
def inject_scenario(scenario_id):
    station_id = flask_request.args.get("station", "maitri")
    if scenario_id not in SCENARIOS:
        raise RequestError(404, f"Unknown scenario '{scenario_id}'. Known: {', '.join(SCENARIOS)}")
    duration = flask_request.args.get("duration")
    if duration is not None:
        try:
            duration = float(duration)
        except ValueError as exc:
            raise RequestError(422, "duration must be a number of seconds") from exc
        if not (math.isfinite(duration) and 1 <= duration <= 600):
            raise RequestError(422, "duration must be 1–600 s")
    source = "public-demo" if flask_request.args.get("source") == "public-demo" else "team"
    with stations_lock:
        sim = _get_station(station_id)
        result = sim.inject_scenario(scenario_id, duration, source)
    return jsonify(result)


@control_app.route("/inject-single", methods=["POST"])
def inject_single():
    data = _json_body()
    station_id = data.get("stationId", "maitri")
    try:
        target = float(data.get("target", 0))
        duration = float(data.get("duration", 20))
    except (TypeError, ValueError) as exc:
        raise RequestError(422, "target and duration must be numbers") from exc
    if not (math.isfinite(target) and 1 <= duration <= 600):
        raise RequestError(422, "target must be finite and duration 1–600 s")
    with stations_lock:
        sim = _get_station(station_id)
        result = sim.inject_single(
            _clean_user_text(data.get("buildingId", ""), 40), _clean_user_text(data.get("sensorId", ""), 40),
            target, duration,
        )
    if "error" in result:
        raise RequestError(404, result["error"])
    return jsonify(result)


@control_app.route("/reset", methods=["POST"])
def reset():
    station_id = flask_request.args.get("station", "maitri")
    reasons = {"public-demo-auto": "public demo ended automatically",
               "public-demo": "public demo reset by a visitor", "nightly": "nightly reset"}
    reason = reasons.get(flask_request.args.get("source", ""))
    with stations_lock:
        sim = _get_station(station_id)
        result = sim.reset(reason)
    return jsonify(result)


@control_app.route("/api/twin-inspector", methods=["GET"])
def twin_inspector():
    """Digital Twin Inspector — full causal-chain breakdown (schema: twin_inspector.py)."""
    station_id = flask_request.args.get("station", "maitri")
    sim = _get_station(station_id)
    weather = getattr(sim, '_last_weather', None)
    reanalysis = sim.mode == "reanalysis"
    return jsonify(build_twin_inspector(
        station_id=station_id,
        mode=sim.mode,
        tick_count=sim.tick_count,
        values=sim.values,
        meta=getattr(sim, '_last_meta', {}),
        params=sim.physics_model.params if sim.physics_model else None,
        environment_source="ERA5 reanalysis (Open-Meteo)" if reanalysis else "Synthetic simulation",
        environment_source_type="reanalysis" if reanalysis else "synthetic",
        simulated_time=weather.get("simulated_time") if weather else None,
        data_source=sim.get_data_source_info(),
        telemetry_source="simulator",
    ))


@control_app.route("/api/anomaly", methods=["GET"])
def anomaly_status():
    """Phase 3: Anomaly detection status and evidence."""
    station_id = flask_request.args.get("station", "maitri")
    sim = _get_station(station_id)

    anomaly = getattr(sim, '_last_anomaly', {"anomaly_score": 0, "is_anomaly": False, "evidence": []})

    return jsonify({
        "stationId": station_id,
        "anomalyScore": anomaly.get("anomaly_score", 0),
        "scoreType": anomaly.get("scoreType", "isolation_forest_path_score"),
        "threshold": anomaly.get("threshold", 0.5),
        "isAnomaly": anomaly.get("is_anomaly", False),
        "evidence": anomaly.get("evidence", []),
        "candidateCauses": anomaly.get("candidateCauses", []),
        # v3: which rule fired ("isolation_forest" and/or "residual_z") + largest residual
        "triggeredBy": anomaly.get("triggeredBy", []),
        "residuals": anomaly.get("residuals", []),
        "maxResidualSigma": anomaly.get("maxResidualSigma"),
        "residualAlarmSigma": anomaly.get("residualAlarmSigma"),
        "detectorAvailable": sim.anomaly_detector is not None if hasattr(sim, 'anomaly_detector') else False,
    })


@control_app.route("/api/forecast", methods=["GET"])
def forecast_status():
    """Phase 4: Forecast predictions, risk, and recommendation."""
    station_id = flask_request.args.get("station", "maitri")
    sim = _get_station(station_id)

    forecast = getattr(sim, '_last_forecast', None)
    if forecast and forecast.get("available"):
        return jsonify(forecast)
    else:
        return jsonify({
            "available": False,
            "stationId": station_id,
            "reason": "Forecast not yet computed or weather unavailable",
        })


@control_app.route("/api/decision/evaluate", methods=["POST"])
def decision_evaluate():
    """Re-evaluate this station's decision on the next tick (debounced). Used by the assistant
    when an incident opens, so the risk it reports catches up with the alerts quickly."""
    station_id = flask_request.args.get("station", "maitri")
    sim = _get_station(station_id)
    sim._decision_scheduler.request("assistant_incident")
    return jsonify({"queued": True, "station": station_id})


@control_app.route("/api/decision", methods=["GET"])
def decision_status():
    """Phase 5: Decision engine output with audit trail."""
    station_id = flask_request.args.get("station", "maitri")
    sim = _get_station(station_id)

    decision = getattr(sim, '_last_decision', None)
    if decision:
        return jsonify(decision)
    else:
        return jsonify({
            "stationId": station_id,
            "event": {"type": "normal", "description": "Decision engine not yet computed"},
            "risk": {"level": "unknown"},
        })


@control_app.route("/api/chronos-forecast", methods=["GET"])
def chronos_forecast():
    """Phase 6: Genuine Chronos time-series forecast (independent of physics)."""
    station_id = flask_request.args.get("station", "maitri")
    sim = _get_station(station_id)

    if not CHRONOS_AVAILABLE:
        return jsonify({
            "available": False,
            "reason": "Chronos unavailable (optional ML extras not installed)",
        })

    forecaster = getattr(sim, '_chronos_forecaster', None)
    if forecaster is None:
        return jsonify({
            "available": False,
            "reason": "Chronos forecaster not initialized",
        })

    return jsonify(forecaster.get_cached_forecast(station_id))


@control_app.route("/api/chronos-status", methods=["GET"])
def chronos_status():
    """Phase 6: Chronos forecaster status and buffer info."""
    if not CHRONOS_AVAILABLE:
        return jsonify({
            "chronos_available": False,
            "model_loaded": False,
            "reason": "Chronos unavailable (optional ML extras not installed)",
        })

    # Get the shared forecaster from any station
    for sim in stations.values():
        forecaster = getattr(sim, '_chronos_forecaster', None)
        if forecaster:
            return jsonify(forecaster.status())

    return jsonify({"chronos_available": True, "initialized": False})


@control_app.route("/mode", methods=["POST"])
def set_mode():
    """Switch simulation mode at runtime."""
    data = _json_body()
    new_mode = data.get("mode", "reanalysis")
    date = data.get("date", None)
    if new_mode not in ("reanalysis", "simulation"):
        raise RequestError(422, "mode must be 'reanalysis' or 'simulation'")
    if date is not None:
        try:
            datetime.strptime(str(date), "%Y-%m-%d")
        except ValueError as exc:
            raise RequestError(422, "date must be YYYY-MM-DD") from exc
    try:
        speed = float(data.get("speed", 120))
    except (TypeError, ValueError) as exc:
        raise RequestError(422, "speed must be a number") from exc
    if not (1.0 <= speed <= 3600.0):
        raise RequestError(422, "speed must be between 1 and 3600")

    # Build replacements OUTSIDE the lock (may download weather), then swap
    # atomically under the lock shared with the tick loop.
    rebuilt = {
        sid: StationSimulator(sid, mode=new_mode, date=date, speed_factor=speed)
        for sid in list(stations.keys())
    }
    with stations_lock:
        stations.update(rebuilt)

    return jsonify({
        "status": "ok",
        "mode": new_mode,
        "date": date,
        "speed": speed,
        "stations": list(stations.keys()),
    })


@control_app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "status": "UP",
        "service": "aurora-simulator-v3-physics",
        "stations": {
            sid: {
                "tickCount": s.tick_count,
                "mode": s.mode,
                "activeScenario": s.active_scenario,
                "activeInjections": len(s.active_injections),
                "activePatterns": [p["name"] for p in s.active_patterns],
                "dataSource": s.get_data_source_info(),
            }
            for sid, s in stations.items()
        },
    })


# ── Phase 6: Groq Explanation Layer ──────────────────────────
# Groq is STRICTLY the communication layer.
# It receives validated structured JSON from the decision engine
# and turns it into human-readable explanations.
# Groq does NOT invent intelligence — it explains the pipeline's output.
#
# Architecture:
#   /api/decision → validated JSON → Groq → operator explanation
#
# Key ONLY from the environment (never hardcoded, never sent to the browser).
GROQ_API_KEY = app_config.GROQ_API_KEY
GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions"
GROQ_MODEL = app_config.GROQ_MODEL
# Honest client identification (no spoofed User-Agent).
GROQ_USER_AGENT = "Aurora-DigitalTwin/1.0 (+https://github.com/Saeesh-Vele/SIH2026A)"
# Operator free text is untrusted: cap its length and only ever place it in
# the *user* message, never in the system prompt.
MAX_USER_TEXT_CHARS = 500
LLM_UNAVAILABLE_MSG = (
    "LLM explanation unavailable: GROQ_API_KEY is not configured on the server. "
    "The structured decision data (/api/decision) is still available."
)
# Must start with "LLM explanation" so the backend treats it as an LLM failure and
# substitutes its offline summary (see _LLM_FAILURE_PREFIXES in unified_backend.py).
LLM_CAPPED_MSG = (
    "LLM explanation unavailable: the server's Groq budget "
    f"({app_config.GROQ_MAX_CALLS_PER_HOUR} calls an hour, {app_config.GROQ_MAX_CALLS_PER_DAY} a day) is used up. "
    "The structured decision data (/api/decision) is still available."
)

# ── Groq call budget ─────────────────────────────────────────
# Outbound Groq calls are capped per rolling hour for the whole process, so a public demo
# cannot run up a bill (nginx rate-limits the route on top of this). Past the cap nothing
# is sent upstream: the explain routes report llmAvailable=false and the backend serves
# its deterministic offline summary instead.
_groq_calls: collections.deque = collections.deque()
_groq_lock = threading.Lock()
_groq_cap_logged = False


def _groq_prune(now: float) -> None:
    """Drop call timestamps older than a day (the daily cap needs them). Caller holds _groq_lock."""
    cutoff = now - 86400.0
    while _groq_calls and _groq_calls[0] < cutoff:
        _groq_calls.popleft()


def _groq_used(now: float) -> tuple[int, int]:
    """(calls in the last hour, calls in the last 24 h). Caller holds _groq_lock."""
    hour = sum(1 for t in _groq_calls if t >= now - 3600.0)
    return hour, len(_groq_calls)


def groq_budget_remaining() -> int:
    """Calls still allowed now: the tighter of the hourly and daily caps. Consumes none."""
    with _groq_lock:
        now = time.time()
        _groq_prune(now)
        hour, day = _groq_used(now)
        return max(0, min(app_config.GROQ_MAX_CALLS_PER_HOUR - hour, app_config.GROQ_MAX_CALLS_PER_DAY - day))


def _groq_take_slot() -> bool:
    """Reserve one call. False when the hourly cap is already used up."""
    global _groq_cap_logged
    now = time.time()
    with _groq_lock:
        _groq_prune(now)
        hour, day = _groq_used(now)
        if hour >= app_config.GROQ_MAX_CALLS_PER_HOUR or day >= app_config.GROQ_MAX_CALLS_PER_DAY:
            if not _groq_cap_logged:
                log.warning(
                    "[Groq] budget used up (%d/%d this hour, %d/%d today); serving offline summaries "
                    "until it refills (GROQ_MAX_CALLS_PER_HOUR / GROQ_MAX_CALLS_PER_DAY)",
                    hour, app_config.GROQ_MAX_CALLS_PER_HOUR, day, app_config.GROQ_MAX_CALLS_PER_DAY,
                )
                _groq_cap_logged = True
            return False
        _groq_calls.append(now)
        _groq_cap_logged = False
        return True


def _llm_available() -> bool:
    """A key is configured AND the hourly budget still has room."""
    return bool(GROQ_API_KEY) and groq_budget_remaining() > 0


# ── Assistant router budget ──────────────────────────────────
# The Aurora assistant's free-form requests are routed to its whitelisted UI actions by a
# small, fast model (GROQ_ROUTER_MODEL). Groq meters each model separately, so the router
# has its own rolling-hour and 24 h caps; explanations keep using the budget above.
_router_calls: collections.deque = collections.deque()


def _router_used(now: float) -> tuple[int, int]:
    """(router calls in the last hour, in the last 24 h). Caller holds _groq_lock."""
    while _router_calls and _router_calls[0] < now - 86400.0:
        _router_calls.popleft()
    return sum(1 for t in _router_calls if t >= now - 3600.0), len(_router_calls)


def router_budget_remaining() -> int:
    with _groq_lock:
        hour, day = _router_used(time.time())
        return max(0, min(app_config.GROQ_ROUTER_MAX_CALLS_PER_HOUR - hour,
                          app_config.GROQ_ROUTER_MAX_CALLS_PER_DAY - day))


def _router_take_slot() -> bool:
    now = time.time()
    with _groq_lock:
        hour, day = _router_used(now)
        if hour >= app_config.GROQ_ROUTER_MAX_CALLS_PER_HOUR or day >= app_config.GROQ_ROUTER_MAX_CALLS_PER_DAY:
            log.info("[Groq] router budget used up (%d this hour, %d today)", hour, day)
            return False
        _router_calls.append(now)
        return True


def _clean_user_text(value, limit: int = MAX_USER_TEXT_CHARS) -> str:
    """Coerce untrusted operator input to a bounded plain string."""
    if value is None:
        return ""
    text = str(value).replace("\x00", "").strip()
    return text[:limit]


def _json_body() -> dict:
    """Parse the request body without raising on bad/missing JSON."""
    data = flask_request.get_json(silent=True)
    return data if isinstance(data, dict) else {}

AURORA_SYSTEM_PROMPT = (
    "You are Aurora, the AI operations assistant for Indian Antarctic Research Stations (Maitri and Bharati), "
    "operated by NCPOR under the Ministry of Earth Sciences.\n"
    "\n"
    "CRITICAL RULES:\n"
    "1. You ONLY describe facts provided in the DECISION_DATA JSON. NEVER invent sensor values, predictions, or risk "
    "assessments.\n"
    "2. Your job is to EXPLAIN the decision engine's output in clear language — not to diagnose equipment yourself.\n"
    "3. Every claim you make must trace to a specific field in the provided data.\n"
    "4. Use Celsius, kW, km/h, kL, L/hr as units. Use precise numbers from the data.\n"
    "5. Distinguish provenance: say \"the physics model predicts\" not \"I predict\". Say \"the anomaly detector "
    "indicates\" not \"I detected\".\n"
    "6. Keep responses concise: 3-5 sentences for status, up to 8 for detailed explanations.\n"
    "7. If asked \"why\", explain the evidence and triggered risk rules from the data.\n"
    "8. If asked \"what should I do\", read the recommendation from the data — do not generate your own.\n"
    "9. You can respond in Hindi, English, or mixed Hindi-English if the user asks in Hindi.\n"
    "10. Always end with the confidence level and action type from the recommendation.\n"
    '11. Candidate causes are POSSIBLE explanations, not confirmed failures. Use words like "possible", '
    '"candidate", '
    "\"indicated\".\n"
    "12. All degradation assessments are against synthetic prototype signatures — do not claim production-validated "
    "diagnosis."
)

QUESTION_PROMPTS = {
    "status": "Provide a brief operational status summary for this station based on the decision data.",
    "why": "Explain WHY the risk level is what it is. Reference the specific triggered rules and evidence.",
    "action": "What should the operator do? Read the recommendation from the decision data. Do not generate your own "
              "actions.",
    "detail": "Provide a detailed explanation of the current situation, including evidence, forecast, impact, and "
              "recommendation.",
}


def _call_groq(system_prompt: str, user_prompt: str, max_tokens: int = 400) -> str:
    """Call Groq API with the given prompts. Returns explanation text.

    Nothing leaves the process without a budget slot, so the hourly cap holds even if a
    caller forgets to check _llm_available() first.
    """
    if not GROQ_API_KEY:
        return LLM_UNAVAILABLE_MSG
    if not _groq_take_slot():
        return LLM_CAPPED_MSG
    try:
        import urllib.request
        req = urllib.request.Request(
            GROQ_API_URL,
            data=json.dumps({
                "model": GROQ_MODEL,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                "temperature": 0.2, "max_tokens": max_tokens,
            }).encode(),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {GROQ_API_KEY}",
                "User-Agent": GROQ_USER_AGENT,
            },
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            result = json.loads(resp.read())
            return result["choices"][0]["message"]["content"]
    except Exception as e:
        err_msg = str(e)
        if hasattr(e, 'read'):
            try:
                err_msg = f"{e} — {e.read().decode(errors='replace')[:500]}"
            except Exception as read_err:
                log.debug("[Groq] could not read error body: %s", read_err)
        log.warning("[Groq] request failed: %s", err_msg)
        return "LLM explanation temporarily unavailable (upstream error; see server log)."


# ── Assistant LLM gateway (internal) ─────────────────────────
# The unified backend builds the Aurora assistant's grounded prompts (simulator/assistant.py)
# and sends them here, so the key and every budget stay in this one process. Not reachable
# from the browser (the backend is the only public service).
LLM_ROLES = {"system", "user", "assistant"}
LLM_MAX_MESSAGES = 12
LLM_MAX_CHARS = 16000
LLM_MAX_TOOLS = 20


def _groq_chat(model: str, messages: list, *, tools=None, max_tokens: int = 400, json_mode: bool = False) -> dict:
    """One Groq chat completion. The caller has already taken a budget slot.
    → {"ok", "content", "toolCalls": [{"name", "arguments"}], "reason", "usage"}; never raises.
    Uses requests (certifi's CA bundle), so it also works on Python builds without system certificates."""
    body = {"model": model, "messages": messages, "temperature": 0.2, "max_tokens": max_tokens}
    if model.startswith("openai/gpt-oss"):
        body["reasoning_effort"] = "low"      # reasoning tokens count against max_tokens
    if tools:
        body["tools"] = tools
        body["tool_choice"] = "auto"
    if json_mode:
        body["response_format"] = {"type": "json_object"}
    try:
        resp = requests.post(GROQ_API_URL, json=body, timeout=15, headers={
            "Authorization": f"Bearer {GROQ_API_KEY}", "User-Agent": GROQ_USER_AGENT})
    except requests.RequestException as e:
        log.warning("[Groq] %s request failed: %s", model, type(e).__name__)
        return {"ok": False, "reason": "upstream unreachable", "content": "", "toolCalls": []}
    if resp.status_code != 200:
        log.warning("[Groq] %s returned HTTP %s: %s", model, resp.status_code, resp.text[:300])
        return {"ok": False, "reason": f"upstream HTTP {resp.status_code}", "content": "", "toolCalls": []}
    try:
        result = resp.json()
    except ValueError:
        log.warning("[Groq] %s returned invalid JSON", model)
        return {"ok": False, "reason": "upstream returned invalid JSON", "content": "", "toolCalls": []}
    msg = ((result.get("choices") or [{}])[0]).get("message") or {}
    calls = []
    for c in msg.get("tool_calls") or []:
        fn = c.get("function") or {}
        try:
            args = json.loads(fn.get("arguments") or "{}")
        except ValueError:
            log.info("[Groq] tool call %s had invalid JSON arguments; dropped", fn.get("name"))
            continue
        calls.append({"name": str(fn.get("name", "")), "arguments": args if isinstance(args, dict) else {}})
    usage = result.get("usage") or {}
    return {"ok": True, "content": str(msg.get("content") or ""), "toolCalls": calls, "reason": None,
            "usage": {"prompt": usage.get("prompt_tokens"), "completion": usage.get("completion_tokens")}}


@control_app.route("/api/llm/status")
def llm_status():
    """Internal: whether the assistant's LLM stages can be used right now (never the key)."""
    return jsonify({"configured": bool(GROQ_API_KEY), "explainRemaining": groq_budget_remaining(),
                    "routerRemaining": router_budget_remaining(),
                    "explainModel": GROQ_MODEL, "routerModel": app_config.GROQ_ROUTER_MODEL})


@control_app.route("/api/llm/chat", methods=["POST"])
def llm_chat():
    """Internal: one chat completion for the backend's assistant.
    kind "router" → GROQ_ROUTER_MODEL and the router budget (tool calling);
    kind "explain" → GROQ_MODEL and the explanation budget."""
    data = _json_body()
    kind = data.get("kind")
    if kind not in ("router", "explain"):
        return jsonify({"error": "kind must be 'router' or 'explain'"}), 400
    raw = data.get("messages")
    if not isinstance(raw, list) or not 1 <= len(raw) <= LLM_MAX_MESSAGES:
        return jsonify({"error": f"messages must be a list of 1-{LLM_MAX_MESSAGES}"}), 400
    messages = []
    for m in raw:
        if not isinstance(m, dict) or m.get("role") not in LLM_ROLES or not isinstance(m.get("content"), str):
            return jsonify({"error": "each message needs a role and string content"}), 400
        messages.append({"role": m["role"], "content": m["content"]})
    if sum(len(m["content"]) for m in messages) > LLM_MAX_CHARS:
        return jsonify({"error": "messages too long"}), 400
    tools = data.get("tools")
    if tools is not None and (not isinstance(tools, list) or len(tools) > LLM_MAX_TOOLS):
        return jsonify({"error": "tools must be a list"}), 400
    try:
        max_tokens = max(50, min(int(data.get("maxTokens", 400)), 900))
    except (TypeError, ValueError):
        max_tokens = 400
    model = app_config.GROQ_ROUTER_MODEL if kind == "router" else GROQ_MODEL
    if not GROQ_API_KEY:
        return jsonify({"available": False, "reason": "GROQ_API_KEY is not configured on the server", "model": model})
    if not (_router_take_slot() if kind == "router" else _groq_take_slot()):
        return jsonify({"available": False, "capped": True, "model": model,
                        "reason": "the server's Groq budget for this hour or day is used up"})
    res = _groq_chat(model, messages, tools=tools, max_tokens=max_tokens, json_mode=bool(data.get("json")))
    return jsonify({"available": res["ok"], "model": model, **res})


@control_app.route("/api/aurora-explain", methods=["POST"])
def aurora_explain():
    """Phase 6: Decision-aware Groq explanation endpoint.

    Groq receives the validated decision JSON and turns it into
    a human-readable explanation. It does NOT invent intelligence.

    Request body:
        question: "status" | "why" | "action" | "detail" | free-text
        station: "maitri" | "bharati" (default: maitri)
    """
    data = _json_body()
    question_type = _clean_user_text(data.get("question", "status"), 32) or "status"
    station_id = _clean_user_text(data.get("station", "maitri"), 32) or "maitri"
    free_text = _clean_user_text(data.get("freeText", ""))

    # Get the latest decision for this station
    sim = _get_station(station_id)
    decision = getattr(sim, '_last_decision', None)

    if not decision:
        return jsonify({
            "explanation": "Decision engine has not yet computed a result for this station.",
            "sources": [],
            "llmAvailable": _llm_available(),
        })

    # Build the decision context (exclude audit trail for token efficiency)
    decision_compact = {k: v for k, v in decision.items() if k != "auditTrail"}
    decision_str = json.dumps(decision_compact, indent=2, default=str)[:4000]

    # Build the question prompt
    if question_type in QUESTION_PROMPTS:
        question = QUESTION_PROMPTS[question_type]
    elif free_text:
        question = free_text
    else:
        question = QUESTION_PROMPTS["status"]

    user_prompt = f"DECISION_DATA:\n{decision_str}\n\nQUESTION: {question}"

    explanation = _call_groq(AURORA_SYSTEM_PROMPT, user_prompt)

    # Determine which data sources contributed
    sources = []
    if decision.get("currentState"):
        sources.append("current_telemetry")
    if decision.get("evidence"):
        for ev in decision["evidence"]:
            if ev.get("source") == "anomaly_detector_v2":
                sources.append("anomaly_v2")
                break
        for ev in decision["evidence"]:
            if ev.get("source") == "forecast_engine":
                sources.append("forecast_engine")
                break
    if decision.get("risk", {}).get("triggered_rules"):
        sources.append("decision_engine")
    sources = list(dict.fromkeys(sources))  # deduplicate, preserve order

    return jsonify({
        "explanation": explanation,
        "llmAvailable": _llm_available(),
        "sources": sources,
        "questionType": question_type,
        "riskLevel": decision.get("risk", {}).get("level", "unknown"),
        "event": decision.get("event", {}),
        "provenance": decision.get("provenance", {}),
    })


# Keep legacy /api/explain for backward compatibility
@control_app.route("/api/explain", methods=["POST"])
def explain():
    """Legacy explain endpoint — now delegates to aurora-explain."""
    data = _json_body()
    query = _clean_user_text(data.get("query", ""))
    station = _clean_user_text(data.get("station", "maitri"), 32) or "maitri"

    # Map to new endpoint
    sim = _get_station(station)
    decision = getattr(sim, '_last_decision', None)

    if not _llm_available():
        return jsonify({"explanation": LLM_UNAVAILABLE_MSG, "llmAvailable": False}), 200
    if decision:
        decision_compact = {k: v for k, v in decision.items() if k != "auditTrail"}
        decision_str = json.dumps(decision_compact, indent=2, default=str)[:3000]
        context = data.get("context", {})
        context_str = json.dumps(context, indent=2, default=str)[:1500]
        user_prompt = f"DECISION_DATA:\n{decision_str}\n\nADDITIONAL CONTEXT:\n{context_str}\n\nQUESTION: {query}"
        explanation = _call_groq(AURORA_SYSTEM_PROMPT, user_prompt)
        return jsonify({"explanation": explanation})
    context = data.get("context", {})
    context_str = json.dumps(context, indent=2, default=str)[:3000]
    user_prompt = f"STATION DATA:\n{context_str}\n\nQUESTION: {query}"
    explanation = _call_groq(AURORA_SYSTEM_PROMPT, user_prompt)
    return jsonify({"explanation": explanation})


@control_app.route("/api/explain/incident", methods=["POST"])
def explain_incident():
    """Legacy incident explanation — now decision-aware."""
    if not _llm_available():
        return jsonify({"explanation": LLM_UNAVAILABLE_MSG, "llmAvailable": False}), 200
    data = _json_body()
    incident = data.get("incident", {})
    if not isinstance(incident, dict):
        incident = {}
    station = _clean_user_text(data.get("station", "maitri"), 32) or "maitri"

    # Include decision context if available
    sim = _get_station(station)
    decision = getattr(sim, '_last_decision', None)
    decision_str = ""
    if decision:
        decision_compact = {k: v for k, v in decision.items() if k != "auditTrail"}
        decision_str = f"\n\nDECISION ENGINE CONTEXT:\n{json.dumps(decision_compact, indent=2, default=str)[:2000]}"

    # Incident fields come from the browser: treat as untrusted, bounded text
    # (user message only — never the system prompt).
    def field(key, default):
        return _clean_user_text(incident.get(key, default), 200) or default
    affected_raw = incident.get("affectedSystems", [])
    affected = [
        _clean_user_text(a.get("name", ""), 60)
        for a in (affected_raw if isinstance(affected_raw, list) else [])
        if isinstance(a, dict)
    ][:20]

    prompt = f"""Explain this incident briefly (3-4 sentences):
INCIDENT: {field('title', 'Unknown')}
RISK: {field('riskLevel', 'Unknown')}
CAUSE: {field('cause', 'Unknown')}
BUILDING: {field('rootBuildingName', 'Unknown')}
AFFECTED: {', '.join(affected)}
RECOMMENDED ACTION: {field('recommendedAction', 'None')}{decision_str}"""

    explanation = _call_groq(AURORA_SYSTEM_PROMPT, prompt, max_tokens=200)
    return jsonify({"explanation": explanation})


def run_control_server():
    control_app.run(host=HOST, port=CONTROL_PORT, debug=False, use_reloader=False)


# ── Main loop — ticks BOTH stations independently ────────────
def main():
    log.info("Aurora v3 — Physics-Based Digital Twin Simulator")
    log.info(f"Mode: {DEFAULT_MODE.upper()}")
    if DEFAULT_DATE:
        log.info(f"Replay date: {DEFAULT_DATE} (source: {app_config.AURORA_DATE_SOURCE})")
    log.info(f"Speed: {DEFAULT_SPEED}x "
             f"({sim_hours_per_real_minute(DEFAULT_SPEED):.1f} simulated hours per real minute)")
    log.info(f"Stations: {', '.join(STATION_PROFILES.keys())}")
    log.info(f"Backend: {BACKEND_URL}")
    log.info(f"Control API: http://{HOST}:{CONTROL_PORT}  (CORS: {', '.join(ALLOWED_ORIGINS)})")
    groq_status = "configured" if GROQ_API_KEY else "NOT SET"
    log.info(f"Groq API: {groq_status}")

    # Start Flask control API
    control_thread = threading.Thread(target=run_control_server, daemon=True)
    control_thread.start()
    log.info(f"Control API running on http://{HOST}:{CONTROL_PORT}")

    consecutive_errors = 0
    max_errors = 10

    while True:
        try:
            # Tick + build payloads under the lock; POST outside it.
            payloads = []
            with stations_lock:
                current = dict(stations)
                for station_id, sim in current.items():
                    readings = sim.tick()
                    source_info = sim.get_data_source_info()
                    payloads.append({
                        "stationId": station_id,
                        "timestamp": int(time.time() * 1000),
                        "readings": readings,
                        "eventTimeline": sim.event_log[-50:],
                        "activePatterns": [p["name"] for p in sim.active_patterns],
                        # Provenance hints for the unified backend (additive, optional fields)
                        "mode": source_info.get("mode"),
                        "activeScenario": sim.active_scenario,
                        "injectedSensors": sorted(sim.active_injections.keys()),
                        "weatherSource": source_info.get("dataset") or source_info.get("label"),
                        # Energy breakdown of THIS tick (same timestamp as the readings).
                        "energy": getattr(sim, "_last_energy", None),
                        # ERA5 replay clock of THIS tick: the instant the readings describe.
                        "replay": getattr(sim, "_last_replay", None),
                    })

            for payload in payloads:
                try:
                    response = requests.post(
                        BACKEND_URL, json=payload, timeout=5, headers=BATCH_HEADERS,
                    )
                    if response.status_code == 200:
                        consecutive_errors = 0
                    else:
                        consecutive_errors += 1
                        if response.status_code == 401:
                            log.error(
                                "Backend rejected telemetry (401): ADMIN_TOKEN does not match "
                                "the backend's. Both services must read the same root .env."
                            )
                except requests.exceptions.ConnectionError:
                    consecutive_errors += 1
                    if consecutive_errors == 1:
                        log.warning(f"Waiting for backend at {BACKEND_URL}...")

            # Print status (alternate stations)
            active_sid = "maitri" if current["maitri"].tick_count % 2 == 0 else "bharati"
            sim = current[active_sid]
            ts = datetime.now().strftime("%H:%M:%S")
            temp = sim.values.get("lab", {}).get("env_temp", 0)
            power = sim.values.get("generator", {}).get("gen_power", 0)
            patterns = [p["name"] for p in sim.active_patterns]

            mode_tag = "ERA5" if sim.mode == "reanalysis" else "SIM"
            meta = getattr(sim, '_last_meta', {})
            load_pct = meta.get("gen_load_pct", 0)

            status = f"[{ts}] {active_sid:>7s} #{sim.tick_count:>4d}"
            status += f" | {temp:>6.1f}C | {power:>6.1f}kW"
            status += f" | {load_pct:>4.1f}%"
            status += f" | {mode_tag}"
            if patterns:
                status += f" | W: {', '.join(patterns)}"
            if sim.active_scenario:
                status += f" | S: {SCENARIOS[sim.active_scenario]['name']}"

            # Show simulated time in reanalysis mode
            weather = getattr(sim, '_last_weather', None)
            if weather and 'simulated_time' in weather:
                sim_time = weather['simulated_time'][:16]
                status += f" | T:{sim_time}"

            log.info(status)

        except Exception:
            consecutive_errors += 1
            log.exception("Simulator main-loop iteration failed")

        if consecutive_errors >= max_errors:
            consecutive_errors = 0

        time.sleep(TICK_INTERVAL)


if __name__ == "__main__":
    main()

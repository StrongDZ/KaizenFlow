#!/usr/bin/env python3
import json
import math
import os
import sys
from typing import Dict, Optional

import numpy as np
import pandas as pd


def _fail(msg: str) -> None:
    print(json.dumps({"error": msg}), file=sys.stderr)
    sys.exit(1)


def _load_project_m(root: str):
    sys.path.insert(0, root)
    from src.utils import bimbo_forecast_booster as booster

    return booster


def _promo_frames(ts_index, promo_global_df, promo_sku_df) -> Dict[int, pd.DataFrame]:
    frames: Dict[int, pd.DataFrame] = {}
    if promo_sku_df is None or len(promo_sku_df) == 0:
        return frames
    semana_to_date_map = {}
    if promo_global_df is not None and len(promo_global_df):
        for _, row in promo_global_df.iterrows():
            try:
                semana_to_date_map[int(row["Semana"])] = pd.Timestamp(row["week_start_date"])
            except Exception:
                continue
    for sku_id_int in promo_sku_df["sku_id"].dropna().astype(int).unique().tolist():
        sub = promo_sku_df[promo_sku_df["sku_id"] == sku_id_int].copy()
        sub["_date"] = sub["Semana"].apply(lambda s: semana_to_date_map.get(int(s), None))
        sub = sub[sub["_date"].notna()].copy()
        if len(sub) == 0:
            continue
        sub["date"] = pd.to_datetime(sub["_date"])
        sub = sub.set_index("date").sort_index()
        sub = sub.reindex(ts_index).fillna(0.0)
        cols = [c for c in ("fl_global_promo", "fl_promo_local", "regime_shift_pct", "fl_post_regime_break") if c in sub.columns]
        if cols:
            frames[int(sku_id_int)] = sub[cols].astype(float)
    return frames


def _tuned_cfg(booster, root: str, sku_id: int):
    tuner_path = os.path.join(root, "data", "synthetic", "tuner_per_sku_best_config.csv")
    grid = {cfg["cfg_id"]: cfg for cfg in booster.HW_GRID_SHORT}
    default_cfg = booster.HW_GRID_SHORT[0]
    if not os.path.exists(tuner_path):
        return default_cfg
    try:
        df = pd.read_csv(tuner_path)
        row = df[df["sku_id"] == sku_id]
        if len(row) == 0:
            return default_cfg
        cfg_id = str(row.iloc[0]["cfg_id"])
        return grid.get(cfg_id, default_cfg)
    except Exception:
        return default_cfg


def _series_of(ts_wide: pd.DataFrame, sku_id: int) -> Optional[pd.Series]:
    for key in (str(sku_id), sku_id):
        if key in ts_wide.columns:
            return ts_wide[key].astype(float).dropna()
    return None


def main() -> None:
    try:
        req = json.load(sys.stdin)
    except Exception as exc:
        _fail(f"invalid request json: {exc}")

    root = str(req.get("project_root") or "").strip()
    if not root:
        _fail("missing project_root")
    if not os.path.isdir(root):
        _fail(f"project_root not found: {root}")

    booster = _load_project_m(root)
    ts_wide, meta_df, ret_wide, promo_global_df, promo_sku_df = booster.load_bimbo_inputs()
    promo_by_sku = _promo_frames(ts_wide.index, promo_global_df, promo_sku_df)
    meta_df = meta_df.copy()
    if "sku_id" in meta_df.columns:
        meta_df["sku_id"] = meta_df["sku_id"].astype(int)

    out_items = []
    for item in req.get("items", []):
        item_id = str(item.get("id") or "").strip()
        sku_id = int(item.get("sku_id") or 0)
        horizon_weeks = max(1, int(math.ceil(float(item.get("horizon_weeks") or 1))))
        if not item_id or sku_id <= 0:
            continue

        series = _series_of(ts_wide, sku_id)
        if series is None or len(series) == 0:
            out_items.append({"id": item_id, "sku_id": sku_id, "error": f"sku {sku_id} not found"})
            continue

        meta_row = meta_df[meta_df["sku_id"] == sku_id]
        if len(meta_row) == 0:
            out_items.append({"id": item_id, "sku_id": sku_id, "error": f"metadata for sku {sku_id} not found"})
            continue
        meta_row = meta_row.iloc[0]

        returns_series = None
        for key in (str(sku_id), sku_id):
            if key in ret_wide.columns:
                returns_series = ret_wide[key]
                break

        feat = booster.get_sku_feature_dict(meta_row, returns_series)
        promo_frame = promo_by_sku.get(sku_id)
        pred = booster.fit_predict_ml_bimbo(series, len(series), horizon_weeks, feat, returns_series, promo_frame)
        if pred is None:
            cfg = _tuned_cfg(booster, root, sku_id)
            hw = booster.fit_hw_one(series.values.astype(float), horizon_weeks, cfg)
            if hw is None:
                fallback = float(np.nanmean(series.tail(min(8, len(series))).values))
                hw = np.full(horizon_weeks, max(0.0, fallback), dtype=float)
            pred = {"preds": hw, "backend": f"HW_{cfg['cfg_id']}", "used_ml": False}

        preds = [max(0.0, float(x)) for x in np.asarray(pred["preds"], float).tolist()]
        history_mean = float(np.nanmean(series.tail(min(8, len(series))).values))
        out_items.append({
            "id": item_id,
            "sku_id": sku_id,
            "backend": str(pred.get("backend") or "unknown"),
            "used_ml": bool(pred.get("used_ml")),
            "preds": preds,
            "history_mean": max(0.0, history_mean),
            "brand": str(meta_row.get("brand") or ""),
            "abc_category": str(meta_row.get("abc_category") or ""),
        })

    json.dump({"items": out_items}, sys.stdout)


if __name__ == "__main__":
    main()

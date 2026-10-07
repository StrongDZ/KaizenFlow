"""End-to-end run of the render command."""

import pyarrow.parquet as pq
import pytest
from gauge_renderer import cli, groundtruth
from gauge_renderer.noise import FRAME_COLUMNS


def test_render_command_writes_every_output(tmp_path):
    code = cli.main(
        [
            "--stations",
            "2",
            "--minutes",
            "0.02",
            "--fps",
            "10",
            "--seed",
            "5",
            "--out",
            str(tmp_path),
            "--workers",
            "2",
        ]
    )

    assert code == 0
    for machine in ("machine_001", "machine_002"):
        directory = tmp_path / machine
        for name in ("video.mp4", "groundtruth.parquet", "station_config.json", "render_meta.json"):
            assert (directory / name).stat().st_size > 0, f"{machine}/{name}"
        table = pq.read_table(directory / groundtruth.FILENAME)
        n_gauges = len(set(table["gauge_id"].to_pylist()))
        assert table.num_rows == 12 * n_gauges
        assert {"ts_ms", "gauge_id", "value", *FRAME_COLUMNS} <= set(table.column_names)
        assert table["ts_ms"].to_pylist()[::n_gauges][:3] == [0, 100, 200]


def test_render_command_rejects_bad_arguments(tmp_path):
    with pytest.raises(SystemExit):
        cli.main(["--stations", "0", "--out", str(tmp_path)])
    with pytest.raises(SystemExit):
        cli.main(["--noise", "extreme", "--out", str(tmp_path)])

"""Hệ toạ độ của hãng xe giả lập: feed demo phát vị trí ở hệ này (xoay, dịch, mm, nhiễu) để chứng minh khung toạ độ và khớp làn của API."""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class ControllerFrame:
    """Cùng nghĩa với Frame của API: toạ độ bản đồ = dịch + xoay(scale × lật_Y(toạ độ hãng xe)). to_raw là phép ngược."""
    dx: float = 0.0
    dy: float = 0.0
    rot_deg: float = 0.0
    scale: float = 1.0
    flip_y: bool = False
    noise_m: float = 0.0

    def _s(self) -> float:
        return self.scale or 1.0

    def to_map(self, x: float, y: float) -> tuple[float, float]:
        if self.flip_y:
            y = -y
        s = self._s()
        x, y = x * s, y * s
        r = math.radians(self.rot_deg)
        c, sn = math.cos(r), math.sin(r)
        return (self.dx + c * x - sn * y, self.dy + sn * x + c * y)

    def to_raw(self, x: float, y: float, rng: np.random.Generator | None = None) -> tuple[float, float]:
        """Toạ độ hãng xe báo cho một điểm của bản đồ (mét). Có rng thì cộng nhiễu Gauss noise_m mét (tính ở hệ bản đồ)."""
        if rng is not None and self.noise_m > 0:
            x, y = x + rng.normal(0.0, self.noise_m), y + rng.normal(0.0, self.noise_m)
        vx, vy = x - self.dx, y - self.dy
        r = math.radians(-self.rot_deg)
        c, sn = math.cos(r), math.sin(r)
        rx, ry = (c * vx - sn * vy) / self._s(), (sn * vx + c * vy) / self._s()
        return (rx, -ry if self.flip_y else ry)

    def heading_to_map(self, h: float) -> float:
        return (( -h if self.flip_y else h) + self.rot_deg) % 360.0

    def heading_to_raw(self, h: float) -> float:
        h = h - self.rot_deg
        return (-h if self.flip_y else h) % 360.0

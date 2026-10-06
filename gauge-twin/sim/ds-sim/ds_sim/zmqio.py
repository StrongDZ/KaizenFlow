"""ZeroMQ side of the pipeline: PUSH for FrameResult, REP for commands.

The pipeline binds both sockets; edge-agent connects. Frames are dropped
(and counted) when edge-agent is not there, so the pipeline never blocks.
"""

from __future__ import annotations

from collections.abc import Callable

import zmq
from denso.gauge.v1 import command_pb2, frame_result_pb2


class FramePublisher:
    def __init__(self, context: zmq.Context, endpoint: str, high_water_mark: int = 1000) -> None:
        self.socket = context.socket(zmq.PUSH)
        self.socket.setsockopt(zmq.SNDHWM, high_water_mark)
        self.socket.setsockopt(zmq.LINGER, 0)
        self.socket.bind(endpoint)
        self.sent = 0
        self.dropped = 0

    def send(self, frame: frame_result_pb2.FrameResult) -> bool:
        """Sends a frame; returns False when it had to be dropped."""
        try:
            self.socket.send(frame.SerializeToString(), zmq.NOBLOCK)
        except zmq.Again:
            self.dropped += 1
            return False
        self.sent += 1
        return True


class CommandServer:
    """Answers Command messages; handler returns (ok, error)."""

    def __init__(
        self,
        context: zmq.Context,
        endpoint: str,
        handler: Callable[[command_pb2.Command], tuple[bool, str]],
    ) -> None:
        self.socket = context.socket(zmq.REP)
        self.socket.setsockopt(zmq.LINGER, 0)
        self.socket.bind(endpoint)
        self.handler = handler

    def poll(self, timeout_ms: int = 0) -> bool:
        """Handles at most one pending command; returns True if one was handled."""
        if not self.socket.poll(timeout_ms, zmq.POLLIN):
            return False
        command = command_pb2.Command()
        reply = command_pb2.CommandReply()
        try:
            command.ParseFromString(self.socket.recv())
            reply.command_id = command.command_id
            reply.ok, reply.error = self.handler(command)
        except Exception as exc:  # noqa: BLE001 - a REP socket must always answer
            reply.ok, reply.error = False, f"{type(exc).__name__}: {exc}"
        self.socket.send(reply.SerializeToString())
        return True

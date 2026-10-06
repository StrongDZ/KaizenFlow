// Package logging provides the structured JSON logger every service uses.
package logging

import (
	"log/slog"
	"os"
	"strings"
)

// New returns a JSON logger tagged with the service name. The level comes
// from LOG_LEVEL (debug, info, warn, error) and defaults to info.
func New(service string) *slog.Logger {
	var level slog.Level
	switch strings.ToLower(os.Getenv("LOG_LEVEL")) {
	case "debug":
		level = slog.LevelDebug
	case "warn":
		level = slog.LevelWarn
	case "error":
		level = slog.LevelError
	default:
		level = slog.LevelInfo
	}
	handler := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: level})
	return slog.New(handler).With("service", service)
}

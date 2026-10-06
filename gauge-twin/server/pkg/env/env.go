// Package env reads service configuration from environment variables.
package env

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// String returns the variable or the fallback when it is unset or empty.
func String(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

// Strings splits a comma-separated variable.
func Strings(name string, fallback []string) []string {
	v := os.Getenv(name)
	if v == "" {
		return fallback
	}
	var out []string
	for _, part := range strings.Split(v, ",") {
		if part = strings.TrimSpace(part); part != "" {
			out = append(out, part)
		}
	}
	return out
}

// Int returns the variable as an integer; a malformed value is an error
// rather than a silent fallback, so a typo cannot go unnoticed.
func Int(name string, fallback int) (int, error) {
	v := os.Getenv(name)
	if v == "" {
		return fallback, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return 0, fmt.Errorf("%s: %q is not an integer", name, v)
	}
	return n, nil
}

// Duration returns the variable parsed with time.ParseDuration.
func Duration(name string, fallback time.Duration) (time.Duration, error) {
	v := os.Getenv(name)
	if v == "" {
		return fallback, nil
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		return 0, fmt.Errorf("%s: %q is not a duration", name, v)
	}
	return d, nil
}

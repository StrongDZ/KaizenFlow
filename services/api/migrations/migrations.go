// Package migrations nhúng các file SQL cho goose.
package migrations

import "embed"

//go:embed *.sql
var FS embed.FS

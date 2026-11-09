//go:build !embed

// Package web exposes the built web app to the server.
package web

import "io/fs"

// Dist returns nil in development, where Vite serves the app.
func Dist() fs.FS { return nil }

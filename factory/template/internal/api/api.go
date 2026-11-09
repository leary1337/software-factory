// Package api serves the HTTP API and, when built with it, the web app.
package api

import (
	"encoding/json"
	"io/fs"
	"net/http"
)

// NewHandler returns the application handler. static may be nil in development.
func NewHandler(static fs.FS) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", health)
	if static != nil {
		mux.Handle("/", http.FileServerFS(static))
	}
	return mux
}

func health(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

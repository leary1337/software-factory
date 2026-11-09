package api_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"__MODULE__/internal/api"
)

func TestHealth(t *testing.T) {
	t.Parallel()
	rec := httptest.NewRecorder()
	api.NewHandler(nil).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/health", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `"ok"`) {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

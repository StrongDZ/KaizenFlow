package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	_ "image/jpeg" // đăng ký bộ giải mã cho image.DecodeConfig
	_ "image/png"
	"io"
	"mime"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/kaizenflow/api/internal/live"
	"github.com/kaizenflow/api/internal/store"
)

const (
	maxMapImageBytes = 6 << 20
	maxMapImageSide  = 8000
)

var mapImageFormats = map[string]string{"image/png": "png", "image/jpeg": "jpeg"}

// putAgvMapImage nhận ảnh mặt bằng (PNG hoặc JPEG, thân nhị phân) làm nền bản đồ AGV. Chỗ đặt và tỉ lệ ảnh do bản đồ giữ (trường bg).
func (h *handlers) putAgvMapImage(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	key := chi.URLParam(r, "key")
	if _, _, err := h.modelGraph(ctx, key, false); err != nil {
		writeErr(w, err)
		return
	}
	ctype, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	format, ok := mapImageFormats[ctype]
	if !ok {
		writeJSON(w, 415, map[string]string{"error": "ảnh nền phải là PNG hoặc JPEG (Content-Type image/png hoặc image/jpeg)"})
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxMapImageBytes))
	var tooBig *http.MaxBytesError
	if errors.As(err, &tooBig) {
		writeJSON(w, 413, map[string]string{"error": fmt.Sprintf("ảnh nền quá lớn (tối đa %d MB); hãy thu nhỏ ảnh trước khi tải lên", maxMapImageBytes>>20)})
		return
	}
	if err != nil {
		writeJSON(w, 400, map[string]string{"error": "không đọc được ảnh: " + err.Error()})
		return
	}
	cfg, got, err := image.DecodeConfig(bytes.NewReader(data))
	switch {
	case err != nil:
		writeJSON(w, 400, map[string]string{"error": "không phải ảnh hợp lệ: " + err.Error()})
		return
	case got != format:
		writeJSON(w, 400, map[string]string{"error": fmt.Sprintf("nội dung là ảnh %s nhưng Content-Type khai báo %s", got, ctype)})
		return
	case cfg.Width > maxMapImageSide || cfg.Height > maxMapImageSide:
		writeJSON(w, 400, map[string]string{"error": fmt.Sprintf("ảnh quá lớn (%d×%d px, tối đa %d px mỗi cạnh)", cfg.Width, cfg.Height, maxMapImageSide)})
		return
	}
	img := store.MapImage{Mime: ctype, Data: data, Width: cfg.Width, Height: cfg.Height, Rev: time.Now().UnixMilli()}
	if err := h.Store.PutAgvMapImage(ctx, key, img); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"width": img.Width, "height": img.Height, "rev": img.Rev})
}

func (h *handlers) getAgvMapImage(w http.ResponseWriter, r *http.Request) {
	img, err := h.Store.GetAgvMapImage(r.Context(), chi.URLParam(r, "key"))
	if err != nil {
		writeErr(w, err)
		return
	}
	etag := `"` + strconv.FormatInt(img.Rev, 10) + `"`
	w.Header().Set("ETag", etag)
	w.Header().Set("Cache-Control", "no-cache")
	if r.Header.Get("If-None-Match") == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Header().Set("Content-Type", img.Mime)
	w.Header().Set("Content-Length", strconv.Itoa(len(img.Data)))
	w.WriteHeader(200)
	_, _ = w.Write(img.Data)
}

// deleteAgvMapImage xoá ảnh nền và bỏ trường bg khỏi bản đồ (nếu có) để bản đồ không trỏ tới ảnh không còn.
func (h *handlers) deleteAgvMapImage(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	key := chi.URLParam(r, "key")
	if err := h.Store.DeleteAgvMapImage(ctx, key); err != nil {
		writeErr(w, err)
		return
	}
	raw, err := h.Store.GetAgvMap(ctx, key)
	switch {
	case errors.Is(err, store.ErrNotFound):
		w.WriteHeader(204)
		return
	case err != nil:
		writeErr(w, err)
		return
	}
	m, err := live.ParseMap(raw)
	if err == nil && m.BG != nil {
		m.BG = nil
		out, _ := json.Marshal(m)
		if err := h.Store.PutAgvMap(ctx, key, out); err != nil {
			writeErr(w, err)
			return
		}
		h.Live.InvalidateMap(key)
	}
	w.WriteHeader(204)
}

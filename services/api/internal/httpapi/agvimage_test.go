package httpapi_test

import (
	"bytes"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"io"
	"net/http"
	"testing"
)

func tinyPNG(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for x := 0; x < w; x++ {
		img.Set(x, 0, color.Black)
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// raw gửi thân nhị phân (ảnh) và trả mã trạng thái, tiêu đề, thân.
func (a *liveAPI) raw(method, path, ctype string, body []byte) (int, http.Header, []byte) {
	a.t.Helper()
	req, _ := http.NewRequest(method, a.srv.URL+path, bytes.NewReader(body))
	if ctype != "" {
		req.Header.Set("Content-Type", ctype)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		a.t.Fatal(err)
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, resp.Header, out
}

func TestAgvMapImageUploadServeAndDelete(t *testing.T) {
	a := newLiveAPI(t, "")
	a.publishedModel("lm")
	const path = "/api/models/lm/agv-map/image"
	img := tinyPNG(t, 8, 5)

	if code, _, _ := a.raw("GET", path, "", nil); code != 404 {
		t.Fatalf("no image yet: GET = %d", code)
	}
	if code, _, _ := a.raw("PUT", "/api/models/nope/agv-map/image", "image/png", img); code != 404 {
		t.Errorf("unknown model: PUT = %d", code)
	}
	if code, _, _ := a.raw("PUT", path, "text/plain", img); code != 415 {
		t.Errorf("wrong content type: PUT = %d", code)
	}
	if code, _, _ := a.raw("PUT", path, "image/png", []byte("khong phai anh")); code != 400 {
		t.Errorf("bytes that are not an image: PUT = %d", code)
	}
	if code, _, _ := a.raw("PUT", path, "image/png", make([]byte, 7<<20)); code != 413 {
		t.Errorf("image over the limit: PUT = %d", code)
	}

	code, _, body := a.raw("PUT", path, "image/png", img)
	if code != 200 {
		t.Fatalf("PUT = %d %s", code, body)
	}
	var up struct {
		Width, Height int
		Rev           int64
	}
	if err := json.Unmarshal(body, &up); err != nil || up.Width != 8 || up.Height != 5 || up.Rev == 0 {
		t.Fatalf("upload reply = %s (%v)", body, err)
	}

	code, hdr, got := a.raw("GET", path, "", nil)
	if code != 200 || hdr.Get("Content-Type") != "image/png" || !bytes.Equal(got, img) {
		t.Errorf("GET = %d %q, %d bytes (want the %d uploaded)", code, hdr.Get("Content-Type"), len(got), len(img))
	}

	// Chỗ đặt ảnh đi theo bản đồ và về lại nguyên vẹn.
	a.call("PUT", "/api/models/lm/agv-map", map[string]any{"v": 2, "speed_mps": 1.2, "points": []any{}, "lanes": []any{},
		"bg": map[string]any{"x": 1, "y": 2, "m_per_px": 0.05, "w_px": 8, "h_px": 5, "rev": up.Rev, "calibrated": true}}, 204)
	m := a.call("GET", "/api/models/lm/agv-map", nil, 200)
	bg, _ := m["bg"].(map[string]any)
	if bg == nil || bg["m_per_px"].(float64) != 0.05 || bg["calibrated"] != true {
		t.Errorf("bg lost: %v", m)
	}

	// Xoá ảnh thì bản đồ cũng thôi tham chiếu nó.
	if code, _, _ := a.raw("DELETE", path, "", nil); code != 204 {
		t.Fatalf("DELETE = %d", code)
	}
	if code, _, _ := a.raw("GET", path, "", nil); code != 404 {
		t.Errorf("image must be gone: GET = %d", code)
	}
	m = a.call("GET", "/api/models/lm/agv-map", nil, 200)
	if _, has := m["bg"]; has {
		t.Errorf("map still points at the deleted image: %v", m)
	}
	if code, _, _ := a.raw("DELETE", path, "", nil); code != 204 {
		t.Errorf("deleting twice must be harmless: %d", code)
	}
}

func TestAgvMapImageAcceptsJPEGAndRejectsAMislabelledBody(t *testing.T) {
	a := newLiveAPI(t, "")
	a.publishedModel("lm")
	const path = "/api/models/lm/agv-map/image"
	var jb bytes.Buffer
	if err := jpeg.Encode(&jb, image.NewRGBA(image.Rect(0, 0, 6, 4)), nil); err != nil {
		t.Fatal(err)
	}
	if code, _, body := a.raw("PUT", path, "image/jpeg", jb.Bytes()); code != 200 {
		t.Fatalf("jpeg PUT = %d %s", code, body)
	}
	if code, hdr, _ := a.raw("GET", path, "", nil); code != 200 || hdr.Get("Content-Type") != "image/jpeg" {
		t.Errorf("GET = %d %q", code, hdr.Get("Content-Type"))
	}
	if code, _, _ := a.raw("PUT", path, "image/jpeg", tinyPNG(t, 5, 5)); code != 400 {
		t.Errorf("PNG bytes declared as JPEG must be refused: %d", code)
	}
}

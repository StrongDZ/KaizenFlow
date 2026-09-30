// Package live chuẩn hoá bản tin thô của thiết bị thành tín hiệu chuẩn và giữ trạng thái live của nhà máy.
// Gói này thuần (không I/O) để test nhanh; ghi DB và phát WebSocket nằm ở tầng trên.
package live

import (
	"fmt"
	"strconv"
	"strings"
)

// Extract lấy một giá trị trong payload JSON đã giải mã. Cú pháp: `a.b`, `a[0]`, `a[sku=RAW-01].qty`, `[id=x].v`.
// Đường dẫn rỗng trả cả payload. Sai cú pháp hoặc không thấy thì trả (nil, false).
func Extract(payload any, path string) (any, bool) {
	if path == "" {
		return payload, true
	}
	cur := payload
	n := len(path)
	first := true
	for i := 0; i < n; {
		j := i
		for j < n && path[j] != '.' && path[j] != '[' {
			j++
		}
		name := path[i:j]
		if name == "" && !(first && j < n && path[j] == '[') {
			return nil, false
		}
		if name != "" {
			m, ok := cur.(map[string]any)
			if !ok {
				return nil, false
			}
			if cur, ok = m[name]; !ok {
				return nil, false
			}
		}
		for j < n && path[j] == '[' {
			k := strings.IndexByte(path[j:], ']')
			if k < 0 {
				return nil, false
			}
			sel := path[j+1 : j+k]
			j += k + 1
			arr, ok := cur.([]any)
			if !ok {
				return nil, false
			}
			if cur, ok = pick(arr, sel); !ok {
				return nil, false
			}
		}
		first = false
		if j < n {
			if path[j] != '.' {
				return nil, false
			}
			j++
			if j >= n {
				return nil, false
			}
		}
		i = j
	}
	return cur, true
}

// pick chọn phần tử mảng theo chỉ số (`0`) hoặc theo trường (`sku=RAW-01`).
func pick(arr []any, sel string) (any, bool) {
	if key, val, ok := strings.Cut(sel, "="); ok {
		for _, el := range arr {
			if m, isMap := el.(map[string]any); isMap && fmt.Sprint(m[key]) == val {
				return el, true
			}
		}
		return nil, false
	}
	i, err := strconv.Atoi(sel)
	if err != nil || i < 0 || i >= len(arr) {
		return nil, false
	}
	return arr[i], true
}
